import { getDb } from './db.js';

export interface Message {
  role: string;
  content: string;
  created_at: string;
}

export function addMessage(role: 'user' | 'assistant', content: string): void {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)');
  stmt.run(role, content);
}

/** Store a completed turn atomically so a failed insert cannot leave one role alone. */
export function addMessagePair(userContent: string, assistantContent: string): void {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('user', userContent);
    stmt.run('assistant', assistantContent);
  })();
}

export function getRecentMessages(options?: {
  limit?: number;
  maxAgeHours?: number;
}): Message[] {
  const limit = options?.limit ?? 30;
  const maxAgeHours = options?.maxAgeHours ?? 48;

  const db = getDb();
  const stmt = db.prepare(`
    SELECT role, content, created_at
    FROM messages
    WHERE created_at >= datetime('now', ? || ' hours')
    ORDER BY id DESC
    LIMIT ?
  `);

  const rows = stmt.all(`-${maxAgeHours}`, limit) as Message[];
  return rows.reverse();
}

export function isFirstConversation(): boolean {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) AS count FROM messages');
  const row = stmt.get() as { count: number };
  return row.count === 0;
}
