import type { HevyCompletedWorkout, HevyCompletedWorkoutExercise } from "./types.js";
import { kilogramsToPounds } from "./utils.js";

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

const TIMEZONE = process.env.TIMEZONE ?? "America/New_York";

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
function topSetSummary(exercise: HevyCompletedWorkoutExercise): string {
  const normalSets = exercise.sets.filter(
    (s) => s.type === "normal" || s.type === undefined,
  );
  const setsToCheck = normalSets.length > 0 ? normalSets : exercise.sets;

  if (setsToCheck.length === 0) return "no sets";

  let bestSet = setsToCheck[0];
  for (const set of setsToCheck) {
    const currentWeight = set.weightKg ?? 0;
    const bestWeight = bestSet.weightKg ?? 0;
    if (currentWeight > bestWeight) {
      bestSet = set;
    }
  }

  const weightKg = bestSet.weightKg ?? 0;
  const reps = bestSet.reps ?? 0;

  if (weightKg > 0) {
    const weightLbs = kilogramsToPounds(weightKg);
    return `${weightLbs}x${reps}`;
  }

  // Duration-based exercise (e.g. planks)
  if (bestSet.durationSeconds && bestSet.durationSeconds > 0) {
    return `${bestSet.durationSeconds}s`;
  }

  // Distance-based exercise (e.g. running)
  if (bestSet.distanceMeters && bestSet.distanceMeters > 0) {
    const distanceM = Math.round(bestSet.distanceMeters);
    return `${distanceM}m`;
  }

  // Bodyweight or zero-weight
  return `BWx${reps}`;
}

// ---------------------------------------------------------------------------
// Public summarization functions
// ---------------------------------------------------------------------------

/**
 * Produces a compact text summary of recent workouts.
 *
 * Each workout is one line showing date, title, and top set per exercise.
 * Targets ~200 tokens per 5 workouts.
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
      (ex) => `${ex.title}: ${topSetSummary(ex)}`,
    );

    const exerciseText =
      exerciseSummaries.length > 0
        ? exerciseSummaries.join(", ")
        : "no exercises";

    return `- ${date}: ${title} -- ${exerciseText}`;
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
  workouts: HevyCompletedWorkout[],
  exerciseName: string,
): string {
  const normalizedName = exerciseName.trim().toLowerCase();

  const entries: { date: string; summary: string }[] = [];

  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      if (exercise.title.trim().toLowerCase() === normalizedName) {
        entries.push({
          date: formatDate(workout.startTime),
          summary: topSetSummary(exercise),
        });
        break; // Only the first match per workout
      }
    }
  }

  if (entries.length === 0) {
    return `No history found for "${exerciseName}".`;
  }

  const lines = entries.map((e) => `- ${e.date}: ${e.summary}`);
  return `${exerciseName} history (last ${entries.length} sessions):\n${lines.join("\n")}`;
}
