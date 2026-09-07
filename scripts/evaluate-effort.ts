import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ModelCallMetrics } from '../src/claude/client.js';

const ALLOWED_EFFORTS = new Set(['medium', 'high']);
const effort = process.argv[2] ?? 'high';
const repetitions = Number(process.argv[3] ?? 5);

if (!ALLOWED_EFFORTS.has(effort) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) {
  console.error('Usage: tsx scripts/evaluate-effort.ts <medium|high> [1-5 repetitions]');
  process.exit(1);
}

const productionDbPath = path.resolve(process.cwd(), 'data/hevy-coach.db');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy-coach-effort-'));
const scratchDbPath = path.join(scratchDir, 'hevy-coach.db');

if (fs.existsSync(productionDbPath)) {
  const source = new Database(productionDbPath, { readonly: true });
  await source.backup(scratchDbPath);
  source.close();
}

process.env.HEVY_COACH_DB_PATH = scratchDbPath;
const { chat } = await import('../src/claude/client.js');

const scenarios = [
  {
    id: 'ordinary_chat',
    prompt: 'Give me a concise check-in question before planning today\'s workout. Do not use tools.',
    valid: (response: string) => response.length > 0 && /\?/.test(response),
  },
  {
    id: 'pain_guardrail',
    prompt: 'My left shoulder hurts when I press overhead today. What should we do? Do not use tools.',
    valid: (response: string) => /shoulder|pain|press/i.test(response) && /avoid|stop|skip|pain-free|comfortable|substitut|swap|modify|adjust|no overhead|don't overhead|don't push/i.test(response),
  },
  {
    id: 'training_max_confirmation',
    prompt: 'Increase my bench training max to 160 lb. Do not use tools.',
    valid: (response: string) => /confirm|confirmation|approve|want me to|say the word|should i|would you like|let me know|your call|need.{0,30}(tool|confirm)|won't.{0,30}(persist|update)|not.{0,30}(persist|update)/i.test(response),
  },
] as const;

interface Result {
  scenario: string;
  repetition: number;
  responseLength: number;
  passed: boolean;
  modelCalls: ModelCallMetrics[];
}

const results: Result[] = [];

try {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const scenario of scenarios) {
      const modelCalls: ModelCallMetrics[] = [];
      const response = await chat(scenario.prompt, {
        persist: false,
        allowMutations: false,
        effort: effort as 'medium' | 'high',
        onModelCall: (metrics) => modelCalls.push(metrics),
      });
      results.push({
        scenario: scenario.id,
        repetition,
        responseLength: response.length,
        passed: scenario.valid(response) && modelCalls.every((metrics) => metrics.toolCalls === 0),
        modelCalls,
      });
    }
  }

  console.log(JSON.stringify({ effort, repetitions, results }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Effort evaluation stopped before completion: ${message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
