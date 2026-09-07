import Anthropic from '@anthropic-ai/sdk';

import { assembleSystemPrompt, loadChatHistory } from './context.js';
import { TOOLS } from './tools.js';
import { READ_ONLY_TOOLS, ToolExecutor, type ToolOutcome } from './tool-executor.js';
import { HevyClient, type HevyToolClient } from '../hevy/client.js';
import { addMessagePair } from '../state/chatlog.js';
import { summarizeWorkouts } from '../hevy/summarize.js';
import type { HevyCompletedWorkout, HevyRoutineRecord } from '../hevy/types.js';
import { TurnDeadlineError } from './turn-queue.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 10;

// A full hevy_push_routine call spells out every set as its own JSON object, so
// a whole workout runs to thousands of tokens. 4096 truncated those mid-call.
const MAX_OUTPUT_TOKENS = 16000;

// ---------------------------------------------------------------------------
// History sanitizer
// ---------------------------------------------------------------------------

/**
 * Merge consecutive same-role messages before sending to Claude.
 * Belt-and-suspenders defense against DB corruption or edge cases that
 * could produce an invalid message sequence.
 */
function sanitizeHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      // Merge consecutive same-role messages
      const prev = result[result.length - 1];
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        result[result.length - 1] = { role: msg.role, content: prev.content + '\n' + msg.content };
      }
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Module-level singletons (created once, reused across chat() calls)
// ---------------------------------------------------------------------------

const anthropic = new Anthropic();
const hevyClient = new HevyClient();
const toolExecutor = new ToolExecutor(hevyClient);

export type ChatProgressStage = 'calling_model' | 'running_tools' | 'complete';

export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelCallMetrics {
  iteration: number;
  elapsedMs: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  stopReason: string | null;
  toolCalls: number;
}

/**
 * Per-tool telemetry for isolated evaluation. Callers opt in explicitly; the
 * production transport continues to log only the tool name and input keys.
 */
export interface ToolCallMetrics {
  iteration: number;
  name: string;
  input: Record<string, unknown>;
  result: string;
  elapsedMs: number;
}

export interface ChatOptions {
  /** Default true. Set false for a fully read-only conversation. */
  persist?: boolean;
  freshContext?: string;
  freshWorkouts?: HevyCompletedWorkout[];
  freshRoutines?: HevyRoutineRecord[];
  turnId?: string;
  /** Default true. Set false to disable every state-changing tool. */
  allowMutations?: boolean;
  /** Default true. The CLI disables only live Hevy routine writes. */
  allowHevyWrites?: boolean;
  /** Absolute deadline supplied by the Telegram turn queue. */
  deadlineAt?: number;
  /** Default high. The evaluation CLI can override this without changing production. */
  effort?: ModelEffort;
  onProgress?: (stage: ChatProgressStage) => void;
  /** Per-call telemetry hook. Do not persist raw prompt or response content here. */
  onModelCall?: (metrics: ModelCallMetrics) => void;
  /**
   * Replaces the live Hevy transport for an isolated caller such as the
   * effort evaluator. It is intentionally typed as the production client so
   * the tool executor follows the same path it does in normal operation.
   */
  hevyClient?: HevyToolClient;
  /** Captures full tool inputs/results only for an explicit evaluation caller. */
  onToolCall?: (metrics: ToolCallMetrics) => void;
  /** Evaluation-only cap; production continues to use the module default. */
  maxOutputTokens?: number;
  /** Evaluation-only cap; production continues to use the module default. */
  maxToolIterations?: number;
  /** Reject an evaluation request before it can exceed its reserved input size. */
  maxRequestBytes?: number;
  /** Evaluation-only control that removes prompt-cache markers from the request. */
  disablePromptCache?: boolean;
}

function throwIfDeadlineExpired(deadlineAt: number | undefined): void {
  if (deadlineAt != null && Date.now() >= deadlineAt) {
    throw new TurnDeadlineError();
  }
}

