import type { HevyClient } from "../hevy/client.js";
import type { RoutineExercisePayload, RoutinePayload } from "../hevy/types.js";
import { resolveExerciseName } from "../hevy/exercise-pins.js";
import { getConfig, setConfig, getTrainingMaxes, setTrainingMaxes } from "../state/config.js";
import { saveNote, clearNote } from "../state/notes.js";
import { getDb } from "../state/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loads the exercise_map table into a Map<displayName, templateId>.
 * Keys are stored lowercase for case-insensitive lookup by the HevyClient.
 */
function loadExerciseMap(): Map<string, string> {
  const db = getDb();
  const rows = db
    .prepare("SELECT display_name, template_id FROM exercise_map")
    .all() as Array<{ display_name: string; template_id: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.display_name.trim().toLowerCase(), row.template_id);
  }
  return map;
}

/**
 * Wraps a search function bound to the HevyClient for use with
 * resolveExerciseName's searchFn parameter.
 */
function makeSearchFn(client: HevyClient) {
  return (query: string) => client.searchExerciseTemplates(query);
}

/**
 * Converts tool-input exercise objects into RoutineExercisePayload[].
 */
function parseExerciseInputs(
  exercises: unknown[],
): RoutineExercisePayload[] {
  return exercises.map((ex, i) => {
    const e = ex as Record<string, unknown>;
    if (!e.name || typeof e.name !== "string") {
      throw new Error(`Exercise ${i + 1} is missing a name.`);
    }
    if (!Array.isArray(e.sets) || e.sets.length === 0) {
      throw new Error(`Exercise "${e.name}" has no sets.`);
    }
    const sets = e.sets.map((s) => {
      const set = s as Record<string, unknown>;
      return {
        type: (set.type as "normal" | "warmup") ?? "normal",
        weightLbs: typeof set.weight_lbs === "number" ? set.weight_lbs : 0,
        reps: typeof set.reps === "number" ? set.reps : 0,
      };
    });
    return {
      name: e.name,
      supersetId: typeof e.superset_id === "number" ? e.superset_id : undefined,
      sets,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

export class ToolExecutor {
  constructor(private hevyClient: HevyClient) {}

  /**
   * Dispatches a tool call to the appropriate handler and returns the
   * result as a string for inclusion in a tool_result message.
   *
   * Never throws -- errors are caught and returned as conversational
   * error strings that Claude can relay to the user.
   */
  async execute(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<string> {
    try {
      switch (toolName) {
        case "hevy_get_recent_workouts":
          return await this.getRecentWorkouts(toolInput);
        case "hevy_get_exercise_history":
          return await this.getExerciseHistory(toolInput);
        case "hevy_get_routines":
          return await this.getRoutines();
        case "hevy_push_routine":
          return await this.pushRoutine(toolInput);
        case "hevy_edit_routine_exercise":
          return await this.editRoutineExercise(toolInput);
        case "save_note":
          return await this.handleSaveNote(toolInput);
        case "clear_note":
          return await this.handleClearNote(toolInput);
        case "update_training_maxes":
          return await this.handleUpdateTrainingMaxes(toolInput);
        default:
          return `Unknown tool "${toolName}". Available tools: hevy_get_recent_workouts, hevy_get_exercise_history, hevy_get_routines, hevy_push_routine, hevy_edit_routine_exercise, save_note, clear_note, update_training_maxes.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Something went wrong running "${toolName}": ${msg}. Want me to try again?`;
    }
  }

  // -------------------------------------------------------------------------
  // Tool handlers
  // -------------------------------------------------------------------------

  private async getRecentWorkouts(
    input: Record<string, unknown>,
  ): Promise<string> {
    const count =
      typeof input.count === "number" ? input.count : 5;
    const result = await this.hevyClient.getRecentWorkouts(count);

    if (typeof result === "string") return result;

    // HevyApiError
    return `Couldn't fetch recent workouts -- ${result.message}. ${result.suggestion}`;
  }

  private async getExerciseHistory(
    input: Record<string, unknown>,
  ): Promise<string> {
    const exerciseName = input.exercise_name as string;
    if (!exerciseName) {
      return "Need an exercise name to look up history. Which exercise?";
    }

    const exerciseMap = loadExerciseMap();
    const searchFn = makeSearchFn(this.hevyClient);
    const templateId = await resolveExerciseName(
      exerciseName,
      exerciseMap,
      searchFn,
    );

    if (!templateId) {
      return `Couldn't find "${exerciseName}" in the exercise library. Check the spelling or try the full name (e.g. "Bench Press" instead of "bench").`;
    }

    const result = await this.hevyClient.getExerciseHistory(templateId);

    if (typeof result === "string") return result;

    return `Couldn't fetch history for "${exerciseName}" -- ${result.message}. ${result.suggestion}`;
  }

  private async getRoutines(): Promise<string> {
    const result = await this.hevyClient.getRoutines();

    if (!Array.isArray(result)) {
      return `Couldn't fetch routines -- ${result.message}. ${result.suggestion}`;
    }

    if (result.length === 0) {
      return "No routines found in Hevy.";
    }

    const lines = result.map(
      (r) => `- ${r.title} (id: ${r.id})`,
    );
    return `Routines:\n${lines.join("\n")}`;
  }

  private async pushRoutine(
    input: Record<string, unknown>,
  ): Promise<string> {
    const title = input.title as string;
    const rawExercises = input.exercises as unknown[];

    if (!title || !rawExercises?.length) {
      return "Need a title and at least one exercise to push a routine.";
    }

    const exercises = parseExerciseInputs(rawExercises);
    const exerciseMap = loadExerciseMap();

    // Resolve any exercise names not already in the map
    const searchFn = makeSearchFn(this.hevyClient);
    for (const ex of exercises) {
      const normalizedName = ex.name.trim().toLowerCase();
      if (!exerciseMap.has(normalizedName)) {
        const templateId = await resolveExerciseName(
          ex.name,
          exerciseMap,
          searchFn,
        );
        if (templateId) {
          exerciseMap.set(normalizedName, templateId);
        }
        // If it still can't resolve, buildRoutineBody in the client will
        // throw with a clear message about the missing exercise.
      }
    }

    const existingRoutineId = getConfig("routine_id");

    if (existingRoutineId) {
      // Update existing routine
      const updateResult = await this.hevyClient.updateRoutine(
        existingRoutineId,
        title,
        exercises,
        exerciseMap,
      );

      if (updateResult && typeof updateResult === "object" && "error" in updateResult) {
        return `Couldn't update the routine in Hevy -- ${updateResult.message}. ${updateResult.suggestion}`;
      }

      // Store the full payload for quick edits
      const payload: RoutinePayload = { title, exercises };
      setConfig("last_routine_payload", JSON.stringify(payload));

      return `Routine updated in Hevy: "${title}". Open the Hevy app to start the workout.`;
    } else {
      // Create new routine
      const createResult = await this.hevyClient.createRoutine(
        title,
        exercises,
        exerciseMap,
      );

      if ("error" in createResult) {
        return `Couldn't create the routine in Hevy -- ${createResult.message}. ${createResult.suggestion}`;
      }

      // Store the routine ID for future updates
      setConfig("routine_id", createResult.routineId);

      // Store the full payload for quick edits
      const payload: RoutinePayload = { title, exercises };
      setConfig("last_routine_payload", JSON.stringify(payload));

      return `Routine created in Hevy: "${title}". Open the Hevy app to start the workout.`;
    }
  }

  private async editRoutineExercise(
    input: Record<string, unknown>,
  ): Promise<string> {
    const replaceExercise = input.replace_exercise as string;
    const withExercise = input.with_exercise as string;
    const newSets = input.sets as unknown[] | undefined;

    if (!replaceExercise || !withExercise) {
      return "Need both the exercise to replace and the replacement exercise name.";
    }

    // Load the cached routine payload
    const payloadRaw = getConfig("last_routine_payload");
    if (!payloadRaw) {
      return "No standing routine found to edit. Push a full routine first with hevy_push_routine.";
    }

    const routineId = getConfig("routine_id");
    if (!routineId) {
      return "No routine ID on file. Push a full routine first with hevy_push_routine.";
    }

    let payload: RoutinePayload;
    try {
      payload = JSON.parse(payloadRaw) as RoutinePayload;
    } catch {
      return "The cached routine payload is corrupted. Push a fresh routine with hevy_push_routine.";
    }

    // Find the exercise to replace (case-insensitive)
    const replaceNormalized = replaceExercise.trim().toLowerCase();
    const exerciseIndex = payload.exercises.findIndex(
      (ex) => ex.name.trim().toLowerCase() === replaceNormalized,
    );

    if (exerciseIndex === -1) {
      const exerciseNames = payload.exercises
        .map((ex) => ex.name)
        .join(", ");
      return `Couldn't find "${replaceExercise}" in the current routine. Current exercises: ${exerciseNames}.`;
    }

    // Resolve the new exercise name to a template ID
    const exerciseMap = loadExerciseMap();
    const searchFn = makeSearchFn(this.hevyClient);
    const newTemplateId = await resolveExerciseName(
      withExercise,
      exerciseMap,
      searchFn,
    );

    if (!newTemplateId) {
      return `Couldn't find "${withExercise}" in the exercise library. Check the spelling or try the full name.`;
    }

    // Ensure the new exercise is in the map for buildRoutineBody
    const newNormalized = withExercise.trim().toLowerCase();
    if (!exerciseMap.has(newNormalized)) {
      exerciseMap.set(newNormalized, newTemplateId);
    }

    // Swap the exercise
    const oldExercise = payload.exercises[exerciseIndex];
    const replacement: RoutineExercisePayload = {
      name: withExercise,
      supersetId: oldExercise.supersetId,
      sets: newSets
        ? (newSets.map((s) => {
            const set = s as Record<string, unknown>;
            return {
              type: (set.type as "normal" | "warmup") ?? "normal",
              weightLbs: (set.weight_lbs as number) ?? 0,
              reps: (set.reps as number) ?? 0,
            };
          }))
        : oldExercise.sets,
    };

    payload.exercises[exerciseIndex] = replacement;

    // Push the updated routine
    const updateResult = await this.hevyClient.updateRoutine(
      routineId,
      payload.title,
      payload.exercises,
      exerciseMap,
    );

    if (updateResult && typeof updateResult === "object" && "error" in updateResult) {
      return `Couldn't update the routine in Hevy -- ${updateResult.message}. ${updateResult.suggestion}`;
    }

    // Update the cached payload
    setConfig("last_routine_payload", JSON.stringify(payload));

    return `Swapped "${replaceExercise}" for "${withExercise}" in the routine. Updated in Hevy.`;
  }

  private async handleSaveNote(
    input: Record<string, unknown>,
  ): Promise<string> {
    const content = input.content as string;
    if (!content) {
      return "Need some content to save as a note.";
    }

    const noteId = saveNote(content);
    return `Note saved (id: ${noteId}).`;
  }

  private async handleClearNote(
    input: Record<string, unknown>,
  ): Promise<string> {
    const noteId = input.note_id as number;
    if (noteId == null) {
      return "Need a note ID to clear.";
    }

    clearNote(noteId);
    return `Note #${noteId} cleared.`;
  }

  private async handleUpdateTrainingMaxes(
    input: Record<string, unknown>,
  ): Promise<string> {
    const updates: Record<string, number> = {};

    if (typeof input.squat === "number") updates.squat = input.squat;
    if (typeof input.bench === "number") updates.bench = input.bench;
    if (typeof input.deadlift === "number") updates.deadlift = input.deadlift;
    if (typeof input.ohp === "number") updates.ohp = input.ohp;

    if (Object.keys(updates).length === 0) {
      return "No training maxes provided to update. Pass at least one of: squat, bench, deadlift, ohp.";
    }

    setTrainingMaxes(updates);
    const current = getTrainingMaxes();

    return `Training maxes updated. Current: Squat ${current.squat} lbs, Bench ${current.bench} lbs, Deadlift ${current.deadlift} lbs, OHP ${current.ohp} lbs.`;
  }
}
