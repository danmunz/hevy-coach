import type { ExerciseLookup, HevyTemplateMatch } from "./types.js";
import { normalizeText, queryVariants } from "./utils.js";

// ---------------------------------------------------------------------------
// Pinned exercise name -> Hevy template mappings
// ---------------------------------------------------------------------------

/**
 * Hardcoded mappings from common exercise display names to Hevy template
 * search queries and optional muscle-group filters.
 *
 * These pins ensure that frequently-used exercise names resolve to the correct
 * Hevy template without relying on fuzzy search every time.
 */
export const EXERCISE_PINS: Record<string, ExerciseLookup> = {
  // -- Barbell compounds --
  "Squat":                          { query: "Squat (Barbell)", primaryMuscleGroup: "quadriceps" },
  "Deadlift":                       { query: "Deadlift (Barbell)" },
  "Bench Press":                    { query: "Bench Press (Barbell)", primaryMuscleGroup: "chest" },
  "Overhead Press":                 { query: "Overhead Press (Barbell)", primaryMuscleGroup: "shoulders" },
  "Front Squat":                    { query: "Front Squat", primaryMuscleGroup: "quadriceps" },

  // -- Cable exercises --
  "Face Pull":                      { query: "Face Pull" },
  "Lat Pulldown":                   { query: "Lat Pulldown (Cable)", primaryMuscleGroup: "lats" },
  "Tricep Pushdown":                { query: "Triceps Pushdown" },
  "Triceps Rope Pushdown":          { query: "Triceps Rope Pushdown", primaryMuscleGroup: "triceps" },
  "Cable Crunch":                   { query: "Cable Crunch", primaryMuscleGroup: "abdominals" },
  "Seated Row":                     { query: "Seated Row", primaryMuscleGroup: "upper_back" },

  // -- Dumbbell exercises --
  "Lateral Raise":                  { query: "Dumbbell Lateral Raise", primaryMuscleGroup: "shoulders" },
  "Incline Bench Press (Dumbbell)": { query: "Incline Dumbbell Bench Press", primaryMuscleGroup: "chest" },
  "Triceps Extension (Dumbbell)":   { query: "Dumbbell Triceps Extension", primaryMuscleGroup: "triceps" },

  // -- Bodyweight / minimal equipment --
  "Dips":                           { query: "Dips" },
  "Pull Up":                        { query: "Pull Up" },
  "Hanging Knee Raise":             { query: "Hanging Knee Raise" },
  "Lunge":                          { query: "Lunge" },
};

/** Punctuation aliases retain every equipment word. */
function exerciseKey(name: string): string {
  return normalizeText(name).replace(/[-_()]/g, " ").replace(/\s+/g, " ").trim();
}

/** Only exact titles or unique word-order equivalents identify a template. */
function safeMatch(candidates: HevyTemplateMatch[], ...names: string[]): HevyTemplateMatch | undefined {
  for (const name of names) {
    const key = exerciseKey(name);
    const exact = candidates.filter((candidate) => exerciseKey(candidate.title) === key);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
    const words = key.split(" ").sort().join(" ");
    const equivalent = candidates.filter((candidate) =>
      exerciseKey(candidate.title).split(" ").sort().join(" ") === words);
    if (equivalent.length === 1) return equivalent[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bulk resolution
// ---------------------------------------------------------------------------

/**
 * Resolves every entry in {@link EXERCISE_PINS} to a Hevy template ID.
 *
 * For each pin the function tries progressively looser search queries
 * (via {@link queryVariants}) until a match is found. Pins that fail to
 * resolve are logged as warnings but do not cause the function to throw.
 *
 * @param searchFn - A function that searches the Hevy exercise library and
 *   returns matching templates for a given query string.
 * @returns A map from display name to template ID for every pin that resolved.
 */
export async function resolveExerciseMap(
  searchFn: (query: string) => Promise<HevyTemplateMatch[]>,
): Promise<Map<string, string>> {
  const exerciseMap = new Map<string, string>();

  for (const [displayName, lookup] of Object.entries(EXERCISE_PINS)) {
    const variants = queryVariants(displayName, lookup.query);
    let matched: HevyTemplateMatch | undefined;
    const candidateTitles = new Set<string>();

    for (const variant of variants) {
      const candidates = await searchFn(variant);
      for (const candidate of candidates) candidateTitles.add(candidate.title);

      // Filter by muscle group when specified in the pin.
      const filtered = lookup.primaryMuscleGroup
        ? candidates.filter(
            (c) =>
              c.primaryMuscleGroup &&
              normalizeText(c.primaryMuscleGroup) ===
                normalizeText(lookup.primaryMuscleGroup!),
          )
        : candidates;

      // A missing muscle match must not select an unrelated exercise.
      const pool = lookup.primaryMuscleGroup ? filtered : candidates;

      matched = safeMatch(pool, lookup.query ?? displayName);
      if (matched) break;
    }

    if (matched) {
      exerciseMap.set(displayName, matched.id);
    } else {
      console.warn(
        `[exercise-pins] Failed to resolve pin "${displayName}" ` +
          `(query: "${lookup.query ?? displayName}"). Use a specific exercise name. ` +
          `Candidates: ${[...candidateTitles].join(", ") || "none"}`,
      );
    }
  }

  return exerciseMap;
}

// ---------------------------------------------------------------------------
// Single-name runtime resolution
// ---------------------------------------------------------------------------

/**
 * Resolves an exercise name to a Hevy template ID at runtime.
 *
 * Resolution order:
 * 1. Case-insensitive exact match against the pre-resolved {@link exerciseMap}.
 * 2. Unique exact or word-order matching via {@link searchFn} using progressively looser query
 *    variants.
 *
 * When runtime search is used, a warning is logged so that the
 * pin list can be extended to avoid the runtime search in future runs.
 *
 * @param name        - The exercise name as provided by the caller (e.g. Claude).
 * @param exerciseMap - A pre-resolved map from {@link resolveExerciseMap}.
 * @param searchFn    - A function that searches the Hevy exercise library.
 * @returns The template ID, or `null` if nothing resolves.
 */
export async function resolveExerciseName(
  name: string,
  exerciseMap: Map<string, string>,
  searchFn: (query: string) => Promise<HevyTemplateMatch[]>,
): Promise<string | null> {
  // 1. Case-insensitive lookup against the pre-resolved map.
  const normalizedName = exerciseKey(name);

  const mappedIds = new Set([...exerciseMap]
    .filter(([key]) => exerciseKey(key) === normalizedName)
    .map(([, templateId]) => templateId));
  if (mappedIds.size === 1) return [...mappedIds][0];
  if (mappedIds.size > 1) return null;

  // 2. Search more broadly, but retain the complete requested identity.
  const variants = queryVariants(name);

  for (const variant of variants) {
    const candidates = await searchFn(variant);
    const matched = safeMatch(candidates, name);

    if (matched) {
      console.warn(
        `[exercise-pins] "${name}" resolved via runtime search to ` +
          `"${matched.title}" (${matched.id}). Consider adding a pin.`,
      );
      return matched.id;
    }
  }

  console.warn(
    `[exercise-pins] "${name}" could not be resolved to any Hevy template.`,
  );
  return null;
}
