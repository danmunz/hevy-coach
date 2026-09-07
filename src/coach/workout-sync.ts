import type { HevyWorkoutSyncClient } from '../hevy/client.js';
import { readWorkoutCache, replaceWorkoutCache } from '../state/workouts.js';

// Recovery policy, not a claim about Hevy event retention.
const FULL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** One process owns this coordinator. Failed scans never advance the checkpoint. */
export class WorkoutSync {
  private lastFullRefreshAt?: number;
  private active?: Promise<ReturnType<typeof readWorkoutCache>>;
  constructor(private readonly client: HevyWorkoutSyncClient, private readonly now = () => Date.now()) {}
  async synchronize(minimumStartedAt = 0): Promise<ReturnType<typeof readWorkoutCache>> {
    if (!this.active) this.active = this.scan().finally(() => { this.active = undefined; });
    const result = await this.active;
    if (Date.parse(result.checkedAt ?? '') < minimumStartedAt) return this.synchronize(minimumStartedAt);
    return result;
  }
  private async scan() {
    const startedMs = this.now();
    const started = new Date(startedMs).toISOString();
    const cached = readWorkoutCache();
    let workouts = cached.workouts;
    let fullRefresh = this.lastFullRefreshAt == null || !cached.checkedAt ||
      !Number.isFinite(Date.parse(cached.checkedAt)) ||
      startedMs - this.lastFullRefreshAt >= FULL_REFRESH_INTERVAL_MS ||
      startedMs < this.lastFullRefreshAt;
    if (fullRefresh) workouts = await this.client.getRecentWorkoutRecords(10);
    else {
      const since = new Date(Date.parse(cached.checkedAt ?? started) - 60_000).toISOString();
      const events = await this.client.getWorkoutEvents(since);
      const byId = new Map(workouts.map(workout => [workout.id, workout]));
      // Events arrive newest first. Apply the latest event for each ID once.
      const seen = new Set<string>();
      let refill = false;
      for (const event of events) {
        const id = event.type === 'updated' ? event.workout.id : event.id;
        if (seen.has(id)) continue;
        seen.add(id);
        if (event.type === 'deleted') { refill = byId.delete(id) || refill; }
        else {
          const previous = byId.get(id);
          if (previous && previous.startTime !== event.workout.startTime) refill = true;
          byId.set(id, event.workout);
        }
      }
      fullRefresh = refill;
      workouts = refill ? await this.client.getRecentWorkoutRecords(10) : [...byId.values()];
    }
    const timestamp = (value: string | undefined): number => {
      const parsed = Date.parse(value ?? '');
      if (!Number.isFinite(parsed)) throw new Error('Workout start time is missing or invalid.');
      return parsed;
    };
    // Validate every record, including a one-record response that never invokes the comparator.
    for (const workout of workouts) timestamp(workout.startTime);
    workouts.sort((a,b) => timestamp(b.startTime) - timestamp(a.startTime) || a.id.localeCompare(b.id));
    replaceWorkoutCache(workouts.slice(0,10), started);
    if (fullRefresh) this.lastFullRefreshAt = startedMs;
    return readWorkoutCache();
  }
}

/** Optional clock hooks keep scheduler tests independent from elapsed wall time. */
export interface PollingClock {
  schedule(callback: () => void, delayMs: number): () => void;
  random(): number;
}
const pollingClock: PollingClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
  random: Math.random,
};

/** Completion-based scheduling prevents overlapping scans and catches up after sleep. */
export function startWorkoutPolling(
  sync: Pick<WorkoutSync, 'synchronize'>,
  intervalSeconds: number,
  clock: PollingClock = pollingClock,
): () => void {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) throw new Error('HEVY_SYNC_INTERVAL_SECONDS must be nonnegative.');
  let stopped = false;
  let cancel: (() => void) | undefined;
  let failures = 0;
  const poll = async () => {
    try { await sync.synchronize(); failures = 0; }
    catch { failures++; console.warn('[sync] scan_failed'); }
    if (!stopped && intervalSeconds > 0) {
      const delay = Math.max(intervalSeconds, Math.min(intervalSeconds * 2 ** Math.min(failures, 4), 3600)) * 1000 + clock.random()*5000;
      cancel = clock.schedule(() => { void poll(); }, delay);
    }
  };
  if (intervalSeconds > 0) void poll();
  return () => { stopped = true; cancel?.(); };
}
