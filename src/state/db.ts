import Database from 'better-sqlite3';
import path from 'node:path';

let dbPath = process.env.HEVY_COACH_DB_PATH
  ? path.resolve(process.env.HEVY_COACH_DB_PATH)
  : path.resolve(process.cwd(), 'data/hevy-coach.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  console.log(`[db] Opening database at ${dbPath}`);
  db = new Database(dbPath);
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

    CREATE TABLE IF NOT EXISTS pending_hevy_mutation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      operation TEXT NOT NULL,
      routine_id TEXT,
      payload TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

/** Test-only seam. It must run before the first database access. */
export function configureDbPathForTests(nextPath: string): void {
  if (db) throw new Error('Cannot change the database path after it has opened.');
  dbPath = path.resolve(nextPath);
}

export function closeDbForTests(): void {
  db?.close();
  db = null;
}
