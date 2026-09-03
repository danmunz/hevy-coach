import { Context } from 'telegraf';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHUNK = 800;
const INTER_CHUNK_DELAY_MS = 400;

/** Tags that Telegram's HTML parse mode supports. */
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);

// ---------------------------------------------------------------------------
// HTML sanitisation
// ---------------------------------------------------------------------------

/**
 * Strip or escape HTML tags that Telegram doesn't support.
 *
 * Telegram's HTML parse mode only allows: <b>, <i>, <u>, <s>, <code>, <pre>,
 * and <a href="...">. Everything else is stripped to avoid send failures.
 */
export function sanitizeHtml(text: string): string {
  return text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag: string) => {
    const lower = tag.toLowerCase();
    if (ALLOWED_TAGS.has(lower)) {
      return match;
    }
    return '';
  });
}

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

/**
 * Split text into chunks that each fit under `MAX_CHUNK` characters.
 *
 * Strategy:
 * 1. Split on double-newlines (paragraph boundaries).
 * 2. Greedily combine paragraphs until the next one would exceed the limit.
 * 3. If a single paragraph exceeds the limit, split it on single newlines.
 * 4. If a single line still exceeds the limit, hard-break at MAX_CHUNK.
 */
function splitIntoChunks(text: string): string[] {
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length === 0) continue;

    // Would adding this paragraph (with separator) exceed the limit?
    const combined = current ? `${current}\n\n${para}` : para;

    if (combined.length <= MAX_CHUNK) {
      current = combined;
      continue;
    }

    // Flush whatever we have accumulated so far
    if (current) {
      chunks.push(current);
      current = '';
    }

    // If the paragraph itself fits, start a new accumulator with it
    if (para.length <= MAX_CHUNK) {
      current = para;
      continue;
    }

    // Paragraph too long — split on single newlines
    const lines = para.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;

      const combinedLine = current ? `${current}\n${line}` : line;

      if (combinedLine.length <= MAX_CHUNK) {
        current = combinedLine;
        continue;
      }

      if (current) {
        chunks.push(current);
        current = '';
      }

      // Single line still too long — hard-break
      if (line.length > MAX_CHUNK) {
        let remaining = line;
        while (remaining.length > MAX_CHUNK) {
          chunks.push(remaining.slice(0, MAX_CHUNK));
          remaining = remaining.slice(MAX_CHUNK);
        }
        if (remaining) {
          current = remaining;
        }
      } else {
        current = line;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a (possibly long) text response to the user, splitting into multiple
 * messages for readability on mobile. Each chunk is sent with HTML parse mode
 * and a short delay between messages for natural pacing.
 */
export async function sendSplitMessages(ctx: Context, text: string): Promise<void> {
  if (text.length <= MAX_CHUNK) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  const chunks = splitIntoChunks(text);

  for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(chunks[i], { parse_mode: 'HTML' });

    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
    }
  }
}
