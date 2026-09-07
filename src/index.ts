import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HevyClient } from './hevy/client.js';
import { WorkoutSync, startWorkoutPolling } from './coach/workout-sync.js';
import { prepareFreshContext } from './coach/fresh-context.js';
import { Telegraf } from 'telegraf';

import { chat } from './claude/client.js';
import { TurnQueue } from './claude/turn-queue.js';
import { safeErrorFields, sendSplitMessages } from './telegram/client.js';

import { handleMessageTurn } from './telegram/handler.js';

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', safeErrorFields(reason));
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', safeErrorFields(err));
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
// Each synchronization scan has a bounded HTTP deadline, including background scans.
const sync = new WorkoutSync({
  getRecentWorkoutRecords: count => new HevyClient(undefined, Date.now() + 15_000, event => console.log(`[http] owner=sync ${JSON.stringify(event)}`)).getRecentWorkoutRecords(count),
  getWorkoutEvents: since => new HevyClient(undefined, Date.now() + 15_000, event => console.log(`[http] owner=sync ${JSON.stringify(event)}`)).getWorkoutEvents(since),
});
const stopPolling = startWorkoutPolling(sync, Number(process.env.HEVY_SYNC_INTERVAL_SECONDS ?? 300));
let revision = 'unknown';
try { revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding:'utf8'}).trim(); }
catch { console.warn('[startup] Revision unavailable.'); }
console.log(`[startup] revision=${revision}`);

// ---------------------------------------------------------------------------
// Bot-level error handler
// ---------------------------------------------------------------------------

bot.catch((err, ctx) => {
  console.error(`[telegram] Error for ${ctx.updateType}:`, safeErrorFields(err));
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
  const receivedAt = Date.now();
  const turnId = randomUUID();
  console.log(`[turn] id=${turnId} event=received`);
  void ctx.replyWithChatAction('typing').catch(() => undefined);
  void ctx.react('👀').catch(() => undefined);

  // Keep typing indicator alive while Claude is thinking (expires after ~5s)
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction('typing');
    } catch {
      // Ignore errors from typing indicator refresh
    }
  }, 4000);

  try {
    await handleMessageTurn({
      queue: turnQueue,
      receivedAt,
      deliver: (text, deadlineAt) => sendSplitMessages(ctx, text, event => console.log(`[delivery] id=${turnId} ${JSON.stringify(event)}`), { deadlineAt }),
      logFailure: fields => console.error(`[turn] id=${turnId} status=failed total_ms=${Date.now()-receivedAt}`, fields),
      coach: async (turn) => {
        console.log(`[turn] id=${turnId} queue_ms=${turn.queueWaitMs} budget_ms=${turn.deadlineAt - turn.startedAt}`);
        const contextStarted = Date.now();
        const context = await prepareFreshContext(sync, new HevyClient(undefined, turn.deadlineAt, event => console.log(`[http] turn=${turnId} ${JSON.stringify(event)}`)), turn.deadlineAt);
        console.log(`[turn] id=${turnId} context_ms=${Date.now()-contextStarted}`);
        return chat(ctx.message.text, {
          deadlineAt: turn.deadlineAt,
          turnId,
          freshContext: context.text,
          freshWorkouts: context.workouts,
          freshRoutines: context.routines,
          onProgress: (stage) => {
            console.log(`[turn] id=${turnId} stage=${stage}`);
            const reaction = stage === 'running_tools' ? '⚡' : stage === 'calling_model' ? '✍' : undefined;
            if (reaction) void ctx.react(reaction).catch(() => undefined);
          },
        });
      },
    });
    console.log(`[turn] id=${turnId} event=finished total_ms=${Date.now()-receivedAt}`);
  } finally {
    clearInterval(typingInterval);
    void ctx.react().catch(() => undefined);
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
process.once('SIGINT', () => { stopPolling(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopPolling(); bot.stop('SIGTERM'); });
