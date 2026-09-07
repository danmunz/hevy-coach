import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureDbPathForTests,closeDbForTests} from '../src/state/db.js';
import {prepareFreshContext, contextSection} from '../src/coach/fresh-context.js';
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
 console.log(`[fixture-size] name=prepared_normal context_bytes=${Buffer.byteLength(context.text)} estimated_tokens=${Math.ceil(context.text.length/4)} estimate_method=characters_divided_by_4 not_billed_usage=true`);
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


test('automatic context bounds large notes and preserves full tool data', async () => {
 const records=[{id:'large',startTime:'2026-09-07T12:00:00Z',title:'Large fixture',description:'長'.repeat(20000),exercises:[]}];
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>records,getWorkoutEvents:async()=>[]});
 // Use a new cache seed for this isolated size fixture.
 const {replaceWorkoutCache}=await import('../src/state/workouts.js');
 replaceWorkoutCache(records,new Date().toISOString());
 const context=await prepareFreshContext(sync,new FixtureHevyClient());
 assert.ok(Buffer.byteLength(context.text)<10000);
 assert.match(context.text,/Incomplete excerpt/);
 assert.equal(context.workouts?.[0].description,records[0].description);
 assert.ok(Buffer.byteLength(context.recentWorkouts!)>60000);
});

test('offline context size fixtures report bytes and estimated tokens separately', () => {
 for (const [name,payload] of [['normal','Squat: 3x205x5\n'.repeat(20)],['large','長 notes '.repeat(20000)]]) {
   const excerpt=contextSection('workouts',payload,6000);
   const bytes=Buffer.byteLength(excerpt);
   assert.ok(bytes<=6040);
   assert.doesNotMatch(excerpt,/�/);
   console.log(`[fixture-size] name=${name} source_bytes=${Buffer.byteLength(payload)} excerpt_bytes=${bytes} estimated_tokens=${Math.ceil(excerpt.length/4)} estimate_method=characters_divided_by_4 not_billed_usage=true`);
 }
});


test('an explicit deadline error propagates even before the wall clock deadline',async()=>{
 const {TurnDeadlineError}=await import('../src/claude/turn-queue.js');
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>{throw new TurnDeadlineError();},getWorkoutEvents:async()=>{throw new TurnDeadlineError();}});
 await assert.rejects(prepareFreshContext(sync,new FixtureHevyClient(),Date.now()+60000),TurnDeadlineError);
});
