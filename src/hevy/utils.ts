import type { HevyTemplateMatch } from "./types.js";

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/** Returns the number of decimal places in a numeric value. */
function decimalPlaces(value: number): number {
  const valueText = value.toString();
  const decimalPart = valueText.split(".")[1];
  return decimalPart?.length ?? 0;
}

/**
 * Converts pounds to kilograms, rounding to the nearest `incrementKg`.
 *
 * The default increment of 0.001 kg preserves enough precision for Hevy to
 * display the original pound value in its UI.
 */
export function poundsToRoundedKilograms(weightLb: number, incrementKg = 0.001): number {
  const exactKg = weightLb * 0.45359237;

  if (incrementKg <= 0) {
    return exactKg;
  }

  const roundedKg = Math.round(exactKg / incrementKg) * incrementKg;
  return Number(roundedKg.toFixed(decimalPlaces(incrementKg)));
}

/**
 * Converts kilograms back to the nearest whole pound.
 *
 * Useful for reading weights from Hevy (which stores in kg) and presenting
 * them in pounds.
 */
export function kilogramsToPounds(weightKg: number): number {
  return Math.round(weightKg / 0.45359237);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lowercases and trims a string for case-insensitive comparison. */
export function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Exercise template matching
// ---------------------------------------------------------------------------

/**
 * Picks the best exercise template from a list of candidates.
 *
 * Matching priority:
 * 1. Exact match on the local exercise name
 * 2. Exact match on the search query
 * 3. Substring match on the local name
 * 4. Substring match on the query
 * 5. First candidate (fallback)
 */
export function bestTemplateMatch(
  candidates: HevyTemplateMatch[],
  query: string,
  localName: string,
): HevyTemplateMatch | undefined {
  const normalizedLocal = normalizeText(localName);
  const normalizedQuery = normalizeText(query);

  return (
    candidates.find((c) => normalizeText(c.title) === normalizedLocal) ??
    candidates.find((c) => normalizeText(c.title) === normalizedQuery) ??
    candidates.find((c) => normalizeText(c.title).includes(normalizedLocal)) ??
    candidates.find((c) => normalizeText(c.title).includes(normalizedQuery)) ??
    candidates[0]
  );
}

/**
 * Generates progressively simplified search queries for an exercise name.
 *
 * Returns an ordered list starting with the most specific variant:
 * 1. `preferredQuery` (if provided)
 * 2. The original `localName`
 * 3. The name with parenthetical qualifiers removed (e.g. "(Barbell)")
 * 4. Further simplified by removing common equipment words
 */
export function queryVariants(localName: string, preferredQuery?: string): string[] {
  const variants = new Set<string>();

  if (preferredQuery) {
    variants.add(preferredQuery);
  }

  variants.add(localName);

  const withoutParenthetical = localName.replace(/\s*\([^)]*\)/g, "").trim();
  if (withoutParenthetical) {
    variants.add(withoutParenthetical);
  }

  const simplified = withoutParenthetical
    .replace(/\bMachine\b|\bCable\b|\bDumbbell\b|\bBarbell\b|\bAssisted\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (simplified) {
    variants.add(simplified);
  }

  return [...variants].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/** Returns a promise that resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
