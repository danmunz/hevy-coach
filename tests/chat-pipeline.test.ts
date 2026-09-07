import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { FixtureHevyClient, seedEffortFixtureState } from '../scripts/effort-fixtures.js';
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

test('saving a note preserves checked routines for reads after the write', async () => {
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
  assert.deepEqual(hevy.calls, []);
  assert.deepEqual(results().map(result => result.tool_use_id), ['before', 'mutation', 'after', 'duplicate-after']);
  assert.match(results()[0].content, /stale-routine/);
  assert.match(results()[2].content, /stale-routine/);
  assert.equal(results()[2].content, results()[3].content);
  assert.match(JSON.stringify(requests[1].system), /Fixture checked context/);
  assert.equal(responses.length, 0);
});


test('explicit workout refresh replaces old data across model iterations', async () => {
  const hevy = new FixtureHevyClient();
  script([tool('refresh', 'hevy_get_recent_workouts', {refresh:true, count:1})], [tool('later', 'hevy_get_recent_workouts', {count:1})]);
  await chat('Refresh.', {persist:false, hevyClient:hevy, freshWorkouts:[{id:'old',title:'OLD SNAPSHOT',exercises:[]}]});
  assert.deepEqual(hevy.calls, ['getRecentWorkouts:1']);
  assert.doesNotMatch(results()[0].content, /OLD SNAPSHOT/);
  assert.match(JSON.stringify(requests.at(-1)?.system), /Latest successful tool check/);
});

test('explicit routine refresh replaces old data before a later default read', async () => {
  const hevy = new FixtureHevyClient();
  script([tool('refresh', 'hevy_get_routines', {refresh:true}), tool('later', 'hevy_get_routines')]);
  await chat('Refresh.', {persist:false, hevyClient:hevy, freshRoutines:[{id:'old',title:'OLD SNAPSHOT'}]});
  assert.deepEqual(hevy.calls, ['getRoutines']);
  assert.equal(results()[0].content, results()[1].content);
  assert.doesNotMatch(results()[1].content, /OLD SNAPSHOT/);
});

test('invalid workout counts fail identically with and without checked data', async () => {
  for (const count of [0, 1.5, 11, '5', null]) {
    const outputs:string[]=[];
    for (const cached of [true,false]) {
      const hevy = new FixtureHevyClient();
      script([tool('invalid', 'hevy_get_recent_workouts', {count})]);
      await chat('Check.', {persist:false, hevyClient:hevy, freshWorkouts:cached?[]:undefined});
      assert.deepEqual(hevy.calls, []);
      outputs.push(results()[0].content);
    }
    assert.equal(outputs[0],outputs[1]);
    assert.match(outputs[0], /integer from 1 through 10/);
  }
});

test('failed refresh marks old context unavailable and retries on a later read', async () => {
  class FailedRead extends FixtureHevyClient {
    override async getRecentWorkouts():Promise<string> {this.calls.push('failed');throw Error('offline fixture');}
  }
  const hevy=new FailedRead();
  script([tool('refresh','hevy_get_recent_workouts',{refresh:true})], [tool('later','hevy_get_recent_workouts')]);
  await chat('Refresh.',{persist:false,hevyClient:hevy,freshContext:'<checked_workouts>OLD SNAPSHOT</checked_workouts>',freshWorkouts:[]});
  assert.deepEqual(hevy.calls,['failed','failed']);
  assert.match(JSON.stringify(requests.at(-1)?.system),/Current data is unavailable/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.system),/OLD SNAPSHOT/);
});

test('blocked and failed routine writes preserve checked routines', async () => {
  for (const allowMutations of [false,true]) {
    const hevy=new FixtureHevyClient();
    script([tool('write','hevy_push_routine',{}),tool('read','hevy_get_routines')]);
    await chat('Write.',{persist:false,hevyClient:hevy,allowMutations,freshRoutines:[{id:'preserved',title:'Preserved'}]});
    assert.match(results()[1].content,/preserved/);
    assert.deepEqual(hevy.calls,[]);
  }
});


