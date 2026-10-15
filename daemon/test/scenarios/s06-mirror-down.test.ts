// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const WRITES = [
  'filesystem upload',
  'filesystem move',
  'filesystem rename',
  'filesystem trash',
  'filesystem create-folder',
  'filesystem delete',
];

describe('S6 mirror-down', () => {
  it('downloads new/changed remote files, trashes local copies of remote deletions, conflicts on local edits, never writes remotely', async () => {
    h = await makeHarness({
      accounts: [{ id: 'sam', workers: 1, devices: [] }],
      pairs: [
        {
          account: 'sam',
          name: 'Laptop-Backup',
          local: 'Sam/Laptop-Backup',
          remote: '/my-files/Laptop-Backup',
          direction: 'mirror-down',
        },
      ],
      seed: {
        sam: [
          {
            to: '/my-files/Laptop-Backup',
            files: { 'a.jpg': 'jpeg v1', 'docs/cv.pdf': 'cv', 'b.txt': 'b', 'empty/.keep': '' },
          },
        ],
      },
    });
    const r1 = await h.sync();
    expect(r1.status).toBe('ok');
    expect(h.read('Sam/Laptop-Backup/a.jpg')).toBe('jpeg v1');
    expect(h.read('Sam/Laptop-Backup/docs/cv.pdf')).toBe('cv');

    h.otherUpload('sam', '/my-files/Laptop-Backup', 'new.jpg', 'new photo', 'skip');
    h.otherUpload('sam', '/my-files/Laptop-Backup', 'a.jpg', 'jpeg v2 (edited on laptop)');
    h.other('sam', 'filesystem', 'trash', '/my-files/Laptop-Backup/docs/cv.pdf');
    h.write('Sam/Laptop-Backup/b.txt', 'edited locally by Alex');

    const r2 = await h.sync();
    expect(r2.status).toBe('ok');
    expect(h.read('Sam/Laptop-Backup/new.jpg')).toBe('new photo');
    expect(h.read('Sam/Laptop-Backup/a.jpg')).toBe('jpeg v2 (edited on laptop)');
    // old local a.jpg and the remotely deleted cv.pdf are in the freedesktop trash, not deleted
    const trash = path.join(h.dir, 'trash');
    expect(readFileSync(path.join(trash, 'files/cv.pdf'), 'utf8')).toBe('cv');
    expect(readFileSync(path.join(trash, 'info/cv.pdf.trashinfo'), 'utf8')).toMatch(
      /^\[Trash Info\]\nPath=.*cv\.pdf\nDeletionDate=/,
    );
    expect(readFileSync(path.join(trash, 'files/a.jpg'), 'utf8')).toBe('jpeg v1');
    expect(h.exists('Sam/Laptop-Backup/docs/cv.pdf')).toBe(false);
    // local edit in a mirror -> conflict, local file untouched
    expect(h.read('Sam/Laptop-Backup/b.txt')).toBe('edited locally by Alex');
    expect(h.engine.conflicts()).toEqual([expect.objectContaining({ relPath: 'b.txt', kind: 'mirror_local_edit' })]);
    expect(h.engine.activity(50).some((a) => a.action === 'trashed_local' && a.relPath === 'docs/cv.pdf')).toBe(true);

    // a mirror never writes to Proton: "keep local" is refused, the conflict stays open
    const cid = h.engine.conflicts()[0]!.id;
    expect(() => h.engine.resolveConflict(cid, 'keep_local', 'test')).toThrow(/mirror pairs never write/);
    expect(h.engine.conflicts()).toHaveLength(1);
    // resolution "keep remote" preserves the local edit as a copy
    h.engine.resolveConflict(cid, 'keep_remote', 'test');
    await h.drain();
    expect(h.read('Sam/Laptop-Backup/b.txt')).toBe('b');
    const copies = (await import('node:fs'))
      .readdirSync(path.join(h.data, 'Sam/Laptop-Backup'))
      .filter((n) => n.includes('local edit'));
    expect(copies).toHaveLength(1);

    expect(h.commands('sam').filter((c) => WRITES.includes(c.cmd))).toHaveLength(0);
    const staging = path.join(h.data, '.nucleon-sync-staging');
    expect(!existsSync(staging) || (await import('node:fs')).readdirSync(staging).length === 0).toBe(true);
  });
});
