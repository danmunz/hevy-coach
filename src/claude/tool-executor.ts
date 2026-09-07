import { kilogramsToPounds } from '../hevy/utils.js';
import { buildRoutineSnapshot, routineSnapshotsMatch, type HevyToolClient } from "../hevy/client.js";
import type { RoutineExercisePayload, RoutinePayload } from "../hevy/types.js";
import { resolveExerciseName } from "../hevy/exercise-pins.js";
import { getConfig, getTrainingMaxes, setTrainingMaxes } from "../state/config.js";
import { saveNote, clearNote } from "../state/notes.js";
import { getDb } from "../state/db.js";
import { clearPendingHevyMutation, confirmHevyMutation, getPendingHevyMutation, markHevyMutationPending } from "../state/routine-state.js";

export interface ToolOutcome {
  result: string;
  status: 'success' | 'error' | 'blocked';
}

/** Carries an explicit outcome without changing the conversational result. */
class ToolResultError extends Error {
  constructor(message: string, readonly status: 'error' | 'blocked' = 'error') {
    super(message);
  }
}

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
function makeSearchFn(client: HevyToolClient) {
  return (query: string) => client.searchExerciseTemplates(query);
}

/** A 4xx response or local payload error proves the write was not ambiguous. */
function clearKnownFailedMutation(message: string): void {
  if (/Hevy API 4\d\d/.test(message) || message.includes('No template ID found')) {
    clearPendingHevyMutation();
  }
}

function ensureRoutineExercisesResolve(
  exercises: RoutineExercisePayload[],
  exerciseMap: Map<string, string>,
): void {
  for (const exercise of exercises) {
    if (!exerciseMap.has(exercise.name.trim().toLowerCase())) {
      throw new Error(`No template ID found for exercise "${exercise.name}".`);
    }
  }
}

function routineTemplateIds(
  payload: RoutinePayload,
  exerciseMap: Map<string, string>,
): Record<string, string> {
  return Object.fromEntries(payload.exercises.map((exercise) => {
    const templateId = exerciseMap.get(exercise.name.trim().toLowerCase());
    if (!templateId) throw new Error(`No template ID found for exercise "${exercise.name}".`);
    return [exercise.name, templateId];
  }));
}

function loadCachedRoutinePayload(): RoutinePayload | undefined {
  const payloadRaw = getConfig("last_routine_payload");
  if (!payloadRaw) return undefined;
  try {
    return JSON.parse(payloadRaw) as RoutinePayload;
  } catch {
    throw new Error("The cached routine payload is corrupted. Push a fresh routine with hevy_push_routine.");
  }
}

async function ensureRemoteRoutineCanBeOverwritten(
  client: HevyToolClient,
  routineId: string,
  cachedPayload: RoutinePayload | undefined,
  exerciseMap: Map<string, string>,
  overwriteExternalChanges: boolean,
): Promise<string | undefined> {
  if (overwriteExternalChanges) return undefined;
  if (!cachedPayload) {
    return 'The local copy of this routine is missing, so I cannot safely check for changes made in Hevy. Ask the user to explicitly confirm replacing the current Hevy routine, then retry with overwrite_external_changes: true.';
  }

  const expected = buildRoutineSnapshot(
    cachedPayload.title,
    cachedPayload.exercises,
    exerciseMap,
  );
  const remote = await client.getRoutineSnapshot(routineId);
  if ("error" in remote) {
    throw new ToolResultError(`I could not check the current Hevy routine before overwriting it: ${remote.message} ${remote.suggestion}`);
  }
  if (!routineSnapshotsMatch(expected, remote)) {
    return 'The standing routine has changed in Hevy since the bot last confirmed it. Ask the user whether to replace those external changes. Only after explicit confirmation, retry with overwrite_external_changes: true.';
  }
  return undefined;
}

/**
 * Converts tool-input exercise objects into RoutineExercisePayload[].
 */
const MAX_REPEAT_COUNT = 20;
const MAX_SETS_PER_EXERCISE = 40;

