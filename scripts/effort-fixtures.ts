import type {
  HevyApiError,
  HevyToolClient,
} from '../src/hevy/client.js';
import { buildRoutineSnapshot } from '../src/hevy/client.js';
import type { ToolCallMetrics } from '../src/claude/client.js';
import type {
  HevyRoutineRecord,
  HevyRoutineSnapshot,
  HevyTemplateMatch,
  RoutineExercisePayload,
} from '../src/hevy/types.js';
import { getDb } from '../src/state/db.js';
import { getTrainingMaxes, setConfig } from '../src/state/config.js';
import { getActiveNotes } from '../src/state/notes.js';

/** A fixed, deliberately small exercise library used by effort evaluation. */
export const FIXTURE_TEMPLATES: readonly HevyTemplateMatch[] = [
  { id: 'fixture-bench', title: 'Bench Press (Barbell)', primaryMuscleGroup: 'chest' },
  { id: 'fixture-lat-pulldown', title: 'Lat Pulldown (Cable)', primaryMuscleGroup: 'lats' },
  { id: 'fixture-row', title: 'Seated Row (Cable)', primaryMuscleGroup: 'upper_back' },
  { id: 'fixture-squat', title: 'Squat (Barbell)', primaryMuscleGroup: 'quadriceps' },
  { id: 'fixture-ohp', title: 'Overhead Press (Barbell)', primaryMuscleGroup: 'shoulders' },
];

const FIXTURE_TEMPLATE_IDS = new Map([
  ['bench press', 'fixture-bench'],
  ['lat pulldown', 'fixture-lat-pulldown'],
  ['seated row', 'fixture-row'],
  ['squat', 'fixture-squat'],
  ['overhead press', 'fixture-ohp'],
]);

export interface FixtureRoutineWrite {
  operation: 'create' | 'update';
  routineId?: string;
  title: string;
  exercises: RoutineExercisePayload[];
  exerciseTemplateIds: Record<string, string>;
  snapshot: HevyRoutineSnapshot;
}

/**
 * A complete input/output oracle for the tool loop. It deliberately has no
 * fetch dependency: any request that reaches this fixture is served from the
 * constants below, while writes are retained for exactness assertions.
 */
export class FixtureHevyClient implements HevyToolClient {
  readonly routineWrites: FixtureRoutineWrite[] = [];
  readonly calls: string[] = [];

  private readonly standingRoutine: HevyRoutineSnapshot = buildRoutineSnapshot(
    'Fixture Standing Routine',
    [{ name: 'Bench Press', sets: [{ type: 'normal', weightLbs: 135, reps: 5 }] }],
    FIXTURE_TEMPLATE_IDS,
  );

  async getRecentWorkouts(count = 5): Promise<string> {
    this.calls.push(`getRecentWorkouts:${count}`);
    return [
      'Recent workouts:',
      '- Thu Sep 4: Fixture Upper -- Bench Press: warmup 95x8, 3x135x5, Lat Pulldown: 3x100x10',
      '- Mon Sep 1: Fixture Upper -- Bench Press: warmup 95x8, 3x130x5, Lat Pulldown: 3x95x10',
    ].join('\n');
  }

  async getExerciseHistory(
    templateId: string,
    options?: { startDate?: string; endDate?: string; exerciseName?: string },
  ): Promise<string> {
    this.calls.push(`getExerciseHistory:${templateId}`);
    const exercise = options?.exerciseName ?? templateId;
    return [
      `${exercise} history (2026-06-01T00:00:00Z through 2026-09-01T00:00:00Z; 3 sessions):`,
      '- Thu Sep 4: warmup 95x8, 3x135x5@8',
      '- Mon Sep 1: warmup 95x8, 3x130x5@8',
      '- Thu Aug 28: warmup 95x8, 3x125x5@7',
    ].join('\n');
  }

  async getRoutines(): Promise<HevyRoutineRecord[]> {
    this.calls.push('getRoutines');
    return [{ id: 'fixture-standing-routine', title: 'Fixture Standing Routine', folderId: null }];
  }

