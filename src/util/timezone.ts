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
