import { getDb } from './db.js';
import { poundsToRoundedKilograms } from '../hevy/utils.js';
import type { HevyCompletedWorkout } from '../hevy/types.js';

function database() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS workout_cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workout_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), checked_at TEXT NOT NULL);`);
  return db;
}
type StoredWorkout = Omit<HevyCompletedWorkout, 'exercises'> & {exercises: Array<Omit<HevyCompletedWorkout['exercises'][number], 'sets'> & {sets: Array<Omit<HevyCompletedWorkout['exercises'][number]['sets'][number], 'weightKg'> & {weightLbs?:number|null}>}>};

export function readWorkoutCache(): { checkedAt: string | null; workouts: HevyCompletedWorkout[] } {
  const db = database();
  const checkpoint = db.prepare('SELECT checked_at FROM workout_checkpoint WHERE id=1').get() as {checked_at:string} | undefined;
  const rows = db.prepare('SELECT payload FROM workout_cache').all() as {payload:string}[];
  return { checkedAt: checkpoint?.checked_at ?? null, workouts: rows.map(row => decode(JSON.parse(row.payload) as StoredWorkout)) };
}
export function replaceWorkoutCache(workouts: HevyCompletedWorkout[], checkedAt: string): void {
  const db = database();
  db.transaction(() => {
    db.prepare('DELETE FROM workout_cache').run();
    const insert = db.prepare('INSERT INTO workout_cache(id,payload) VALUES (?,?)');
    for (const workout of workouts) insert.run(workout.id, JSON.stringify({...workout,exercises:workout.exercises.map(ex=>({...ex,sets:ex.sets.map(({weightKg,...set})=>({...set,weightLbs:weightKg == null ? weightKg : weightKg / 0.45359237}))}))}));
    db.prepare('INSERT OR REPLACE INTO workout_checkpoint(id,checked_at) VALUES (1,?)').run(checkedAt);
  })();
}

function decode(workout: StoredWorkout): HevyCompletedWorkout {
 return {...workout, exercises:workout.exercises.map(ex=>({...ex,sets:ex.sets.map(({weightLbs,...set})=>({...set,weightKg:weightLbs == null ? weightLbs : poundsToRoundedKilograms(weightLbs)}))}))};
}
