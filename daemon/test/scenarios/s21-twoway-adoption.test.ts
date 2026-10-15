// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S21 two-way adoption: both sides already hold the same files -> no re-upload, no re-download and above all no new
 * remote revisions — also for files the old Windows client uploaded without a sha1 digest (the 31 GB lesson).
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { twoWayConflictName } from '@nucleon-sync/shared';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents';
const T = new Date('2024-05-01T08:00:00Z');
const OTHER = new Date('2023-01-01T08:00:00Z');

describe('S21 two-way adoption', () => {
  it('identical files are only recorded; digest-less ones are proven by content; real differences kept both', async () => {
    h = await makeHarness({
      pairs: [
        {
          account: 'alex',
          name: 'Haus',
          local: 'Haus',
          remote: R,
          direction: 'two-way',
          options: { twoWayAdoption: true },
        },
      ],
      engine: { twoWayVerifyMaxBytes: 20 },
      seed: {
        alex: [
          // CLI uploads with sha1
          { to: R, files: { 'same.txt': 'identical', 'diff.txt': 'remote version', 'only-remote.txt': 'R' } },
          // old Windows uploads without sha1, same mtime
          { to: R, noDigest: true, files: { 'win-same.doc': 'windows same' } },
          // old Windows uploads without sha1, other mtime (same size): proven by downloading to staging
          {
            to: R,
            noDigest: true,
            mtime: OTHER,
            files: {
              'win-mtime.doc': 'same bytes',
              'win-diff.doc': 'XXXX bytes',
              'big.bin': 'big file, more than twenty bytes',
            },
          },
        ],
      },
      localFiles: {
        'Haus/same.txt': 'identical',
        'Haus/diff.txt': 'local version!',
        'Haus/only-local.txt': 'L',
        'Haus/win-same.doc': 'windows same',
        'Haus/win-mtime.doc': 'same bytes',
        'Haus/win-diff.doc': 'same bytes',
        'Haus/big.bin': 'big file, more than twenty bytes',
      },
      mtime: T,
    });
    const before = h.remoteState();
    const revs = (name: string) =>
      Object.values(h.remoteState().nodes).find((n) => n.name === name && !n.trashed)?.revisions?.length;
    const r = await h.sync();
    expect(r.status).toBe('ok');
    await h.drain();
    const cmds = h.commands();
    // no new revision of anything, ever
    expect(uploadsWith(cmds, 'create-new-revision')).toHaveLength(0);
    expect(uploadsWith(cmds, 'replace')).toHaveLength(0);
    for (const n of ['same.txt', 'win-same.doc', 'win-mtime.doc', 'win-diff.doc', 'big.bin', 'diff.txt'])
      expect(revs(n), n).toBe(1);
    // identical (sha1, size+mtime, content-checked) -> synced without transfer
    for (const rel of ['same.txt', 'win-same.doc', 'win-mtime.doc']) expect(h.entry(1, rel)?.state, rel).toBe('synced');
    expect(h.entry(1, 'win-same.doc')!.flags & 1).toBe(1); // digest_missing
    expect(
      h.engine.activity(100).some((a) => a.relPath === 'win-mtime.doc' && /content verified/.test(a.message ?? '')),
    ).toBe(true);
    // what was uploaded: the local-only file and the two conflict copies (both -f skip)
    const uploadedNames = uploadsWith(cmds, 'skip').flatMap((c) =>
      c.args
        .slice(0, -1)
        .filter((a) => a.startsWith('/'))
        .map((a) => path.basename(a)),
    );
    expect(uploadedNames.sort()).toEqual(
      [
        'only-local.txt',
        path.basename(twoWayConflictName('diff.txt', 'pc', new Date())),
        path.basename(twoWayConflictName('win-diff.doc', 'pc', new Date())),
      ].sort(),
    );
    // different content -> both kept: remote version under the name, local one as conflict copy
    expect(h.read('Haus/diff.txt')).toBe('remote version');
    expect(h.read(`Haus/${twoWayConflictName('diff.txt', 'pc', new Date())}`)).toBe('local version!');
    expect(h.read('Haus/win-diff.doc')).toBe('XXXX bytes');
    expect(h.read('Haus/only-remote.txt')).toBe('R');
    // too big to check cheaply -> held for the user, nothing written on either side
    const nc = h.engine.conflicts().find((c) => c.relPath === 'big.bin')!;
    expect(nc).toMatchObject({ kind: 'needs_check', keptBoth: null });
    expect(h.read('Haus/big.bin')).toBe('big file, more than twenty bytes');
    // the user checked: identical -> "ignore" records it as synced, still no upload
    h.engine.resolveConflict(nc.id, 'ignore', 'test');
    const mark = h.mark();
    await h.sync();
    expect(h.entry(1, 'big.bin')!.state).toBe('synced');
    expect(h.commands('alex', mark).every((c) => c.cmd === 'filesystem list')).toBe(true);
    expect(revs('big.bin')).toBe(1);
    // nothing was trashed on either side during adoption
    expect(Object.values(h.remoteState().nodes).filter((n) => n.trashed)).toHaveLength(0);
    expect(() => readdirSync(path.join(h.dir, 'trash/files'))).toThrow();
    expect(Object.keys(before.nodes).every((uid) => h.remoteState().nodes[uid])).toBe(true);
    expect(JSON.parse((h.db.prepare('SELECT options FROM pairs').get() as { options: string }).options)).toEqual({});
  });

  it('adoption run never deletes: a base from an earlier direction is not used to delete on the first run', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Haus', local: 'Haus', remote: R, direction: 'backup' }],
      localFiles: { 'Haus/a.txt': 'a', 'Haus/b.txt': 'b', 'Haus/c.txt': 'c' },
      mtime: T,
    });
    await h.sync(); // backup: everything uploaded, base recorded
    // switched to two-way (what PATCH /v1/pairs does, see pairs.ts switchDirection) ...
    h.db.prepare("UPDATE pairs SET direction = 'two-way', options = '{\"twoWayAdoption\":true}'").run();
    // ... while a.txt was deleted locally and b.txt in Proton
    (await import('node:fs')).rmSync(path.join(h.data, 'Haus/a.txt'));
    h.remoteTrash('alex', `${R}/b.txt`);
    const mark = h.mark();
    await h.sync();
    expect(h.commands('alex', mark).filter((c) => c.cmd === 'filesystem trash')).toHaveLength(0);
    expect(h.read('Haus/a.txt')).toBe('a'); // restored from Proton
    expect(h.remoteNode('alex', `${R}/b.txt`)).toBeDefined(); // uploaded again
    expect(h.read('Haus/b.txt')).toBe('b');
    // from now on deletions are carried over
    (await import('node:fs')).rmSync(path.join(h.data, 'Haus/c.txt'));
    await h.sync();
    expect(h.remoteNode('alex', `${R}/c.txt`)).toBeUndefined();
  });
});
