import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'telegraf';
import { TurnQueue } from '../src/claude/turn-queue.js';
import { DeliveryError, safeErrorFields, sendSplitMessages } from '../src/telegram/client.js';
import { handleMessageTurn } from '../src/telegram/handler.js';

const ctx = (reply: () => Promise<unknown>) => ({ reply: reply as Context['reply'] });

test('handler keeps slow first delivery ahead of fast second turn', async () => {
  const queue = new TurnQueue();
  const sent: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = handleMessageTurn({ queue, receivedAt: Date.now(), coach: async () => 'first',
    deliver: async text => { firstStarted(); await blocked; sent.push(text); }, logFailure: () => {} });
  await started;
  const second = handleMessageTurn({ queue, receivedAt: Date.now(), coach: async () => { sent.push('second coached'); return 'second'; },
    deliver: async text => { sent.push(text); }, logFailure: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ['first', 'second coached', 'second']);
});

test('delivery timeout does not resend and releases the queue', async () => {
  let sends = 0;
  const queue = new TurnQueue();
  const failures: unknown[] = [];
  await handleMessageTurn({ queue, receivedAt: Date.now(), coach: async () => 'reply',
    deliver: text => sendSplitMessages(ctx(async () => { sends++; return new Promise(() => {}); }), text, undefined, { timeoutMs: 10 }),
    logFailure: fields => failures.push(fields) });
  // One answer attempt plus one distinct failure notice. Neither is retried.
  assert.equal(sends, 2);
  assert.equal(failures.length, 2);
  assert.equal(await queue.run(async () => 'next'), 'next');
});

test('partial delivery after successful mutation produces a safe notice and safe logs', async () => {
  let saved = false;
  const messages: string[] = [];
  const logs: unknown[] = [];
  const secret = 'private-token-and-workout';
  await handleMessageTurn({ queue: new TurnQueue(), receivedAt: Date.now(),
    coach: async () => { saved = true; return 'saved'; },
    deliver: async text => {
      messages.push(text);
      if (messages.length === 1) throw new DeliveryError(1, 3, { message: secret, response: { description: secret }, on: { payload: secret } });
    }, logFailure: fields => logs.push(fields) });
  assert.equal(saved, true);
  assert.match(messages[1], /Only 1 of 3/);
  assert.match(messages[1], /Saved changes may already be complete/);
  assert.doesNotMatch(messages[1], /Try again/);
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.deepEqual(safeErrorFields({ message: secret, response: { error_code: 429, description: secret }, token: secret }), { kind: 'request_error', code: 429 });
});

test('production transport receives cancellation signal on a timed out request', async () => {
  let signal: { aborted: boolean } | undefined;
  let calls = 0;
  const transport = {
    reply: (async () => { throw new Error('Unexpected fallback'); }) as Context['reply'],
    chat: { id: 1, type: 'private', first_name: 'Test' } as Context['chat'],
    telegram: { callApi: async (_method: unknown, _payload: unknown, options: { signal: { aborted: boolean } }) => {
      calls++;
      signal = options.signal;
      return new Promise(() => {});
    } } as unknown as Context['telegram'],
  };
  await assert.rejects(sendSplitMessages(transport, 'test', undefined, { timeoutMs: 10 }), DeliveryError);
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test('retry wait shares the overall delivery deadline', async () => {
  let calls = 0;
  await assert.rejects(sendSplitMessages(ctx(async () => {
    calls++;
    throw { response: { error_code: 429, parameters: { retry_after: 1 } } };
  }), 'test', undefined, { timeoutMs: 20 }), DeliveryError);
  assert.equal(calls, 1);
});

test('handler passes the receipt deadline and caps the separate failure notice', async () => {
  const receivedAt = Date.now();
  const deadlines: number[] = [];
  await handleMessageTurn({ queue: new TurnQueue(), receivedAt, coach: async () => 'reply',
    deliver: async (_text, deadlineAt) => {
      deadlines.push(deadlineAt);
      if (deadlines.length === 1) throw new DeliveryError(0, 1, new Error('connection lost'));
      assert.ok(deadlineAt <= Date.now() + 5_000);
    }, logFailure: () => {} });
  assert.equal(deadlines[0], receivedAt + 75_000);
  assert.equal(deadlines.length, 2);
});

test('an exhausted turn deadline prevents even the first delivery request', async () => {
  let sends = 0;
  await assert.rejects(sendSplitMessages(ctx(async () => { sends++; }), 'reply', undefined,
    { deadlineAt: Date.now() - 1 }), DeliveryError);
  assert.equal(sends, 0);
});

test('handler completes every first reply chunk before the second reply', async () => {
  const queue = new TurnQueue();
  const firstText = 'first '.repeat(800);
  const secondText = 'second '.repeat(350);
  const chunks: Array<{ owner: string; text: string }> = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstSend = new Promise<void>(resolve => { started = resolve; });
  const transport = (owner: string) => ({ reply: (async (text: string) => {
    if (owner === 'first' && chunks.length === 0) { started(); await blocked; }
    chunks.push({ owner, text });
  }) as unknown as Context['reply'] });
  const first = handleMessageTurn({ queue, receivedAt: Date.now(), coach: async () => firstText,
    deliver: (text, deadlineAt) => sendSplitMessages(transport('first'), text, undefined, { deadlineAt }), logFailure: () => {} });
  await firstSend;
  const second = handleMessageTurn({ queue, receivedAt: Date.now(), coach: async () => secondText,
    deliver: (text, deadlineAt) => sendSplitMessages(transport('second'), text, undefined, { deadlineAt }), logFailure: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chunks.length, 0);
  release();
  await Promise.all([first, second]);
  const firstChunks = chunks.filter(chunk => chunk.owner === 'first');
  const secondChunks = chunks.filter(chunk => chunk.owner === 'second');
  assert.ok(firstChunks.length >= 2);
  assert.ok(secondChunks.length >= 2);
  assert.deepEqual(chunks.map(chunk => chunk.owner), [...firstChunks.map(() => 'first'), ...secondChunks.map(() => 'second')]);
  assert.equal(firstChunks.map(chunk => chunk.text).join(''), firstText);
  assert.equal(secondChunks.map(chunk => chunk.text).join(''), secondText);
});

test('an expired turn rejoins the queue for its notice without overtaking a later reply', async () => {
  let now = Date.now();
  const queue = new TurnQueue(100, () => now);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  let startFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { startFirst = resolve; });
  let releaseLater!: () => void;
  const laterBlocked = new Promise<void>(resolve => { releaseLater = resolve; });
  let startLater!: () => void;
  const laterStarted = new Promise<void>(resolve => { startLater = resolve; });
  const first = handleMessageTurn({ queue, receivedAt: now, coach: async () => 'first',
    deliver: async () => { startFirst(); await firstBlocked; events.push('first'); }, logFailure: () => {} });
  await firstStarted;
  const expired = handleMessageTurn({ queue, receivedAt: now, coach: async () => { throw new Error('Expired turn must not coach'); },
    deliver: async text => { assert.match(text, /waited too long/); events.push('expired notice'); }, logFailure: () => {} });
  now += 101;
  const later = handleMessageTurn({ queue, receivedAt: now, coach: async () => 'later',
    deliver: async () => { startLater(); await laterBlocked; events.push('later'); }, logFailure: () => {} });
  releaseFirst();
  await laterStarted;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  releaseLater();
  await Promise.all([first, expired, later]);
  assert.deepEqual(events, ['first', 'later', 'expired notice']);
});
