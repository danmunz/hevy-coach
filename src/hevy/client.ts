import type {
  HevyCompletedWorkout,
  HevyCompletedWorkoutExercise,
  HevyWorkoutEvent,
  HevyCompletedWorkoutSet,
  HevyExerciseHistoryEntry,
  HevyRoutineRecord,
  HevyRoutineSnapshot,
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

  if (!Array.isArray(r.sets)) return undefined;
  const rawSets = r.sets;
  if (rawSets.some((set) => normalizeSet(set) == null)) return undefined;

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

  if (!Array.isArray(r.exercises)) return undefined;
  const rawExercises = r.exercises;
  if (rawExercises.some((exercise) => normalizeExercise(exercise) == null)) return undefined;

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

function normalizeExerciseHistoryEntry(item: unknown): HevyExerciseHistoryEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;
  const workoutId = typeof r.workout_id === "string" ? r.workout_id : r.workoutId;
  const templateId = typeof r.exercise_template_id === "string" ? r.exercise_template_id : r.exerciseTemplateId;
  if (typeof workoutId !== "string" || typeof templateId !== "string") return undefined;
  return {
    workoutId,
    workoutTitle: typeof r.workout_title === "string" ? r.workout_title : typeof r.workoutTitle === "string" ? r.workoutTitle : undefined,
    workoutStartTime: typeof r.workout_start_time === "string" ? r.workout_start_time : typeof r.workoutStartTime === "string" ? r.workoutStartTime : undefined,
    workoutEndTime: typeof r.workout_end_time === "string" ? r.workout_end_time : typeof r.workoutEndTime === "string" ? r.workoutEndTime : undefined,
    exerciseTemplateId: templateId,
    weightKg: typeof r.weight_kg === "number" ? r.weight_kg : typeof r.weightKg === "number" ? r.weightKg : null,
    reps: typeof r.reps === "number" ? r.reps : null,
    distanceMeters: typeof r.distance_meters === "number" ? r.distance_meters : typeof r.distanceMeters === "number" ? r.distanceMeters : null,
    durationSeconds: typeof r.duration_seconds === "number" ? r.duration_seconds : typeof r.durationSeconds === "number" ? r.durationSeconds : null,
    rpe: typeof r.rpe === "number" ? r.rpe : null,
    customMetric: typeof r.custom_metric === "number" ? r.custom_metric : typeof r.customMetric === "number" ? r.customMetric : null,
    setType: typeof r.set_type === "string" ? r.set_type : typeof r.setType === "string" ? r.setType : undefined,
  };
}

// ---------------------------------------------------------------------------
// Structured error type
// ---------------------------------------------------------------------------

export interface HevyApiError {
  error: true;
  message: string;
  suggestion: string;
}

function apiError(message: string, suggestion: string): HevyApiError {
  return { error: true, message, suggestion };
}

/**
 * The portion of the Hevy client used by the coaching tool executor. Keeping
 * this small lets deterministic evaluation fixtures exercise the production
 * tool loop without making an HTTP request or carrying the client's private
 * transport state.
 */
export interface HevyToolClient {
  getRecentWorkouts(count?: number): Promise<string | HevyApiError>;
  getExerciseHistory(
    templateId: string,
    options?: { startDate?: string; endDate?: string; exerciseName?: string },
  ): Promise<string | HevyApiError>;
  getRoutines(): Promise<HevyRoutineRecord[] | HevyApiError>;
  getRoutineSnapshot(routineId: string): Promise<HevyRoutineSnapshot | HevyApiError>;
  createRoutine(
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
  ): Promise<{ routineId: string } | HevyApiError>;
  updateRoutine(
    routineId: string,
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
  ): Promise<void | HevyApiError>;
  searchExerciseTemplates(query: string): Promise<HevyTemplateMatch[]>;
}

/** Synchronization failures throw. Callers must retain their old checkpoint. */
export interface HevyWorkoutSyncClient {
  getRecentWorkoutRecords(count?: number): Promise<HevyCompletedWorkout[]>;
  getWorkoutEvents(since: string): Promise<HevyWorkoutEvent[]>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface HevyHttpEvent {
  method: string;
  path: string;
  attempt: number;
  elapsedMs: number;
  status?: number;
  success: boolean;
}

export class HevyClient {
  private readonly apiKey: string;
  private templateCache: HevyTemplateMatch[] | null = null;
  private readonly refreshedMisses = new Set<string>();
  private templatePromise: Promise<HevyTemplateMatch[]> | null = null;

