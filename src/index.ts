import 'dotenv/config';
import { Telegraf } from 'telegraf';

import { chat } from './claude/client.js';
import { TurnDeadlineError, TurnExpiredError, TurnQueue } from './claude/turn-queue.js';
import { sanitizeHtml, sendSplitMessages } from './telegram/client.js';

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'ANTHROPIC_API_KEY',
  'HEVY_API_KEY',
  'AUTHORIZED_CHAT_ID',
] as const;

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`[fatal] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const AUTHORIZED_CHAT_ID = process.env.AUTHORIZED_CHAT_ID!;
const turnQueue = new TurnQueue();

// ---------------------------------------------------------------------------
// Bot-level error handler
// ---------------------------------------------------------------------------

bot.catch((err, ctx) => {
  console.error(`[telegram] Error for ${ctx.updateType}:`, err);
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

bot.on('text', async (ctx) => {
  // Only respond to the authorized user
  if (ctx.chat.id.toString() !== AUTHORIZED_CHAT_ID) {
    return;
  }

  // Receipt and progress indicators are best effort. A Telegram status error
  // must never prevent the queued coaching turn from running.
  await ctx.replyWithChatAction('typing').catch(() => undefined);
  await ctx.react('👀').catch(() => undefined);

  // Keep typing indicator alive while Claude is thinking (expires after ~5s)
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction('typing');
    } catch {
      // Ignore errors from typing indicator refresh
    }
  }, 4000);

  try {
    const response = await turnQueue.run(async (turn) => {
      console.log(`[turn] queue_ms=${turn.queueWaitMs} budget_ms=${turn.deadlineAt - turn.startedAt}`);
      return chat(ctx.message.text, {
        deadlineAt: turn.deadlineAt,
        onProgress: (stage) => {
          console.log(`[turn] stage=${stage}`);
          const reaction = stage === 'running_tools' ? '⚡' : stage === 'calling_model' ? '✍' : undefined;
          if (reaction) void ctx.react(reaction).catch(() => undefined);
        },
      });
    });
    clearInterval(typingInterval);

    const sanitized = sanitizeHtml(response);
    if (!sanitized.trim()) {
      console.warn('[telegram] Claude returned empty response, sending fallback');
      await ctx.reply("I couldn't generate a response. Try again in a moment.");
    } else {
      await sendSplitMessages(ctx, sanitized);
    }
    await ctx.react().catch(() => undefined);
  } catch (error) {
    clearInterval(typingInterval);
    console.error('[telegram] Error processing message:', error);

    try {
      await ctx.reply(
        error instanceof TurnExpiredError || error instanceof TurnDeadlineError
          ? error.message
          : 'Something went wrong. Try again in a moment.',
      );
    } catch {
      // If even the error message fails to send, just log it
      console.error('[telegram] Failed to send error message to user');
    }
  }
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

bot.launch().then(() => {
  const botInfo = bot.botInfo;
  console.log(`[telegram] hevy-coach running as @${botInfo?.username ?? 'unknown'} (long-polling)`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
