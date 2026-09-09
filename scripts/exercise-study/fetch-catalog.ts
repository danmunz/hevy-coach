/** Read-only acquisition. Emits data to stdout; never opens the application DB. */
import 'dotenv/config';
import { createHash } from 'node:crypto';

const key = process.env.HEVY_API_KEY;
if (!key) throw new Error('HEVY_API_KEY is required.');
const templates: Record<string, unknown>[] = [];
let expectedPages: number | undefined;
for (let page = 1; ; page++) {
  const response = await fetch(`https://api.hevyapp.com/v1/exercise_templates?page=${page}&pageSize=100`, {
    headers: { 'api-key': key }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Catalog GET failed: HTTP ${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  const pages = data.page_count;
  const entries = data.exercise_templates;
  if (data.page !== page || typeof pages !== 'number' || !Number.isInteger(pages) || pages < page ||
      !Array.isArray(entries) || entries.length === 0 || (expectedPages !== undefined && pages !== expectedPages)) {
    throw new Error('Incomplete or inconsistent catalog scan.');
  }
  expectedPages = pages;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
      throw new Error('Invalid template.');
    }
    templates.push(entry as Record<string, unknown>);
  }
  if (page === pages) break;
}
if (new Set(templates.map(t => t.id)).size !== templates.length) throw new Error('Duplicate template IDs.');
process.stdout.write(JSON.stringify({ fetchedAt: new Date().toISOString(), pages: expectedPages,
  sha256: createHash('sha256').update(JSON.stringify(templates)).digest('hex'), templates }, null, 2) + '\n');
