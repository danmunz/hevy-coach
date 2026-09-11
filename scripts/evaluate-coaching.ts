import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { COACHING_SCENARIOS, CoachingFixtureClient, seedCoachingState, coachingStateSnapshot, assessCoachingTools } from './coaching-fixtures.js';
import { closeDbForTests, configureDbPathForTests } from '../src/state/db.js';
import { addMessagePair } from '../src/state/chatlog.js';
import type { ModelCallMetrics, ToolCallMetrics } from '../src/claude/client.js';

const args = process.argv.slice(2);
let dryRun = false;
let output = path.resolve('docs/coaching-evaluation-results.json');
let selectedScenario: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--dry-run') dryRun = true;
  else if ((arg === '--output' || arg === '--scenario') && args[index + 1] && !args[index + 1].startsWith('--')) {
    const value = args[++index];
    if (arg === '--output') output = path.resolve(value);
    else selectedScenario = value;
  } else throw new Error('Usage: npm run evaluate:coaching -- [--dry-run] [--output path.json] [--scenario id]');
}
const scenarios = selectedScenario ? COACHING_SCENARIOS.filter(scenario => scenario.id === selectedScenario) : COACHING_SCENARIOS;
if (!scenarios.length) throw new Error(`Unknown coaching scenario: ${selectedScenario}`);

// Scratch DB selection precedes all database access. No production DB is copied.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy-coach-coaching-'));
const results: unknown[] = [];
let failed = false;
const manifest = {
  startedAt: new Date().toISOString(), dryRun,
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  effort: process.env.CLAUDE_EFFORT || 'medium', repetitions: 2,
  promptHashes: Object.fromEntries(['coach', 'rules', 'program', 'equipment'].map(name =>
    [name, createHash('sha256').update(fs.readFileSync(`config/${name}.md`)).digest('hex')])),
  evaluatorHashes: Object.fromEntries(['scripts/coaching-fixtures.ts', 'scripts/evaluate-coaching.ts'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  assessment: 'Automated checks cover tools and state only. Coaching prose requires manual review against each rubric. Dry run is not behavioral validation.',
  results,
};
function save(): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
}

try {
  // Dry runs never instantiate the model client, and need no API credentials.
  const chat = dryRun ? undefined : (await import('../src/claude/client.js')).chat;
  for (const scenario of scenarios) {
    for (let repetition = 1; repetition <= 2; repetition++) {
      closeDbForTests();
      configureDbPathForTests(path.join(scratch, `${scenario.id}-${repetition}.db`));
      seedCoachingState();
      if (scenario.priorReview) addMessagePair('What about my last workout?', scenario.priorReview);
      const fixture = new CoachingFixtureClient(scenario);
      const before = coachingStateSnapshot();
      const toolCalls: ToolCallMetrics[] = [];
      const modelCalls: ModelCallMetrics[] = [];
      const responses: string[] = [];
      const failures: string[] = [];
      try {
        if (chat) {
          for (let turn = 0; turn < scenario.prompts.length; turn++) {
            fixture.turn = turn;
            responses.push(await chat(scenario.prompts[turn], {
              hevyClient: fixture, persist: true,
              freshContext: `## Checked synthetic workout context\n${await fixture.getRecentWorkouts()}`,
              onToolCall: call => toolCalls.push(call), onModelCall: call => modelCalls.push(call),
              deadlineAt: Date.now() + 75_000,
            }));
          }
          failures.push(...assessCoachingTools(scenario, toolCalls, fixture, before));
          if (modelCalls.some(call => call.stopReason === 'max_tokens')) failures.push('Truncated model response.');
          if (!modelCalls.length || modelCalls.at(-1)?.stopReason !== 'end_turn') failures.push('No normal final model completion.');
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      if (failures.length) failed = true;
      results.push({ id: scenario.id, repetition, prompts: scenario.prompts, rubric: scenario.rubric,
        responses, toolCalls, modelCalls, fixtureCalls: fixture.calls, routineWrites: fixture.routineWrites,
        failures, automatedPassed: dryRun ? null : failures.length === 0, manualReview: 'pending' });
      save();
      console.log(`[evaluation] ${scenario.id} run=${repetition} ${dryRun ? 'dry-run' : failures.length ? 'FAIL' : 'tools/state passed; prose pending'}`);
    }
  }
} finally {
  closeDbForTests();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`[evaluation] Results: ${output}`);
if (failed) process.exitCode = 1;
