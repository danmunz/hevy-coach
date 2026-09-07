import 'dotenv/config';

import { HevyClient, buildRoutineSnapshot, routineSnapshotsMatch } from '../src/hevy/client.js';
import { getDb } from '../src/state/db.js';
import { confirmHevyMutation, getPendingHevyMutation } from '../src/state/routine-state.js';

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function loadExerciseMap(): Map<string, string> {
  const rows = getDb().prepare(
    'SELECT display_name, template_id FROM exercise_map',
  ).all() as Array<{ display_name: string; template_id: string }>;
  return new Map(rows.map((row) => [row.display_name.trim().toLowerCase(), row.template_id]));
}

const pending = getPendingHevyMutation();
if (!pending) {
  console.log('No pending Hevy mutation is blocking routine writes.');
  process.exit(0);
}

const routineId = pending.routineId ?? argumentValue('--routine-id');
if (!routineId) {
  console.error(
    'This was a create with no returned routine ID. Find the candidate routine in Hevy, then run npm run recover:hevy -- --routine-id <id>.',
  );
  process.exit(1);
}

const exerciseMap = loadExerciseMap();
for (const [displayName, templateId] of Object.entries(pending.exerciseTemplateIds)) {
  exerciseMap.set(displayName.trim().toLowerCase(), templateId);
}
const expected = buildRoutineSnapshot(
  pending.payload.title,
  pending.payload.exercises,
  exerciseMap,
);
const actual = await new HevyClient().getRoutineSnapshot(routineId);

if ('error' in actual) {
  console.error(`Could not fetch routine ${routineId}: ${actual.message}`);
  process.exit(1);
}

if (!routineSnapshotsMatch(expected, actual)) {
  console.error(
    `Routine ${routineId} does not match the pending ${pending.operation} payload. The safety block remains in place.`,
  );
  process.exit(1);
}

confirmHevyMutation(routineId, pending.payload, pending.exerciseTemplateIds);
console.log(`Confirmed the pending ${pending.operation} for "${pending.payload.title}" against Hevy and cleared the safety block.`);
