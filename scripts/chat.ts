import 'dotenv/config';
import * as readline from 'readline';
import { chat } from '../src/claude/client.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Hevy Coach CLI — type a message (Ctrl+C to quit)\n');

function prompt(): void {
  rl.question('You: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    console.log('[thinking...]');

    try {
      const response = await chat(trimmed);
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
  console.log('\nBye!');
  process.exit(0);
});

prompt();