  constructor(apiKey?: string, private readonly deadlineAt?: number, private readonly onHttpEvent?: (event: HevyHttpEvent) => void) {
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
    const method = (options?.method ?? "GET").toUpperCase();
    // A connection failure after POST/PUT can occur after Hevy accepted the
    // write. Retrying would duplicate or overwrite a routine, so only reads
    // are retried automatically.
    const canRetry = method === "GET" || method === "HEAD";

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      const startedAt = Date.now();
      let status: number | undefined;
      let success = false;
      const controller = new AbortController();
      const remainingMs = this.deadlineAt == null
        ? 15_000
        : this.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error("Hevy request exceeded the turn deadline.");
      }
      const timeoutId = setTimeout(() => controller.abort(), Math.min(15_000, remainingMs));
      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        status = response.status;

        // Handle rate limiting (429)
        if (response.status === 429) {
          if (canRetry && attempt < RETRY_CONFIG.maxRetries) {
            let waitMs = RETRY_CONFIG.backoffMs;
            if (RETRY_CONFIG.honorRetryAfter) {
              const retryAfter = response.headers.get("retry-after");
              if (retryAfter) {
                const seconds = Number(retryAfter);
                if (Number.isFinite(seconds) && seconds > 0) {
                  waitMs = seconds * 1000;
                } else {
                  const retryAt = Date.parse(retryAfter);
                  if (Number.isFinite(retryAt)) waitMs = Math.max(0, retryAt - Date.now());
                }
              }
            }
            await this.waitForRetry(waitMs);
            continue;
          }
          throw new Error(
            `Hevy API 429 on ${path}: rate limited after ${attempt + 1} attempts`,
          );
        }

        // Handle retryable server errors
        if (RETRY_CONFIG.retryOn.includes(response.status)) {
          if (canRetry && attempt < RETRY_CONFIG.maxRetries) {
            await this.waitForRetry(RETRY_CONFIG.backoffMs * (attempt + 1));
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

        const result = (await response.json()) as T;
        success = true;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Network errors and timeouts are retryable
        if (
          canRetry && attempt < RETRY_CONFIG.maxRetries &&
          !(lastError.message.includes("Hevy API")) &&
          !(lastError.message.includes("turn deadline"))
        ) {
          await this.waitForRetry(RETRY_CONFIG.backoffMs * (attempt + 1));
          continue;
        }

        throw lastError;
      } finally {
        clearTimeout(timeoutId);
        try {
          this.onHttpEvent?.({ method, path: path.split("?")[0], attempt: attempt + 1,
            elapsedMs: Date.now() - startedAt, status, success });
        } catch (error) {
          console.warn("[hevy] HTTP telemetry callback failed:", error instanceof Error ? error.message : String(error));
        }
      }
    }

    throw lastError ?? new Error(`fetchJson failed for ${path}`);
  }

