/**
 * Resolves the configured TIMEZONE once at startup. An invalid IANA zone
 * would otherwise make every `toLocaleString` call throw (system prompt) or
 * silently degrade to "Unknown date" (workout summaries), so it is validated
 * here and falls back to UTC for all consumers alike.
 */
function resolve(): string {
  const configured = process.env.TIMEZONE || 'America/New_York';
  try {
    new Date().toLocaleString('en-US', { timeZone: configured });
    return configured;
  } catch {
    console.warn(`[config] Invalid TIMEZONE "${configured}", falling back to UTC`);
    return 'UTC';
  }
}

export const TIMEZONE = resolve();

/**
 * Parses a SQLite `CURRENT_TIMESTAMP` value ("YYYY-MM-DD HH:MM:SS", always
 * UTC but carrying no zone marker). `new Date()` would read that shape as
 * local time and shift it by the machine's offset, so the marker is added
 * explicitly before parsing.
 */
export function parseSqliteTimestamp(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/** Formats a stored UTC timestamp as a short local date, e.g. "Sep 5". */
export function formatStoredDate(value: string): string {
  return parseSqliteTimestamp(value).toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric',
  });
}

/** Formats a stored UTC timestamp as a local weekday + time, e.g. "Fri 10:33 PM". */
export function formatStoredTime(value: string): string {
  return parseSqliteTimestamp(value).toLocaleString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
