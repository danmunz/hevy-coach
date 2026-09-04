import type { ExerciseLookup, HevyTemplateMatch } from "./types.js";
import { bestTemplateMatch, normalizeText, queryVariants } from "./utils.js";

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
  "Front Squat":                    { query: "Front Squat (Barbell)", primaryMuscleGroup: "quadriceps" },

  // -- Cable exercises --
  "Face Pull":                      { query: "Face Pull (Cable)" },
  "Lat Pulldown":                   { query: "Lat Pulldown (Cable)", primaryMuscleGroup: "lats" },
  "Tricep Pushdown":                { query: "Triceps Pushdown" },
  "Triceps Rope Pushdown":          { query: "Rope Pushdown", primaryMuscleGroup: "triceps" },
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

    for (const variant of variants) {
      const candidates = await searchFn(variant);

      // Filter by muscle group when specified in the pin.
      const filtered = lookup.primaryMuscleGroup
        ? candidates.filter(
            (c) =>
              c.primaryMuscleGroup &&
              normalizeText(c.primaryMuscleGroup) ===
                normalizeText(lookup.primaryMuscleGroup!),
          )
        : candidates;

      // Fall back to unfiltered candidates when the muscle-group filter
      // eliminates everything.
      const pool = filtered.length > 0 ? filtered : candidates;

      matched = bestTemplateMatch(pool, variant, displayName);
      if (matched) break;
    }

    if (matched) {
      exerciseMap.set(displayName, matched.id);
    } else {
      console.warn(
        `[exercise-pins] Failed to resolve pin "${displayName}" ` +
          `(query: "${lookup.query ?? displayName}")`,
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
 * 2. Fuzzy search via {@link searchFn} using progressively looser query
 *    variants.
 *
 * When the fuzzy-search fallback is used, a warning is logged so that the
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
  const normalizedName = normalizeText(name);

  for (const [key, templateId] of exerciseMap) {
    if (normalizeText(key) === normalizedName) {
      return templateId;
    }
  }

  // 2. Fuzzy search fallback.
  const variants = queryVariants(name);

  for (const variant of variants) {
    const candidates = await searchFn(variant);
    const matched = bestTemplateMatch(candidates, variant, name);

    if (matched) {
      console.warn(
        `[exercise-pins] "${name}" resolved via fuzzy search to ` +
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
