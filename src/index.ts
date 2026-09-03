import 'dotenv/config';
import { Telegraf } from 'telegraf';

import { chat } from './claude/client.js';
import { sanitizeHtml, sendSplitMessages } from './telegram/client.js';

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
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const AUTHORIZED_CHAT_ID = process.env.AUTHORIZED_CHAT_ID!;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

bot.on('text', async (ctx) => {
  // Only respond to the authorized user
  if (ctx.chat.id.toString() !== AUTHORIZED_CHAT_ID) {
    return;
  }

  // Show initial typing indicator
  await ctx.replyWithChatAction('typing');

  // Keep typing indicator alive while Claude is thinking (expires after ~5s)
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction('typing');
    } catch {
      // Ignore errors from typing indicator refresh
    }
  }, 4000);

  try {
    const response = await chat(ctx.message.text);
    clearInterval(typingInterval);

    const sanitized = sanitizeHtml(response);
    await sendSplitMessages(ctx, sanitized);
  } catch (error) {
    clearInterval(typingInterval);
    console.error('Error processing message:', error);

    try {
      await ctx.reply('Something went wrong. Try again in a moment.');
    } catch {
      // If even the error message fails to send, just log it
      console.error('Failed to send error message to user');
    }
  }
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

bot.launch();
console.log('hevy-coach running (Telegram long-polling)');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
