import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { COACHING_SCENARIOS, CoachingFixtureClient, seedCoachingState, coachingStateSnapshot, assessCoachingTools } from '../scripts/coaching-fixtures.js';
import { closeDbForTests, configureDbPathForTests, getDb } from '../src/state/db.js';
import type { ToolCallMetrics } from '../src/claude/client.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coaching-tests-'));
test.after(() => { closeDbForTests(); fs.rmSync(scratch, { recursive: true, force: true }); });
test.beforeEach(() => {
  closeDbForTests();
  configureDbPathForTests(path.join(scratch, `state-${crypto.randomUUID()}.db`));
  seedCoachingState();
});

test('fixtures remain offline, distinguish empty history from failures, and change between calibration turns', async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network call'); };
  try {
    const empty = new CoachingFixtureClient(COACHING_SCENARIOS.find(s => s.id === 'empty_history')!);
    assert.match(await empty.getExerciseHistory('fixture-row'), /No history/);
    const failure = new CoachingFixtureClient(COACHING_SCENARIOS.find(s => s.id === 'history_failure')!);
    await assert.rejects(failure.getExerciseHistory('fixture-row'), /service unavailable/);
    const variant = new CoachingFixtureClient(COACHING_SCENARIOS.find(s => s.id === 'variant_calibration')!);
    assert.match(await variant.getExerciseHistory('fixture-v-grip'), /No history/);
    variant.turn = 1;
    assert.match(await variant.getExerciseHistory('fixture-v-grip'), /3x50x12@8/);
    assert.match(await variant.getRecentWorkouts(), /Lower A/);
  } finally { globalThis.fetch = fetch; }
});

test('captured remote writes fail assessment even without a tool trace', async () => {
  const scenario = COACHING_SCENARIOS[4];
  const fixture = new CoachingFixtureClient(scenario);
  const before = coachingStateSnapshot();
  await fixture.createRoutine('Unexpected', [{ name: 'Seated Row', sets: [{ type: 'normal', weightLbs: 70, reps: 12 }] }],
    new Map([['seated row', 'fixture-row']]));
  assert.match(assessCoachingTools(scenario, [], fixture, before).join(), /Unexpected Hevy routine write/);
});

test('assessment detects mutation attempts, real scratch mutations, and missing history', () => {
  const scenario = COACHING_SCENARIOS[0];
  const fixture = new CoachingFixtureClient(scenario);
  const before = coachingStateSnapshot();
  const read: ToolCallMetrics = { iteration: 1, name: 'hevy_get_exercise_history', input: {}, result: 'history', elapsedMs: 0 };
  assert.match(assessCoachingTools(scenario, [read], fixture, before).join(), /exact exercise variant/);
  fixture.calls.push('getExerciseHistory:fixture-row');
  assert.deepEqual(assessCoachingTools(scenario, [read], fixture, before), []);
  assert.match(assessCoachingTools(scenario, [], fixture, before).join(), /Missing exercise-history/);
  for (const name of ['save_note', 'update_training_maxes', 'hevy_prepare_routine', 'hevy_push_draft', 'hevy_push_routine']) {
    assert.match(assessCoachingTools(scenario, [read, { ...read, name }], fixture, before).join(), /Unexpected mutation/);
  }
  getDb().prepare("UPDATE config SET value='changed' WHERE key='goals'").run();
  assert.match(assessCoachingTools(scenario, [read], fixture, before).join(), /durable coaching state/);
});

test('dry-run isolates an explicitly supplied sentinel database and makes no model calls', () => {
  const sentinel = path.join(scratch, 'do-not-open.db');
  fs.writeFileSync(sentinel, 'not a database; must remain untouched');
  const output = path.join(scratch, 'dry-run.json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-coaching.ts', '--dry-run', '--output', output], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, HEVY_COACH_DB_PATH: sentinel, ANTHROPIC_API_KEY: '', HEVY_API_KEY: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'not a database; must remain untouched');
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.results.length, COACHING_SCENARIOS.length * 2);
  for (const row of report.results) {
    assert.equal(row.automatedPassed, null);
    assert.deepEqual(row.modelCalls, []);
    assert.deepEqual(row.toolCalls, []);
    assert.deepEqual(row.routineWrites, []);
  }
});

test('scenario selection runs exactly two cases and invalid selection fails before evaluation', () => {
  const output = path.join(scratch, 'selected.json');
  const run = (id: string) => spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/evaluate-coaching.ts', '--dry-run', '--scenario', id, '--output', output],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  assert.equal(run('missing_effort').status, 0);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(report.results.map((row: { id: string }) => row.id), ['missing_effort', 'missing_effort']);
  assert.notEqual(run('not-a-scenario').status, 0);
});
