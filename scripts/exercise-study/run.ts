import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { HevyClient } from '../../src/hevy/client.js';
import { resolveExerciseName } from '../../src/hevy/exercise-pins.js';
import { cases, lifecycleCases } from './cases.js';
import { bind, captureWrite, CatalogStore, compatibility, homeGym, key, migrateLegacy, resolve, revision, type Template } from './reference.js';

const read = (name: string): string => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const snapshot = JSON.parse(read('catalog.snapshot.json')) as { fetchedAt: string; pages: number; sha256: string; templates: Template[] };
const mappings = JSON.parse(read('mappings.snapshot.json')) as { display_name: string; template_id: string; hevy_title: string }[];
const catalog = snapshot.templates;
assert.equal(revision(catalog), snapshot.sha256);
assert.equal(cases.length + lifecycleCases.length, 24);
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalWarn = console.warn;
const baselineMessages: string[] = [];
console.log = console.warn = (...args: unknown[]) => baselineMessages.push(args.join(' '));
let reads = 0;
let forbiddenRequests = 0;
let activeCatalog = catalog;
// Real production resolver/client, with all transport replaced. No live API/DB access.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if ((init?.method ?? 'GET') !== 'GET' || url.pathname !== '/v1/exercise_templates') {
    forbiddenRequests++;
    throw new Error('Study transport forbids this operation.');
  }
  reads++;
  const page = Number(url.searchParams.get('page'));
  const pageSize = Number(url.searchParams.get('pageSize'));
  return Response.json({ page, page_count: Math.ceil(activeCatalog.length / pageSize),
    exercise_templates: activeCatalog.slice((page - 1) * pageSize, page * pageSize) });
};

