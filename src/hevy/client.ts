import type {
  HevyCompletedWorkout,
  HevyCompletedWorkoutExercise,
  HevyCompletedWorkoutPage,
  HevyCompletedWorkoutSet,
  HevyRoutineRecord,
  HevyTemplateMatch,
  RoutineExercisePayload,
} from "./types.js";
import { poundsToRoundedKilograms, sleep } from "./utils.js";
import { summarizeWorkouts, summarizeExerciseHistory } from "./summarize.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEVY_API_BASE_URL = "https://api.hevyapp.com/v1";

const RETRY_CONFIG = {
  maxRetries: 2,
  retryOn: [500, 502, 503, 504],
  backoffMs: 2000,
  honorRetryAfter: true,
};

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------
// The Hevy API can return fields in either camelCase or snake_case depending
// on the endpoint or API version.  These normalizers defensively read both
// forms so the rest of the codebase can rely on a single shape.

function normalizeSet(item: unknown): HevyCompletedWorkoutSet | undefined {
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;

  return {
    index: typeof r.index === "number" ? r.index : undefined,
    type: typeof r.type === "string" ? r.type : undefined,
    weightKg:
      typeof r.weight_kg === "number"
        ? r.weight_kg
        : typeof r.weightKg === "number"
          ? r.weightKg
          : null,
    reps: typeof r.reps === "number" ? r.reps : null,
    distanceMeters:
      typeof r.distance_meters === "number"
        ? r.distance_meters
        : typeof r.distanceMeters === "number"
          ? r.distanceMeters
          : null,
    durationSeconds:
      typeof r.duration_seconds === "number"
        ? r.duration_seconds
        : typeof r.durationSeconds === "number"
          ? r.durationSeconds
          : null,
    rpe: typeof r.rpe === "number" ? r.rpe : null,
    customMetric:
      typeof r.custom_metric === "number"
        ? r.custom_metric
        : typeof r.customMetric === "number"
          ? r.customMetric
          : null,
  };
}

function normalizeExercise(
  item: unknown,
): HevyCompletedWorkoutExercise | undefined {
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;
  if (typeof r.title !== "string") return undefined;

  const rawSets = Array.isArray(r.sets) ? r.sets : [];

  return {
    index: typeof r.index === "number" ? r.index : undefined,
    title: r.title,
    notes: typeof r.notes === "string" ? r.notes : undefined,
    exerciseTemplateId:
      typeof r.exercise_template_id === "string"
        ? r.exercise_template_id
        : typeof r.exerciseTemplateId === "string"
          ? r.exerciseTemplateId
          : undefined,
    supersetId:
      typeof r.superset_id === "number"
        ? r.superset_id
        : typeof r.supersetId === "number"
          ? r.supersetId
          : null,
    sets: rawSets
      .map(normalizeSet)
      .filter((s): s is HevyCompletedWorkoutSet => s != null),
  };
}

function normalizeWorkout(item: unknown): HevyCompletedWorkout | undefined {
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return undefined;

  const rawExercises = Array.isArray(r.exercises) ? r.exercises : [];

  return {
    id: r.id,
    title: r.title,
    routineId:
      typeof r.routine_id === "string"
        ? r.routine_id
        : typeof r.routineId === "string"
          ? r.routineId
          : null,
    description:
      typeof r.description === "string" ? r.description : undefined,
    startTime:
      typeof r.start_time === "string"
        ? r.start_time
        : typeof r.startTime === "string"
          ? r.startTime
          : undefined,
    endTime:
      typeof r.end_time === "string"
        ? r.end_time
        : typeof r.endTime === "string"
          ? r.endTime
          : undefined,
    updatedAt:
      typeof r.updated_at === "string"
        ? r.updated_at
        : typeof r.updatedAt === "string"
          ? r.updatedAt
          : undefined,
    createdAt:
      typeof r.created_at === "string"
        ? r.created_at
        : typeof r.createdAt === "string"
          ? r.createdAt
          : undefined,
    exercises: rawExercises
      .map(normalizeExercise)
      .filter((e): e is HevyCompletedWorkoutExercise => e != null),
  };
}

