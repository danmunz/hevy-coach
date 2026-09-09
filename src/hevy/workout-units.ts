import type { CachedWorkout, HevyCompletedWorkout } from './types.js';

/** Convert at ingestion without rounding away fractional pounds. */
export function workoutInPounds(workout: HevyCompletedWorkout): CachedWorkout {
  return {
    ...workout,
    exercises: workout.exercises.map(exercise => ({
      ...exercise,
      sets: exercise.sets.map(({ weightKg, ...set }) => ({
        ...set,
        weightLbs: weightKg == null ? weightKg : weightKg / 0.45359237,
      })),
    })),
  };
}
