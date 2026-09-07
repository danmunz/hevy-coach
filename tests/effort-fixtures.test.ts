import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assessFixtureScenario,
  EFFORT_FIXTURE_SCENARIOS,
  FixtureHevyClient,
  seedEffortFixtureState,
} from '../scripts/effort-fixtures.js';
import { closeDbForTests, configureDbPathForTests, getDb } from '../src/state/db.js';
import { getTrainingMaxes, setConfig } from '../src/state/config.js';
import { saveNote } from '../src/state/notes.js';

const testDbPath = path.join('/private/tmp', `hevy-coach-effort-fixture-test-${process.pid}.db`);
configureDbPathForTests(testDbPath);

test.after(() => {
  closeDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${testDbPath}${suffix}`, { force: true });
});

test('fixture client serves history without touching the network', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fixture evaluation must not call fetch');
  };
  try {
    const fixture = new FixtureHevyClient();
    const result = await fixture.getExerciseHistory('fixture-bench', { exerciseName: 'Bench Press' });
    assert.match(result, /Bench Press history/);
    assert.deepEqual(fixture.calls, ['getExerciseHistory:fixture-bench']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fixture client retains a lossless routine write oracle', async () => {
  const fixture = new FixtureHevyClient();
  const exerciseMap = new Map([
    ['bench press', 'fixture-bench'],
    ['lat pulldown', 'fixture-lat-pulldown'],
  ]);
  await fixture.createRoutine('Fixture Push Day', [
    {
      name: 'Bench Press',
      sets: [
        { type: 'warmup', weightLbs: 95, reps: 8 },
        { type: 'normal', weightLbs: 135, reps: 5 },
        { type: 'normal', weightLbs: 135, reps: 5 },
        { type: 'normal', weightLbs: 135, reps: 5 },
      ],
    },
    {
      name: 'Lat Pulldown',
      sets: [
        { type: 'normal', weightLbs: 100, reps: 10 },
        { type: 'normal', weightLbs: 100, reps: 10 },
        { type: 'normal', weightLbs: 100, reps: 10 },
      ],
    },
  ], exerciseMap);

  assert.deepEqual(fixture.routineWrites, [{
    operation: 'create',
    title: 'Fixture Push Day',
    exercises: [
      {
        name: 'Bench Press',
        sets: [
          { type: 'warmup', weightLbs: 95, reps: 8 },
          { type: 'normal', weightLbs: 135, reps: 5 },
          { type: 'normal', weightLbs: 135, reps: 5 },
          { type: 'normal', weightLbs: 135, reps: 5 },
        ],
      },
      {
        name: 'Lat Pulldown',
        sets: [
          { type: 'normal', weightLbs: 100, reps: 10 },
          { type: 'normal', weightLbs: 100, reps: 10 },
          { type: 'normal', weightLbs: 100, reps: 10 },
        ],
      },
    ],
    exerciseTemplateIds: {
      'Bench Press': 'fixture-bench',
      'Lat Pulldown': 'fixture-lat-pulldown',
    },
    snapshot: {
      title: 'Fixture Push Day',
      exercises: [
        {
          exerciseTemplateId: 'fixture-bench',
          supersetId: null,
          sets: [
            { type: 'warmup', weightKg: 43.091, reps: 8 },
            { type: 'normal', weightKg: 61.235, reps: 5 },
            { type: 'normal', weightKg: 61.235, reps: 5 },
            { type: 'normal', weightKg: 61.235, reps: 5 },
          ],
        },
        {
          exerciseTemplateId: 'fixture-lat-pulldown',
          supersetId: null,
          sets: [
            { type: 'normal', weightKg: 45.359, reps: 10 },
            { type: 'normal', weightKg: 45.359, reps: 10 },
            { type: 'normal', weightKg: 45.359, reps: 10 },
          ],
        },
      ],
    },
  }]);
});

test('fixture scenarios cover analysis, safety note, approved max, and exact routine push', () => {
  assert.deepEqual(
    EFFORT_FIXTURE_SCENARIOS.map((scenario) => [scenario.id, scenario.requiredTools, scenario.allowedMutationTools]),
    [
      ['history_analysis', ['hevy_get_exercise_history'], []],
      ['pain_note', ['save_note'], ['save_note']],
      ['training_max_approval', ['update_training_maxes'], ['update_training_maxes']],
      ['approved_routine_push', ['hevy_push_routine'], ['hevy_push_routine']],
    ],
  );
});

test('history assessment rejects an unrelated state-changing tool call', () => {
  seedEffortFixtureState();
  const assessment = assessFixtureScenario(
    EFFORT_FIXTURE_SCENARIOS.find((scenario) => scenario.id === 'history_analysis')!,
    [
      { iteration: 1, name: 'hevy_get_exercise_history', input: { exercise_name: 'Bench Press' }, result: 'Bench Press history', elapsedMs: 1 },
      { iteration: 1, name: 'update_training_maxes', input: { bench: 160 }, result: 'Training maxes updated.', elapsedMs: 1 },
    ],
    new FixtureHevyClient(),
  );
  assert.equal(assessment.passed, false);
  assert.match(assessment.failures.join('\n'), /unexpected state-changing/);
});

test('fixture seed resets every scratch state to the same known baseline', () => {
  seedEffortFixtureState();
  assert.deepEqual(getTrainingMaxes(), { squat: 205, bench: 155, deadlift: 275, ohp: 95 });
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM exercise_map').get() as { count: number }).count, 5);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 2);

  setConfig('training_maxes', JSON.stringify({ bench: 1 }));
  saveNote('State that must not survive another fixture seed');
  seedEffortFixtureState();

  assert.deepEqual(getTrainingMaxes(), { squat: 205, bench: 155, deadlift: 275, ohp: 95 });
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM notes').get() as { count: number }).count, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 2);
});

test('dry-run evaluator launches isolated workers and emits a parseable artifact', () => {
  const scriptPath = path.resolve('scripts/evaluate-effort.ts');
  const child = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, 'pair', '1', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 1, child.stderr);
  const summary = JSON.parse(child.stdout) as { artifactPath: string; passed: number; failed: number; promotionEligible: boolean };
  try {
    assert.equal(summary.passed, 8);
    assert.equal(summary.failed, 0);
    assert.equal(summary.promotionEligible, false);
    const artifact = JSON.parse(fs.readFileSync(summary.artifactPath, 'utf8')) as {
      results: Array<{ dryRun?: boolean; effort: string }>;
      comparison: { high: { cases: number }; medium: { cases: number } };
    };
    assert.equal(artifact.results.length, 8);
    assert.ok(artifact.results.every((result) => result.dryRun));
    assert.deepEqual(artifact.results.map((result) => result.effort), ['high', 'medium', 'high', 'medium', 'high', 'medium', 'high', 'medium']);
    assert.equal(artifact.comparison.high.cases, 4);
    assert.equal(artifact.comparison.medium.cases, 4);
  } finally {
    fs.rmSync(path.dirname(summary.artifactPath), { recursive: true, force: true });
  }
});

test('routine assessment rejects a fixture write that alters the approved prescription', async () => {
  const fixture = new FixtureHevyClient();
  await fixture.createRoutine(
    'Fixture Push Day',
    [{ name: 'Bench Press', sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
    new Map([['bench press', 'fixture-bench']]),
  );
  const assessment = assessFixtureScenario(
    EFFORT_FIXTURE_SCENARIOS.find((scenario) => scenario.id === 'approved_routine_push')!,
    [{
      iteration: 1,
      name: 'hevy_push_routine',
      input: {},
      result: 'Routine created.',
      elapsedMs: 1,
    }],
    fixture,
  );
  assert.equal(assessment.passed, false);
  assert.match(assessment.failures.join('\n'), /did not exactly match/);
});
