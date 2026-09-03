import { getDb } from './db.js';

export interface Note {
  id: number;
  content: string;
  created_at: string;
}

export function saveNote(content: string): number {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO notes (content) VALUES (?)');
  const result = stmt.run(content);
  return Number(result.lastInsertRowid);
}

export function clearNote(id: number): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE notes SET active = 0 WHERE id = ?');
  stmt.run(id);
}

export function getActiveNotes(): Note[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, content, created_at
    FROM notes
    WHERE active = 1
    ORDER BY created_at ASC
  `);
  return stmt.all() as Note[];
}
