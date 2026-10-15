// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Migration 009 (0.4.0): an existing database with the settings and log rows of the removed Telegram channel comes
 * out clean; everything else (other settings, broken rows, notify command log rows) stays as it was.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { migrate } from '../src/db/db.ts';
import { readSettings } from '../src/engine/settings.ts';
import { tmp } from './helpers.ts';

const M009 = 'migration:009-c-drop-telegram.sql';

/** a database migrated up to 008, i.e. what 0.3.x leaves behind */
function oldDb(): DatabaseSync {
  const db = new DatabaseSync(path.join(tmp('mig9-'), 'state.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(M009, 'held back by the test');
  migrate(db);
  db.prepare('DELETE FROM meta WHERE key = ?').run(M009);
  return db;
}

const setting = (db: DatabaseSync, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

describe('migration 009-c-drop-telegram', () => {
  it('drops the Telegram settings and log rows, keeps everything else', () => {
    const db = oldDb();
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    put.run(
      'notifications',
      JSON.stringify({ desktop: false, telegram: { enabled: true, chatId: '424242' }, minIntervalMinutes: 120 }),
    );
    // older layout: one whole-settings row
    put.run(
      'settings',
      JSON.stringify({
        schedule: { incrementalEveryMinutes: 180 },
        notifications: { desktop: true, telegram: { enabled: false, chatId: '' } },
      }),
    );
    put.run('schedule', JSON.stringify({ incrementalEveryMinutes: 720 }));
    put.run('brakes', 'not json'); // a damaged row must neither break the migration nor be touched
    const log = db.prepare(
      'INSERT INTO notifications (ts, channel, dedupe_key, message, ok, detail) VALUES (?, ?, ?, ?, ?, ?)',
    );
    log.run(1, 'telegram', 'error:auth:sam', 'x', 1, 'sent');
    log.run(2, 'command', 'error:auth:sam', 'x', 1, 'command exited 0');
    log.run(3, 'telegram', 'digest:daily', 'y', 0, 'HTTP 400');

    migrate(db);

    expect(JSON.parse(setting(db, 'notifications')!)).toEqual({ desktop: false, minIntervalMinutes: 120 });
    expect(JSON.parse(setting(db, 'settings')!)).toEqual({
      schedule: { incrementalEveryMinutes: 180 },
      notifications: { desktop: true },
    });
    expect(JSON.parse(setting(db, 'schedule')!)).toEqual({ incrementalEveryMinutes: 720 });
    expect(setting(db, 'brakes')).toBe('not json');
    expect(db.prepare('SELECT ts, channel FROM notifications ORDER BY ts').all()).toEqual([
      { ts: 2, channel: 'command' },
    ]);
    expect(db.prepare('SELECT 1 AS ok FROM meta WHERE key = ?').get(M009)).toEqual({ ok: 1 });
    // what the engine and the API see
    expect(readSettings(db).notifications).toEqual({ desktop: false, minIntervalMinutes: 120 });
    // applied once: running migrate again changes nothing
    migrate(db);
    expect(JSON.parse(setting(db, 'notifications')!)).toEqual({ desktop: false, minIntervalMinutes: 120 });
    db.close();
  });

  it('is a no-op on a database without Telegram settings', () => {
    const db = oldDb();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'notifications',
      JSON.stringify({ desktop: true, minIntervalMinutes: 360 }),
    );
    migrate(db);
    expect(JSON.parse(setting(db, 'notifications')!)).toEqual({ desktop: true, minIntervalMinutes: 360 });
    db.close();
  });
});
