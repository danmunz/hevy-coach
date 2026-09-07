import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkoutSync, startWorkoutPolling, type PollingClock } from '../src/coach/workout-sync.js';
import { readWorkoutCache, replaceWorkoutCache } from '../src/state/workouts.js';
import { configureDbPathForTests, closeDbForTests, getDb } from '../src/state/db.js';
import type { HevyWorkoutEvent, HevyCompletedWorkout } from '../src/hevy/types.js';
const dir = mkdtempSync(join(tmpdir(),'hevy-sync-test-'));
configureDbPathForTests(join(dir,'state.db'));
test.after(() => {closeDbForTests(); rmSync(dir,{recursive:true,force:true});});
const workout = (id:string, startTime='2026-09-07T10:00:00Z'):HevyCompletedWorkout => ({id,title:id,startTime,exercises:[]});

test('sync shares scans, applies newest events, refills deletion, and preserves state on failure',async () => {
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
 const before=readWorkoutCache();
 now+=60_000;fail=true;
 await assert.rejects(sync.synchronize(),/scan failed/);
 assert.deepEqual(readWorkoutCache(),before);
});

test('foreground waits for a scan started after activation',async()=>{
 let now=Date.now();let finish!:()=>void;let calls=0;
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>{
  calls++;await new Promise<void>(resolve=>{finish=resolve;});return [];
 },getWorkoutEvents:async()=>{calls++;return [];}},()=>now);
 const background=sync.synchronize();
 now+=10;
 const foreground=sync.synchronize(now);
 finish();
 await Promise.all([background,foreground]);
 assert.equal(calls,2);
});

test('cache stores pounds and preserves fractional API precision',()=>{
 const w=workout('fractional');w.exercises=[{title:'Dumbbell',sets:[{weightKg:10.206,reps:8}]}];
 replaceWorkoutCache([w],new Date().toISOString());
 assert.equal(readWorkoutCache().workouts[0].exercises[0].sets[0].weightKg,10.206);
 const row=getDb().prepare('SELECT payload FROM workout_cache').get() as {payload:string};
 assert.doesNotMatch(row.payload,/weightKg/);
 assert.match(row.payload,/weightLbs/);
});

test('latest ten survive inserts and date edits across the cutoff with numeric date ordering',async()=>{
 let now=Date.parse('2026-09-07T12:00:00Z');
 let recent=Array.from({length:10},(_,i)=>workout(String(i),new Date(now-i*60_000).toISOString()));
 let events:HevyWorkoutEvent[]=[];
 let reads=0;
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>{reads++;return recent;},getWorkoutEvents:async()=>events},()=>now);
 await sync.synchronize();
 now+=60_000;
 // 08:01 -04:00 is later than 12:00 Z, despite lexical ordering.
 events=[{type:'updated',workout:workout('new','2026-09-07T08:01:00-04:00')}];
 await sync.synchronize();
 assert.equal(readWorkoutCache().workouts.length,10);
 assert.equal(readWorkoutCache().workouts[0].id,'new');
 assert.equal(readWorkoutCache().workouts.some(w=>w.id==='9'),false);
 now+=60_000;
 events=[{type:'updated',workout:workout('new','2026-01-01T00:00:00Z')}];
 await sync.synchronize();
 assert.equal(reads,2);
 assert.equal(readWorkoutCache().workouts[0].id,'0');
 assert.equal(readWorkoutCache().workouts.at(-1)?.id,'9');
});

