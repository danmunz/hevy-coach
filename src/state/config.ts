import { getDb } from './db.js';

export interface TrainingMaxes {
  squat: number;
  bench: number;
  deadlift: number;
  ohp: number;
}

export function getConfig(key: string): string | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(key, value);
}

export function getTrainingMaxes(): TrainingMaxes {
  const raw = getConfig('training_maxes');
  if (!raw) {
    return { squat: 0, bench: 0, deadlift: 0, ohp: 0 };
  }
  const parsed = JSON.parse(raw) as Partial<TrainingMaxes>;
  return {
    squat: parsed.squat ?? 0,
    bench: parsed.bench ?? 0,
    deadlift: parsed.deadlift ?? 0,
    ohp: parsed.ohp ?? 0,
  };
}

export function setTrainingMaxes(maxes: Partial<TrainingMaxes>): void {
  const current = getTrainingMaxes();
  const merged: TrainingMaxes = { ...current, ...maxes };
  setConfig('training_maxes', JSON.stringify(merged));
}

export function seedDefaults(defaults: Record<string, string>): void {
  const db = getDb();
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) {
    stmt.run(key, value);
  }
}
