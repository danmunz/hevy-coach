import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseExerciseInputs, parseSetInputs } from '../src/claude/tool-executor.js';
import { ToolExecutor } from '../src/claude/tool-executor.js';
import { buildRoutineSnapshot, HevyClient } from '../src/hevy/client.js';
import { configureDbPathForTests, closeDbForTests } from '../src/state/db.js';
import { clearPendingHevyMutation, getPendingHevyMutation, markHevyMutationPending } from '../src/state/routine-state.js';
import { getDb } from '../src/state/db.js';
import { setConfig } from '../src/state/config.js';

const testDbPath = path.join('/private/tmp', `hevy-coach-routine-test-${process.pid}.db`);
configureDbPathForTests(testDbPath);

test.after(() => {
  closeDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${testDbPath}${suffix}`, { force: true });
});

test('expands compact repeated sets without changing their order', () => {
  assert.deepEqual(
    parseSetInputs([
      { weight_lbs: 45, reps: 10, warmup: true },
      { weight_lbs: 135, reps: 5 },
      { weight_lbs: 135, reps: 5, count: 3 },
      { weight_lbs: 155, reps: 3 },
      { weight_lbs: 135, reps: 5 },
    ], 'Bench Press'),
    [
      { type: 'warmup', weightLbs: 45, reps: 10 },
      { type: 'normal', weightLbs: 135, reps: 5 },
      { type: 'normal', weightLbs: 135, reps: 5 },
      { type: 'normal', weightLbs: 135, reps: 5 },
      { type: 'normal', weightLbs: 135, reps: 5 },
      { type: 'normal', weightLbs: 155, reps: 3 },
      { type: 'normal', weightLbs: 135, reps: 5 },
    ],
  );
});

test('accepts the legacy type representation during the migration', () => {
  assert.deepEqual(
    parseSetInputs([{ type: 'warmup', weight_lbs: 0, reps: 10 }], 'Push Up'),
    [{ type: 'warmup', weightLbs: 0, reps: 10 }],
  );
});

test('rejects malformed or unsafe set input before a routine can be built', () => {
  assert.throws(() => parseSetInputs([{ weight_lbs: 100, reps: 5, count: 21 }], 'Squat'), /count from 1 to 20/);
  assert.throws(() => parseSetInputs([{ weight_lbs: -1, reps: 5 }], 'Squat'), /nonnegative/);
  assert.throws(() => parseSetInputs([{ weight_lbs: 100, reps: 1.5 }], 'Squat'), /positive integer reps/);
  assert.throws(() => parseSetInputs([{ type: 'warmup', warmup: false, weight_lbs: 100, reps: 5 }], 'Squat'), /conflicting/);
  assert.throws(
    () => parseSetInputs([{ weight_lbs: 100, reps: 5, count: 20 }, { weight_lbs: 105, reps: 5, count: 20 }, { weight_lbs: 110, reps: 5 }], 'Squat'),
    /40-set safety limit/,
  );
});

test('validates all exercise sets before returning a routine payload', () => {
  assert.throws(
    () => parseExerciseInputs([{ name: 'Bench Press', sets: [{ weight_lbs: 135, reps: 5 }] }, { name: 'Row', sets: [{ weight_lbs: 100, reps: 0 }] }]),
    /positive integer reps/,
  );
});

test('demo mode blocks every mutating tool before it can use a client or database', async () => {
  const executor = new ToolExecutor({} as HevyClient, { allowMutations: false });
  const result = await executor.execute('hevy_push_routine', {});
  assert.match(result, /Demo mode blocked hevy_push_routine/);
});

test('scratch mode blocks Hevy writes while allowing local state tools', async () => {
  const executor = new ToolExecutor({} as HevyClient, { allowHevyWrites: false });
  const result = await executor.execute('hevy_push_routine', {});
  assert.match(result, /never changes a live Hevy routine/);
});

test('a pending Hevy mutation blocks later routine writes', async () => {
  markHevyMutationPending('create', { title: 'Pending', exercises: [] });
  const executor = new ToolExecutor({} as HevyClient);
  const result = await executor.execute('hevy_push_routine', {});
  assert.match(result, /unknown outcome/);
  clearPendingHevyMutation();
  assert.equal(getPendingHevyMutation(), undefined);
});

test('a known rejected routine update clears its pending safety marker', async () => {
  getDb().prepare(`INSERT OR REPLACE INTO exercise_map (display_name, template_id, hevy_title) VALUES (?, ?, ?)`).run('bench press', 'bench', 'Bench Press');
  setConfig('routine_id', 'routine-1');
  const client = {
    async updateRoutine() {
      return { error: true as const, message: 'Hevy API 400 on /routines/routine-1: invalid request', suggestion: 'Fix the request.' };
    },
  } as unknown as HevyClient;
  const executor = new ToolExecutor(client);
  const result = await executor.execute('hevy_push_routine', {
    title: 'Fixture',
    exercises: [{ name: 'Bench Press', sets: [{ weight_lbs: 135, reps: 5 }] }],
    overwrite_external_changes: true,
  });
  assert.match(result, /Couldn't update the routine/);
  assert.equal(getPendingHevyMutation(), undefined);
});

test('a rate-limited routine create or update clears its pending safety marker', async () => {
  getDb().prepare('DELETE FROM config WHERE key IN (?, ?)').run('routine_id', 'last_routine_payload');
  const createClient = {
    async createRoutine() {
      return { error: true as const, message: 'Hevy API 429 on /routines: rate limited', suggestion: 'Try later.' };
    },
  } as unknown as HevyClient;
  const createResult = await new ToolExecutor(createClient).execute('hevy_push_routine', {
    title: 'Fixture',
    exercises: [{ name: 'Bench Press', sets: [{ weight_lbs: 135, reps: 5 }] }],
  });
  assert.match(createResult, /Couldn't create the routine/);
  assert.equal(getPendingHevyMutation(), undefined);

  setConfig('routine_id', 'routine-1');
  const updateClient = {
    async updateRoutine() {
      return { error: true as const, message: 'Hevy API 429 on /routines/routine-1: rate limited', suggestion: 'Try later.' };
    },
  } as unknown as HevyClient;
  const updateResult = await new ToolExecutor(updateClient).execute('hevy_push_routine', {
    title: 'Fixture',
    exercises: [{ name: 'Bench Press', sets: [{ weight_lbs: 135, reps: 5 }] }],
    overwrite_external_changes: true,
  });
  assert.match(updateResult, /Couldn't update the routine/);
  assert.equal(getPendingHevyMutation(), undefined);
});

test('an empty replacement set list is rejected before a Hevy write', async () => {
  setConfig('routine_id', 'routine-1');
  setConfig('last_routine_payload', JSON.stringify({
    title: 'Fixture',
    exercises: [{ name: 'Bench Press', sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
  }));
  let writes = 0;
  const client = {
    async updateRoutine() { writes++; },
  } as unknown as HevyClient;
  const executor = new ToolExecutor(client);
  const result = await executor.execute('hevy_edit_routine_exercise', {
    replace_exercise: 'Bench Press',
    with_exercise: 'Bench Press',
    sets: [],
  });
  assert.match(result, /New sets cannot be empty/);
  assert.equal(writes, 0);
});

test('does not overwrite a routine changed directly in Hevy without confirmation', async () => {
  setConfig('routine_id', 'routine-1');
  setConfig('last_routine_payload', JSON.stringify({
    title: 'Fixture',
    exercises: [{ name: 'Bench Press', sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
  }));
  let writes = 0;
  const client = {
    async getRoutineSnapshot() {
      return {
        title: 'Changed in Hevy',
        exercises: [{
          exerciseTemplateId: 'bench',
          supersetId: null,
          sets: [{ type: 'normal', weightKg: 61.235, reps: 5 }],
        }],
      };
    },
    async updateRoutine() { writes++; },
  } as unknown as HevyClient;
  const executor = new ToolExecutor(client);
  const result = await executor.execute('hevy_push_routine', {
    title: 'Replacement',
    exercises: [{ name: 'Bench Press', sets: [{ weight_lbs: 135, reps: 5 }] }],
  });
  assert.match(result, /changed in Hevy/);
  assert.equal(writes, 0);
  assert.equal(getPendingHevyMutation(), undefined);
});

test('persists a runtime-resolved exercise ID for later overwrite checks', async () => {
  getDb().prepare('DELETE FROM config WHERE key IN (?, ?)').run('routine_id', 'last_routine_payload');
  const initialClient = {
    async searchExerciseTemplates() {
      return [{ id: 'cable-fly', title: 'Cable Fly' }];
    },
    async createRoutine() {
      return { routineId: 'routine-fly' };
    },
  } as unknown as HevyClient;
  const initialResult = await new ToolExecutor(initialClient).execute('hevy_push_routine', {
    title: 'Fixture',
    exercises: [{ name: 'Cable Fly', sets: [{ weight_lbs: 25, reps: 12 }] }],
  });
  assert.match(initialResult, /Routine created/);
  assert.equal(
    (getDb().prepare('SELECT template_id FROM exercise_map WHERE display_name = ?').get('Cable Fly') as { template_id: string }).template_id,
    'cable-fly',
  );

  let writes = 0;
  const currentRoutine = buildRoutineSnapshot(
    'Fixture',
    [{ name: 'Cable Fly', sets: [{ type: 'normal', weightLbs: 25, reps: 12 }] }],
    new Map([['cable fly', 'cable-fly']]),
  );
  const freshClient = {
    async getRoutineSnapshot() { return currentRoutine; },
    async updateRoutine() { writes++; },
  } as unknown as HevyClient;
  const result = await new ToolExecutor(freshClient).execute('hevy_push_routine', {
    title: 'Next',
    exercises: [{ name: 'Cable Fly', sets: [{ weight_lbs: 30, reps: 10 }] }],
  });
  assert.match(result, /Routine updated/);
  assert.equal(writes, 1);
});
