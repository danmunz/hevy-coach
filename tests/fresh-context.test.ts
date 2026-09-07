import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureDbPathForTests,closeDbForTests} from '../src/state/db.js';
import {prepareFreshContext} from '../src/coach/fresh-context.js';
import {WorkoutSync} from '../src/coach/workout-sync.js';
import {FixtureHevyClient,seedEffortFixtureState} from '../scripts/effort-fixtures.js';
import {assembleSystemPrompt} from '../src/claude/context.js';
const dir=mkdtempSync(join(tmpdir(),'hevy-context-test-'));
configureDbPathForTests(join(dir,'state.db'));
test.after(()=>{closeDbForTests();rmSync(dir,{recursive:true,force:true});});
test('checked context stays below static cache marker',async()=>{
 seedEffortFixtureState();
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>[],getWorkoutEvents:async()=>[]});
 const context=await prepareFreshContext(sync,new FixtureHevyClient());
 const prompt=assembleSystemPrompt(context.text);
 assert.match(prompt[1].text,/Checked Hevy context/);
 assert.doesNotMatch(prompt[0].text,/Workout check started/);
 assert.equal(prompt[0].cache_control?.type,'ephemeral');
 assert.equal(prompt[1].cache_control,undefined);
 assert.match(context.text,/Squat/);
 assert.doesNotMatch(context.text,/weightKg/);
});
test('failed check reports unavailable freshness',async()=>{
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>{throw Error('offline');},getWorkoutEvents:async()=>{throw Error('offline');}});
 const context=await prepareFreshContext(sync,new FixtureHevyClient());
 assert.match(context.text,/Workout freshness check failed/);
 assert.equal(context.workouts,undefined);
});
test('foreground deadline bounds wait for shared synchronization',async()=>{
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>new Promise(()=>{}),getWorkoutEvents:async()=>new Promise(()=>{})});
 await assert.rejects(prepareFreshContext(sync,new FixtureHevyClient(),Date.now()+10),/too long/);
});

test('foreground deadline bounds routine request',async()=>{
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>[],getWorkoutEvents:async()=>[]});
 class HangingRoutineClient extends FixtureHevyClient {
  override async getRoutineSnapshot():Promise<Awaited<ReturnType<FixtureHevyClient['getRoutineSnapshot']>>> {return new Promise(()=>{});}
 }
 await assert.rejects(prepareFreshContext(sync,new HangingRoutineClient(),Date.now()+10),/too long/);
});