test('failed refill and failed checkpoint write preserve payload and checkpoint together',async()=>{
 let events:HevyWorkoutEvent[]=[];let fail=false;
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>{if(fail)throw Error('refill failed');return [workout('a')];},getWorkoutEvents:async()=>events});
 await sync.synchronize();
 const before=readWorkoutCache();
 events=[{type:'deleted',id:'a'}];fail=true;
 await assert.rejects(sync.synchronize(),/refill failed/);
 assert.deepEqual(readWorkoutCache(),before);
 fail=false;events=[{type:'updated',workout:{...workout('a'),title:'changed'}}];
 getDb().exec("CREATE TEMP TRIGGER reject_checkpoint BEFORE INSERT ON workout_checkpoint BEGIN SELECT RAISE(ABORT, 'storage failed'); END");
 try {
  await assert.rejects(sync.synchronize(),/storage failed/);
  assert.deepEqual(readWorkoutCache(),before);
 } finally {getDb().exec('DROP TRIGGER reject_checkpoint');}
 await sync.synchronize();
 assert.equal(readWorkoutCache().workouts[0].title,'changed');
});

test('restart and hourly reconciliation rebuild latest ten without relying on retained events',async()=>{
 let now=Date.parse('2026-09-07T12:00:00Z');let reads=0;let eventReads=0;
 const client={getRecentWorkoutRecords:async()=>{reads++;return [workout(String(reads))];},getWorkoutEvents:async()=>{eventReads++;return [];}};
 const sync=new WorkoutSync(client,()=>now);
 await sync.synchronize();
 now+=300_000;await sync.synchronize();assert.equal(eventReads,1);
 now+=3_600_000;await sync.synchronize();assert.equal(reads,2);
 closeDbForTests();
 const restarted=new WorkoutSync(client,()=>now);
 await restarted.synchronize();
 assert.equal(reads,3);
 assert.equal(readWorkoutCache().workouts[0].id,'3');
});

test('invalid dates cannot advance the cache checkpoint',async()=>{
 const before=readWorkoutCache();
 const sync=new WorkoutSync({getRecentWorkoutRecords:async()=>[workout('invalid','invalid')],getWorkoutEvents:async()=>[]});
 await assert.rejects(sync.synchronize(),/start time/);
 assert.deepEqual(readWorkoutCache(),before);
});

const settle=async()=>{await new Promise<void>(resolve=>setImmediate(resolve));};
function fakeClock() {
 const pending:Array<{callback:()=>void;delay:number;canceled:boolean}>=[];
 const clock:PollingClock={random:()=>0.5,schedule:(callback,delay)=>{
  const entry={callback,delay,canceled:false};pending.push(entry);return()=>{entry.canceled=true;};
 }};
 return {clock,pending,fire:()=>{const entry=pending.shift();assert.ok(entry);if(!entry.canceled)entry.callback();}};
}
test('disabled polling makes no request or timer',()=>{
 const {clock,pending}=fakeClock();let calls=0;
 startWorkoutPolling({synchronize:async()=>{calls++;return {workouts:[],checkedAt:null};}},0,clock)();
 assert.equal(calls,0);assert.equal(pending.length,0);
});

test('polling waits for completion, backs off, recovers, and cancels the next timer',async()=>{
 const {clock,pending,fire}=fakeClock();let finish!:()=>void;let calls=0;let fail=false;
 const stop=startWorkoutPolling({synchronize:async()=>{
  calls++;if(calls===1)await new Promise<void>(resolve=>{finish=resolve;});
  if(fail)throw Error('offline');return {workouts:[],checkedAt:null};
 }},300,clock);
 assert.equal(calls,1);assert.equal(pending.length,0);
 finish();await settle();assert.equal(pending[0].delay,302500);
 fail=true;fire();await settle();assert.equal(pending[0].delay,602500);
 fire();await settle();assert.equal(pending[0].delay,1202500);
 fail=false;fire();await settle();assert.equal(pending[0].delay,302500);
 stop();fire();assert.equal(calls,4);
});

test('stopping an active poll prevents rescheduling',async()=>{
 const {clock,pending}=fakeClock();let finish!:()=>void;
 const stop=startWorkoutPolling({synchronize:async()=>{
  await new Promise<void>(resolve=>{finish=resolve;});return {workouts:[],checkedAt:null};
 }},300,clock);
 stop();finish();await settle();assert.equal(pending.length,0);
});
