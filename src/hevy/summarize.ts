import type {
  HevyCompletedWorkout,
  HevyCompletedWorkoutExercise,
  HevyCompletedWorkoutSet,
  HevyExerciseHistoryEntry,
} from "./types.js";
import { kilogramsToPounds } from "./utils.js";
import { TIMEZONE } from "../util/timezone.js";

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/** Formats an ISO timestamp as a short weekday + date string (e.g. "Tue Sep 2"). */
function formatDate(iso: string | undefined): string {
  if (!iso) return "Unknown date";
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "Unknown date";
  }
}

// ---------------------------------------------------------------------------
// Top-set extraction
// ---------------------------------------------------------------------------

/**
 * Finds the "top set" for an exercise — the set with the heaviest weight.
 * Returns a compact string like "205x5" (weight in lbs x reps).
 * For bodyweight or zero-weight exercises, shows just reps.
 */
function setSummary(set: HevyCompletedWorkoutSet | HevyExerciseHistoryEntry): string {
  const weightKg = set.weightKg ?? 0;
  const reps = set.reps ?? 0;
  const core = weightKg > 0
    ? `${kilogramsToPounds(weightKg)}x${reps}`
    : set.durationSeconds && set.durationSeconds > 0
      ? `${set.durationSeconds}s`
      : set.distanceMeters && set.distanceMeters > 0
        ? `${Math.round(set.distanceMeters)}m`
        : `BWx${reps}`;
  const rpe = set.rpe == null ? "" : `@${set.rpe}`;
  const setType =
    (set as HevyExerciseHistoryEntry).setType ??
    (set as HevyCompletedWorkoutSet).type;
  return `${setType && setType !== "normal" ? `${setType} ` : ""}${core}${rpe}`;
}

/** Compactly preserves every performed set, grouping only adjacent equals. */
function setGroups(sets: Array<HevyCompletedWorkoutSet | HevyExerciseHistoryEntry>): string {
  if (sets.length === 0) return "no sets";
  const groups: Array<{ summary: string; count: number }> = [];
  for (const set of sets) {
    const summary = setSummary(set);
    const previous = groups.at(-1);
    if (previous?.summary === summary) previous.count++;
    else groups.push({ summary, count: 1 });
  }
  return groups.map((group) => group.count > 1 ? `${group.count}x${group.summary}` : group.summary).join(", ");
}

// ---------------------------------------------------------------------------
// Public summarization functions
// ---------------------------------------------------------------------------

/**
 * Produces a compact text summary of recent workouts.
 *
 * Each workout is one line showing date, title, and all performed set groups
 * per exercise. It intentionally retains volume and non-normal set types.
 *
 * Example output:
 * ```
 * Recent workouts:
 * - Tue Sep 2: Squat Day -- Squat: 205x5, Front Squat: 135x10, Cable Row: 70x12
 * - Mon Sep 1: Bench Day -- Bench: 155x7, OHP: 65x10, Face Pull: 30x15
 * ```
 */
export function summarizeWorkouts(workouts: HevyCompletedWorkout[]): string {
  if (workouts.length === 0) {
    return "No recent workouts found.";
  }

  const lines = workouts.map((workout) => {
    const date = formatDate(workout.startTime);
    const title = workout.title || "Untitled";

    const exerciseSummaries = workout.exercises.map(
      (ex) => `${ex.title}${ex.exerciseTemplateId ? ` [${ex.exerciseTemplateId}]` : ""}: ${setGroups(ex.sets)}${ex.notes ? ` (notes: ${ex.notes})` : ""}`,
    );

    const exerciseText =
      exerciseSummaries.length > 0
        ? exerciseSummaries.join(", ")
        : "no exercises";

    return `- ${date}: ${title} -- ${exerciseText}${workout.description ? ` (notes: ${workout.description})` : ""}`;
  });

  return `Recent workouts:\n${lines.join("\n")}`;
}

/**
 * Summarizes performance history for a single exercise across multiple workouts.
 *
 * Shows progression over time — each session's top set for the named exercise.
 *
 * Example output:
 * ```
 * Squat history (last 5 sessions):
 * - Tue Sep 2: 205x5
 * - Fri Aug 29: 200x5
 * - Tue Aug 26: 195x5
 * ```
 */
export function summarizeExerciseHistory(
  entries: HevyExerciseHistoryEntry[],
  exerciseName: string,
  coverage: { startDate: string; endDate: string },
): string {
  const workouts = new Map<string, { date?: string; sets: HevyExerciseHistoryEntry[] }>();
  for (const entry of entries) {
    const key = `${entry.workoutId}:${entry.exerciseTemplateId}`;
    const workout = workouts.get(key) ?? { date: entry.workoutStartTime, sets: [] };
    workout.sets.push(entry);
    workouts.set(key, workout);
  }
  if (workouts.size === 0) {
    return `No history found for "${exerciseName}" from ${coverage.startDate} through ${coverage.endDate}.`;
  }
  const lines = [...workouts.values()]
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .map((workout) => `- ${formatDate(workout.date)}: ${setGroups(workout.sets)}`);
  const dates = entries.map((entry) => entry.workoutStartTime).filter((date): date is string => date != null).sort();
  const returnedCoverage = dates.length > 0
    ? `Returned dates: ${dates[0]} through ${dates.at(-1)}.`
    : "Returned dates unavailable.";
  return `${exerciseName} history (${coverage.startDate} through ${coverage.endDate}; ${workouts.size} sessions):\n${returnedCoverage}\n${lines.join("\n")}`;
}
