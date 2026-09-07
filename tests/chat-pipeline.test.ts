import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { FixtureHevyClient } from '../scripts/effort-fixtures.js';
import { configureDbPathForTests, closeDbForTests } from '../src/state/db.js';

const directory = mkdtempSync(join(tmpdir(), 'hevy-chat-pipeline-'));
configureDbPathForTests(join(directory, 'state.db'));
const originalFetch = globalThis.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;
const originalBase = process.env.ANTHROPIC_BASE_URL;
process.env.ANTHROPIC_API_KEY = 'isolated-fixture-key';
process.env.ANTHROPIC_BASE_URL = 'https://isolated-model.invalid';
let responses: Anthropic.ContentBlockParam[][] = [];
let requests: Record<string, unknown>[] = [];

// Replace transport before the module constructs its SDK singleton. Never delegate to real fetch.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assert.equal(new URL(url).origin, 'https://isolated-model.invalid');
  const body = input instanceof Request ? await input.text() : String(init?.body);
  requests.push(JSON.parse(body) as Record<string, unknown>);
  const content = responses.shift();
  assert.ok(content, 'Unexpected model request');
  return Response.json({
    id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: 'fixture-model', content,
    stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  });
};
const { chat } = await import('../src/claude/client.js');

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalBase;
  closeDbForTests();
  rmSync(directory, { recursive: true, force: true });
});

function tool(id: string, name: string, input: Record<string, unknown> = {}): Anthropic.ToolUseBlockParam {
  return { type: 'tool_use', id, name, input };
}
function script(...turns: Anthropic.ContentBlockParam[][]): void {
  requests = [];
  responses = [...turns, [{ type: 'text', text: 'Complete.' }]];
}
function results(): Array<{ tool_use_id: string; content: string }> {
  const messages = requests.at(-1)?.messages as Array<{ content: unknown }>;
  return messages.at(-1)?.content as Array<{ tool_use_id: string; content: string }>;
}

test('identical consecutive reads share one Hevy request and retain every tool result', async () => {
  const hevy = new FixtureHevyClient();
  script([tool('first', 'hevy_get_recent_workouts', { count: 5 }), tool('second', 'hevy_get_recent_workouts', { count: 5 })]);
  assert.equal(await chat('Check workouts.', { persist: false, hevyClient: hevy }), 'Complete.');
  assert.deepEqual(hevy.calls, ['getRecentWorkouts:5']);
  assert.equal(requests.length, 2);
  assert.deepEqual(results().map(result => result.tool_use_id), ['first', 'second']);
  assert.equal(results()[0].content, results()[1].content);
  assert.equal(responses.length, 0);
});

test('fresh workout and routine records avoid remote reads', async () => {
  const hevy = new FixtureHevyClient();
  script([tool('workouts', 'hevy_get_recent_workouts', { count: 1 }), tool('routines', 'hevy_get_routines')]);
  await chat('Check current data.', {
    persist: false, hevyClient: hevy,
    freshWorkouts: [{ id: 'fresh-workout', title: 'Fresh workout', startTime: '2026-09-07T12:00:00Z', exercises: [] }],
    freshRoutines: [{ id: 'fresh-routine', title: 'Fresh routine' }],
  });
  assert.deepEqual(hevy.calls, []);
  assert.match(results()[0].content, /Fresh workout/);
  assert.match(results()[1].content, /fresh-routine/);
  assert.equal(responses.length, 0);
});

test('mutation barrier invalidates routine context for reads after the write', async () => {
  const hevy = new FixtureHevyClient();
  script([
    tool('before', 'hevy_get_routines'),
    tool('mutation', 'save_note', { content: 'Fixture-only reminder.' }),
    tool('after', 'hevy_get_routines'),
    tool('duplicate-after', 'hevy_get_routines'),
  ]);
  await chat('Save this fixture reminder.', {
    persist: false, hevyClient: hevy, freshContext: 'Fixture checked context.',
    freshRoutines: [{ id: 'stale-routine', title: 'Earlier routine' }],
  });
  assert.deepEqual(hevy.calls, ['getRoutines']);
  assert.deepEqual(results().map(result => result.tool_use_id), ['before', 'mutation', 'after', 'duplicate-after']);
  assert.match(results()[0].content, /stale-routine/);
  assert.doesNotMatch(results()[2].content, /stale-routine/);
  assert.equal(results()[2].content, results()[3].content);
  assert.match(JSON.stringify(requests[1].system), /invalidated by a mutation/);
  assert.equal(responses.length, 0);
});