try {
  const started = performance.now();
  const results = [];
  for (const fixture of cases) {
    activeCatalog = structuredClone(catalog);
    const map = new Map(mappings.map(m => [m.display_name.toLowerCase(), m.template_id]));
    let boundId: string | undefined;
    if (fixture.variant === 'rename') {
      boundId = '79D0BB3A';
      activeCatalog.find(t => t.id === boundId)!.title = 'Renamed historical bench';
    }
    if (fixture.variant === 'duplicate') {
      const template = catalog[0];
      activeCatalog.push({ ...template, id: 'fixture-a', title: 'Study Custom' }, { ...template, id: 'fixture-b', title: 'Study Custom' });
    }
    if (fixture.variant === 'removed') {
      boundId = 'c6572171-5bd3-4722-9cd0-917fa9f64de7';
      activeCatalog = activeCatalog.filter(t => t.id !== boundId);
      map.set('bird dogs', boundId);
    }
    const client = new HevyClient('fixture');
    const beforeReads = reads;
    const baselineId = await resolveExerciseName(fixture.query, map, q => client.searchExerciseTemplates(q));
    const baseline = { status: baselineId ? 'compatible' : 'unresolved', id: baselineId ?? undefined };
    const reference = resolve(activeCatalog, fixture.query, { id: boundId,
      history: fixture.variant === 'rename', requestedEquipment: fixture.variant === 'adaptation' ? 'kettlebell' : undefined });
    const matches = (r: { status: string; id?: string }): boolean => r.status === fixture.expected && r.id === fixture.expectedId;
    results.push({ ...fixture, baseline, reference, baselinePass: matches(baseline), referencePass: matches(reference), baselineCatalogRequests: reads - beforeReads });
  }

  const lifecycle = [];
  const bench = catalog.find(t => t.id === '79D0BB3A')!;
  const selected = bind(bench);
  assert.notEqual(revision(homeGym), revision({ ...homeGym, barbell: false }));
  assert.throws(() => captureWrite(selected, catalog, { ...homeGym, barbell: false }), /removed/);
  lifecycle.push({ ...lifecycleCases[0], referencePass: true, baseline: 'No equipment validator in resolver; static source finding, not a full-turn measurement.' });
  const renamed = catalog.map(t => t.id === bench.id ? { ...t, title: 'Renamed bench' } : t);
  assert.deepEqual(captureWrite(selected, renamed), { exercise_template_id: bench.id });
  const recreated = catalog.map(t => t.id === bench.id ? { ...t, id: 'fixture-recreated' } : t);
  assert.throws(() => captureWrite(selected, recreated), /absent/);
  lifecycle.push({ ...lifecycleCases[1], referencePass: true, baseline: 'Name-based payloads reconstruct identity from mutable mappings; covered separately by I1/I3.' });
  const store = new CatalogStore(catalog);
  await assert.rejects(store.refresh(async () => { throw new Error('offline fixture'); }), /offline/);
  assert.equal(store.templates, catalog);
  await assert.rejects(store.refresh(async () => ({ complete: false, templates: catalog.slice(0, 100) })), /Incomplete/);
  assert.equal(store.templates, catalog);
  await store.refresh(async () => ({ complete: true, templates: renamed }));
  assert.equal(store.templates, renamed);
  lifecycle.push({ ...lifecycleCases[2], referencePass: true, baseline: 'Production already has cache recovery tests in tests/hevy-reads.test.ts; run those separately.' });
  assert.equal(migrateLegacy('bench', {}, catalog), undefined);
  assert.deepEqual(migrateLegacy('bench', { bench: bench.id }, catalog), selected);
  assert.equal(migrateLegacy('bench', { bench: 'missing-id' }, catalog), undefined);
  lifecycle.push({ ...lifecycleCases[3], referencePass: true, baseline: 'Confirmed payload stores names; pending records additionally store name-to-ID evidence.' });

  // Reproduce equipment-stripping collision without executing external source.
  const strip = (s: string): string => keyForCollision(s).replace(/\b(barbell|dumbbell|cable|machine)\b/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(strip('Bench Press (Barbell)'), strip('Bench Press (Dumbbell)'));
  assert.notEqual(resolve(catalog, 'Bench Press (Barbell)').id, resolve(catalog, 'Bench Press (Dumbbell)').id);
  // Full-catalog inspection found that generic token sorting merges opposite directions.
  assert.notEqual(key('Cable Twist (Down to up)'), key('Cable Twist (Up to down)'));
  assert.throws(() => captureWrite({ templateId: 'fabricated', titleAtSelection: bench.title }, catalog), /absent/);
  const classifications = catalog.map(t => ({ id: t.id, title: t.title, ...compatibility(t, homeGym) }));
  const countBy = (values: string[]): Record<string, number> => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
  const titleGroups = new Map<string, string[]>();
  const sortedGroups = new Map<string, string[]>();
  for (const t of catalog) titleGroups.set(t.title.trim().toLowerCase(), [...(titleGroups.get(t.title.trim().toLowerCase()) ?? []), t.id]);
  for (const t of catalog) {
    const sorted = keyForCollision(t.title).replace(/\s+/g, ' ').trim().split(' ').sort().join(' ');
    sortedGroups.set(sorted, [...(sortedGroups.get(sorted) ?? []), t.id]);
  }
  const summary = {
    implementationHashes: Object.fromEntries(['../../src/hevy/exercise-pins.ts', '../../src/hevy/client.ts',
      'reference.ts', 'cases.ts', 'mappings.snapshot.json'].map(file => [file, revision(read(file))])),
    catalog: { fetchedAt: snapshot.fetchedAt, sha256: snapshot.sha256, count: catalog.length, pages: snapshot.pages,
      fieldMissing: Object.fromEntries(['id', 'title', 'type', 'equipment', 'primary_muscle_group', 'secondary_muscle_groups', 'is_custom']
        .map(field => [field, catalog.filter(t => !(field in t)).length])),
      equipment: countBy(catalog.map(t => t.equipment)), types: countBy(catalog.map(t => t.type)),
      custom: catalog.filter(t => t.is_custom).length,
      nonHexBuiltInIds: catalog.filter(t => !t.is_custom && !/^[0-9A-F]{8}$/.test(t.id)).map(t => ({ id: t.id, title: t.title })),
      duplicateTitles: [...titleGroups].filter(([, ids]) => ids.length > 1),
      wordOrderCollisions: [...sortedGroups].filter(([, ids]) => ids.length > 1),
      titleMetadataConflicts: catalog.filter(t => /\(cable\)|cable row|rope pushdown/i.test(t.title) && t.equipment === 'machine').map(t => ({ id: t.id, title: t.title })),
    },
    selection: { count: results.length, baselinePass: results.filter(r => r.baselinePass).length, referencePass: results.filter(r => r.referencePass).length,
      baselineUnexpectedSelections: results.filter(r => r.baseline.id && !r.baselinePass).map(r => r.id),
      referenceUnexpectedSelections: results.filter(r => r.reference.id && !r.referencePass).map(r => r.id) },
    lifecyclePass: lifecycle.length, compatibilityCoverage: countBy(classifications.map(r => r.status)),
    paidEvaluation: { run: false, spentUsd: 0, reason: 'Fixed cases are resolved by explicit identity rules or correctly remain uncertain because of missing equipment/intent facts. No demonstrated residual semantic failure requires a paid comparison. Full-catalog semantic coverage remains unproven.' },
    durationMs: Math.round(performance.now() - started), forbiddenRequests,
  };
  assert.equal(forbiddenRequests, 0);
  assert.ok(results.every(r => r.referencePass), 'Reference failed a predefined case');
  process.stdout.write(JSON.stringify({ summary, results, lifecycle, classifications, baselineMessages }, null, 2) + '\n');
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
}

function keyForCollision(s: string): string { return s.toLowerCase().replace(/[()]/g, ' '); }
