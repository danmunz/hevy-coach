import assert from 'node:assert/strict';
import test from 'node:test';

import { HevyClient, buildRoutineSnapshot, routineSnapshotsMatch } from '../src/hevy/client.js';
import { summarizeWorkouts } from '../src/hevy/summarize.js';

test('exercise history distinguishes an empty history from a malformed response', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const payload of [{}, { exercise_history: null }, { exerciseHistory: {} }, null]) {
      globalThis.fetch = async () => Response.json(payload);
      const result = await new HevyClient('fixture').getExerciseHistory('bench');
      assert.equal(typeof result, 'object');
      if (typeof result !== 'string') assert.match(result.message, /Failed to fetch exercise history/);
    }
    for (const payload of [{ exercise_history: [] }, { exerciseHistory: [] }]) {
      globalThis.fetch = async () => Response.json(payload);
      const result = await new HevyClient('fixture').getExerciseHistory('bench');
      assert.equal(typeof result, 'string');
      assert.match(result as string, /No history found/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses the dedicated dated exercise-history endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      exercise_history: [
        { workout_id: 'w1', workout_start_time: '2026-09-01T12:00:00Z', exercise_template_id: 'bench', weight_kg: 61.235, reps: 5, set_type: 'normal', rpe: 8 },
        { workout_id: 'w1', workout_start_time: '2026-09-01T12:00:00Z', exercise_template_id: 'bench', weight_kg: 61.235, reps: 5, set_type: 'normal', rpe: 8 },
        { workout_id: 'w2', workout_start_time: '2026-08-28T12:00:00Z', exercise_template_id: 'bench', weight_kg: 65, reps: 3, set_type: 'failure' },
      ],
    });
  };
  try {
    const result = await new HevyClient('fixture').getExerciseHistory('bench', {
      exerciseName: 'Bench Press',
      startDate: '2026-08-01T00:00:00Z',
      endDate: '2026-09-02T00:00:00Z',
    });
    assert.equal(typeof result, 'string');
    assert.match(result as string, /Bench Press history \(2026-08-01T00:00:00Z through 2026-09-02T00:00:00Z; 2 sessions\)/);
    assert.match(result as string, /2x135x5@8/);
    assert.match(result as string, /failure 143x3/);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/exercise_history\/bench\?/);
    assert.match(requests[0], /start_date=2026-08-01T00%3A00%3A00Z/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recent-workout summaries retain all set groups and set types', () => {
  const summary = summarizeWorkouts([{
    id: 'workout',
    title: 'Bench day',
    startTime: '2026-09-01T12:00:00Z',
    exercises: [{
      title: 'Bench Press',
      sets: [
        { type: 'warmup', weightKg: 20, reps: 10 },
        { type: 'normal', weightKg: 61.235, reps: 5 },
        { type: 'normal', weightKg: 61.235, reps: 5 },
        { type: 'failure', weightKg: 61.235, reps: 3 },
      ],
    }],
  }]);
  assert.match(summary, /warmup 44x10, 2x135x5, failure 135x3/);
});

test('does not retry an ambiguous routine creation request', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new TypeError('connection dropped after dispatch');
  };
  try {
    const result = await new HevyClient('fixture').createRoutine(
      'Fixture',
      [{ name: 'Bench Press', sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
      new Map([['bench press', 'bench']]),
    );
    assert.equal(attempts, 1);
    assert.equal('error' in result, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not start a Hevy request after the shared turn deadline', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return Response.json({ workouts: [] });
  };
  try {
    const result = await new HevyClient('fixture', Date.now() - 1).getRecentWorkouts();
    assert.equal(attempts, 0);
    assert.equal(typeof result, 'object');
    if (typeof result !== 'string') assert.match(result.message, /turn deadline/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not wait through a retry interval that exceeds the turn deadline', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response('', { status: 429, headers: { 'retry-after': '60' } });
  };
  try {
    const started = Date.now();
    const result = await new HevyClient('fixture', started + 100).getRecentWorkouts();
    assert.equal(attempts, 1);
    assert.ok(Date.now() - started < 500, 'deadline-aware retry should fail immediately');
    if (typeof result !== 'string') assert.match(result.message, /turn deadline/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizes a routine detail for safe overwrite comparison', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    routine: {
      title: 'Fixture',
      exercises: [{
        exercise_template_id: 'bench',
        superset_id: null,
        sets: [{ type: 'normal', weight_kg: 61.235, reps: 5 }],
      }],
    },
  });
  try {
    const result = await new HevyClient('fixture').getRoutineSnapshot('routine-1');
    assert.equal('error' in result, false);
    if ('error' in result) return;
    const expected = buildRoutineSnapshot(
      'Fixture',
      [{ name: 'Bench Press', sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
      new Map([['bench press', 'bench']]),
    );
    assert.equal(routineSnapshotsMatch(expected, result), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
