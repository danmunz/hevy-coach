import type { HevyToolClient } from '../hevy/client.js';
import { getDb } from '../state/db.js';
import { TurnDeadlineError } from '../claude/turn-queue.js';
import { getConfig } from '../state/config.js';
import { summarizeWorkouts } from '../hevy/summarize.js';
import { kilogramsToPounds } from '../hevy/utils.js';
import type { CachedWorkout, HevyRoutineRecord } from '../hevy/types.js';
import type { WorkoutSync } from './workout-sync.js';

export interface FreshContext { text: string; recentWorkouts?: string; workouts?: CachedWorkout[]; routines?: HevyRoutineRecord[]; }
export async function prepareFreshContext(sync: WorkoutSync, client: HevyToolClient, deadlineAt = Date.now()+75_000): Promise<FreshContext> {
  const routineId = getConfig('routine_id');
  const [workouts, routine] = await Promise.allSettled([
    withinDeadline(sync.synchronize(Date.now()), deadlineAt),
    withinDeadline((async () => routineId ? client.getRoutineSnapshot(routineId) : client.getRoutines())(), deadlineAt),
  ]);
  for (const result of [workouts, routine]) {
    if (result.status === 'rejected' && result.reason instanceof TurnDeadlineError) throw result.reason;
  }
  if (Date.now() >= deadlineAt) throw new TurnDeadlineError();
  const names = getDb().prepare('SELECT template_id, hevy_title FROM exercise_map').all() as {template_id:string;hevy_title:string}[];
  const text: string[] = ['## Checked Hevy context'];
  let recentWorkouts: string | undefined;
  if (workouts.status === 'fulfilled') {
    recentWorkouts = summarizeWorkouts(workouts.value.workouts);
    text.push(contextSection('workouts', `Workout check started at ${workouts.value.checkedAt}. Coverage: ${workouts.value.workouts.length} latest workouts.\n${recentWorkouts}`, 6000));
  } else text.push(contextSection('workouts', 'Workout freshness check failed. Do not describe previous workout data as current. Use tools to retry if necessary.', 6000));
  const routineText: string[] = [];
  if (routine.status === 'fulfilled' && !('error' in routine.value)) {
    const value = routine.value;
    if (Array.isArray(value)) routineText.push(`Routine list checked at ${new Date().toISOString()}: ${JSON.stringify(value)}`);
    else if ('exercises' in value) routineText.push(`Standing routine checked at ${new Date().toISOString()}: ${JSON.stringify({
      id: routineId,
      title: value.title,
      exercises: value.exercises.map(ex => ({ exercise: names.find(name=>name.template_id===ex.exerciseTemplateId)?.hevy_title ?? `Unresolved exercise ${ex.exerciseTemplateId}`, sets: ex.sets.map(set => ({type:set.type, weight_lbs:kilogramsToPounds(set.weightKg), reps:set.reps})) })),
    })}`);
    else routineText.push('Routine freshness check failed. Do not assume that the standing routine is current.');
  } else routineText.push('Routine freshness check failed. Do not assume that the standing routine is current.');
  text.push(contextSection('routines', routineText.join('\n'), 3000));
  text.push('Use this checked context before requesting the same information again. Keep explicit approval rules. Check the remote routine again before overwriting it.');
  return {routines: routine.status === 'fulfilled' && Array.isArray(routine.value) ? routine.value : undefined, text:text.join('\n\n'), recentWorkouts, workouts: workouts.status === 'fulfilled' ? workouts.value.workouts : undefined};
}

async function withinDeadline<T>(work:Promise<T>, deadlineAt:number):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new TurnDeadlineError()),Math.max(0,deadlineAt-Date.now()));})]); }
 finally {if(timer)clearTimeout(timer);}
}

/** Bound automatic excerpts only. Full tool results keep all available details. */
export function contextSection(kind: 'workouts' | 'routines', value: string, maximumBytes: number): string {
  const omitted = '\n[Incomplete excerpt. Details and possibly part of the final record are omitted. Use the Hevy read tool for complete details. For a routine, pass its routine_id.]';
  let body = value;
  if (Buffer.byteLength(body) > maximumBytes) {
    const bytes = Buffer.from(body);
    let end = maximumBytes - Buffer.byteLength(omitted);
    // Stop before an incomplete UTF-8 code point.
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    body = bytes.subarray(0, end).toString('utf8') + omitted;
  }
  return `<checked_${kind}>\n${body}\n</checked_${kind}>`;
}
