import type { RoutinePayload } from '../hevy/types.js';
import { getDb } from './db.js';

export interface PendingHevyMutation {
  operation: 'create' | 'update';
  routineId?: string;
  payload: RoutinePayload;
  exerciseTemplateIds: Record<string, string>;
  createdAt: string;
}

export function getPendingHevyMutation(): PendingHevyMutation | undefined {
  const row = getDb().prepare(`
    SELECT operation, routine_id, payload, created_at
    FROM pending_hevy_mutation
    WHERE id = 1
  `).get() as { operation: string; routine_id: string | null; payload: string; created_at: string } | undefined;
  if (!row) return undefined;
  let parsed: RoutinePayload | { payload: RoutinePayload; exerciseTemplateIds?: Record<string, string> };
  try {
    parsed = JSON.parse(row.payload) as typeof parsed;
  } catch {
    throw new Error('The pending Hevy mutation payload is corrupted. Resolve it before writing another routine.');
  }
  if (row.operation !== 'create' && row.operation !== 'update') {
    throw new Error('The pending Hevy mutation has an unknown operation. Resolve it before writing another routine.');
  }
  const payload = 'payload' in parsed ? parsed.payload : parsed;
  const exerciseTemplateIds = 'payload' in parsed && parsed.exerciseTemplateIds
    ? parsed.exerciseTemplateIds
    : {};
  return { operation: row.operation, routineId: row.routine_id ?? undefined, payload, exerciseTemplateIds, createdAt: row.created_at };
}

export function markHevyMutationPending(
  operation: PendingHevyMutation['operation'],
  payload: RoutinePayload,
  routineId?: string,
  exerciseTemplateIds: Record<string, string> = {},
): void {
  getDb().prepare(`
    INSERT INTO pending_hevy_mutation (id, operation, routine_id, payload, created_at)
    VALUES (1, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      operation = excluded.operation,
      routine_id = excluded.routine_id,
      payload = excluded.payload,
      created_at = excluded.created_at
  `).run(operation, routineId ?? null, JSON.stringify({ payload, exerciseTemplateIds }));
}

/** Commits the remote success and its local routine cache together. */
export function confirmHevyMutation(
  routineId: string,
  payload: RoutinePayload,
  exerciseTemplateIds: Record<string, string> = {},
): void {
  const db = getDb();
  const write = db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO config (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    upsert.run('routine_id', routineId);
    upsert.run('last_routine_payload', JSON.stringify(payload));
    const upsertExercise = db.prepare(`
      INSERT INTO exercise_map (display_name, template_id, hevy_title, cached_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(display_name) DO UPDATE SET
        template_id = excluded.template_id,
        hevy_title = excluded.hevy_title,
        cached_at = excluded.cached_at
    `);
    for (const [displayName, templateId] of Object.entries(exerciseTemplateIds)) {
      upsertExercise.run(displayName, templateId, displayName);
    }
    db.prepare('DELETE FROM pending_hevy_mutation WHERE id = 1').run();
  });
  write();
}

/**
 * Deliberate operator recovery after the remote routine has been inspected.
 * This never retries a mutation or changes Hevy; it only removes the local
 * safety block.
 */
export function clearPendingHevyMutation(): void {
  getDb().prepare('DELETE FROM pending_hevy_mutation WHERE id = 1').run();
}
