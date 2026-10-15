// SPDX-License-Identifier: GPL-3.0-or-later
/** Planner units: move pairing (sha1 + inode), ambiguity, folder mapping and the 90 % folder-move rule. */
import { describe, expect, it } from 'vitest';

import { openDb } from '../../src/db/db.ts';
import type { PairRow } from '../../src/db/repo.ts';
import { folderMapping, planPair } from '../../src/engine/planner.ts';
import { RuleMatcher } from '../../src/engine/rules.ts';

function setup() {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO accounts (id, display_name, credential_backend, created_at) VALUES ('a', 'A', 'mock', 0)",
  ).run();
  db.prepare(
    "INSERT INTO pairs (id, account_id, name, local_root, remote_root, remote_section, remote_root_uid, direction, created_at) VALUES (1, 'a', 'P', '/l', '/devices/R/D', '/devices/R', 'root', 'backup', 0)",
  ).run();
  const pair = db.prepare('SELECT * FROM pairs WHERE id = 1').get() as unknown as PairRow;
  let n = 0;
  const synced = (rel: string, sha: string, inode: number, kind = 'file') =>
    db
      .prepare(
        `INSERT INTO entries (pair_id, rel_path, kind, l_exists, l_size, l_mtime_us, l_inode, l_dev, l_sha1, r_exists, r_uid, r_parent_uid,
         r_rev_uid, r_size, r_sha1, b_sha1, b_size, b_l_mtime_us, b_r_rev_uid, synced_at, updated_at)
         VALUES (1, ?, ?, 1, 3, 1000, ?, 1, ?, 1, ?, 'root', ?, 3, ?, ?, 3, 1000, ?, 1, 1)`,
      )
      .run(rel, kind, inode, sha, `uid-${++n}`, `rev-${n}`, sha, sha, `rev-${n}`);
  const gone = (rel: string) => db.prepare('UPDATE entries SET l_exists = 0 WHERE rel_path = ?').run(rel);
  const fresh = (rel: string, sha: string, inode: number, kind = 'file') =>
    db
      .prepare(
        'INSERT INTO entries (pair_id, rel_path, kind, l_exists, l_size, l_mtime_us, l_inode, l_dev, l_sha1, updated_at) VALUES (1, ?, ?, 1, 3, 1000, ?, 1, ?, 1)',
      )
      .run(rel, kind, inode, kind === 'file' ? sha : null);
  const plan = () => planPair({ db, pair, runId: null, matcher: new RuleMatcher({ rules: [] }) });
  const jobs = () =>
    (db.prepare('SELECT type, payload FROM jobs ORDER BY id').all() as { type: string; payload: string }[]).map(
      (j) => ({ ...(JSON.parse(j.payload) as Record<string, unknown>), type: j.type }) as Record<string, unknown>,
    );
  return { db, synced, gone, fresh, plan, jobs };
}

describe('folderMapping', () => {
  it('splits at the common suffix', () => {
    expect(folderMapping('A/x/f', 'B/x/f')).toEqual(['A', 'B']);
    expect(folderMapping('a/Kolpingstr/f', 'a/05_Wohnen/01_Kolpingstr/f')).toEqual([
      'a/Kolpingstr',
      'a/05_Wohnen/01_Kolpingstr',
    ]);
    expect(folderMapping('a/one.txt', 'a/uno.txt')).toBeNull(); // rename of the file itself
    expect(folderMapping('f.txt', 'sub/f.txt')).toBeNull(); // root involved
  });
});

describe('move pairing', () => {
  it('pairs by sha1; duplicates are disambiguated by inode; unresolvable ambiguity -> no move', () => {
    const t = setup();
    t.synced('a.txt', 's1', 10);
    t.synced('dup1.txt', 'sd', 11);
    t.synced('dup2.txt', 'sd', 12);
    t.synced('amb1.txt', 'sa', 13);
    t.synced('amb2.txt', 'sa', 14);
    for (const r of ['a.txt', 'dup1.txt', 'dup2.txt', 'amb1.txt', 'amb2.txt']) t.gone(r);
    t.fresh('moved/a.txt', 's1', 99); // copied+deleted: other inode, unique sha1 -> still a move
    t.fresh('moved/dup2.txt', 'sd', 12); // same inode as dup2
    t.fresh('x/amb.txt', 'sa', 50); // two candidates, no inode match -> ambiguous
    const res = t.plan();
    expect(res.moves).toBe(2);
    expect(res.ambiguous).toBe(1);
    const moves = t.jobs().filter((j) => j.type === 'move');
    expect(moves.map((m) => [m.fromRel, m.toRel]).sort()).toEqual([
      ['a.txt', 'moved/a.txt'],
      ['dup2.txt', 'moved/dup2.txt'],
    ]);
    const types = t.jobs().map((j) => `${j.type}:${j.rel}`);
    expect(types).toContain('upload:x/amb.txt'); // a wrong move is worse than one extra copy
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get()).toEqual({ n: 3 }); // dup1, amb1, amb2
  });

  it('folder move only when >= 90 % of the folder reappears under one new folder', () => {
    const t = setup();
    t.synced('old', '', 0, 'folder');
    for (let i = 0; i < 10; i++) t.synced(`old/f${i}`, `s${i}`, 100 + i);
    t.gone('old');
    for (let i = 0; i < 10; i++) t.gone(`old/f${i}`);
    t.fresh('new', '', 0, 'folder');
    for (let i = 0; i < 9; i++) t.fresh(`new/f${i}`, `s${i}`, 100 + i); // 9 of 10 -> folder move
    const res = t.plan();
    expect(res.folderMoves).toBe(1);
    expect(res.moves).toBe(0);
    const j = t.jobs();
    expect(j.filter((x) => x.type === 'move')).toEqual([
      expect.objectContaining({ folderMove: true, fromRel: 'old', toRel: 'new' }),
    ]);
    expect(j.filter((x) => x.type === 'mkdir')).toHaveLength(0); // new folder comes from the move
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get()).toEqual({ n: 0 }); // re-planned after the move

    const t2 = setup();
    t2.synced('old', '', 0, 'folder');
    for (let i = 0; i < 10; i++) t2.synced(`old/f${i}`, `s${i}`, 100 + i);
    t2.gone('old');
    for (let i = 0; i < 10; i++) t2.gone(`old/f${i}`);
    t2.fresh('new', '', 0, 'folder');
    for (let i = 0; i < 8; i++) t2.fresh(`new/f${i}`, `s${i}`, 100 + i); // 8 of 10 -> individual moves
    const r2 = t2.plan();
    expect(r2.folderMoves).toBe(0);
    expect(r2.moves).toBe(8);
    expect(t2.jobs().filter((x) => x.type === 'mkdir')).toHaveLength(1);
  });

  it('dedupe: planning twice does not create duplicate jobs', () => {
    const t = setup();
    t.fresh('n.txt', 'x', 1);
    t.plan();
    t.plan();
    expect(t.jobs().filter((j) => j.type === 'upload')).toHaveLength(1);
  });
});
