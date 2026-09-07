import assert from 'node:assert/strict';
import test from 'node:test';

import { TurnExpiredError, TurnQueue } from '../src/claude/turn-queue.js';

test('runs turns in arrival order and reports queue wait', async () => {
  let now = 0;
  const queue = new TurnQueue(75_000, () => now);
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = queue.run(async () => {
    events.push('first-start');
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    events.push('first-end');
  });
  const second = queue.run(async (context) => {
    events.push(`second-start-${context.queueWaitMs}`);
  });
  await Promise.resolve();
  now = 25;
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start-25']);
});

test('expires an already queued turn without blocking the following turn', async () => {
  let now = 0;
  const queue = new TurnQueue(10, () => now);
  let releaseFirst: (() => void) | undefined;
  const first = queue.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
  const expired = queue.run(async () => 'unreachable');
  const following = queue.run(async () => 'also-unreachable');
  await Promise.resolve();
  now = 11;
  releaseFirst?.();
  await first;
  await assert.rejects(expired, TurnExpiredError);
  await assert.rejects(following, TurnExpiredError);
});