export function parseSetInputs(rawSets: unknown[], exerciseName: string): RoutineExercisePayload["sets"] {
  const expanded: RoutineExercisePayload["sets"] = [];
  for (const [index, rawSet] of rawSets.entries()) {
    if (!rawSet || typeof rawSet !== "object") throw new Error(`Set ${index + 1} for "${exerciseName}" must be an object.`);
    const set = rawSet as Record<string, unknown>;
    const weightLbs = set.weight_lbs;
    const reps = set.reps;
    const count = set.count ?? 1;
    if (typeof weightLbs !== "number" || !Number.isFinite(weightLbs) || weightLbs < 0) throw new Error(`Set ${index + 1} for "${exerciseName}" needs a nonnegative finite weight_lbs.`);
    if (typeof reps !== "number" || !Number.isInteger(reps) || reps <= 0) throw new Error(`Set ${index + 1} for "${exerciseName}" needs a positive integer reps.`);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_REPEAT_COUNT) throw new Error(`Set ${index + 1} for "${exerciseName}" needs count from 1 to ${MAX_REPEAT_COUNT}.`);
    const legacyType = set.type;
    if (legacyType !== undefined && legacyType !== "normal" && legacyType !== "warmup") throw new Error(`Set ${index + 1} for "${exerciseName}" has an unsupported type.`);
    if (set.warmup !== undefined && typeof set.warmup !== "boolean") throw new Error(`Set ${index + 1} for "${exerciseName}" has a non-boolean warmup flag.`);
    if (legacyType !== undefined && set.warmup !== undefined && (legacyType === "warmup") !== set.warmup) throw new Error(`Set ${index + 1} for "${exerciseName}" has conflicting type and warmup fields.`);
    const type = set.warmup === true || legacyType === "warmup" ? "warmup" : "normal";
    for (let repeat = 0; repeat < count; repeat++) expanded.push({ type, weightLbs, reps });
    if (expanded.length > MAX_SETS_PER_EXERCISE) throw new Error(`"${exerciseName}" exceeds the ${MAX_SETS_PER_EXERCISE}-set safety limit.`);
  }
  return expanded;
}

