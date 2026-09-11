import type { ToolCallMetrics } from '../src/claude/client.js';
import { READ_ONLY_TOOLS } from '../src/claude/tool-executor.js';
import { getDb } from '../src/state/db.js';
import { FixtureHevyClient, seedEffortFixtureState } from './effort-fixtures.js';

export interface CoachingScenario {
  id: string;
  prompts: string[];
  history: string[];
  rubric: string[];
  requireHistory?: boolean;
  priorReview?: string;
  completed?: string;
}

const advice = ' Give advice only; do not prepare or write a routine, save notes, or change training maxes.';
const rowQuestion = 'My Seated Row target is 3x10-15 at RPE 7-8. What load and reps should I use next?' + advice;
const exposures = (a: string, b: string) => `Seated Row history (two comparable cable sessions):\n- Sep 10: warmup 30x10, ${a}\n- Sep 7: warmup 30x10, ${b}`;

export const COACHING_SCENARIOS: CoachingScenario[] = [
  { id: 'qualified_progression', prompts: [rowQuestion], history: [exposures('3x70x15@8', '3x70x15@8')], requireHistory: true,
    rubric: ['Recommend 72.5 lb (smallest single plate is 2.5 lb) for 3 sets near 10 reps, supported by both exposures; exclude warmups.'] },
  { id: 'one_qualifying_exposure', prompts: [rowQuestion], history: [exposures('3x70x15@8', '70x15@8, 70x13@8, 70x12@8')], requireHistory: true,
    rubric: ['Retain 70 lb; repeat the ceiling to establish a second qualifying exposure, rather than increasing load.'] },
  { id: 'below_ceiling', prompts: [rowQuestion], history: [exposures('3x70x12@8', '3x70x11@8')], requireHistory: true,
    rubric: ['Retain 70 lb and build reps within 10-15; do not add sets.'] },
  { id: 'missing_effort', prompts: [rowQuestion], history: [exposures('3x70x15', '3x70x15')], requireHistory: true,
    rubric: ['Do not invent RPE; ask about effort or give an explicitly conditional increase pending effort confirmation.'] },
  { id: 'equipment_ceiling', prompts: ['My one-arm Kettlebell Row is 3x10-15. Both recent sessions were 53 lb for 3x15 at RPE 8. My largest kettlebell is 53 lb. What next?' + advice], history: [],
    rubric: ['Keep 53 lb; do not invent a heavier kettlebell, round to 55 lb, or automatically add sets.'] },
  { id: 'main_and_fsl', prompts: ['I finished Lower A in Week 1 and feel good. For Upper B in Week 1, what are just my bench work sets and OHP FSL sets? My TMs are bench 155 and OHP 95. Last bench working weight was 130 lb.' + advice], history: [],
    rubric: ['Bench 100x5, 115x5, 130x5; OHP 60x5 for 5 sets. Do not use 130 as TM or apply accessory double progression.'] },
  { id: 'completed_not_planned', prompts: ['Finished that workout. What should I take from it for next time?' + advice], history: [],
    completed: 'Sep 11: Completed Lower A: Squat work 135x5, 155x5, 175x5. No accessories recorded. The queued routine had Squat and three accessory exercises.',
    rubric: ['Review completed squat work briefly; do not claim accessories were completed or failed. Ask why omitted only if consequential; no unapproved TM change.'] },
  { id: 'review_already_visible', prompts: ['How do I change the units shown in Hevy?' + advice], history: [],
    priorReview: 'You completed all squat work sets. Repeat the planned progression next time; the missing accessories are not evidence of failure.',
    rubric: ['Answer the unrelated units question without repeating the workout review.'] },
  { id: 'empty_history', prompts: ['I want to try Seated Row. What starting load and reps would you suggest?' + advice], history: ['No history found for Seated Row in the requested interval.'], requireHistory: true,
    rubric: ['Check history; explicitly label any suggested load a provisional starting estimate, and explain using first-session performance and effort to calibrate.'] },
  { id: 'history_failure', prompts: ['What load should I use for Seated Row?' + advice], history: ['ERROR'], requireHistory: true,
    rubric: ['History is unavailable, not empty. Ask for a known load or clearly label a provisional estimate; no claimed established weight.'] },
  { id: 'variant_calibration', prompts: [
    'I normally do Seated Row at 70 lb, but want to try Seated Row (V Grip) for 3x10-15. What should I start with?' + advice,
    'I completed the first V Grip session: 50 lb for 3x12 at RPE 8. What should I do next time?' + advice,
  ], history: ['No history found for Seated Row (V Grip) in the requested interval.', 'Seated Row (V Grip): first completed exposure, 3x50x12@8.'], requireHistory: true,
    rubric: ['First turn: do not automatically transfer 70 lb; label the V Grip load provisional.', 'Second turn: use 50 lb and build reps within range; do not revert to 70 lb or increase after only one exposure. Any future threshold must still require two qualifying exposures.'] },
];

export class CoachingFixtureClient extends FixtureHevyClient {
  turn = 0;
  constructor(readonly scenario: CoachingScenario) { super(); }
  override async getExerciseHistory(templateId: string): Promise<string> {
    this.calls.push(`getExerciseHistory:${templateId}`);
    const result = this.scenario.history[this.turn] ?? this.scenario.history[0];
    if (result === 'ERROR') throw new Error('Synthetic Hevy history service unavailable.');
    return result ?? 'No history found for this exercise in the requested interval.';
  }
  override async getRecentWorkouts(): Promise<string> {
    this.calls.push('getRecentWorkouts');
    return this.scenario.completed ?? 'Latest completed session: Lower A, Week 1. Squat work: 135x5, 155x5, 175x5. No accessory history supplied; fetch exercise history if needed.';
  }
}

export function seedCoachingState(): void {
  seedEffortFixtureState();
  getDb().prepare('INSERT INTO exercise_map (display_name, template_id, hevy_title) VALUES (?, ?, ?)')
    .run('seated row (v grip)', 'fixture-v-grip', 'Seated Row (V Grip)');
}

/** Read-only coaching scenarios must leave every durable table except messages unchanged. */
export function coachingStateSnapshot(): string {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'messages' ORDER BY name")
    .all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .map(row => JSON.stringify(row)).sort(),
  ]));
}

export function assessCoachingTools(scenario: CoachingScenario, calls: ToolCallMetrics[], fixture: CoachingFixtureClient, before: string): string[] {
  const failures: string[] = [];
  for (const call of calls) {
    if (!READ_ONLY_TOOLS.has(call.name)) failures.push(`Unexpected mutation attempt: ${call.name}`);
  }
  if (fixture.routineWrites.length) failures.push('Unexpected Hevy routine write.');
  if (before !== coachingStateSnapshot()) failures.push('Unexpected durable coaching state change.');
  if (scenario.requireHistory && !calls.some(call => call.name === 'hevy_get_exercise_history')) failures.push('Missing exercise-history lookup.');
  const expectedId = scenario.id === 'variant_calibration' ? 'fixture-v-grip' : 'fixture-row';
  if (scenario.requireHistory && !fixture.calls.includes(`getExerciseHistory:${expectedId}`)) failures.push('Missing history lookup for the exact exercise variant.');
  return failures;
}
