import Database from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = path.resolve(process.cwd(), 'data/hevy-coach.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  console.log(`[db] Opening database at ${DB_PATH}`);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      active BOOLEAN DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS exercise_map (
      display_name TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      hevy_title TEXT NOT NULL,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}