export function parseExerciseInputs(
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
    const sets = parseSetInputs(e.sets, e.name);
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

/**
 * Tools that only read. These are safe to run concurrently; everything else
 * touches Hevy or SQLite state (`routine_id`, `last_routine_payload`, notes,
 * training maxes) and is run sequentially so overlapping read-modify-write
 * cycles can't leave stored state disagreeing with what's actually in Hevy.
 *
 * All the latency lives in these three anyway — the writes are one call each.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'hevy_get_recent_workouts',
  'hevy_get_exercise_history',
  'hevy_get_routines',
]);

export function validateWorkoutCount(value: unknown): number {
  if (value === undefined) return 5;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('Workout count must be an integer from 1 through 10.');
  }
  return value;
}

export class ToolExecutor {
  constructor(
    private hevyClient: HevyToolClient,
    private readonly options: { allowMutations?: boolean; allowHevyWrites?: boolean } = {},
  ) {}

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
    return (await this.executeWithOutcome(toolName, toolInput)).result;
  }

  async executeWithOutcome(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    try {
      return { result: await this.executeResult(toolName, toolInput), status: 'success' };
    } catch (error) {
      if (error instanceof ToolResultError) return { result: error.message, status: error.status };
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: `Something went wrong running "${toolName}": ${message}. Want me to try again?`,
        status: 'error',
      };
    }
  }

  private async executeResult(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<string> {
    if (!READ_ONLY_TOOLS.has(toolName) && this.options.allowMutations === false) {
      throw new ToolResultError(`Demo mode blocked ${toolName}. Reads are live, but notes, training maxes, and Hevy writes are disabled.`, 'blocked');
    }
    if (
      (toolName === "hevy_push_routine" || toolName === "hevy_edit_routine_exercise") &&
      this.options.allowHevyWrites === false
    ) {
      throw new ToolResultError(`Demo mode blocked ${toolName}. It can update scratch coaching state, but never changes a live Hevy routine.`, 'blocked');
    }
    if ((toolName === "hevy_push_routine" || toolName === "hevy_edit_routine_exercise") && getPendingHevyMutation()) {
      throw new ToolResultError('A previous Hevy routine write has an unknown outcome. Check Hevy and resolve that write before changing the routine again.', 'blocked');
    }
    // Keep READ_ONLY_TOOLS in sync with the cases below when adding a tool.
    switch (toolName) {
      case "hevy_get_recent_workouts":
        return await this.getRecentWorkouts(toolInput);
      case "hevy_get_exercise_history":
        return await this.getExerciseHistory(toolInput);
      case "hevy_get_routines":
        return await this.getRoutines(toolInput);
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
        throw new ToolResultError(`Unknown tool "${toolName}". Available tools: hevy_get_recent_workouts, hevy_get_exercise_history, hevy_get_routines, hevy_push_routine, hevy_edit_routine_exercise, save_note, clear_note, update_training_maxes.`);
    }
  }

  // -------------------------------------------------------------------------
  // Tool handlers
  // -------------------------------------------------------------------------

  private async getRecentWorkouts(
    input: Record<string, unknown>,
  ): Promise<string> {
    const count = validateWorkoutCount(input.count);
    const result = await this.hevyClient.getRecentWorkouts(count);

    if (typeof result === "string") return result;

    // HevyApiError
    throw new ToolResultError(`Couldn't fetch recent workouts -- ${result.message}. ${result.suggestion}`);
  }

  private async getExerciseHistory(
    input: Record<string, unknown>,
  ): Promise<string> {
    const exerciseName = input.exercise_name as string;
    if (!exerciseName) {
      throw new ToolResultError("Need an exercise name to look up history. Which exercise?");
    }

    const exerciseMap = loadExerciseMap();
    const searchFn = makeSearchFn(this.hevyClient);
    const templateId = await resolveExerciseName(
      exerciseName,
      exerciseMap,
      searchFn,
    );

    if (!templateId) {
      throw new ToolResultError(`Couldn't find "${exerciseName}" in the exercise library. Check the spelling or try the full name (e.g. "Bench Press" instead of "bench").`);
    }

    const startDate = typeof input.start_date === "string" ? input.start_date : undefined;
    const endDate = typeof input.end_date === "string" ? input.end_date : undefined;
    const result = await this.hevyClient.getExerciseHistory(templateId, { startDate, endDate, exerciseName });

    if (typeof result === "string") return result;

    throw new ToolResultError(`Couldn't fetch history for "${exerciseName}" -- ${result.message}. ${result.suggestion}`);
  }

  private async getRoutines(input: Record<string, unknown>): Promise<string> {
    if (input.routine_id !== undefined) {
      if (typeof input.routine_id !== 'string' || !input.routine_id.trim()) throw new Error('Routine ID must be a nonempty string.');
      const snapshot = await this.hevyClient.getRoutineSnapshot(input.routine_id);
      if ('error' in snapshot) throw new ToolResultError(`Couldn't fetch routine -- ${snapshot.message}. ${snapshot.suggestion}`);
      return JSON.stringify({id:input.routine_id, title:snapshot.title, exercises:snapshot.exercises.map(exercise => ({
        exercise_template_id:exercise.exerciseTemplateId,
        sets:exercise.sets.map(set => ({type:set.type, weight_lbs:kilogramsToPounds(set.weightKg), reps:set.reps})),
      }))});
    }
    const result = await this.hevyClient.getRoutines();

    if (!Array.isArray(result)) {
      throw new ToolResultError(`Couldn't fetch routines -- ${result.message}. ${result.suggestion}`);
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
      throw new ToolResultError("Need a title and at least one exercise to push a routine.");
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
    ensureRoutineExercisesResolve(exercises, exerciseMap);

    const existingRoutineId = getConfig("routine_id");
    const overwriteExternalChanges = input.overwrite_external_changes === true;

    if (existingRoutineId) {
      const overwriteCheck = await ensureRemoteRoutineCanBeOverwritten(
        this.hevyClient,
        existingRoutineId,
        loadCachedRoutinePayload(),
        exerciseMap,
        overwriteExternalChanges,
      );
      if (overwriteCheck) throw new ToolResultError(overwriteCheck, 'blocked');
      const payload: RoutinePayload = { title, exercises };
      const exerciseTemplateIds = routineTemplateIds(payload, exerciseMap);
      markHevyMutationPending("update", payload, existingRoutineId, exerciseTemplateIds);

      // Update existing routine
      const updateResult = await this.hevyClient.updateRoutine(
        existingRoutineId,
        title,
        exercises,
        exerciseMap,
      );

      if (updateResult && typeof updateResult === "object" && "error" in updateResult) {
        clearKnownFailedMutation(updateResult.message);
        throw new ToolResultError(`Couldn't update the routine in Hevy -- ${updateResult.message}. ${updateResult.suggestion}`);
      }

      confirmHevyMutation(existingRoutineId, payload, exerciseTemplateIds);

      return `Routine updated in Hevy: "${title}". Open the Hevy app to start the workout.`;
    } else {
      const payload: RoutinePayload = { title, exercises };
      const exerciseTemplateIds = routineTemplateIds(payload, exerciseMap);
      markHevyMutationPending("create", payload, undefined, exerciseTemplateIds);

      // Create new routine
      const createResult = await this.hevyClient.createRoutine(
        title,
        exercises,
        exerciseMap,
      );

      if ("error" in createResult) {
        clearKnownFailedMutation(createResult.message);
        throw new ToolResultError(`Couldn't create the routine in Hevy -- ${createResult.message}. ${createResult.suggestion}`);
      }

      confirmHevyMutation(createResult.routineId, payload, exerciseTemplateIds);

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
      throw new ToolResultError("Need both the exercise to replace and the replacement exercise name.");
    }
    if (newSets && newSets.length === 0) {
      throw new ToolResultError('New sets cannot be empty. Omit sets to keep the existing set scheme.');
    }

    // Load the cached routine payload
    const payload = loadCachedRoutinePayload();
    if (!payload) {
      throw new ToolResultError("No standing routine found to edit. Push a full routine first with hevy_push_routine.");
    }

    const routineId = getConfig("routine_id");
    if (!routineId) {
      throw new ToolResultError("No routine ID on file. Push a full routine first with hevy_push_routine.");
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
      throw new ToolResultError(`Couldn't find "${replaceExercise}" in the current routine. Current exercises: ${exerciseNames}.`);
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
      throw new ToolResultError(`Couldn't find "${withExercise}" in the exercise library. Check the spelling or try the full name.`);
    }

    // Ensure the new exercise is in the map for buildRoutineBody
    const newNormalized = withExercise.trim().toLowerCase();
    if (!exerciseMap.has(newNormalized)) {
      exerciseMap.set(newNormalized, newTemplateId);
    }

    const overwriteCheck = await ensureRemoteRoutineCanBeOverwritten(
      this.hevyClient,
      routineId,
      payload,
      exerciseMap,
      input.overwrite_external_changes === true,
    );
    if (overwriteCheck) throw new ToolResultError(overwriteCheck, 'blocked');

    // Swap the exercise
    const oldExercise = payload.exercises[exerciseIndex];
    const replacement: RoutineExercisePayload = {
      name: withExercise,
      supersetId: oldExercise.supersetId,
      sets: newSets ? parseSetInputs(newSets, withExercise) : oldExercise.sets,
    };

    payload.exercises[exerciseIndex] = replacement;
    ensureRoutineExercisesResolve(payload.exercises, exerciseMap);
    const exerciseTemplateIds = routineTemplateIds(payload, exerciseMap);

    markHevyMutationPending("update", payload, routineId, exerciseTemplateIds);

    // Push the updated routine
    const updateResult = await this.hevyClient.updateRoutine(
      routineId,
      payload.title,
      payload.exercises,
      exerciseMap,
    );

    if (updateResult && typeof updateResult === "object" && "error" in updateResult) {
      clearKnownFailedMutation(updateResult.message);
      throw new ToolResultError(`Couldn't update the routine in Hevy -- ${updateResult.message}. ${updateResult.suggestion}`);
    }

    confirmHevyMutation(routineId, payload, exerciseTemplateIds);

    return `Swapped "${replaceExercise}" for "${withExercise}" in the routine. Updated in Hevy.`;
  }

  private async handleSaveNote(
    input: Record<string, unknown>,
  ): Promise<string> {
    const content = input.content as string;
    if (!content) {
      throw new ToolResultError("Need some content to save as a note.");
    }

    const noteId = saveNote(content);
    return `Note saved (id: ${noteId}).`;
  }

  private async handleClearNote(
    input: Record<string, unknown>,
  ): Promise<string> {
    const noteId = input.note_id as number;
    if (noteId == null) {
      throw new ToolResultError("Need a note ID to clear.");
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
      throw new ToolResultError("No training maxes provided to update. Pass at least one of: squat, bench, deadlift, ohp.");
    }

    setTrainingMaxes(updates);
    const current = getTrainingMaxes();

    return `Training maxes updated. Current: Squat ${current.squat} lbs, Bench ${current.bench} lbs, Deadlift ${current.deadlift} lbs, OHP ${current.ohp} lbs.`;
  }
}
