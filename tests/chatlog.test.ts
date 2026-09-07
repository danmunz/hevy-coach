import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addMessagePair, getRecentMessages } from '../src/state/chatlog.js';
import { closeDbForTests, configureDbPathForTests, getDb } from '../src/state/db.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy-coach-chatlog-'));
configureDbPathForTests(path.join(directory, 'state.db'));

test.after(() => {
  closeDbForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('completed turns retain user and assistant order', () => {
  addMessagePair('First question', 'First answer');
  addMessagePair('Second question', 'Second answer');
  assert.deepEqual(getRecentMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Second question' },
    { role: 'assistant', content: 'Second answer' },
  ]);
});

test('failure of the assistant insert rolls back the whole turn and preserves earlier turns', () => {
  const before = getRecentMessages();
  const db = getDb();
  db.exec(`
    CREATE TEMP TRIGGER reject_assistant BEFORE INSERT ON messages
    WHEN NEW.role = 'assistant'
    BEGIN
      SELECT RAISE(ABORT, 'injected storage failure');
    END;
  `);
  try {
    assert.throws(() => addMessagePair('Rejected question', 'Rejected answer'), /injected storage failure/);
    assert.deepEqual(getRecentMessages(), before);
  } finally {
    db.exec('DROP TRIGGER reject_assistant');
  }
  addMessagePair('Recovered question', 'Recovered answer');
  assert.deepEqual(getRecentMessages().slice(-2).map(({ role }) => role), ['user', 'assistant']);
});
