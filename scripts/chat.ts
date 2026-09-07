import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'readline';

const productionDbPath = path.resolve(process.cwd(), 'data/hevy-coach.db');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy-coach-cli-'));
const scratchDbPath = path.join(scratchDir, 'hevy-coach.db');

if (fs.existsSync(productionDbPath)) {
  const source = new Database(productionDbPath, { readonly: true });
  await source.backup(scratchDbPath);
  source.close();
}

// db.ts is loaded only after this point, so every local state write belongs to
// the temporary copy. The directory is removed when the process exits.
process.env.HEVY_COACH_DB_PATH = scratchDbPath;
const { chat } = await import('../src/claude/client.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Hevy Coach CLI — DEMO MODE: scratch coaching state; live Hevy reads only (Ctrl+C to quit)\n');

function cleanup(): void {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

function prompt(): void {
  rl.question('You: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    console.log('[thinking...]');

    try {
      const response = await chat(trimmed, { allowHevyWrites: false });
      console.log(`Coach: ${response}`);
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    console.log();
    prompt();
  });
}

rl.on('close', () => {
  cleanup();
  console.log('\nBye!');
  process.exit(0);
});

process.once('SIGINT', () => rl.close());
process.once('SIGTERM', () => rl.close());

prompt();
