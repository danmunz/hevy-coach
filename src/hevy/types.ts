/** Set types supported by Hevy. */
export type HevySetType = "warmup" | "normal" | "failure" | "dropset";

/** A matched exercise template from the Hevy library. */
export interface HevyTemplateMatch {
  id: string;
  title: string;
  primaryMuscleGroup?: string;
  isCustom?: boolean;
}

/** A routine record returned by the Hevy API. */
export interface HevyRoutineRecord {
  id: string;
  title: string;
  folderId?: number | null;
}

/** A single set within a completed workout exercise. */
export interface HevyCompletedWorkoutSet {
  index?: number;
  type?: string;
  weightKg?: number | null;
  reps?: number | null;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  rpe?: number | null;
  customMetric?: number | null;
}

/** An exercise within a completed workout. */
export interface HevyCompletedWorkoutExercise {
  index?: number;
  title: string;
  notes?: string;
  exerciseTemplateId?: string;
  supersetId?: number | null;
  sets: HevyCompletedWorkoutSet[];
}

/** A completed workout record from the Hevy API. */
export interface HevyCompletedWorkout {
  id: string;
  title: string;
  routineId?: string | null;
  description?: string;
  startTime?: string;
  endTime?: string;
  updatedAt?: string;
  createdAt?: string;
  exercises: HevyCompletedWorkoutExercise[];
}

/** A paginated response of completed workouts. */
export interface HevyCompletedWorkoutPage {
  page: number;
  pageCount: number;
  workouts: HevyCompletedWorkout[];
}

/** Maps a local exercise name to a Hevy template search query and optional filters. */
export interface ExerciseLookup {
  query?: string;
  templateId?: string;
  primaryMuscleGroup?: string;
}

// ---------------------------------------------------------------------------
// Routine-push payload types (coach -> Hevy)
// ---------------------------------------------------------------------------

/** A single exercise in a routine payload to be pushed to Hevy. */
export interface RoutineExercisePayload {
  name: string;
  supersetId?: number;
  sets: Array<{
    type: "normal" | "warmup";
    weightLbs: number;
    reps: number;
  }>;
}

/** A complete routine payload ready for conversion and push to Hevy. */
export interface RoutinePayload {
  title: string;
  exercises: RoutineExercisePayload[];
}
