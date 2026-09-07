import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ModelCallMetrics, ModelEffort, ToolCallMetrics } from '../src/claude/client.js';

type EvaluationEffort = 'high' | 'medium';

const ALLOWED_EFFORTS = new Set<ModelEffort>(['medium', 'high']);
const EVALUATION_EFFORTS: readonly EvaluationEffort[] = ['high', 'medium'];
const MAX_REPETITIONS = 5;
const EVALUATION_MAX_OUTPUT_TOKENS = 2048;
const EVALUATION_MAX_TOOL_ITERATIONS = 3;
const MAX_EVALUATION_REQUEST_BYTES = 31_000;
const MAX_EVALUATION_INPUT_TOKENS = 32_000;
const SCREENING_BUDGET_USD = 25;
const DECISION_BUDGET_MICRODOLLARS = 20_000_000;
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const PRODUCTION_SMOKE_ARTIFACT_SHA256 = '8262a5b322481b8a0a64c86548c30a2f46d5dd40ec0507403d8479231d4906da';
const PRODUCTION_SMOKE_SOURCE_COMMIT = '1e0660284f572649d27b71d8ca073c4fa8ae2847';
const PRODUCTION_MAX_OUTPUT_TOKENS = 16_000;
const PRODUCTION_MAX_TOOL_ITERATIONS = 10;
const PRODUCTION_BUDGET_USD = 25;
const requestedMode = process.argv[2] ?? 'pair';
const repetitions = Number(process.argv[3] ?? MAX_REPETITIONS);
const dryRun = process.argv.includes('--dry-run');
const workerScenarioId = process.env.HEVY_COACH_EFFORT_SCENARIO_ID;
const workerEffort = process.env.HEVY_COACH_EFFORT as ModelEffort | undefined;
const workerCampaignMode = process.env.HEVY_COACH_EFFORT_CAMPAIGN_MODE;

if (
  (requestedMode !== 'pair' && requestedMode !== 'production' && requestedMode !== 'decision' && !ALLOWED_EFFORTS.has(requestedMode as ModelEffort)) ||
  !Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS
) {
  console.error('Usage: tsx scripts/evaluate-effort.ts <pair|production|decision|medium|high> [1-5 repetitions] [--dry-run]');
  process.exit(1);
}

if (requestedMode === 'decision' && repetitions !== MAX_REPETITIONS) {
  console.error(`Decision mode requires exactly ${MAX_REPETITIONS} repetitions.`);
  process.exit(1);
}

interface Pricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

interface CostEstimate {
  inputUsd: number | null;
  cacheWriteUsd: number | null;
  cacheReadUsd: number | null;
  outputUsd: number | null;
  totalUsd: number | null;
}

interface WorkerResult {
  scenario: string;
  repetition: number;
  model: string;
  effort: ModelEffort;
  response: string;
  responseLength: number;
  elapsedMs: number;
  passed: boolean;
  failures: string[];
  modelCalls: ModelCallMetrics[];
  toolCalls: ToolCallMetrics[];
  fixtureCalls: string[];
  routineWrites: unknown[];
  cost: CostEstimate;
  dryRun?: boolean;
  error?: string;
}

interface AggregateArtifact {
  generatedAt: string;
  model: string;
  mode: 'pair' | 'production' | 'decision' | ModelEffort;
  repetitions: number;
  pricing: Pricing;
  budget: {
    limitUsd: number;
    perWorkerReservationUsd: number;
    reservedUsd: number;
    observedUsd: number;
  };
  execution: {
    maxOutputTokens: number;
    maxToolIterations: number;
    maxRequestBytes: number;
    sdkRetries: 0;
    promptCaching: 'enabled' | 'disabled';
    requiredReservationMicrodollars: number;
    workerReservationMicrodollars: number;
    plannedWorkers: number;
    scenarioOrder: Record<EvaluationEffort, string[]> | null;
    effortSessionOrder: readonly EvaluationEffort[] | null;
    commitSha: string | null;
    lockfileSha256: string | null;
    fixtureSha256: string | null;
    evaluatorSha256: string | null;
    clientSha256: string | null;
    productionSmokeManifestSha256: string | null;
    productionSmokeArtifactSha256: string | null;
    productionSmokeSourceCommit: string | null;
  };
  /** True only for a passing production-equivalent paired campaign. */
  promotionEligible: boolean;
  decisionEligible: boolean;
  screeningPass: boolean;
  limitation: string;
  comparison: EffortComparison | null;
  results: WorkerResult[];
  totals: {
    passed: number;
    failed: number;
    totalElapsedMs: number;
    totalCostUsd: number;
  };
}