  async getRoutineSnapshot(routineId: string): Promise<HevyRoutineSnapshot | HevyApiError> {
    this.calls.push(`getRoutineSnapshot:${routineId}`);
    if (routineId !== 'fixture-standing-routine') {
      return {
        error: true,
        message: `Fixture routine "${routineId}" does not exist.`,
        suggestion: 'Use the fixture standing routine ID.',
      };
    }
    return this.standingRoutine;
  }

  async createRoutine(
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
  ): Promise<{ routineId: string }> {
    this.calls.push('createRoutine');
    this.routineWrites.push(this.captureRoutineWrite('create', title, exercises, exerciseMap));
    return { routineId: 'fixture-created-routine' };
  }

  async updateRoutine(
    routineId: string,
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
  ): Promise<void> {
    this.calls.push(`updateRoutine:${routineId}`);
    this.routineWrites.push(this.captureRoutineWrite('update', title, exercises, exerciseMap, routineId));
  }

  async searchExerciseTemplates(query: string): Promise<HevyTemplateMatch[]> {
    this.calls.push(`searchExerciseTemplates:${query}`);
    const normalized = query.trim().toLowerCase();
    return FIXTURE_TEMPLATES.filter((template) => template.title.toLowerCase().includes(normalized));
  }

  private captureRoutineWrite(
    operation: FixtureRoutineWrite['operation'],
    title: string,
    exercises: RoutineExercisePayload[],
    exerciseMap: Map<string, string>,
    routineId?: string,
  ): FixtureRoutineWrite {
    const stableMap = Object.fromEntries(
      exercises.map((exercise) => {
        const templateId = exerciseMap.get(exercise.name.trim().toLowerCase());
        if (!templateId) throw new Error(`Fixture has no template ID for ${exercise.name}.`);
        return [exercise.name, templateId];
      }),
    );
    return {
      operation,
      ...(routineId == null ? {} : { routineId }),
      title,
      exercises: structuredClone(exercises),
      exerciseTemplateIds: stableMap,
      snapshot: buildRoutineSnapshot(title, exercises, exerciseMap),
    };
  }
}

export interface EffortFixtureScenario {
  id: 'history_analysis' | 'pain_note' | 'training_max_approval' | 'approved_routine_push';
  prompt: string;
  /** Requirements verified against captured tool telemetry, never prose alone. */
  requiredTools: readonly string[];
}

/**
 * Every prompt explicitly authorizes only the state change it asks for. Their
 * postconditions are evaluated from the captured tool calls, not heuristics
 * over a model response.
 */
export const EFFORT_FIXTURE_SCENARIOS: readonly EffortFixtureScenario[] = [
  {
    id: 'history_analysis',
    prompt: 'Use my Bench Press history to assess whether my recent progression supports another 5 lb increase. Give a concise recommendation.',
    requiredTools: ['hevy_get_exercise_history'],
  },
  {
    id: 'pain_note',
    prompt: 'My left shoulder hurts at the bottom of every press. Please save that as an active coaching note and tell me how to modify today\'s pressing.',
    requiredTools: ['save_note'],
  },
  {
    id: 'training_max_approval',
    prompt: 'I explicitly approve increasing my bench training max from 155 lb to 160 lb now. Update only that training max.',
    requiredTools: ['update_training_maxes'],
  },
  {
    id: 'approved_routine_push',
    prompt: 'I explicitly approve this exact new Hevy routine. Push it with title "Fixture Push Day": Bench Press warmup 95 lb x 8 for 1 set, then 135 lb x 5 for 3 sets; Lat Pulldown 100 lb x 10 for 3 sets. Do not add, remove, or substitute anything.',
    requiredTools: ['hevy_push_routine'],
  },
];

