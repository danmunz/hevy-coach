import Anthropic from '@anthropic-ai/sdk';

import { assembleSystemPrompt, loadChatHistory } from './context.js';
import { TOOLS } from './tools.js';
import { READ_ONLY_TOOLS, ToolExecutor } from './tool-executor.js';
import { HevyClient } from '../hevy/client.js';
import { addMessage } from '../state/chatlog.js';

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
export async function chat(userMessage: string): Promise<string> {
  // 1. Assemble context (before storing the user message — CRIT-001 fix)
  const systemPrompt = assembleSystemPrompt();
  const chatHistory = loadChatHistory();

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

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
  const preToolText: string[] = [];

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    console.log(`[claude] Calling model=${model} messages=${messages.length} iteration=${iterations}`);
    const iterationStart = Date.now();
    const response = await anthropic.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });

    // Extract text from this iteration
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    const iterationText = textBlocks.map((block) => block.text).join('');

    // cache_w/cache_r are the only way to tell a working cache from a silently
    // missing one. Both are number|null in SDK 0.39.0, hence the `?? 0`.
    console.log(
      `[claude] stop_reason=${response.stop_reason} ` +
        `blocks=${response.content.map((b) => b.type).join(',') || 'none'} ` +
        `in=${response.usage.input_tokens} ` +
        `cache_w=${response.usage.cache_creation_input_tokens ?? 0} ` +
        `cache_r=${response.usage.cache_read_input_tokens ?? 0} ` +
        `out=${response.usage.output_tokens} ` +
        `ms=${Date.now() - iterationStart}`,
    );

    // max_tokens means the turn was cut off mid-thought — often partway through
    // a tool call, which leaves no text and an unusable partial block. Treating
    // it as a normal finish silently swallows the truncation.
    if (response.stop_reason === 'max_tokens') {
      console.error(
        `[claude] Response truncated at the ${MAX_OUTPUT_TOKENS}-token cap ` +
          `on iteration ${iterations}; discarding the partial turn.`,
      );
      const truncatedNotice =
        "That answer ran long and got cut off before I could finish. " +
        'Ask me again — I\'ll keep it tighter.';
      addMessage('user', userMessage);
      addMessage('assistant', truncatedNotice);
      return truncatedNotice;
    }

    // Check if Claude wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

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
      if (finalText) {
        addMessage('user', userMessage);
        addMessage('assistant', finalText);
      }

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
    const runTool = async (
      toolBlock: Anthropic.ToolUseBlock,
    ): Promise<Anthropic.ToolResultBlockParam> => {
      const started = Date.now();
      console.log(`[tool] ${toolBlock.name}(${JSON.stringify(toolBlock.input)})`);

      const result = await toolExecutor.execute(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>,
      );

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
  addMessage('user', userMessage);
  addMessage('assistant', fallbackText);
  return fallbackText;
}
