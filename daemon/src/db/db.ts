// SPDX-License-Identifier: GPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

/** Opens (and migrates) the state DB. node:sqlite is built into Node >= 26: no native module to rebuild. */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // the state DB holds file names and paths: readable by the user only (also the WAL/SHM files SQLite creates)
  if (file !== ':memory:')
    for (const f of [file, `${file}-wal`, `${file}-shm`])
      try {
        chmodSync(f, 0o600);
      } catch {
        /* not created yet */
      }
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;',
  );
  migrate(db);
  return db;
}

/**
 * Base schema (schema.sql, version 1) + ordered migration files `migrations/NNN-<area>-<name>.sql`. Applied names are
 * recorded in meta ('migration:<file>'), so features can add migrations without editing the same file.
 */
export function migrate(db: DatabaseSync): void {
  migrateBase(db);
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    const key = `migration:${f}`;
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) continue;
    const sql = readFileSync(path.join(dir, f), 'utf8');
    // table rebuilds (e.g. changing a CHECK constraint) need foreign keys off, otherwise DROP TABLE would cascade;
    // the pragma is a no-op inside a transaction, so it is switched around BEGIN/COMMIT (SQLite docs, ALTER TABLE §7)
    // marker in the leading comment block (e.g. next to the licence header)
    const fkOff = /^-- psync:foreign-keys-off$/m.test(sql.split('\n').slice(0, 5).join('\n'));
    // a rebuild must not introduce foreign key violations (older violations, if any, are tolerated, not fatal)
    const fkBefore = fkOff ? db.prepare('PRAGMA foreign_key_check').all().length : 0;
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      if (fkOff) {
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length > fkBefore)
          throw new Error(`migration ${f}: foreign key check failed (${JSON.stringify(bad[0])})`);
      }
      db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(key, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function migrateBase(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current >= SCHEMA_VERSION) return;
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec('BEGIN');
  try {
    if (current < 1) db.exec(sql);
    // future: if (current < 2) db.exec(readFileSync(new URL('./migrations/002.sql', import.meta.url), 'utf8'));
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
