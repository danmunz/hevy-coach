import type { HevyWorkoutSyncClient } from '../hevy/client.js';
import { readWorkoutCache, replaceWorkoutCache } from '../state/workouts.js';

/** One process owns this coordinator. Failed scans never advance the checkpoint. */
export class WorkoutSync {
  private active?: Promise<ReturnType<typeof readWorkoutCache>>;
  constructor(private readonly client: HevyWorkoutSyncClient, private readonly now = () => Date.now()) {}
  async synchronize(minimumStartedAt = 0): Promise<ReturnType<typeof readWorkoutCache>> {
    if (!this.active) this.active = this.scan().finally(() => { this.active = undefined; });
    const result = await this.active;
    if (Date.parse(result.checkedAt ?? '') < minimumStartedAt) return this.synchronize(minimumStartedAt);
    return result;
  }
  private async scan() {
    const started = new Date(this.now()).toISOString();
    const cached = readWorkoutCache();
    let workouts = cached.workouts;
    if (!cached.checkedAt) workouts = await this.client.getRecentWorkoutRecords(10);
    else {
      const since = new Date(Date.parse(cached.checkedAt) - 60_000).toISOString();
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
      workouts = refill ? await this.client.getRecentWorkoutRecords(10) : [...byId.values()];
    }
    workouts.sort((a,b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    replaceWorkoutCache(workouts.slice(0,10), started);
    return readWorkoutCache();
  }
}

/** Completion-based scheduling prevents overlapping scans and catches up after sleep. */
export function startWorkoutPolling(sync: WorkoutSync, intervalSeconds: number): () => void {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) throw new Error('HEVY_SYNC_INTERVAL_SECONDS must be nonnegative.');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const poll = async () => {
    try { await sync.synchronize(); failures = 0; }
    catch (error) { failures++; console.warn('[sync] scan_failed', error instanceof Error ? error.message : 'Unknown error'); }
    if (!stopped && intervalSeconds > 0) {
      const delay = Math.min(intervalSeconds * 2 ** Math.min(failures, 4), 3600) * 1000 + Math.random()*5000;
      timer = setTimeout(() => { void poll(); }, delay);
      timer.unref();
    }
  };
  if (intervalSeconds > 0) void poll();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