  private async waitForRetry(waitMs: number): Promise<void> {
    if (this.deadlineAt != null && waitMs >= this.deadlineAt - Date.now()) {
      throw new Error("Hevy retry would exceed the turn deadline.");
    }
    await sleep(waitMs);
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
      return summarizeWorkouts(await this.getRecentWorkoutRecords(count));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to fetch recent workouts: ${msg}`,
        "Check that HEVY_API_KEY is set and valid. Try again in a moment.",
      );
    }
  }

  async getRecentWorkoutRecords(count = 10): Promise<HevyCompletedWorkout[]> {
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error("Workout count must be an integer from 1 through 10.");
    }
    const payload = await this.fetchJson<Record<string, unknown>>(
      `/workouts?page=1&pageSize=${count}`,
    );
    if (!Array.isArray(payload.workouts)) throw new Error("Invalid workout page.");
    return payload.workouts.map((raw) => {
      const workout = normalizeWorkout(raw);
      if (!workout || !raw || typeof raw !== "object" ||
          !Array.isArray((raw as Record<string, unknown>).exercises)) {
        throw new Error("Invalid workout record.");
      }
      return workout;
    }).slice(0, count);
  }

  async getWorkoutEvents(since: string): Promise<HevyWorkoutEvent[]> {
    if (!Number.isFinite(Date.parse(since))) throw new Error("Invalid workout event checkpoint.");
    const events: HevyWorkoutEvent[] = [];
    let expectedPages: number | undefined;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ since, page: String(page), pageSize: "10" });
      const payload = await this.fetchJson<Record<string, unknown>>(`/workouts/events?${query}`);
      const pageCount = payload.page_count ?? payload.pageCount;
      // Hevy currently returns this undocumented semantic shape for an empty
      // first page: { page: 1, page_count: 1, workouts: [] }. Accept only
      // that representation. Any declared `events` value or nonempty
      // `workouts` field remains invalid here.
      const legacyEmptyPage = payload.events === undefined && page === 1 && pageCount === 1 &&
        Array.isArray(payload.workouts) && payload.workouts.length === 0;
      const pageEvents = legacyEmptyPage ? [] : payload.events;
      if (payload.page !== page || !Number.isInteger(pageCount) ||
          typeof pageCount !== "number" || pageCount < 0 ||
          !Array.isArray(pageEvents) ||
          (pageCount < page && !(page === 1 && pageCount === 0 && pageEvents.length === 0))) {
        throw new Error("Invalid workout event page.");
      }
      if (expectedPages != null && pageCount !== expectedPages) {
        throw new Error("Workout event pages changed during synchronization. Retry the scan.");
      }
      expectedPages = pageCount;
      if (pageCount > 0 && pageEvents.length === 0 && !legacyEmptyPage) {
        throw new Error("Incomplete workout event scan.");
      }
      for (const raw of pageEvents) {
        if (!raw || typeof raw !== "object") throw new Error("Invalid workout event.");
        const event = raw as Record<string, unknown>;
        if (event.type === "updated") {
          const workout = normalizeWorkout(event.workout);
          if (!workout || !event.workout || typeof event.workout !== "object" ||
              !Array.isArray((event.workout as Record<string, unknown>).exercises)) {
            throw new Error("Invalid updated workout.");
          }
          events.push({ type: "updated", workout });
        } else if (event.type === "deleted" && typeof event.id === "string") {
          const deletedAt = event.deleted_at ?? event.deletedAt;
          events.push({ type: "deleted", id: event.id,
            deletedAt: typeof deletedAt === "string" ? deletedAt : undefined });
        } else {
          throw new Error("Unknown workout event. The synchronization checkpoint must not advance.");
        }
      }
      if (page >= pageCount) return events;
    }
  }

  /**
   * Fetches workout history filtered to a specific exercise template.
   * Returns a summarized progression string.
   */
  async getExerciseHistory(
    templateId: string,
    options?: { startDate?: string; endDate?: string; exerciseName?: string },
  ): Promise<string | HevyApiError> {
    try {
      const endDate = options?.endDate ?? new Date().toISOString();
      const startDate = options?.startDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const query = new URLSearchParams({ start_date: startDate, end_date: endDate });
      const payload = await this.fetchJson<Record<string, unknown>>(
        `/exercise_history/${encodeURIComponent(templateId)}?${query.toString()}`,
      );
      const rawEntries = Array.isArray(payload.exercise_history)
        ? payload.exercise_history
        : Array.isArray(payload.exerciseHistory) ? payload.exerciseHistory : [];
      const entries = rawEntries
        .map(normalizeExerciseHistoryEntry)
        .filter((entry): entry is HevyExerciseHistoryEntry => entry != null);
      return summarizeExerciseHistory(entries, options?.exerciseName ?? templateId, { startDate, endDate });
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
   * Fetches only the programming fields needed before an overwrite and during
   * recovery from a write whose outcome is unknown.
   */
  async getRoutineSnapshot(
    routineId: string,
  ): Promise<HevyRoutineSnapshot | HevyApiError> {
    try {
      const payload = await this.fetchJson<Record<string, unknown>>(
        `/routines/${encodeURIComponent(routineId)}`,
      );
      const snapshot = normalizeRoutineSnapshot(payload.routine ?? payload);
      if (!snapshot) {
        return apiError(
          `Routine "${routineId}" returned an unexpected shape.`,
          "Check the routine in Hevy before attempting another write.",
        );
      }
      return snapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(
        `Failed to fetch routine "${routineId}": ${msg}`,
        "Check the routine in Hevy before attempting another write.",
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
   *
   * Concurrent callers share one in-flight request. Caching only the finished
   * array would let simultaneous callers on a cold cache each run the full
   * pagination, multiplying the API calls for identical data.
   */
  async fetchAllTemplates(refresh = false): Promise<HevyTemplateMatch[]> {
    if (this.templatePromise) return this.templatePromise;
    if (this.templateCache && !refresh) return this.templateCache;

    if (!this.templatePromise) {
      // Cleared on settle so a failed fetch doesn't poison later calls.
      this.templatePromise = this.doFetchAllTemplates().finally(() => {
        this.templatePromise = null;
      });
    }

    return this.templatePromise;
  }

  private async doFetchAllTemplates(): Promise<HevyTemplateMatch[]> {
    const templates: HevyTemplateMatch[] = [];
    let page = 1;
    const pageSize = 100; // API max
    let expectedPages: number | undefined;

    while (true) {
      const payload = await this.fetchJson<Record<string, unknown>>(
        `/exercise_templates?page=${page}&pageSize=${pageSize}`,
      );

      const rawTemplates = payload.exercise_templates ?? payload.exerciseTemplates;
      const pageCount = payload.page_count ?? payload.pageCount;
      if (!Array.isArray(rawTemplates) || payload.page !== page ||
          typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 0 ||
          (pageCount < page && !(page === 1 && pageCount === 0 && rawTemplates.length === 0))) {
        throw new Error("Invalid exercise template page.");
      }
      if (rawTemplates.length === 0 && pageCount > 0) {
        throw new Error("Incomplete exercise template scan.");
      }
      if (expectedPages != null && expectedPages !== pageCount) {
        throw new Error("Exercise template pages changed during the scan.");
      }
      expectedPages = pageCount;

      for (const raw of rawTemplates) {
        if (!raw || typeof raw !== "object") throw new Error("Invalid exercise template.");
        const r = raw as Record<string, unknown>;
        const templateTitle = typeof r.title === "string" ? r.title : "";
        if (!templateTitle || typeof r.id !== "string" || !r.id) throw new Error("Invalid exercise template.");

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
   * Fetches templates on first use. Cached misses refresh once per query.
   * Concurrent callers share the refresh.
   */
  async searchExerciseTemplates(
    query: string,
  ): Promise<HevyTemplateMatch[]> {
    const hadCache = this.templateCache != null;
    const allTemplates = await this.fetchAllTemplates();
    const normalize = (value: string) => value.toLowerCase().replace(/[-_()]/g, " ").replace(/\s+/g, " ").trim();
    const normalizedQuery = normalize(query);
    const matches = (templates: HevyTemplateMatch[]) =>
      templates.filter((template) => normalize(template.title).includes(normalizedQuery));
    const found = matches(allTemplates);
    // A cold fetch already checks the server. Only a stale cache needs a refresh.
    if (found.length > 0 || !hadCache || this.refreshedMisses.has(normalizedQuery)) return found;
    const refreshed = await this.fetchAllTemplates(true);
    this.refreshedMisses.add(normalizedQuery);
    return matches(refreshed);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the JSON body for a routine create/update request.
 * Resolves display names to template IDs and converts lbs to kg.
 */
export function buildRoutineSnapshot(
  title: string,
  exercises: RoutineExercisePayload[],
  exerciseMap: Map<string, string>,
): HevyRoutineSnapshot {
  return {
    title,
    exercises: exercises.map((ex) => {
    const normalizedName = ex.name.trim().toLowerCase();
    const templateId = exerciseMap.get(normalizedName);

    if (!templateId) {
      throw new Error(
        `No template ID found for exercise "${ex.name}". ` +
          `Add it to the exercise map before creating the routine.`,
      );
    }

    return {
      exerciseTemplateId: templateId,
      supersetId: ex.supersetId ?? null,
      sets: ex.sets.map((set) => ({
        type: set.type,
        weightKg: poundsToRoundedKilograms(set.weightLbs),
        reps: set.reps,
      })),
    };
    }),
  };
}

export function routineSnapshotsMatch(
  first: HevyRoutineSnapshot,
  second: HevyRoutineSnapshot,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function buildRoutineBody(
  title: string,
  exercises: RoutineExercisePayload[],
  exerciseMap: Map<string, string>,
): Record<string, unknown> {
  const snapshot = buildRoutineSnapshot(title, exercises, exerciseMap);
  return {
    routine: {
      title: snapshot.title,
      exercises: snapshot.exercises.map((exercise) => ({
        exercise_template_id: exercise.exerciseTemplateId,
        superset_id: exercise.supersetId,
        sets: exercise.sets.map((set) => ({
          type: set.type,
          weight_kg: set.weightKg,
          reps: set.reps,
        })),
      })),
    },
  };
}

function normalizeRoutineSnapshot(value: unknown): HevyRoutineSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const routine = value as Record<string, unknown>;
  if (typeof routine.title !== "string" || !Array.isArray(routine.exercises)) return undefined;

  const exercises: HevyRoutineSnapshot["exercises"] = [];
  for (const rawExercise of routine.exercises) {
    if (!rawExercise || typeof rawExercise !== "object") return undefined;
    const exercise = rawExercise as Record<string, unknown>;
    const exerciseTemplateId = typeof exercise.exercise_template_id === "string"
      ? exercise.exercise_template_id
      : exercise.exerciseTemplateId;
    const supersetId = typeof exercise.superset_id === "number"
      ? exercise.superset_id
      : typeof exercise.supersetId === "number" ? exercise.supersetId : null;
    if (typeof exerciseTemplateId !== "string" || !Array.isArray(exercise.sets)) return undefined;

    const sets: HevyRoutineSnapshot["exercises"][number]["sets"] = [];
    for (const rawSet of exercise.sets) {
      if (!rawSet || typeof rawSet !== "object") return undefined;
      const set = rawSet as Record<string, unknown>;
      const weightKg = typeof set.weight_kg === "number" ? set.weight_kg : set.weightKg;
      if (typeof set.type !== "string" || typeof weightKg !== "number" || typeof set.reps !== "number") return undefined;
      sets.push({ type: set.type, weightKg, reps: set.reps });
    }
    exercises.push({ exerciseTemplateId, supersetId, sets });
  }
  return { title: routine.title, exercises };
}