function assertRequestSize(
  maxRequestBytes: number | undefined,
  system: Anthropic.MessageCreateParams['system'],
  messages: Anthropic.MessageParam[],
): void {
  if (maxRequestBytes == null) return;
  const bytes = Buffer.byteLength(JSON.stringify({ system, messages, tools: TOOLS }));
  if (bytes > maxRequestBytes) {
    throw new Error(`Evaluation request is ${bytes} bytes, above its ${maxRequestBytes}-byte input budget.`);
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Send a user message through the full Claude request lifecycle:
 *
 * 1. Assemble system prompt + chat history
 * 2. Call Claude with tools
 * 3. Execute the tool loop until Claude produces a final text response
 * 4. Store BOTH user and assistant messages after success
 * 5. Return the assistant's response
 */
export async function chat(userMessage: string, options: ChatOptions = {}): Promise<string> {
  const persist = options.persist ?? true;
  const activeHevyClient = options.hevyClient ?? (options.deadlineAt == null
    ? hevyClient
    : new HevyClient(undefined, options.deadlineAt, event => console.log(`[http] turn=${options.turnId ?? 'cli'} ${JSON.stringify(event)}`)));
  const executor = options.hevyClient != null || options.allowMutations === false || options.allowHevyWrites === false || options.deadlineAt != null
    ? new ToolExecutor(activeHevyClient, {
      allowMutations: options.allowMutations,
      allowHevyWrites: options.allowHevyWrites,
    })
    : toolExecutor;
  // 1. Assemble context (before storing the user message — CRIT-001 fix)
  const assembledSystemPrompt = assembleSystemPrompt(options.freshContext);
  let systemPrompt: Anthropic.TextBlockParam[] = options.disablePromptCache
    ? assembledSystemPrompt.map((block) => ({ type: block.type, text: block.text }))
    : assembledSystemPrompt;
  const chatHistory = loadChatHistory();

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const effort = options.effort ?? 'high';
  const maxOutputTokens = options.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const maxToolIterations = options.maxToolIterations ?? MAX_TOOL_ITERATIONS;

  // Build the messages array: prior history + current user message (not yet persisted).
  // Both messages are stored AFTER Claude responds successfully to avoid
  // consecutive same-role messages in the DB if the request fails mid-flight.
  const messages: Anthropic.MessageParam[] = sanitizeHistory([
    ...chatHistory.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user' as const, content: userMessage },
  ]);

  // 4. Tool execution loop. Claude may put text alongside its tool calls
  // (e.g. "Let me check your workouts…") and then return none at all once the
  // results come back, so that text is kept only as a fallback for an empty
  // final response — never appended to one that has its own text.
  let iterations = 0;
  let freshRoutines = options.freshRoutines;
  const preToolText: string[] = [];

  while (iterations < maxToolIterations) {
    iterations++;

    throwIfDeadlineExpired(options.deadlineAt);
    assertRequestSize(options.maxRequestBytes, systemPrompt, messages);
    options.onProgress?.('calling_model');
    console.log(`[claude] turn=${options.turnId ?? 'cli'} Calling model=${model} effort=${effort} messages=${messages.length} iteration=${iterations}`);
    const iterationStart = Date.now();
    const remainingMs = options.deadlineAt == null
      ? undefined
      : options.deadlineAt - Date.now();
    if (remainingMs != null && remainingMs <= 0) throw new TurnDeadlineError();
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: maxOutputTokens,
        system: systemPrompt,
        messages,
        tools: TOOLS,
        output_config: { effort },
      }, {
        maxRetries: 0,
        ...(remainingMs == null ? {} : { timeout: remainingMs }),
      });
    } catch (error) {
      if (options.deadlineAt != null && Date.now() >= options.deadlineAt) {
        throw new TurnDeadlineError();
      }
      throw error;
    }

    // Extract text from this iteration
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    const iterationText = textBlocks.map((block) => block.text).join('');

    // cache_w/cache_r are the only way to tell a working cache from a silently
    // missing one. Both can be null in the SDK, hence the `?? 0`.
    console.log(
      `[claude] turn=${options.turnId ?? 'cli'} stop_reason=${response.stop_reason} ` +
        `blocks=${response.content.map((b) => b.type).join(',') || 'none'} ` +
        `in=${response.usage.input_tokens} ` +
        `cache_w=${response.usage.cache_creation_input_tokens ?? 0} ` +
        `cache_r=${response.usage.cache_read_input_tokens ?? 0} ` +
        `out=${response.usage.output_tokens} ` +
        `ms=${Date.now() - iterationStart}`,
    );

    // Check if Claude wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    options.onModelCall?.({
      iteration: iterations,
      elapsedMs: Date.now() - iterationStart,
      inputTokens: response.usage.input_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
      toolCalls: toolUseBlocks.length,
    });

    throwIfDeadlineExpired(options.deadlineAt);

    // max_tokens means the turn was cut off mid-thought — often partway through
    // a tool call, which leaves no text and an unusable partial block. The
    // metrics callback intentionally runs first so evaluators retain the paid
    // call and can reject a truncation deterministically.
    if (response.stop_reason === 'max_tokens') {
      console.error(
        `[claude] Response truncated at the ${maxOutputTokens}-token cap ` +
          `on iteration ${iterations}; discarding the partial turn.`,
      );
      const truncatedNotice =
        "That answer ran long and got cut off before I could finish. " +
        'Ask me again — I\'ll keep it tighter.';
      if (persist) {
        addMessagePair(userMessage, truncatedNotice);
      }
      options.onProgress?.('complete');
      return truncatedNotice;
    }

    if (response.stop_reason !== 'tool_use') {
      // No more tool calls. Use this iteration's text; only when it is empty
      // fall back to whatever Claude said before its tool calls.
      const finalText = iterationText || preToolText.join('\n\n');

      // Falling back means Claude finished without answering and the user gets
      // a stale "let me check…" preamble instead. Say so loudly — this used to
      // be invisible because only the fully-empty case warned.
      if (!iterationText && preToolText.length > 0) {
        console.warn(
          `[claude] Final turn had no text (stop_reason=${response.stop_reason}); ` +
            'replying with the pre-tool preamble instead.',
        );
      } else if (!finalText) {
        console.warn(
          `[claude] No text in any iteration. stop_reason=${response.stop_reason} ` +
            `block_types=${response.content.map((b) => b.type).join(',')}`,
        );
      }

      // Store BOTH messages after success (CRIT-001 fix).
      // Skip both if the assistant response is empty to avoid orphaned
      // user messages that corrupt subsequent history.
      if (persist && finalText) {
        addMessagePair(userMessage, finalText);
      }
      options.onProgress?.('complete');
      return finalText;
    }

    // Claude wants to use tools — keep any preamble text as a fallback and
    // append its response to messages
    if (iterationText) {
      preToolText.push(iterationText);
    }

    messages.push({
      role: 'assistant',
      content: response.content,
    });

    // Execute the tool calls in the order Claude asked, running consecutive
    // read-only tools concurrently — it routinely wants recent workouts and
    // routines in one turn, and serializing those Hevy round-trips costs wall
    // time for nothing.
    //
    // A write acts as a barrier: it waits for the reads queued before it, and
    // the reads after it wait for the write. Relative order has to hold, not
    // just the order results are presented in. Claude asking to push a routine
    // and then list routines means the list must observe the push; running the
    // read early and reordering the results afterwards would quietly report
    // pre-write state as though it came after.
    let readCache = new Map<string, Promise<ToolOutcome>>();
    const runTool = async (
      toolBlock: Anthropic.ToolUseBlock,
    ): Promise<Anthropic.ToolResultBlockParam> => {
      const started = Date.now();
      options.onProgress?.('running_tools');
      const input = toolBlock.input as Record<string, unknown>;
      console.log(`[tool] ${toolBlock.name} input_keys=${Object.keys(input).join(',') || 'none'}`);

      throwIfDeadlineExpired(options.deadlineAt);
      const key = JSON.stringify([toolBlock.name, input]);
      const read = READ_ONLY_TOOLS.has(toolBlock.name);
      if (!read) {
        readCache.clear();
        freshRoutines = undefined;
        if (options.freshContext) systemPrompt = systemPrompt.map(block => ({...block, text:block.text.replace(options.freshContext!, 'Earlier checked context was invalidated by a mutation. Use current tool results or refresh before further planning.')}));
      }
      let task = read ? readCache.get(key) : undefined;
      if (!task) {
        task = toolBlock.name === 'hevy_get_recent_workouts' && options.freshWorkouts
          ? Promise.resolve({result:summarizeWorkouts(options.freshWorkouts.slice(0, Math.max(1, Math.min(typeof input.count === 'number' ? input.count : 5, 10)))),status:'success' as const})
          : toolBlock.name === 'hevy_get_routines' && freshRoutines
            ? Promise.resolve({result:JSON.stringify(freshRoutines),status:'success' as const})
            : executor.executeWithOutcome(toolBlock.name, input);
        if (read) readCache.set(key, task);
      }
      const outcome = await task;
      const result = outcome.result;
      const failed = outcome.status !== 'success';
      if (failed) readCache.delete(key);
      console.log(`[tool] turn=${options.turnId ?? 'cli'} name=${toolBlock.name} status=${outcome.status}`);
      throwIfDeadlineExpired(options.deadlineAt);

      options.onToolCall?.({
        iteration: iterations,
        name: toolBlock.name,
        input,
        result,
        elapsedMs: Date.now() - started,
      });

      console.log(`[tool] ${toolBlock.name} done in ${Date.now() - started}ms`);
      return {
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: result,
      };
    };

    // execute() never throws — it catches internally and returns the error as
    // a conversational string — so Promise.all cannot reject here.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let pendingReads: Anthropic.ToolUseBlock[] = [];

    const flushReads = async (): Promise<void> => {
      if (pendingReads.length === 0) return;
      toolResults.push(...(await Promise.all(pendingReads.map(runTool))));
      pendingReads = [];
      readCache.clear();
    };

    for (const toolBlock of toolUseBlocks) {
      if (READ_ONLY_TOOLS.has(toolBlock.name)) {
        pendingReads.push(toolBlock);
      } else {
        await flushReads();
        toolResults.push(await runTool(toolBlock));
      }
    }
    await flushReads();

    // Append tool results as a user message
    messages.push({
      role: 'user',
      content: toolResults,
    });
  }

  // If we hit the iteration limit, extract whatever text we have from the
  // last response. This is a safety guard — in practice the loop should
  // always terminate via the early return above.
  const fallbackText =
    '[Max tool iterations reached. Please try again or rephrase your request.]';
  if (persist) {
    addMessagePair(userMessage, fallbackText);
  }
  options.onProgress?.('complete');
  return fallbackText;
}
