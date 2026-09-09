import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/state/db.js';
import { seedDefaults } from '../src/state/config.js';
import { HevyClient } from '../src/hevy/client.js';
import { EXERCISE_PINS, resolveExerciseMap } from '../src/hevy/exercise-pins.js';
import { installExerciseCatalog } from '../src/state/exercise-catalog.js';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

function fail(msg: string): void {
  console.log(`✗ ${msg}`);
}

// ---------------------------------------------------------------------------
// Step 1 & 2: Database + config seeding
// ---------------------------------------------------------------------------

function initDatabase(): void {
  getDb();
  ok('Database ready at data/hevy-coach.db');
}

function seedConfig(): void {
  const defaultsPath = path.resolve(__dirname, '../config/defaults.json');
  const raw = fs.readFileSync(defaultsPath, 'utf-8');
  const defaults: Record<string, string> = JSON.parse(raw);
  seedDefaults(defaults);
  const keys = Object.keys(defaults).join(', ');
  ok(`Config seeded (${keys})`);
}

// ---------------------------------------------------------------------------
// Step 3: Verify API keys
// ---------------------------------------------------------------------------

interface ApiResults {
  telegram: boolean;
  claude: boolean;
  hevy: boolean;
}

async function verifyTelegram(): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    fail('Telegram: TELEGRAM_BOT_TOKEN not set');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) {
      ok(`Telegram: connected as @${data.result.username}`);
      return true;
    }
    fail(`Telegram: API returned ok=false`);
    return false;
  } catch (err) {
    fail(`Telegram: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function verifyClaude(): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    fail('Claude: ANTHROPIC_API_KEY not set');
    return false;
  }
  try {
    const client = new Anthropic({ apiKey });
    const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
    await client.messages.create({
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    ok('Claude: model responds');
    return true;
  } catch (err) {
    fail(`Claude: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function verifyHevy(): Promise<boolean> {
  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) {
    fail('Hevy: HEVY_API_KEY not set');
    return false;
  }
  try {
    const client = new HevyClient();
    const valid = await client.verifyApiKey();
    if (valid) {
      ok('Hevy: API key valid');
      return true;
    }
    fail('Hevy: API key rejected');
    return false;
  } catch (err) {
    fail(`Hevy: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function verifyApis(): Promise<ApiResults> {
  const [telegram, claude, hevy] = await Promise.all([
    verifyTelegram(),
    verifyClaude(),
    verifyHevy(),
  ]);
  return { telegram, claude, hevy };
}

// ---------------------------------------------------------------------------
// Step 4: Resolve and cache exercise templates
// ---------------------------------------------------------------------------

async function cacheExerciseTemplates(): Promise<{ resolved: number; total: number; failed: string[] }> {
  const client = new HevyClient();
  const catalog = await client.fetchAllTemplates();
  const catalogStatus = installExerciseCatalog(catalog);
  ok(`Exercise catalog: ${catalogStatus.templateCount} templates stored`);
  const total = Object.keys(EXERCISE_PINS).length;

  const searchFn = (query: string) => client.searchExerciseTemplates(query);
  const exerciseMap = await resolveExerciseMap(searchFn);

  // Persist to exercise_map table
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO exercise_map (display_name, template_id, hevy_title, cached_at)
     VALUES (?, ?, ?, datetime('now'))`,
  );

  for (const [displayName, templateId] of exerciseMap) {
    // hevy_title is stored as the display name since we don't have the
    // Hevy-side title readily available from resolveExerciseMap.
    // The display_name is the canonical name used in our system.
    stmt.run(displayName, templateId, displayName);
  }

  const resolved = exerciseMap.size;
  const failed: string[] = [];
  for (const name of Object.keys(EXERCISE_PINS)) {
    if (!exerciseMap.has(name)) {
      failed.push(name);
    }
  }

  ok(`Exercise templates: ${resolved}/${total} resolved`);
  if (failed.length > 0) {
    console.log(`  Unresolved: ${failed.join(', ')}`);
  }

  return { resolved, total, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('hevy-coach setup\n');

  // Database + config
  initDatabase();
  seedConfig();
  console.log();

  // API verification
  console.log('Verifying API connections...');
  const apis = await verifyApis();
  console.log();

  // Exercise templates (only attempt if Hevy key works)
  let exerciseCount = 0;
  if (apis.hevy) {
    console.log('Resolving exercise templates...');
    const result = await cacheExerciseTemplates();
    exerciseCount = result.resolved;
  } else {
    fail('Exercise templates: skipped (Hevy API unavailable)');
  }
  console.log();

  // Summary
  const telegramStatus = apis.telegram ? '✓' : '✗';
  const claudeStatus = apis.claude ? '✓' : '✗';
  const hevyStatus = apis.hevy ? '✓' : '✗';

  console.log('Setup complete.');
  console.log(`- Database: data/hevy-coach.db`);
  console.log(`- Exercise templates cached: ${exerciseCount}`);
  console.log(`- APIs: Telegram ${telegramStatus}, Claude ${claudeStatus}, Hevy ${hevyStatus}`);
  console.log();
  console.log('Run: npm start');

  // Exit with error only if ALL API keys failed
  if (!apis.telegram && !apis.claude && !apis.hevy) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
