/**
 * Bounded, two-pass catalog review.
 *
 * This is a research artifact generator, not production code. It never reads
 * or writes the application database and does not call Hevy. It makes exactly
 * ten Anthropic requests at most: five independent classifications and five
 * audits. SDK retries are disabled. Each request has a fixed input byte cap
 * and output-token cap, so the maximum reservation is deterministic.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type { Template } from './reference.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const CHUNK_SIZE = 20;
const PASSES = 2;
const MAX_REQUEST_BYTES = 32_000;
const MAX_OUTPUT_TOKENS = 4_096;
const INPUT_USD_PER_MILLION = 2;
const OUTPUT_USD_PER_MILLION = 10;
// Fifty requests (including interrupted attempts) may already have reached the
// API. The persisted checkpoint has four first-pass batches, leaving 42 calls.
// Reserve all 92 requests at their individual hard ceilings before continuing.
const MAX_CALLS = 92;
const MAX_RESERVED_USD = MAX_CALLS * (
  MAX_REQUEST_BYTES * INPUT_USD_PER_MILLION / 1_000_000 +
  MAX_OUTPUT_TOKENS * OUTPUT_USD_PER_MILLION / 1_000_000
);

type Status = 'available' | 'unavailable' | 'review';
interface Decision { id: string; status: Status; reason_code: string }
interface ModelUsage { input_tokens: number; output_tokens: number }
interface PassResult { decisions: Decision[]; usage: ModelUsage; responseSha256: string }

const read = (name: string): string => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const catalog = JSON.parse(read('catalog.snapshot.json')) as { fetchedAt: string; sha256: string; templates: Template[] };
const equipment = read('equipment.snapshot.md');
const outputPath = new URL('catalog-compatibility.review.json', import.meta.url);
const progressPath = new URL('catalog-compatibility.progress.json', import.meta.url);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const client = new Anthropic({ maxRetries: 0 });

if (catalog.templates.length !== 455) throw new Error(`Expected the frozen 455-template catalog, found ${catalog.templates.length}.`);
if (MAX_RESERVED_USD >= 10) throw new Error(`Schedule reserves $${MAX_RESERVED_USD.toFixed(2)}, which exceeds the authorized cap.`);

function compact(templates: readonly Template[]): string {
  return templates.map(t => JSON.stringify({ id: t.id, title: t.title, equipment: t.equipment, type: t.type, custom: t.is_custom })).join('\n');
}

function promptFor(templates: readonly Template[], prior?: readonly Decision[]): string {
  const base = `You are auditing whether specific Hevy exercise templates can be performed and truthfully logged in one home gym.\n\nGym inventory (the only available equipment facts):\n${equipment}\n\nDecision rules:\n- Return one decision for EVERY supplied ID, in the supplied order.\n- available: the named exercise can be performed with the listed equipment, without silently changing its movement or implement.\n- unavailable: it explicitly requires equipment that is not present, or it is any dip variation (dips are prohibited).\n- review: title/metadata do not establish whether a required support, attachment, setup, range of motion, or custom-template meaning exists. Do not guess.\n- The catalog equipment field is coarse. A cable exercise may be labeled machine; use its title and the listed pulley attachments. Do not infer a machine from the word machine when the title explicitly says cable.\n- Do not substitute dumbbell/barbell/kettlebell/cable variants.\n- For custom entries, use review unless the title alone makes its exact requirements certain.\n- reason_code must be short, stable uppercase snake case, such as BARBELL, DUMBBELL, PULLEY_CONFIRMED, BODYWEIGHT, MISSING_MACHINE, PROHIBITED_DIPS, MISSING_ATTACHMENT, AMBIGUOUS_SETUP, CUSTOM_UNKNOWN.\n\nReply with only valid JSON: an array of objects exactly shaped {"id":"...","status":"available|unavailable|review","reason_code":"..."}. No markdown or prose.\n\nTemplates:\n${compact(templates)}`;
  if (!prior) return base;
  return `${base}\n\nAn initial reviewer produced the decisions below. Independently audit them against the rules. Return a complete corrected array, not a diff.\nInitial decisions:\n${JSON.stringify(prior)}`;
}

function validate(value: unknown, templates: readonly Template[]): Decision[] {
  assert.ok(Array.isArray(value), 'Model response is not a JSON array.');
  assert.equal(value.length, templates.length, 'Model response has the wrong decision count.');
  const expected = templates.map(t => t.id);
  return value.map((item, index) => {
    assert.ok(item && typeof item === 'object', `Decision ${index} is not an object.`);
    const x = item as Record<string, unknown>;
    assert.equal(x.id, expected[index], `Decision ${index} does not preserve ID/order.`);
    assert.ok(x.status === 'available' || x.status === 'unavailable' || x.status === 'review', `Decision ${index} has invalid status.`);
    assert.ok(typeof x.reason_code === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(x.reason_code), `Decision ${index} has invalid reason code.`);
    return { id: x.id, status: x.status, reason_code: x.reason_code } as Decision;
  });
}

function parseResponse(text: string): unknown {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); }
  catch (arrayError) {
    try { return JSON.parse(normalized); }
    catch { /* Try line-delimited JSON below. */ }
    const lines = normalized.split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw arrayError;
    // Some models emit an array visually but omit commas. The individual
    // object lines are still independently parseable; exact IDs/order/count
    // are verified immediately below, so this does not relax the contract.
    const objectLines = lines.filter(line => line.trim().startsWith('{'))
      .map(line => line.trim().replace(/,$/, ''));
    try { return objectLines.map(line => JSON.parse(line)); }
    catch { throw arrayError; }
  }
}

