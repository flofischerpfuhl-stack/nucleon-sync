// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Migration 005-a-twoway on a populated pre-two-way database: the pairs table is rebuilt (direction CHECK) without
 * losing or cascading anything that references it; foreign keys still work afterwards.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { migrate } from '../src/db/db.ts';
import { tmp } from './helpers.ts';

const DB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/db');

function oldDb(): DatabaseSync {
  const db = new DatabaseSync(path.join(tmp('mig-'), 'state.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8'));
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')").run();
  for (const f of ['002-a-engine.sql', '003-a-mtime-us.sql', '004-c-accounts-api.sql']) {
    db.exec(readFileSync(path.join(DB_DIR, 'migrations', f), 'utf8'));
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(`migration:${f}`, 'test');
  }
  const t = Date.now();
  db.prepare("INSERT INTO accounts (id, display_name, created_at) VALUES ('alex', 'Alex', ?)").run(t);
  for (const [id, local, remote] of [
    [1, '/srv/sync/Documents', '/devices/Workstation/Documents'],
    [2, '/srv/sync/Pictures', '/devices/Workstation/Bilder'],
  ] as const)
    db.prepare(
      `INSERT INTO pairs (id, account_id, name, local_root, remote_root, remote_section, remote_root_uid, direction, options,
       last_run_at, created_at) VALUES (?, 'alex', ?, ?, ?, '/devices/Workstation', 'uid-root', 'backup', '{"remoteChanges":"download"}', ?, ?)`,
    ).run(id, `p${id}`, local, remote, t, t);
  const ins = db.prepare(
    "INSERT INTO entries (pair_id, rel_path, kind, l_exists, r_exists, synced_at, updated_at) VALUES (?, ?, 'file', 1, 1, ?, ?)",
  );
  for (let i = 0; i < 500; i++) ins.run(1 + (i % 2), `f${i}.txt`, t, t);
  db.prepare(
    "INSERT INTO rules (pair_id, kind, pattern_type, pattern, created_at) VALUES (1, 'exclude', 'prefix', 'x', ?)",
  ).run(t);
  db.prepare("INSERT INTO remote_folders (pair_id, rel_path, uid) VALUES (1, '', 'uid-root')").run();
  db.prepare("INSERT INTO pair_state (pair_id, brake_reason, brake_at) VALUES (2, 'test', ?)").run(t);
  db.prepare(
    "INSERT INTO jobs (account_id, pair_id, entry_id, type, payload, state, created_at) VALUES ('alex', 1, 1, 'upload', '{}', 'queued', ?)",
  ).run(t);
  db.prepare("INSERT INTO conflicts (entry_id, kind, detected_at) VALUES (3, 'both_changed', ?)").run(t);
  db.prepare('INSERT INTO pending_deletions (entry_id, detected_at, size) VALUES (5, ?, 1)').run(t);
  db.prepare("INSERT INTO scans (pair_id, side, mode, started_at) VALUES (1, 'local', 'full', ?)").run(t);
  db.prepare(
    "INSERT INTO adoption_proposals (account_id, pair_id, entry_id, target_rel_path, source_remote_path, source_uid, source_section, size, matched_by, outside_pair, created_at) VALUES ('alex', 1, 7, 'f6.txt', '/x', 'u', '/my-files', 1, 'sha1', 1, ?)",
  ).run(t);
  return db;
}

const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migration 005-a-twoway', () => {
  it('rebuilds pairs without cascading, keeps every row, accepts two-way, keeps foreign keys', () => {
    const db = oldDb();
    const tables = [
      'pairs',
      'entries',
      'rules',
      'remote_folders',
      'pair_state',
      'jobs',
      'conflicts',
      'pending_deletions',
      'scans',
      'adoption_proposals',
    ];
    const before = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
    const pairsBefore = db.prepare('SELECT * FROM pairs ORDER BY id').all();
    expect(() => db.prepare("UPDATE pairs SET direction = 'two-way' WHERE id = 1").run()).toThrow(/CHECK constraint/);
    migrate(db);
    expect(Object.fromEntries(tables.map((t) => [t, count(db, t)]))).toEqual(before);
    expect(db.prepare('SELECT * FROM pairs ORDER BY id').all()).toEqual(pairsBefore);
    db.prepare("UPDATE pairs SET direction = 'two-way' WHERE id = 1").run();
    expect(() => db.prepare("UPDATE pairs SET direction = 'sideways' WHERE id = 1").run()).toThrow(/CHECK/);
    // new columns with safe defaults
    expect(db.prepare('SELECT side, held FROM pending_deletions').get()).toEqual({ side: 'local', held: 0 });
    expect(db.prepare('SELECT copy_rel_path, needs_review FROM conflicts').get()).toEqual({
      copy_rel_path: null,
      needs_review: 0,
    });
    // foreign keys are enforced again and still point at the (new) pairs table
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(() =>
      db.prepare("INSERT INTO entries (pair_id, rel_path, kind, updated_at) VALUES (99, 'x', 'file', 1)").run(),
    ).toThrow(/FOREIGN KEY/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries'").get() as { sql: string }).sql),
    ).toMatch(/REFERENCES pairs\(id\)/);
    // deleting a pair still cascades into its entries (and only those)
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM adoption_proposals').run();
    db.prepare('UPDATE runs SET pair_id = NULL').run();
    db.prepare('DELETE FROM pairs WHERE id = 2').run();
    expect(count(db, 'entries')).toBe(250);
    // idempotent
    migrate(db);
    expect(count(db, 'pairs')).toBe(1);
    db.close();
  });
});