interface EffortSummary {
  cases: number;
  passed: number;
  medianElapsedMs: number | null;
  medianCostUsd: number | null;
  totalCostUsd: number;
  cacheStatus: 'cold' | 'mixed' | 'warm';
}

interface EffortComparison {
  high: EffortSummary;
  medium: EffortSummary;
  allGuardrailsPass: boolean;
  latencyImprovementPercent: number | null;
  costImprovementPercent: number | null;
  meetsImprovementThreshold: boolean;
  hasNoRegression: boolean;
  hasNoScenarioRegression: boolean;
  hasComparableCachePattern: boolean;
}

interface ProductionSmokeManifest {
  model: string;
  mode: 'production';
  repetitions: 1;
  maxOutputTokens: number;
  maxToolIterations: number;
  passed: number;
  failed: number;
  truncations: number;
  toolLimitFailures: number;
  latencyImprovementPercent: number;
  costImprovementPercent: number;
}

/** Rates per million tokens for the direct API model used by production. */
function pricingFor(model: string): Pricing | null {
  if (model === 'claude-sonnet-5') {
    return { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 };
  }
  return null;
}

function estimateCost(modelCalls: readonly ModelCallMetrics[], pricing: Pricing): CostEstimate {
  const tokens = modelCalls.reduce((total, call) => ({
    input: total.input + call.inputTokens,
    cacheWrite: total.cacheWrite + call.cacheWriteTokens,
    cacheRead: total.cacheRead + call.cacheReadTokens,
    output: total.output + call.outputTokens,
  }), { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  const inputUsd = tokens.input * pricing.input / 1_000_000;
  const cacheWriteUsd = tokens.cacheWrite * pricing.cacheWrite / 1_000_000;
  const cacheReadUsd = tokens.cacheRead * pricing.cacheRead / 1_000_000;
  const outputUsd = tokens.output * pricing.output / 1_000_000;
  return { inputUsd, cacheWriteUsd, cacheReadUsd, outputUsd, totalUsd: inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd };
}

/**
 * Reserve for every possible model iteration before spending. This intentionally
 * assumes every request uses the full bounded input/output caps and charges the
 * cache-write rate, which is more expensive than a cache read.
 */
function maximumWorkerCost(pricing: Pricing, outputTokens: number, iterations: number): number {
  return iterations * (
    MAX_EVALUATION_INPUT_TOKENS * pricing.input / 1_000_000 +
    MAX_EVALUATION_INPUT_TOKENS * pricing.cacheWrite / 1_000_000 +
    outputTokens * pricing.output / 1_000_000
  );
}

function sha256File(filePath: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function currentCommitSha(): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isWorktreeClean(): boolean {
  const result = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === '';
}

function loadProductionSmokeManifest(model: string): { valid: boolean; manifestSha256: string | null; artifactSha256: string | null; sourceCommit: string | null } {
  const manifestPath = path.resolve('docs/effort-production-smoke-2026-09-07.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ProductionSmokeManifest & { sourceArtifactSha256?: string; sourceCommitSha?: string };
    const valid = manifest.sourceArtifactSha256 === PRODUCTION_SMOKE_ARTIFACT_SHA256 &&
      manifest.sourceCommitSha === PRODUCTION_SMOKE_SOURCE_COMMIT &&
      manifest.sourceCommitSha === currentCommitSha() &&
      manifest.model === model &&
      manifest.mode === 'production' &&
      manifest.repetitions === 1 &&
      manifest.maxOutputTokens === PRODUCTION_MAX_OUTPUT_TOKENS &&
      manifest.maxToolIterations === PRODUCTION_MAX_TOOL_ITERATIONS &&
      manifest.passed === 8 &&
      manifest.failed === 0 &&
      manifest.truncations === 0 &&
      manifest.toolLimitFailures === 0 &&
      manifest.latencyImprovementPercent >= 15 &&
      manifest.costImprovementPercent >= 15;
    return {
      valid,
      manifestSha256: sha256File(manifestPath),
      artifactSha256: manifest.sourceArtifactSha256 ?? null,
      sourceCommit: manifest.sourceCommitSha ?? null,
    };
  } catch {
    return { valid: false, manifestSha256: null, artifactSha256: null, sourceCommit: null };
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizeEffort(results: readonly WorkerResult[], effort: ModelEffort): EffortSummary {
  const cases = results.filter((result) => result.effort === effort && result.repetition > 0);
  const calls = cases.flatMap((result) => result.modelCalls);
  const cacheReads = calls.filter((call) => call.cacheReadTokens > 0).length;
  return {
    cases: cases.length,
    passed: cases.filter((result) => result.passed).length,
    medianElapsedMs: median(cases.map((result) => result.elapsedMs)),
    medianCostUsd: median(cases.map((result) => result.cost.totalUsd ?? 0)),
    totalCostUsd: cases.reduce((sum, result) => sum + (result.cost.totalUsd ?? 0), 0),
    cacheStatus: cacheReads === 0 ? 'cold' : cacheReads === calls.length ? 'warm' : 'mixed',
  };
}

function compareEfforts(results: readonly WorkerResult[], repetitions: number): EffortComparison {
  const high = summarizeEffort(results, 'high');
  const medium = summarizeEffort(results, 'medium');
  const expectedCases = repetitions * 4;
  const allGuardrailsPass = high.cases === expectedCases && medium.cases === expectedCases &&
    high.passed === expectedCases && medium.passed === expectedCases;
  const latencyImprovementPercent = high.medianElapsedMs == null || medium.medianElapsedMs == null || high.medianElapsedMs === 0
    ? null
    : (high.medianElapsedMs - medium.medianElapsedMs) / high.medianElapsedMs * 100;
  const costImprovementPercent = high.medianCostUsd == null || medium.medianCostUsd == null || high.medianCostUsd === 0
    ? null
    : (high.medianCostUsd - medium.medianCostUsd) / high.medianCostUsd * 100;
  const meetsImprovementThreshold = (latencyImprovementPercent ?? -Infinity) >= 15 ||
    (costImprovementPercent ?? -Infinity) >= 15;
  const hasNoRegression = (latencyImprovementPercent ?? -Infinity) >= -5 &&
    (costImprovementPercent ?? -Infinity) >= -5;
  const scenarioIds = ['history_analysis', 'pain_note', 'training_max_approval', 'approved_routine_push'];
  const hasNoScenarioRegression = scenarioIds.every((scenarioId) => {
    const highResults = results.filter((result) => result.scenario === scenarioId && result.effort === 'high' && result.repetition > 0);
    const mediumResults = results.filter((result) => result.scenario === scenarioId && result.effort === 'medium' && result.repetition > 0);
    const highLatency = median(highResults.map((result) => result.elapsedMs));
    const mediumLatency = median(mediumResults.map((result) => result.elapsedMs));
    const highCost = median(highResults.map((result) => result.cost.totalUsd ?? 0));
    const mediumCost = median(mediumResults.map((result) => result.cost.totalUsd ?? 0));
    const latencyPasses = highLatency != null && mediumLatency != null && (highLatency === 0 ? mediumLatency === 0 : mediumLatency <= highLatency * 1.1);
    const costPasses = highCost != null && mediumCost != null && (highCost === 0 ? mediumCost === 0 : mediumCost <= highCost * 1.1);
    return latencyPasses && costPasses;
  });
  const cacheWrites = (effort: EvaluationEffort) => results
    .filter((result) => result.effort === effort && result.repetition > 0)
    .flatMap((result) => result.modelCalls)
    .filter((call) => call.cacheWriteTokens > 0).length;
  const highCacheWrites = cacheWrites('high');
  const mediumCacheWrites = cacheWrites('medium');
  const hasComparableCachePattern = highCacheWrites === mediumCacheWrites && highCacheWrites <= 1;
  return {
    high, medium, allGuardrailsPass, latencyImprovementPercent, costImprovementPercent,
    meetsImprovementThreshold, hasNoRegression, hasNoScenarioRegression, hasComparableCachePattern,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

interface WorkItem {
  scenarioId: string;
  repetition: number;
  effort: ModelEffort;
}

function shuffledScenarioOrder(scenarioIds: readonly string[], repetitions: number, seed: number): string[] {
  const order = Array.from({ length: repetitions }, () => scenarioIds).flat();
  let state = seed >>> 0;
  for (let index = order.length - 1; index > 0; index--) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [order[index], order[swapIndex]] = [order[swapIndex]!, order[index]!];
  }
  return order;
}

function buildWorkItems(
  mode: 'pair' | 'production' | 'decision' | ModelEffort,
  repetitions: number,
  scenarioIds: readonly string[],
  efforts: readonly ModelEffort[],
): { items: WorkItem[]; scenarioOrder: Record<EvaluationEffort, string[]> | null } {
  if (mode === 'decision') {
    const scenarioOrder: Record<EvaluationEffort, string[]> = {
      high: shuffledScenarioOrder(scenarioIds, repetitions, 0x1A2B3C4D),
      medium: shuffledScenarioOrder(scenarioIds, repetitions, 0x5E6F7081),
    };
    const items: WorkItem[] = [];
    for (const effort of EVALUATION_EFFORTS) {
      const repetitionByScenario = new Map<string, number>();
      for (const scenarioId of scenarioOrder[effort]) {
        const repetition = (repetitionByScenario.get(scenarioId) ?? 0) + 1;
        repetitionByScenario.set(scenarioId, repetition);
        items.push({ scenarioId, repetition, effort });
      }
    }
    return { items, scenarioOrder };
  }

  const items: WorkItem[] = [];
  const paired = mode === 'pair' || mode === 'production';
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const orderedEfforts = paired && repetition % 2 === 0 ? [...efforts].reverse() : efforts;
    for (const scenarioId of scenarioIds) {
      for (const effort of orderedEfforts) items.push({ scenarioId, repetition, effort });
    }
  }
  return { items, scenarioOrder: null };
}

async function runWorker(): Promise<void> {
  const outputPath = process.env.HEVY_COACH_EFFORT_OUTPUT_PATH;
  const repetition = Number(process.env.HEVY_COACH_EFFORT_REPETITION);
  const isDryRun = process.env.HEVY_COACH_EFFORT_DRY_RUN === '1';
  const isProductionCampaign = workerCampaignMode === 'production';
  const isDecisionCampaign = workerCampaignMode === 'decision';
  if (!workerScenarioId || !workerEffort || !outputPath || !Number.isInteger(repetition)) {
    throw new Error('Effort evaluation worker is missing its scenario, effort, output path, or repetition.');
  }

  const fixtures = await import('./effort-fixtures.js');
  const scenario = fixtures.EFFORT_FIXTURE_SCENARIOS.find((candidate) => candidate.id === workerScenarioId);
  if (!scenario) throw new Error(`Unknown fixture scenario: ${workerScenarioId}`);

  // This is intentionally the first database access in this process. The
  // worker owns its temporary path, then seeds exactly the same data for each
  // scenario/repetition before importing the client that reads SQLite state.
  fixtures.seedEffortFixtureState();
  const fixture = new fixtures.FixtureHevyClient();
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const pricing = pricingFor(model);
  if (!pricing) throw new Error(`No audited pricing is configured for ${model}.`);
  const modelCalls: ModelCallMetrics[] = [];
  const toolCalls: ToolCallMetrics[] = [];
  const started = Date.now();

  if (isDryRun) {
    writeJson(outputPath, {
      scenario: scenario.id, repetition, model, effort: workerEffort, response: '', responseLength: 0,
      elapsedMs: Date.now() - started, passed: true, failures: [], modelCalls, toolCalls,
      fixtureCalls: fixture.calls, routineWrites: fixture.routineWrites, cost: estimateCost(modelCalls, pricing), dryRun: true,
    } satisfies WorkerResult);
    return;
  }

  try {
    const { chat } = await import('../src/claude/client.js');
    const response = await chat(scenario.prompt, {
      persist: true,
      effort: workerEffort,
      hevyClient: fixture,
      maxOutputTokens: isProductionCampaign ? PRODUCTION_MAX_OUTPUT_TOKENS : EVALUATION_MAX_OUTPUT_TOKENS,
      maxToolIterations: isProductionCampaign ? PRODUCTION_MAX_TOOL_ITERATIONS : EVALUATION_MAX_TOOL_ITERATIONS,
      maxRequestBytes: MAX_EVALUATION_REQUEST_BYTES,
      disablePromptCache: isDecisionCampaign,
      onModelCall: (metrics) => modelCalls.push(metrics),
      onToolCall: (metrics) => toolCalls.push(metrics),
    });
    const assessment = fixtures.assessFixtureScenario(scenario, toolCalls, fixture);
    if (modelCalls.some((call) => call.stopReason === 'max_tokens')) {
      assessment.failures.push(`Model response was truncated at the ${isProductionCampaign ? 'production' : 'screening'} output cap.`);
    }
    if (response.startsWith('[Max tool iterations reached.')) {
      assessment.failures.push(`Model reached the ${isProductionCampaign ? 'production' : 'screening'} tool-iteration cap without a final response.`);
    }
    writeJson(outputPath, {
      scenario: scenario.id, repetition, model, effort: workerEffort, response, responseLength: response.length,
      elapsedMs: Date.now() - started, passed: assessment.failures.length === 0, failures: assessment.failures,
      modelCalls, toolCalls, fixtureCalls: fixture.calls, routineWrites: fixture.routineWrites,
      cost: estimateCost(modelCalls, pricing),
    } satisfies WorkerResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(outputPath, {
      scenario: scenario.id, repetition, model, effort: workerEffort, response: '', responseLength: 0,
      elapsedMs: Date.now() - started, passed: false,
      failures: ['Evaluation worker failed before a fixture assessment completed.'],
      modelCalls, toolCalls, fixtureCalls: fixture.calls, routineWrites: fixture.routineWrites,
      cost: estimateCost(modelCalls, pricing), error: message,
    } satisfies WorkerResult);
    process.exitCode = 1;
  }
}

function runParent(): void {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const pricing = pricingFor(model);
  if (!pricing) throw new Error(`No audited pricing is configured for ${model}.`);
  const mode = requestedMode as 'pair' | 'production' | 'decision' | ModelEffort;
  const isProductionCampaign = mode === 'production';
  const isDecisionCampaign = mode === 'decision';
  const isPairedCampaign = mode === 'pair' || isProductionCampaign || isDecisionCampaign;
  const efforts = isPairedCampaign ? EVALUATION_EFFORTS : [mode];
  const outputTokens = isProductionCampaign ? PRODUCTION_MAX_OUTPUT_TOKENS : EVALUATION_MAX_OUTPUT_TOKENS;
  const toolIterations = isProductionCampaign ? PRODUCTION_MAX_TOOL_ITERATIONS : EVALUATION_MAX_TOOL_ITERATIONS;
  const budgetUsd = isDecisionCampaign ? DECISION_BUDGET_MICRODOLLARS / MICRODOLLARS_PER_DOLLAR : isProductionCampaign ? PRODUCTION_BUDGET_USD : SCREENING_BUDGET_USD;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy-coach-effort-results-'));
  const scriptPath = path.resolve(process.argv[1] ?? 'scripts/evaluate-effort.ts');
  const scenarioIds = ['history_analysis', 'pain_note', 'training_max_approval', 'approved_routine_push'];
  const workerReservationUsd = maximumWorkerCost(pricing, outputTokens, toolIterations);
  const workerReservationMicrodollars = Math.round(workerReservationUsd * MICRODOLLARS_PER_DOLLAR);
  const { items: workItems, scenarioOrder } = buildWorkItems(mode, repetitions, scenarioIds, efforts);
  const requiredReservationMicrodollars = workerReservationMicrodollars * workItems.length;
  if (isDecisionCampaign && requiredReservationMicrodollars > DECISION_BUDGET_MICRODOLLARS) {
    throw new Error(`Decision campaign requires ${(requiredReservationMicrodollars / MICRODOLLARS_PER_DOLLAR).toFixed(6)} USD, above its 20.000000 USD limit.`);
  }
  const productionSmoke = isDecisionCampaign
    ? loadProductionSmokeManifest(model)
    : { valid: false, manifestSha256: null, artifactSha256: null, sourceCommit: null };
  if (isDecisionCampaign && !dryRun && !productionSmoke.valid) {
    throw new Error('Decision campaign requires a valid production-limit smoke-test manifest from the current commit before any model call.');
  }
  if (isDecisionCampaign && !dryRun && !isWorktreeClean()) {
    throw new Error('Decision campaign requires a clean Git worktree before any model call.');
  }
  const results: WorkerResult[] = [];
  let reservedUsd = 0;
  let reservedMicrodollars = 0;
  let observedUsd = 0;
  let budgetExhausted = false;

  for (const { scenarioId, repetition, effort } of workItems) {
    const wouldExceedBudget = isDecisionCampaign
      ? reservedMicrodollars + workerReservationMicrodollars > DECISION_BUDGET_MICRODOLLARS
      : reservedUsd + workerReservationUsd > budgetUsd;
    if (wouldExceedBudget) {
      budgetExhausted = true;
      break;
    }
    if (isDecisionCampaign) {
      reservedMicrodollars += workerReservationMicrodollars;
      reservedUsd = reservedMicrodollars / MICRODOLLARS_PER_DOLLAR;
    } else {
      reservedUsd += workerReservationUsd;
    }
    const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy-coach-effort-worker-'));
    const outputPath = path.join(workerDir, 'result.json');
    const scratchDbPath = path.join(workerDir, 'state.db');
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, effort, String(repetitions)], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 180_000,
        env: {
          ...process.env,
          HEVY_COACH_EFFORT_SCENARIO_ID: scenarioId,
          HEVY_COACH_EFFORT: effort,
          HEVY_COACH_EFFORT_CAMPAIGN_MODE: mode,
          HEVY_COACH_EFFORT_REPETITION: String(repetition),
          HEVY_COACH_EFFORT_OUTPUT_PATH: outputPath,
          HEVY_COACH_DB_PATH: scratchDbPath,
          ...(dryRun ? { HEVY_COACH_EFFORT_DRY_RUN: '1' } : {}),
        },
      });
      if (fs.existsSync(outputPath)) {
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as WorkerResult;
        results.push(result);
        observedUsd += result.cost.totalUsd ?? workerReservationUsd;
      } else {
        results.push({
          scenario: scenarioId, repetition, model, effort, response: '', responseLength: 0, elapsedMs: 0,
          passed: false, failures: ['Evaluation worker did not write a result artifact.'],
          modelCalls: [], toolCalls: [], fixtureCalls: [], routineWrites: [], cost: estimateCost([], pricing),
          error: child.error?.message ?? (child.stderr.trim() || `Worker exited with status ${child.status}.`),
        });
      }
    } finally {
      fs.rmSync(workerDir, { recursive: true, force: true });
    }
  }

  if (budgetExhausted) {
    results.push({
      scenario: 'budget_guard', repetition: 0, model, effort: efforts.at(-1)!, response: '', responseLength: 0, elapsedMs: 0,
      passed: false, failures: [`Campaign stopped before exceeding its $${budgetUsd} budget.`],
      modelCalls: [], toolCalls: [], fixtureCalls: [], routineWrites: [], cost: estimateCost([], pricing),
    });
  }
  const comparison = isPairedCampaign ? compareEfforts(results, repetitions) : null;
  const campaignPass = isPairedCampaign && repetitions === MAX_REPETITIONS && !dryRun && !budgetExhausted &&
    comparison != null && comparison.allGuardrailsPass && comparison.meetsImprovementThreshold &&
    comparison.hasNoRegression && (!isDecisionCampaign || (comparison.hasNoScenarioRegression && comparison.hasComparableCachePattern));
  const decisionEligible = isDecisionCampaign && productionSmoke.valid && campaignPass;
  const artifact: AggregateArtifact = {
    generatedAt: new Date().toISOString(), model, mode, repetitions, pricing,
    budget: { limitUsd: budgetUsd, perWorkerReservationUsd: workerReservationUsd, reservedUsd, observedUsd },
    execution: {
      maxOutputTokens: outputTokens,
      maxToolIterations: toolIterations,
      maxRequestBytes: MAX_EVALUATION_REQUEST_BYTES,
      sdkRetries: 0,
      promptCaching: isDecisionCampaign ? 'disabled' : 'enabled',
      requiredReservationMicrodollars,
      workerReservationMicrodollars,
      plannedWorkers: workItems.length,
      scenarioOrder,
      effortSessionOrder: isDecisionCampaign ? EVALUATION_EFFORTS : null,
      commitSha: currentCommitSha(),
      lockfileSha256: sha256File(path.resolve('package-lock.json')),
      fixtureSha256: sha256File(path.resolve('scripts/effort-fixtures.ts')),
      evaluatorSha256: sha256File(path.resolve('scripts/evaluate-effort.ts')),
      clientSha256: sha256File(path.resolve('src/claude/client.ts')),
      productionSmokeManifestSha256: productionSmoke.manifestSha256,
      productionSmokeArtifactSha256: productionSmoke.artifactSha256,
      productionSmokeSourceCommit: productionSmoke.sourceCommit,
    },
    promotionEligible: decisionEligible,
    decisionEligible,
    screeningPass: mode === 'pair' && campaignPass,
    limitation: isProductionCampaign
      ? `This campaign matches the production output and tool-iteration limits. Its ${MAX_EVALUATION_REQUEST_BYTES}-byte request guard rejects unexpectedly expanded fixture context before the model call.`
      : isDecisionCampaign
        ? `This complete decision matrix reserves ${(requiredReservationMicrodollars / MICRODOLLARS_PER_DOLLAR).toFixed(6)} USD before model calls. It uses the bounded screening output and tool limits, plus the frozen production-limit smoke-test manifest.`
      : `This campaign caps each request at ${EVALUATION_MAX_OUTPUT_TOKENS} output tokens and ${EVALUATION_MAX_TOOL_ITERATIONS} tool iterations to stay within its $${SCREENING_BUDGET_USD} ceiling. It cannot promote a production effort setting.`,
    comparison,
    results,
    totals: {
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      totalElapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
      totalCostUsd: results.reduce((sum, result) => sum + (result.cost.totalUsd ?? 0), 0),
    },
  };
  const artifactPath = path.join(artifactDir, 'evaluation.json');
  writeJson(artifactPath, artifact);

  console.log(JSON.stringify({
    artifactPath, model, mode, repetitions, promotionEligible: artifact.promotionEligible, decisionEligible: artifact.decisionEligible, screeningPass: artifact.screeningPass,
    passed: artifact.totals.passed, failed: artifact.totals.failed,
    totalElapsedMs: artifact.totals.totalElapsedMs, totalCostUsd: artifact.totals.totalCostUsd,
    budgetUsd,
  }, null, 2));
  if (artifact.totals.failed > 0 || !(isDecisionCampaign ? decisionEligible : campaignPass)) process.exitCode = 1;
}

if (workerScenarioId) {
  await runWorker();
} else {
  runParent();
}
