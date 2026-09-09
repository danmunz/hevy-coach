import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { findCatalogCandidates, getApprovedCatalogCandidate, getCatalogStatus, importResearchDecisions, installExerciseCatalog, setReviewedDecision } from '../src/state/exercise-catalog.js';
import { createRoutineDraft, getRoutineDraft, markRoutineDraftPresented } from '../src/state/routine-drafts.js';
import { closeDbForTests, configureDbPathForTests } from '../src/state/db.js';

const dbPath = path.join('/private/tmp', `hevy-coach-catalog-test-${process.pid}.db`);
configureDbPathForTests(dbPath);

test.after(() => {
  closeDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

const fixtures = [
  { id: 'bench-barbell', title: 'Bench Press (Barbell)', type: 'weight_reps', equipment: 'barbell', primaryMuscleGroup: 'chest', isCustom: false },
  { id: 'bench-dumbbell', title: 'Bench Press (Dumbbell)', type: 'weight_reps', equipment: 'dumbbell', primaryMuscleGroup: 'chest', isCustom: false },
  { id: 'run', title: 'Run', type: 'duration', equipment: 'none', isCustom: false },
];

test('stores the complete catalog and preserves distinct exercise variants', () => {
  const installed = installExerciseCatalog(fixtures);
  assert.equal(installed.templateCount, 3);
  assert.equal(getCatalogStatus().complete, true);
  const candidates = findCatalogCandidates('bench press');
  assert.deepEqual(candidates.map(candidate => candidate.id), ['bench-barbell', 'bench-dumbbell']);
  assert.equal(candidates[0].supportedForRoutineWrite, true);
  assert.equal(findCatalogCandidates('run')[0].supportedForRoutineWrite, false);
});

test('requires one research decision for every active template', () => {
  assert.throws(() => importResearchDecisions([
    { templateId: 'bench-barbell', status: 'available', reasonCode: 'BARBELL' },
  ]), /cover each active template exactly once/);
  assert.equal(importResearchDecisions([
    { templateId: 'bench-barbell', status: 'available', reasonCode: 'BARBELL' },
    { templateId: 'bench-dumbbell', status: 'available', reasonCode: 'DUMBBELL' },
    { templateId: 'run', status: 'review', reasonCode: 'METRIC_UNSUPPORTED' },
  ]), 3);
  const candidate = findCatalogCandidates('', 'bench-barbell')[0];
  assert.equal(candidate.compatibility?.status, 'available');
  assert.equal(candidate.compatibility?.source, 'research');
});

test('requires a reviewed available decision before an ID enters a routine draft', () => {
  assert.throws(() => getApprovedCatalogCandidate('bench-barbell'), /not an approved available/);
  setReviewedDecision({ templateId: 'bench-barbell', status: 'available', reasonCode: 'BARBELL_CONFIRMED' });
  const candidate = getApprovedCatalogCandidate('bench-barbell');
  const draft = createRoutineDraft({
    title: 'Fixture', catalogRevision: candidate.catalogRevision, equipmentRevision: getCatalogStatus().equipmentRevision!,
    exercises: [{ occurrenceId: '1-bench', templateId: candidate.id, officialTitle: candidate.title, metricType: candidate.type!, sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
  });
  assert.equal(draft.status, 'prepared');
  assert.equal(markRoutineDraftPresented(draft.draftId).status, 'presented');
  assert.equal(getRoutineDraft(draft.draftId)?.exercises[0].templateId, 'bench-barbell');
});
