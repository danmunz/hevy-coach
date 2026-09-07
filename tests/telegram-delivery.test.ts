import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'telegraf';
import { DeliveryError, htmlToPlainText, sanitizeHtml, sendSplitMessages, splitIntoChunks } from '../src/telegram/client.js';

function context(reply: (...args: unknown[]) => Promise<unknown>): Pick<Context, 'reply'> {
  return { reply: reply as Context['reply'] };
}

test('chunks preserve text, entities, nested tags, and grapheme boundaries', () => {
  const text = `<b>${'a'.repeat(1200)}\n\n<i>${'👩🏽‍💻 &amp; '.repeat(300)}</i></b>`;
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.map(htmlToPlainText).join(''), htmlToPlainText(text));
  for (const chunk of chunks) {
    assert.ok(htmlToPlainText(chunk).length <= 2000);
    const stack: string[] = [];
    for (const tag of chunk.matchAll(/<(\/)?([a-z]+)[^>]*>/g)) {
      if (tag[1]) assert.equal(stack.pop(), tag[2]);
      else stack.push(tag[2]);
    }
    assert.deepEqual(stack, []);
    assert.ok(!htmlToPlainText(chunk).startsWith('🏽'));
    assert.ok(!htmlToPlainText(chunk).startsWith('\u200d'));
  }
  assert.ok(chunks[0].endsWith('\n\n</b>'));
});

test('links remain whole and hard breaks preserve long text', () => {
  const text = `<a href="https://example.com/path">${'z'.repeat(5000)}</a>`;
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.match(chunk, /^<a href="https:\/\/example.com\/path">z+<\/a>$/);
  assert.equal(chunks.map(htmlToPlainText).join(''), 'z'.repeat(5000));
});

test('sanitizer preserves encoded entities and plain fallback decodes them once', () => {
  assert.equal(sanitizeHtml('a &amp; b & c <script>x</script>'), 'a &amp; b &amp; c x');
  assert.equal(htmlToPlainText('<b>&lt;b&gt; &#128512; &#x1F600; &amp;lt;</b>'), '<b> 😀 😀 &lt;');
});

test('only formatting rejection sends a plain fallback', async () => {
  const calls: unknown[][] = [];
  await sendSplitMessages(context(async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw { response: { error_code: 400, description: "Bad Request: can't parse entities" } };
  }), '<b>a &amp; b</b>');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'a & b');
  assert.equal(calls[1][1], undefined);
});

test('ambiguous failure does not resend and records earlier chunks', async () => {
  let calls = 0;
  const progress: string[] = [];
  await assert.rejects(sendSplitMessages(context(async () => {
    if (++calls === 2) throw new Error('socket closed');
  }), 'x'.repeat(4500), event => progress.push(`${event.status}:${event.deliveredChunks}`)), error => {
    assert.ok(error instanceof DeliveryError);
    assert.equal(error.deliveredChunks, 1);
    assert.equal(error.totalChunks, 3);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(progress, ['sent:1', 'failed:1']);
});

test('explicit rate limit retries once, without unbounded waits', async () => {
  let calls = 0;
  const error = { response: { error_code: 429, parameters: { retry_after: 0 } } };
  await assert.rejects(sendSplitMessages(context(async () => { calls++; throw error; }), 'test'), DeliveryError);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(sendSplitMessages(context(async () => {
    calls++;
    throw { response: { error_code: 429, parameters: { retry_after: 31 } } };
  }), 'test'), DeliveryError);
  assert.equal(calls, 1);
});

test('non-formatting rejection never retries', async () => {
  let calls = 0;
  await assert.rejects(sendSplitMessages(context(async () => {
    calls++;
    throw { response: { error_code: 400, description: 'chat not found' } };
  }), 'test'), DeliveryError);
  assert.equal(calls, 1);
});

test('observer exceptions cannot change delivery outcomes or replace the original failure', async () => {
  const observer = () => { throw new Error('observer failed'); };
  let calls = 0;
  await sendSplitMessages(context(async () => { calls++; }), 'x'.repeat(2500), observer);
  assert.equal(calls, 2);
  const transportError = new Error('connection lost');
  await assert.rejects(sendSplitMessages(context(async () => { throw transportError; }), 'test', observer), error => {
    assert.ok(error instanceof DeliveryError);
    assert.equal(error.deliveredChunks, 0);
    assert.equal(error.cause, transportError);
    return true;
  });
});
