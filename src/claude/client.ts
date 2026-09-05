import Anthropic from '@anthropic-ai/sdk';

import { assembleSystemPrompt, loadChatHistory } from './context.js';
import { TOOLS } from './tools.js';
import { ToolExecutor } from './tool-executor.js';
import { HevyClient } from '../hevy/client.js';
import { addMessage } from '../state/chatlog.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 10;

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
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });

    // Extract text from this iteration
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    const iterationText = textBlocks.map((block) => block.text).join('');

    // Check if Claude wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (response.stop_reason !== 'tool_use') {
      // No more tool calls. Use this iteration's text; only when it is empty
      // fall back to whatever Claude said before its tool calls.
      const finalText = iterationText || preToolText.join('\n\n');

      if (!finalText) {
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

    // Execute each tool call and build tool_result blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolBlock of toolUseBlocks) {
      console.log(`[tool] ${toolBlock.name}(${JSON.stringify(toolBlock.input)})`);

      const result = await toolExecutor.execute(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>,
      );

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: result,
      });
    }

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