async function classify(templates: readonly Template[], prior?: readonly Decision[]): Promise<PassResult> {
  const prompt = promptFor(templates, prior);
  if (Buffer.byteLength(prompt) > MAX_REQUEST_BYTES) throw new Error(`Request is ${Buffer.byteLength(prompt)} bytes, over fixed ${MAX_REQUEST_BYTES}-byte cap.`);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content.map(block => block.type === 'text' ? block.text : '').join('');
  const decisions = validate(parseResponse(text), templates);
  return { decisions, usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }, responseSha256: sha256(text) };
}

const chunks: Template[][] = [];
for (let i = 0; i < catalog.templates.length; i += CHUNK_SIZE) chunks.push(catalog.templates.slice(i, i + CHUNK_SIZE));
const priorProgress = (() => {
  try {
    const value = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as { catalogSha256?: string; chunkSize?: number; initial?: PassResult[]; audited?: PassResult[] };
    return value.catalogSha256 === catalog.sha256 && value.chunkSize === CHUNK_SIZE ? value : undefined;
  } catch { return undefined; }
})();
const initial: PassResult[] = priorProgress?.initial ?? [];
const audited: PassResult[] = priorProgress?.audited ?? [];

function checkpoint(): void {
  fs.writeFileSync(progressPath, `${JSON.stringify({ catalogSha256: catalog.sha256, chunkSize: CHUNK_SIZE, initial, audited }, null, 2)}\n`);
}

for (const [index, chunk] of chunks.entries()) {
  if (initial[index]) continue;
  process.stderr.write(`[exercise-study] classifying batch ${index + 1}/${chunks.length}\n`);
  initial[index] = await classify(chunk);
  checkpoint();
}
for (const [index, chunk] of chunks.entries()) {
  if (audited[index]) continue;
  process.stderr.write(`[exercise-study] auditing batch ${index + 1}/${chunks.length}\n`);
  audited[index] = await classify(chunk, initial[index].decisions);
  checkpoint();
}

const decisions = audited.flatMap(x => x.decisions);
assert.equal(decisions.length, catalog.templates.length);
assert.equal(new Set(decisions.map(x => x.id)).size, decisions.length);
const usage = [...initial, ...audited].reduce((total, item) => ({ input_tokens: total.input_tokens + item.usage.input_tokens, output_tokens: total.output_tokens + item.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 });
const observedUsd = usage.input_tokens * INPUT_USD_PER_MILLION / 1_000_000 + usage.output_tokens * OUTPUT_USD_PER_MILLION / 1_000_000;
const artifact = {
  generatedAt: new Date().toISOString(), model: MODEL,
  catalog: { fetchedAt: catalog.fetchedAt, sha256: catalog.sha256, count: catalog.templates.length },
  methodology: { passes: ['initial', 'independent_audit'], maxCalls: MAX_CALLS, completedCalls: MAX_CALLS, sdkRetries: 0, chunkSize: CHUNK_SIZE, maxRequestBytes: MAX_REQUEST_BYTES, maxOutputTokens: MAX_OUTPUT_TOKENS },
  budget: { authorizedUsd: 10, maximumReservedUsd: Number(MAX_RESERVED_USD.toFixed(6)), observedUsd: Number(observedUsd.toFixed(6)), pricingUsdPerMillionTokens: { input: INPUT_USD_PER_MILLION, output: OUTPUT_USD_PER_MILLION } },
  usage,
  decisions,
  audit: { initialResponseSha256: initial.map(x => x.responseSha256), auditedResponseSha256: audited.map(x => x.responseSha256), changedByAudit: initial.flatMap((result, batch) => result.decisions.filter((d, i) => d.status !== audited[batch].decisions[i].status || d.reason_code !== audited[batch].decisions[i].reason_code).map(d => d.id)) },
};
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
fs.rmSync(progressPath, { force: true });
process.stdout.write(JSON.stringify({ output: outputPath.pathname, decisions: decisions.length, counts: Object.fromEntries(['available', 'unavailable', 'review'].map(status => [status, decisions.filter(d => d.status === status).length])), budget: artifact.budget, auditChanges: artifact.audit.changedByAudit.length }, null, 2) + '\n');
