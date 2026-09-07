import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkoutSync } from '../src/coach/workout-sync.js';
import { readWorkoutCache } from '../src/state/workouts.js';
import { configureDbPathForTests, closeDbForTests } from '../src/state/db.js';
import type { HevyWorkoutEvent, HevyCompletedWorkout } from '../src/hevy/types.js';
const dir = mkdtempSync(join(tmpdir(),'hevy-sync-test-'));
configureDbPathForTests(join(dir,'state.db'));
test.after(() => {closeDbForTests(); rmSync(dir,{recursive:true,force:true});});
const workout = (id:string):HevyCompletedWorkout => ({id,title:id,startTime:'2026-09-07T10:00:00Z',exercises:[]});
test('sync shares requests, applies latest events, refills deletion, and preserves checkpoint on failure',async () => {
 let now = Date.parse('2026-09-07T12:00:00Z');
 let reads=0;
 let fail=false;
 let events:HevyWorkoutEvent[]=[];
 let recent=[workout('a')];
 const sync=new WorkoutSync({
  getRecentWorkoutRecords:async()=>{reads++;return recent;},
  getWorkoutEvents:async since=>{assert.equal(since,new Date(now-120_000).toISOString());if(fail)throw Error('scan failed');return events;},
 },()=>now);
 await Promise.all([sync.synchronize(),sync.synchronize()]);
 assert.equal(reads,1);
 now+=60_000;
 events=[{type:'updated',workout:{...workout('a'),title:'latest'}},{type:'updated',workout:{...workout('a'),title:'old'}}];
 await sync.synchronize();
 assert.equal(readWorkoutCache().workouts[0].title,'latest');
 now+=60_000; events=[{type:'deleted',id:'a'}];recent=[workout('b')];
 await sync.synchronize();assert.equal(readWorkoutCache().workouts[0].id,'b');
 const checkpoint=readWorkoutCache().checkedAt;
 now+=60_000;fail=true;
 await assert.rejects(sync.synchronize(),/scan failed/);
 assert.equal(readWorkoutCache().checkedAt,checkpoint);
});

test('foreground waits for a scan started after activation',async()=>{
 let now=Date.now();let finish!:()=>void;let calls=0;
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>[],getWorkoutEvents:async()=>{
  calls++;if(calls===1)await new Promise<void>(resolve=>{finish=resolve;});return [];
 }},()=>now);
 const background=sync.synchronize();
 await new Promise(resolve=>setTimeout(resolve,0));
 now+=10;
 const foreground=sync.synchronize(now);
 finish();
 await Promise.all([background,foreground]);
 assert.equal(calls,2);
});

test('cache preserves fractional weights in pound storage',async()=>{
 const {replaceWorkoutCache}=await import('../src/state/workouts.js');
 const w=workout('fractional');w.exercises=[{title:'Dumbbell',sets:[{weightKg:10.206,reps:8}]}];
 replaceWorkoutCache([w],new Date().toISOString());
 assert.equal(readWorkoutCache().workouts[0].exercises[0].sets[0].weightKg,10.206);
});
