import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { HevyTemplateMatch } from '../hevy/types.js';
import { getDb } from './db.js';

export type CompatibilityStatus = 'available' | 'unavailable' | 'review';
export type CompatibilitySource = 'research' | 'reviewed';

export interface CatalogTemplate extends Required<Pick<HevyTemplateMatch, 'id' | 'title'>> {
  type?: string;
  equipment?: string;
  primaryMuscleGroup?: string;
  secondaryMuscleGroups: string[];
  isCustom: boolean;
}

export interface CatalogDecision {
  templateId: string;
  status: CompatibilityStatus;
  reasonCode: string;
  source: CompatibilitySource;
}

export interface CatalogCandidate extends CatalogTemplate {
  catalogRevision: string;
  compatibility?: CatalogDecision;
  supportedForRoutineWrite: boolean;
}

export interface CatalogStatus {
  revision?: string;
  fetchedAt?: string;
  equipmentRevision?: string;
  templateCount: number;
  complete: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalTemplate(template: HevyTemplateMatch): CatalogTemplate {
  if (!template.id || !template.title) throw new Error('Catalog template must have an ID and title.');
  return {
    id: template.id,
    title: template.title,
    type: template.type,
    equipment: template.equipment,
    primaryMuscleGroup: template.primaryMuscleGroup,
    secondaryMuscleGroups: template.secondaryMuscleGroups ?? [],
    isCustom: template.isCustom === true,
  };
}

function catalogRevision(templates: readonly CatalogTemplate[]): string {
  return sha256(JSON.stringify([...templates].sort((a, b) => a.id.localeCompare(b.id))));
}

export function currentEquipmentRevision(): string {
  return sha256(fs.readFileSync(path.resolve(process.cwd(), 'config/equipment.md'), 'utf8'));
}

export function installExerciseCatalog(templates: readonly HevyTemplateMatch[]): CatalogStatus {
  const normalized = templates.map(canonicalTemplate);
  if (!normalized.length || new Set(normalized.map(template => template.id)).size !== normalized.length) {
    throw new Error('Catalog scan must contain one or more unique template IDs.');
  }
  const revision = catalogRevision(normalized);
  const equipmentRevision = currentEquipmentRevision();
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO exercise_catalog_revision
        (revision, fetched_at, equipment_revision, template_count, is_complete)
      VALUES (?, datetime('now'), ?, ?, 1)
    `).run(revision, equipmentRevision, normalized.length);
    db.prepare('UPDATE exercise_catalog_template SET is_active = 0 WHERE is_active = 1').run();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO exercise_catalog_template
        (template_id, revision, title, metric_type, equipment, primary_muscle_group, secondary_muscle_groups, is_custom, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const template of normalized) {
      insert.run(template.id, revision, template.title, template.type ?? null, template.equipment ?? null,
        template.primaryMuscleGroup ?? null, JSON.stringify(template.secondaryMuscleGroups), template.isCustom ? 1 : 0);
    }
  })();
  return { revision, equipmentRevision, templateCount: normalized.length, complete: true };
}

export function getCatalogStatus(): CatalogStatus {
  const row = getDb().prepare(`
    SELECT revision, fetched_at, equipment_revision, template_count, is_complete
    FROM exercise_catalog_revision ORDER BY fetched_at DESC LIMIT 1
  `).get() as { revision: string; fetched_at: string; equipment_revision: string; template_count: number; is_complete: number } | undefined;
  if (!row) return { templateCount: 0, complete: false };
  return { revision: row.revision, fetchedAt: row.fetched_at, equipmentRevision: row.equipment_revision,
    templateCount: row.template_count, complete: row.is_complete === 1 };
}

export function importResearchDecisions(decisions: readonly Omit<CatalogDecision, 'source'>[]): number {
  const status = getCatalogStatus();
  if (!status.revision || !status.equipmentRevision || !status.complete) throw new Error('Install a complete catalog before importing decisions.');
  const templateRows = getDb().prepare(`
    SELECT template_id FROM exercise_catalog_template WHERE revision = ? AND is_active = 1
  `).all(status.revision) as Array<{ template_id: string }>;
  const templateIds = new Set(templateRows.map(row => row.template_id));
  if (decisions.length !== templateIds.size || new Set(decisions.map(decision => decision.templateId)).size !== decisions.length ||
      decisions.some(decision => !templateIds.has(decision.templateId))) {
    throw new Error('Research decisions must cover each active template exactly once.');
  }
  const insert = getDb().prepare(`
    INSERT OR REPLACE INTO exercise_compatibility
      (template_id, catalog_revision, equipment_revision, status, reason_code, source, reviewed_at)
    VALUES (?, ?, ?, ?, ?, 'research', NULL)
  `);
  const write = getDb().transaction(() => {
    for (const decision of decisions) insert.run(decision.templateId, status.revision, status.equipmentRevision,
      decision.status, decision.reasonCode);
  });
  write();
  return decisions.length;
}

export function setReviewedDecision(decision: Omit<CatalogDecision, 'source'>): void {
  const status = getCatalogStatus();
  if (!status.revision || !status.equipmentRevision || !status.complete) throw new Error('Install a complete catalog before reviewing a decision.');
  const exists = getDb().prepare(`
    SELECT 1 FROM exercise_catalog_template WHERE template_id = ? AND revision = ? AND is_active = 1
  `).get(decision.templateId, status.revision);
  if (!exists) throw new Error(`Template ID "${decision.templateId}" is not active in the current catalog.`);
  getDb().prepare(`
    INSERT OR REPLACE INTO exercise_compatibility
      (template_id, catalog_revision, equipment_revision, status, reason_code, source, reviewed_at)
    VALUES (?, ?, ?, ?, ?, 'reviewed', datetime('now'))
  `).run(decision.templateId, status.revision, status.equipmentRevision, decision.status, decision.reasonCode);
}

function rowToCandidate(row: Record<string, unknown>): CatalogCandidate {
  const compatibility = typeof row.compatibility_status === 'string' && typeof row.reason_code === 'string' && typeof row.source === 'string'
    ? { templateId: String(row.template_id), status: row.compatibility_status as CompatibilityStatus,
      reasonCode: row.reason_code, source: row.source as CompatibilitySource }
    : undefined;
  const type = typeof row.metric_type === 'string' ? row.metric_type : undefined;
  return {
    id: String(row.template_id), title: String(row.title), type,
    equipment: typeof row.equipment === 'string' ? row.equipment : undefined,
    primaryMuscleGroup: typeof row.primary_muscle_group === 'string' ? row.primary_muscle_group : undefined,
    secondaryMuscleGroups: JSON.parse(String(row.secondary_muscle_groups)) as string[],
    isCustom: row.is_custom === 1,
    catalogRevision: String(row.revision), compatibility,
    supportedForRoutineWrite: type === 'weight_reps' || type === 'reps_only',
  };
}

export function findCatalogCandidates(query: string, templateId?: string, limit = 20): CatalogCandidate[] {
  const status = getCatalogStatus();
  if (!status.revision) return [];
  const value = query.trim().toLowerCase().replace(/[-_()]/g, ' ').replace(/\s+/g, ' ');
  const rows = getDb().prepare(`
    SELECT t.*, c.status AS compatibility_status, c.reason_code, c.source
    FROM exercise_catalog_template t
    LEFT JOIN exercise_compatibility c
      ON c.template_id = t.template_id AND c.catalog_revision = t.revision
      AND c.equipment_revision = ?
    WHERE t.revision = ? AND t.is_active = 1
      AND (t.template_id = ? OR (? = '' AND lower(t.title) LIKE ?))
    ORDER BY CASE WHEN t.template_id = ? THEN 0 WHEN lower(t.title) = ? THEN 1 ELSE 2 END, lower(t.title), t.template_id
    LIMIT ?
  `).all(currentEquipmentRevision(), status.revision, templateId ?? '', templateId ?? '', `%${value}%`, templateId ?? '', value, limit) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

export function getApprovedCatalogCandidate(templateId: string): CatalogCandidate {
  const status = getCatalogStatus();
  if (!status.revision || !status.complete || status.equipmentRevision !== currentEquipmentRevision()) {
    throw new Error('The catalog or equipment decisions are stale. Refresh and review the catalog before preparing a routine.');
  }
  const candidate = findCatalogCandidates('', templateId, 1)[0];
  if (!candidate || candidate.id !== templateId) throw new Error(`Template ID "${templateId}" is not active in the current catalog.`);
  if (!candidate.compatibility || candidate.compatibility.status !== 'available' || candidate.compatibility.source !== 'reviewed') {
    throw new Error(`Template ID "${templateId}" is not an approved available exercise.`);
  }
  if (!candidate.supportedForRoutineWrite) throw new Error(`Template ID "${templateId}" has unsupported metric type "${candidate.type ?? 'unknown'}".`);
  return candidate;
}