// ---------------------------------------------------------------------------
// Structured error type
// ---------------------------------------------------------------------------

interface HevyApiError {
  error: true;
  message: string;
  suggestion: string;
}

function apiError(message: string, suggestion: string): HevyApiError {
  return { error: true, message, suggestion };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HevyClient {
  private readonly apiKey: string;
  private templateCache: HevyTemplateMatch[] | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.HEVY_API_KEY ?? "";
    if (!this.apiKey) {
      console.warn("[hevy] No API key configured. Set HEVY_API_KEY in .env.");
    }
  }

  // -------------------------------------------------------------------------
  // Core fetch wrapper with retry logic
  // -------------------------------------------------------------------------

  private async fetchJson<T>(
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const url = `${HEVY_API_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      "api-key": this.apiKey,
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> | undefined),
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        // Handle rate limiting (429)
        if (response.status === 429) {
          if (attempt < RETRY_CONFIG.maxRetries) {
            let waitMs = RETRY_CONFIG.backoffMs;
            if (RETRY_CONFIG.honorRetryAfter) {
              const retryAfter = response.headers.get("retry-after");
              if (retryAfter) {
                const seconds = Number(retryAfter);
                if (Number.isFinite(seconds) && seconds > 0) {
                  waitMs = seconds * 1000;
                }
              }
            }
            await sleep(waitMs);
            continue;
          }
          throw new Error(
            `Rate limited (429) after ${attempt + 1} attempts on ${path}`,
          );
        }

        // Handle retryable server errors
        if (RETRY_CONFIG.retryOn.includes(response.status)) {
          if (attempt < RETRY_CONFIG.maxRetries) {
            await sleep(RETRY_CONFIG.backoffMs * (attempt + 1));
            continue;
          }
          throw new Error(
            `Server error ${response.status} after ${attempt + 1} attempts on ${path}`,
          );
        }

        // Non-retryable error
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `Hevy API ${response.status} on ${path}: ${body || response.statusText}`,
          );
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Network errors and timeouts are retryable
        if (
          attempt < RETRY_CONFIG.maxRetries &&
          !(lastError.message.includes("Hevy API"))
        ) {
          await sleep(RETRY_CONFIG.backoffMs * (attempt + 1));
          continue;
        }

        throw lastError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error(`fetchJson failed for ${path}`);
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  /**
   * Verifies that the configured API key is valid.
   */
  async verifyApiKey(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.fetchJson<unknown>("/workouts?page=1&pageSize=1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetches recent completed workouts and returns a summarized text string.
   *
   * @param count Number of workouts to fetch (default 5, max 10).
   */
  async getRecentWorkouts(
    count: number = 5,
  ): Promise<string | HevyApiError> {
    try {
      const requestCount = Math.max(1, Math.min(count, 10));
      const workouts: HevyCompletedWorkout[] = [];
      const pageSize = Math.min(requestCount, 10);
      let page = 1;

      while (workouts.length < requestCount) {
        const payload = await this.fetchJson<Record<string, unknown>>(
          `/workouts?page=${page}&pageSize=${pageSize}`,
        );

        const rawWorkouts = Array.isArray(payload.workouts)
          ? payload.workouts
          : [];
        const normalized = rawWorkouts
          .map(normalizeWorkout)
          .filter((w): w is HevyCompletedWorkout => w != null);

        if (normalized.length === 0) break;
        workouts.push(...normalized);

        const pageCount =
          typeof payload.page_count === "number"
            ? payload.page_count
            : typeof (payload as Record<string, unknown>).pageCount === "number"
              ? (payload as Record<string, unknown>).pageCount as number
              : page;

        if (page >= pageCount) break;
        page++;
      }

      const trimmed = workouts.slice(0, requestCount);
      return summarizeWorkouts(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to fetch recent workouts: ${msg}`,
        "Check that HEVY_API_KEY is set and valid. Try again in a moment.",
      );
    }
  }

  /**
   * Fetches workout history filtered to a specific exercise template.
   * Returns a summarized progression string.
   */
  async getExerciseHistory(
    templateId: string,
  ): Promise<string | HevyApiError> {
    try {
      const workouts: HevyCompletedWorkout[] = [];
      let page = 1;
      const pageSize = 10;
      const maxPages = 5; // Look back through up to 50 workouts
      let exerciseName = "";

      while (page <= maxPages) {
        const payload = await this.fetchJson<Record<string, unknown>>(
          `/workouts?page=${page}&pageSize=${pageSize}`,
        );

        const rawWorkouts = Array.isArray(payload.workouts)
          ? payload.workouts
          : [];
        const normalized = rawWorkouts
          .map(normalizeWorkout)
          .filter((w): w is HevyCompletedWorkout => w != null);

        if (normalized.length === 0) break;

        // Filter workouts to those containing the target exercise
        for (const workout of normalized) {
          const matchingExercise = workout.exercises.find(
            (ex) => ex.exerciseTemplateId === templateId,
          );
          if (matchingExercise) {
            workouts.push(workout);
            if (!exerciseName) {
              exerciseName = matchingExercise.title;
            }
          }
        }

        const pageCount =
          typeof payload.page_count === "number"
            ? payload.page_count
            : typeof (payload as Record<string, unknown>).pageCount === "number"
              ? (payload as Record<string, unknown>).pageCount as number
              : page;

        if (page >= pageCount) break;
        page++;
      }

      if (!exerciseName) {
        return `No workout history found for exercise template "${templateId}".`;
      }

      return summarizeExerciseHistory(workouts, exerciseName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to fetch exercise history: ${msg}`,
        "Verify the exercise template ID is correct and the API key is valid.",
      );
    }
  }

  /**
   * Fetches all routines, paginating through every page.
   * Returns a simplified list of id, title, and folderId.
   */
  async getRoutines(): Promise<HevyRoutineRecord[] | HevyApiError> {
    try {
      const routines: HevyRoutineRecord[] = [];
      let page = 1;
      const pageSize = 10;

      while (true) {
        const payload = await this.fetchJson<Record<string, unknown>>(
          `/routines?page=${page}&pageSize=${pageSize}`,
        );

        const rawRoutines = Array.isArray(payload.routines)
          ? payload.routines
          : [];

        if (rawRoutines.length === 0) break;

        for (const raw of rawRoutines) {
          if (!raw || typeof raw !== "object") continue;
          const r = raw as Record<string, unknown>;
          if (typeof r.id !== "string" || typeof r.title !== "string") continue;

          routines.push({
            id: r.id,
            title: r.title,
            folderId:
              typeof r.folder_id === "number"
                ? r.folder_id
                : typeof r.folderId === "number"
                  ? r.folderId
                  : null,
          });
        }

        const pageCount =
          typeof payload.page_count === "number"
            ? payload.page_count
            : typeof (payload as Record<string, unknown>).pageCount === "number"
              ? (payload as Record<string, unknown>).pageCount as number
              : page;

        if (page >= pageCount) break;
        page++;
      }

      return routines;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to fetch routines: ${msg}`,
        "Check that HEVY_API_KEY is set and valid.",
      );
    }
  }

  /**
   * Creates a new routine in Hevy.
   *
   * Resolves exercise display names to Hevy template IDs using the provided
   * exerciseMap.  Converts all weightLbs values to weightKg.
   */
  async createRoutine(
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
  ): Promise<{ routineId: string } | HevyApiError> {
    try {
      const body = buildRoutineBody(title, exercises, exerciseMap);

      const payload = await this.fetchJson<Record<string, unknown>>(
        "/routines",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );

      // The API nests the created routine inside a "routine" key
      const routine = (payload.routine ?? payload) as Record<string, unknown>;
      const routineId =
        typeof routine.id === "string" ? routine.id : String(routine.id ?? "");

      if (!routineId) {
        return apiError(
          "Routine was created but no ID was returned.",
          "Check the Hevy app to confirm the routine exists.",
        );
      }

      return { routineId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to create routine: ${msg}`,
        "Verify exercise names match known templates and the API key has write access.",
      );
    }
  }

  /**
   * Updates an existing routine in Hevy.
   *
   * Same name resolution and weight conversion as createRoutine.
   */
  async updateRoutine(
    routineId: string,
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
  ): Promise<void | HevyApiError> {
    try {
      const body = buildRoutineBody(title, exercises, exerciseMap);

      await this.fetchJson<unknown>(`/routines/${routineId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to update routine "${routineId}": ${msg}`,
        "Verify the routine ID exists and the API key has write access.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Exercise template search (cached)
  // -------------------------------------------------------------------------

  /**
   * Fetches ALL exercise templates from the Hevy API and caches them
   * in memory. Uses pageSize=100 (the API max) so it completes in
   * 3-4 requests instead of 30+.
   *
   * Call this once during setup; subsequent calls return the cache.
   */
  async fetchAllTemplates(): Promise<HevyTemplateMatch[]> {
    if (this.templateCache) return this.templateCache;

    const templates: HevyTemplateMatch[] = [];
    let page = 1;
    const pageSize = 100; // API max

    while (true) {
      const payload = await this.fetchJson<Record<string, unknown>>(
        `/exercise_templates?page=${page}&pageSize=${pageSize}`,
      );

      const rawTemplates = Array.isArray(payload.exercise_templates)
        ? payload.exercise_templates
        : Array.isArray(
              (payload as Record<string, unknown>).exerciseTemplates,
            )
          ? (payload as Record<string, unknown>).exerciseTemplates as unknown[]
          : [];

      if (rawTemplates.length === 0) break;

      for (const raw of rawTemplates) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const templateTitle = typeof r.title === "string" ? r.title : "";
        if (!templateTitle) continue;

        templates.push({
          id: typeof r.id === "string" ? r.id : String(r.id ?? ""),
          title: templateTitle,
          primaryMuscleGroup:
            typeof r.primary_muscle_group === "string"
              ? r.primary_muscle_group
              : typeof r.primaryMuscleGroup === "string"
                ? r.primaryMuscleGroup
                : undefined,
          isCustom:
            typeof r.is_custom === "boolean"
              ? r.is_custom
              : typeof r.isCustom === "boolean"
                ? r.isCustom
                : undefined,
        });
      }

      const pageCount =
        typeof payload.page_count === "number"
          ? payload.page_count
          : typeof (payload as Record<string, unknown>).pageCount === "number"
            ? (payload as Record<string, unknown>).pageCount as number
            : page;

      if (page >= pageCount) break;
      page++;
    }

    console.log(`[hevy] Cached ${templates.length} exercise templates in ${page} API calls.`);
    this.templateCache = templates;
    return templates;
  }

  /**
   * Searches exercise templates by name query against the in-memory cache.
   *
   * Fetches and caches all templates on first call. Subsequent calls are
   * pure in-memory substring matching — zero API calls.
   */
  async searchExerciseTemplates(
    query: string,
  ): Promise<HevyTemplateMatch[]> {
    const allTemplates = await this.fetchAllTemplates();
    const normalizedQuery = query.trim().toLowerCase();

    return allTemplates.filter((t) =>
      t.title.toLowerCase().includes(normalizedQuery),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the JSON body for a routine create/update request.
 * Resolves display names to template IDs and converts lbs to kg.
 */
function buildRoutineBody(
  title: string,
  exercises: RoutineExercisePayload[],
  exerciseMap: Map<string, string>,
): Record<string, unknown> {
  const routineExercises = exercises.map((ex) => {
    const normalizedName = ex.name.trim().toLowerCase();
    const templateId = exerciseMap.get(normalizedName);

    if (!templateId) {
      throw new Error(
        `No template ID found for exercise "${ex.name}". ` +
          `Add it to the exercise map before creating the routine.`,
      );
    }

    return {
      exercise_template_id: templateId,
      superset_id: ex.supersetId ?? null,
      sets: ex.sets.map((set) => ({
        type: set.type,
        weight_kg: poundsToRoundedKilograms(set.weightLbs),
        reps: set.reps,
      })),
    };
  });

  return {
    routine: {
      title,
      exercises: routineExercises,
    },
  };
}
