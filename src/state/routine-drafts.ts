import { randomUUID } from 'node:crypto';

import { getDb } from './db.js';

export type DraftStatus = 'prepared' | 'presented' | 'confirmed' | 'superseded';

export interface DraftSet {
  type: 'normal' | 'warmup';
  weightLbs: number;
  reps: number;
}

export interface DraftExercise {
  occurrenceId: string;
  templateId: string;
  officialTitle: string;
  metricType: string;
  supersetId?: number;
  sets: DraftSet[];
}

export interface RoutineDraft {
  draftId: string;
  title: string;
  exercises: DraftExercise[];
  catalogRevision: string;
  equipmentRevision: string;
  targetRoutineId?: string;
  status: DraftStatus;
  createdAt: string;
  presentedAt?: string;
  confirmedAt?: string;
}

interface DraftRow {
  draft_id: string;
  payload: string;
  catalog_revision: string;
  equipment_revision: string;
  target_routine_id: string | null;
  status: DraftStatus;
  created_at: string;
  presented_at: string | null;
  confirmed_at: string | null;
}

function decode(row: DraftRow): RoutineDraft {
  const payload = JSON.parse(row.payload) as Pick<RoutineDraft, 'title' | 'exercises'>;
  return { draftId: row.draft_id, ...payload, catalogRevision: row.catalog_revision,
    equipmentRevision: row.equipment_revision, targetRoutineId: row.target_routine_id ?? undefined,
    status: row.status, createdAt: row.created_at, presentedAt: row.presented_at ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined };
}

export function createRoutineDraft(input: Omit<RoutineDraft, 'draftId' | 'status' | 'createdAt' | 'presentedAt' | 'confirmedAt'>): RoutineDraft {
  const draftId = randomUUID();
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE routine_draft SET status = 'superseded' WHERE status IN ('prepared', 'presented')`).run();
    db.prepare(`
      INSERT INTO routine_draft (draft_id, payload, catalog_revision, equipment_revision, target_routine_id, status)
      VALUES (?, ?, ?, ?, ?, 'prepared')
    `).run(draftId, JSON.stringify({ title: input.title, exercises: input.exercises }), input.catalogRevision,
      input.equipmentRevision, input.targetRoutineId ?? null);
  })();
  return getRoutineDraft(draftId)!;
}

export function getRoutineDraft(draftId: string): RoutineDraft | undefined {
  const row = getDb().prepare(`
    SELECT draft_id, payload, catalog_revision, equipment_revision, target_routine_id, status, created_at, presented_at, confirmed_at
    FROM routine_draft WHERE draft_id = ?
  `).get(draftId) as DraftRow | undefined;
  return row ? decode(row) : undefined;
}

export function markRoutineDraftPresented(draftId: string): RoutineDraft {
  const result = getDb().prepare(`
    UPDATE routine_draft SET status = 'presented', presented_at = datetime('now')
    WHERE draft_id = ? AND status = 'prepared'
  `).run(draftId);
  if (result.changes !== 1) throw new Error(`Draft "${draftId}" is not ready for presentation.`);
  return getRoutineDraft(draftId)!;
}

export function markRoutineDraftConfirmed(draftId: string): RoutineDraft {
  const result = getDb().prepare(`
    UPDATE routine_draft SET status = 'confirmed', confirmed_at = datetime('now')
    WHERE draft_id = ? AND status = 'presented'
  `).run(draftId);
  if (result.changes !== 1) throw new Error(`Draft "${draftId}" was not presented or was replaced.`);
  return getRoutineDraft(draftId)!;
}
