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
// Chat
// ---------------------------------------------------------------------------

/**
 * Send a user message through the full Claude request lifecycle:
 *
 * 1. Store the user message in SQLite
 * 2. Assemble system prompt + chat history
 * 3. Call Claude with tools
 * 4. Execute the tool loop until Claude produces a final text response
 * 5. Store and return the assistant's response
 */
export async function chat(userMessage: string): Promise<string> {
  // 1. Store the user message
  addMessage('user', userMessage);

  // 2. Assemble context
  const systemPrompt = assembleSystemPrompt();
  const chatHistory = loadChatHistory();

  // 3. Create clients
  const anthropic = new Anthropic();
  const hevyClient = new HevyClient();
  const toolExecutor = new ToolExecutor(hevyClient);

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

  // Build the messages array that grows with each tool-loop iteration.
  // Start from the chat history (which already includes the user message
  // we just stored).
  const messages: Anthropic.MessageParam[] = chatHistory.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 4. Tool execution loop
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });

    // Check if Claude wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // No tool calls — extract text and finish
      const finalText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      // 6. Store the assistant response
      addMessage('assistant', finalText);

      // 7. Return the final text
      return finalText;
    }

    // Claude wants to use tools — append its response to messages
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
  addMessage('assistant', fallbackText);
  return fallbackText;
}
