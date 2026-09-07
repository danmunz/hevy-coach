import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessFixtureScenario,
  EFFORT_FIXTURE_SCENARIOS,
  FixtureHevyClient,
} from '../scripts/effort-fixtures.js';

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
    EFFORT_FIXTURE_SCENARIOS.map((scenario) => [scenario.id, scenario.requiredTools]),
    [
      ['history_analysis', ['hevy_get_exercise_history']],
      ['pain_note', ['save_note']],
      ['training_max_approval', ['update_training_maxes']],
      ['approved_routine_push', ['hevy_push_routine']],
    ],
  );
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
