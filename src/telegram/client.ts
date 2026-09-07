import { Context } from 'telegraf';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHUNK = 2000;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

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
  // Step 1: Strip unsupported HTML tags (keep allowed ones)
  let result = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag: string) => {
    const lower = tag.toLowerCase();
    if (ALLOWED_TAGS.has(lower)) {
      return match;
    }
    return '';
  });

  // Step 2: Temporarily replace allowed tags with placeholders
  const placeholders: string[] = [];
  result = result.replace(/<\/?(?:b|i|u|s|code|pre|a)\b[^>]*>/gi, (match) => {
    placeholders.push(match);
    return `\x00${placeholders.length - 1}\x00`;
  });

  // Step 3: Escape bare special characters that Telegram requires entity-encoded
  result = result
    .replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Step 4: Restore allowed tags from placeholders
  result = result.replace(/\x00(\d+)\x00/g, (_, idx) => placeholders[Number(idx)]);

  return result;
}

/** Decode only Telegram HTML entities. Strip tags before decoding literal angle brackets. */
export function htmlToPlainText(text: string): string {
  return text.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '').replace(/&(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const value = entity.slice(2, -1);
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '\uFFFD';
  });
}

/** Split visible text at paragraph boundaries, then line/word boundaries, with balanced tags. */
export function splitIntoChunks(text: string): string[] {
  const tokens = text.match(/<(?:[^>"']|"[^"]*"|'[^']*')*>|&(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);|[^<&]+|[<&]/gi) ?? [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const units = tokens.flatMap(token => token.startsWith('<') || token.startsWith('&')
    ? [token] : Array.from(segmenter.segment(token), item => item.segment).flatMap(segment => segment.length > MAX_CHUNK ? Array.from(segment) : [segment]));
  const chunks: string[] = [];
  const stack: Array<{ name: string; open: string }> = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let visible = 0;
    let paragraph = 0;
    let line = 0;
    let word = 0;
    while (end < units.length) {
      const unit = units[end];
      const size = unit.startsWith('<') ? 0 : unit.startsWith('&') ? htmlToPlainText(unit).length : unit.length;
      if (visible + size > MAX_CHUNK && end > start) break;
      visible += size;
      end++;
      if (visible >= MAX_CHUNK / 2) {
        if (unit === '\n' && units[end - 2] === '\n') paragraph = end;
        else if (unit === '\n') line = end;
        else if (/^\s+$/.test(unit)) word = end;
      }
    }
    if (end < units.length) end = paragraph || line || word || end;
    let chunk = stack.map(tag => tag.open).join('');
    for (const unit of units.slice(start, end)) {
      const tag = unit.match(/^<(\/)?([a-z]+)\b[\s\S]*>$/i);
      if (!tag) { chunk += unit; continue; }
      const name = tag[2].toLowerCase();
      if (!ALLOWED_TAGS.has(name)) continue;
      if (!tag[1]) {
        stack.push({ name, open: unit });
        chunk += unit;
      } else {
        const index = stack.map(item => item.name).lastIndexOf(name);
        if (index >= 0) {
          while (stack.length > index) chunk += `</${stack.pop()!.name}>`;
        }
      }
    }
    chunk += [...stack].reverse().map(tag => `</${tag.name}>`).join('');
    if (htmlToPlainText(chunk).length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

export interface DeliveryProgress {
  deliveredChunks: number;
  totalChunks: number;
  elapsedMs: number;
  status: 'sent' | 'failed';
}

export class DeliveryError extends Error {
  constructor(public readonly deliveredChunks: number, public readonly totalChunks: number, cause: unknown) {
    super(`Telegram delivery failed after ${deliveredChunks}/${totalChunks} confirmed chunks`, { cause });
    this.name = 'DeliveryError';
  }
}

function telegramFailure(error: unknown): { error_code?: number; description?: string; parameters?: { retry_after?: number } } {
  if (typeof error !== 'object' || error === null || !('response' in error)) return {};
  const response = error.response;
  return typeof response === 'object' && response !== null ? response : {};
}

/** Send ordered chunks. Retry only explicit Telegram rejections that confirm no delivery. */
export async function sendSplitMessages(
  ctx: Pick<Context, 'reply'>,
  text: string,
  onProgress?: (progress: DeliveryProgress) => void,
): Promise<void> {
  if (!text.trim()) return;
  const chunks = splitIntoChunks(text);
  const startedAt = Date.now();
  let deliveredChunks = 0;
  const report = (status: DeliveryProgress['status']): void => {
    try {
      onProgress?.({ deliveredChunks, totalChunks: chunks.length, elapsedMs: Date.now() - startedAt, status });
    } catch (error) {
      console.warn('[telegram] Delivery observer failed:', error instanceof Error ? error.message : String(error));
    }
  };
  for (const chunk of chunks) {
    let plain = false;
    let rateLimitRetried = false;
    try {
      for (;;) {
        try {
          await ctx.reply(plain ? htmlToPlainText(chunk) : chunk, plain ? undefined : { parse_mode: 'HTML' });
          break;
        } catch (error) {
          const failure = telegramFailure(error);
          if (!plain && failure.error_code === 400 && /can't parse entities|can't find end tag|unsupported start tag/i.test(failure.description ?? '')) {
            plain = true;
            continue;
          }
          const delay = failure.parameters?.retry_after;
          if (!rateLimitRetried && failure.error_code === 429 && typeof delay === 'number'
            && Number.isFinite(delay) && delay >= 0 && delay * 1000 <= MAX_RATE_LIMIT_WAIT_MS) {
            rateLimitRetried = true;
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      console.warn(`[telegram] delivery_failed confirmed_chunks=${deliveredChunks} total_chunks=${chunks.length}`);
      report('failed');
      throw new DeliveryError(deliveredChunks, chunks.length, error);
    }
    deliveredChunks++;
    report('sent');
  }
}
