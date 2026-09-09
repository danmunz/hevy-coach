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

    CREATE TABLE IF NOT EXISTS exercise_catalog_revision (
      revision TEXT PRIMARY KEY,
      fetched_at DATETIME NOT NULL,
      equipment_revision TEXT NOT NULL,
      template_count INTEGER NOT NULL,
      is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS exercise_catalog_template (
      template_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      title TEXT NOT NULL,
      metric_type TEXT,
      equipment TEXT,
      primary_muscle_group TEXT,
      secondary_muscle_groups TEXT NOT NULL,
      is_custom INTEGER NOT NULL CHECK (is_custom IN (0, 1)),
      is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
      PRIMARY KEY (template_id, revision),
      FOREIGN KEY (revision) REFERENCES exercise_catalog_revision(revision)
    );

    CREATE INDEX IF NOT EXISTS exercise_catalog_template_active_title
      ON exercise_catalog_template(is_active, title);

    CREATE TABLE IF NOT EXISTS exercise_compatibility (
      template_id TEXT NOT NULL,
      catalog_revision TEXT NOT NULL,
      equipment_revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'unavailable', 'review')),
      reason_code TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('research', 'reviewed')),
      reviewed_at DATETIME,
      PRIMARY KEY (template_id, catalog_revision, equipment_revision),
      FOREIGN KEY (catalog_revision) REFERENCES exercise_catalog_revision(revision)
    );

    CREATE TABLE IF NOT EXISTS routine_draft (
      draft_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      catalog_revision TEXT NOT NULL,
      equipment_revision TEXT NOT NULL,
      target_routine_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'presented', 'confirmed', 'superseded')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      presented_at DATETIME,
      confirmed_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS routine_draft_status_created
      ON routine_draft(status, created_at);
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