const EXPECTED_PUSH_SNAPSHOT = buildRoutineSnapshot(
  'Fixture Push Day',
  [
    {
      name: 'Bench Press',
      sets: [
        { type: 'warmup', weightLbs: 95, reps: 8 },
        { type: 'normal', weightLbs: 135, reps: 5 },
        { type: 'normal', weightLbs: 135, reps: 5 },
        { type: 'normal', weightLbs: 135, reps: 5 },
      ],
    },
    {
      name: 'Lat Pulldown',
      sets: [
        { type: 'normal', weightLbs: 100, reps: 10 },
        { type: 'normal', weightLbs: 100, reps: 10 },
        { type: 'normal', weightLbs: 100, reps: 10 },
      ],
    },
  ],
  FIXTURE_TEMPLATE_IDS,
);

export interface FixtureScenarioAssessment {
  passed: boolean;
  failures: string[];
}

/**
 * Scores a completed fixture turn against concrete tool behavior and scratch
 * state. This intentionally does not grade coaching prose: a useful response
 * cannot compensate for a missed note, unapproved max change, or altered
 * routine prescription.
 */
export function assessFixtureScenario(
  scenario: EffortFixtureScenario,
  toolCalls: readonly ToolCallMetrics[],
  fixture: FixtureHevyClient,
): FixtureScenarioAssessment {
  const failures: string[] = [];
  for (const name of scenario.requiredTools) {
    if (!toolCalls.some((call) => call.name === name)) {
      failures.push(`Missing required tool call: ${name}.`);
    }
  }

  switch (scenario.id) {
    case 'history_analysis': {
      const history = toolCalls.find((call) => call.name === 'hevy_get_exercise_history');
      if (history && (
        history.input.exercise_name !== 'Bench Press' ||
        !history.result.includes('Bench Press history')
      )) {
        failures.push('History lookup did not request and receive the Bench Press fixture history.');
      }
      break;
    }
    case 'pain_note': {
      const note = toolCalls.find((call) => call.name === 'save_note');
      const saved = getActiveNotes().some((item) => /left shoulder/i.test(item.content));
      if (!note || typeof note.input.content !== 'string' || !/left shoulder/i.test(note.input.content) || !saved) {
        failures.push('Pain scenario did not save a left-shoulder note in scratch state.');
      }
      break;
    }
    case 'training_max_approval': {
      const update = toolCalls.find((call) => call.name === 'update_training_maxes');
      const maxes = getTrainingMaxes();
      if (!update || update.input.bench !== 160 || maxes.bench !== 160) {
        failures.push('Approved training-max scenario did not set only the bench max to 160 lb.');
      }
      break;
    }
    case 'approved_routine_push': {
      if (fixture.routineWrites.length !== 1) {
        failures.push(`Routine scenario made ${fixture.routineWrites.length} fixture writes; expected exactly one.`);
      } else if (JSON.stringify(fixture.routineWrites[0].snapshot) !== JSON.stringify(EXPECTED_PUSH_SNAPSHOT)) {
        failures.push('Routine write did not exactly match the approved fixture prescription.');
      }
      break;
    }
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Starts every evaluation case from the same state, irrespective of the
 * operator's production chat history, notes, routine cache, or exercise map.
 * Call only after the evaluator has pointed HEVY_COACH_DB_PATH at its fresh
 * temporary database and before it imports/calls chat().
 */
export function seedEffortFixtureState(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM messages;
    DELETE FROM notes;
    DELETE FROM exercise_map;
    DELETE FROM pending_hevy_mutation;
    DELETE FROM config;
  `);
  setConfig('training_maxes', JSON.stringify({ squat: 205, bench: 155, deadlift: 275, ohp: 95 }));
  setConfig('goals', 'Preserve muscle during cut, maintain or slowly progress strength');
  const addTemplate = db.prepare(`
    INSERT INTO exercise_map (display_name, template_id, hevy_title)
    VALUES (?, ?, ?)
  `);
  for (const [displayName, templateId] of FIXTURE_TEMPLATE_IDS) {
    const title = FIXTURE_TEMPLATES.find((template) => template.id === templateId)?.title ?? displayName;
    addTemplate.run(displayName, templateId, title);
  }
}