test('successful routine write invalidates only routine context', async () => {
  seedEffortFixtureState();
  const hevy=new FixtureHevyClient();
  script([tool('write','hevy_push_routine',{title:'Changed routine',overwrite_external_changes:true,exercises:[{name:'Squat',sets:[{weight_lbs:100,reps:5}]}]})], [tool('routines','hevy_get_routines'),tool('workouts','hevy_get_recent_workouts')]);
  await chat('Approved fixture write.',{persist:false,hevyClient:hevy,freshContext:'<checked_workouts>KEEP WORKOUT</checked_workouts><checked_routines>OLD ROUTINE</checked_routines>',freshWorkouts:[],freshRoutines:[{id:'old',title:'Old'}]});
  assert.ok(hevy.calls.some(call=>call.startsWith('updateRoutine')));
  assert.ok(hevy.calls.includes('getRoutines'));
  assert.ok(!hevy.calls.some(call=>call.startsWith('getRecentWorkouts')));
  assert.match(JSON.stringify(requests[1].system),/KEEP WORKOUT/);
  assert.doesNotMatch(JSON.stringify(requests[1].system),/OLD ROUTINE/);
  assert.match(JSON.stringify(requests[1].system),/Routine data changed/);
});

test('routine detail tool returns complete sets in pounds', async () => {
 const hevy=new FixtureHevyClient();
 script([tool('details','hevy_get_routines',{routine_id:'fixture-standing-routine'})]);
 await chat('Details.',{persist:false,hevyClient:hevy,freshRoutines:[]});
 assert.deepEqual(hevy.calls,['getRoutineSnapshot:fixture-standing-routine']);
 assert.match(results()[0].content,/weight_lbs/);
 assert.doesNotMatch(results()[0].content,/weightKg/);
});


test('each explicit refresh makes a new read even for consecutive identical calls', async () => {
 const hevy=new FixtureHevyClient();
 script([tool('one','hevy_get_routines',{refresh:true}),tool('two','hevy_get_routines',{refresh:true})]);
 await chat('Refresh twice.',{persist:false,hevyClient:hevy});
 assert.deepEqual(hevy.calls,['getRoutines','getRoutines']);
});

test('invalid refresh input reports an error before cached or remote reads', async () => {
 const hevy=new FixtureHevyClient();
 script([tool('bad','hevy_get_recent_workouts',{refresh:'true'})]);
 await chat('Refresh.',{persist:false,hevyClient:hevy,freshWorkouts:[]});
 assert.deepEqual(hevy.calls,[]);
 assert.match(results()[0].content,/Refresh must be true or false/);
});

test('successful note changes rebuild local context without changing static prefix', async () => {
 const hevy=new FixtureHevyClient();
 script([tool('note','save_note',{content:'UNIQUE NEW FIXTURE NOTE'})]);
 await chat('Save reminder.',{persist:false,hevyClient:hevy});
 const before=requests[0].system as Array<{text:string}>;
 const after=requests[1].system as Array<{text:string}>;
 assert.equal(before[0].text,after[0].text);
 assert.doesNotMatch(before[1].text,/UNIQUE NEW FIXTURE NOTE/);
 assert.match(after[1].text,/UNIQUE NEW FIXTURE NOTE/);
});

test('failed routine refresh removes the checked routine list', async () => {
 class FailedRoutine extends FixtureHevyClient {
   override async getRoutines():Promise<[]> {this.calls.push('failed routine');throw Error('offline fixture');}
 }
 const hevy=new FailedRoutine();
 script([tool('refresh','hevy_get_routines',{refresh:true})],[tool('later','hevy_get_routines')]);
 await chat('Refresh.',{persist:false,hevyClient:hevy,freshRoutines:[{id:'old',title:'OLD ROUTINE'}],freshContext:'<checked_routines>OLD ROUTINE</checked_routines>'});
 assert.deepEqual(hevy.calls,['failed routine','failed routine']);
 assert.match(JSON.stringify(requests.at(-1)?.system),/Current data is unavailable/);
 assert.doesNotMatch(JSON.stringify(requests.at(-1)?.system),/OLD ROUTINE/);
});

test('omitted workout count defaults to five before the remote call', async () => {
 const hevy=new FixtureHevyClient();
 script([tool('default','hevy_get_recent_workouts')]);
 await chat('Check.',{persist:false,hevyClient:hevy});
 assert.deepEqual(hevy.calls,['getRecentWorkouts:5']);
});
