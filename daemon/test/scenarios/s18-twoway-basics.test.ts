// SPDX-License-Identifier: GPL-3.0-or-later
/** S18 two-way pairs: every three-way classification, against mock-cli with "another device" acting on the remote. */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents';
const T = new Date('2025-03-01T10:00:00Z');
const pair = { account: 'alex', name: 'Docs', local: 'Docs', remote: R, direction: 'two-way' as const };

const trashFiles = (dir: string) => {
  try {
    return readdirSync(path.join(dir, 'files'));
  } catch {
    return [];
  }
};

describe('S18 two-way basics', () => {
  it('classifies local/remote new, changed, deleted and unchanged and acts on each', async () => {
    h = await makeHarness({
      pairs: [{ ...pair, options: { twoWayAdoption: true } }],
      localFiles: {
        'Docs/a.txt': 'a',
        'Docs/b.txt': 'b',
        'Docs/c.txt': 'c',
        'Docs/d.txt': 'd',
        'Docs/e.txt': 'e',
        'Docs/sub/f.txt': 'f',
      },
      mtime: T,
    });
    const r1 = await h.sync();
    expect(r1.status).toBe('ok');
    expect(r1.counters.uploaded).toBe(6);
    expect(uploadsWith(h.commands(), 'create-new-revision')).toHaveLength(0);
    // the adoption run is over: deletions are propagated from now on
    expect(
      JSON.parse(String((h.db.prepare('SELECT options FROM pairs').get() as { options: string }).options)),
    ).toEqual({});
    expect(h.engine.pairs()[0]!.lastRemoteCheckAt).toBeTruthy();

    // a: changed here, b: changed on the laptop, c: deleted here, d: deleted on the laptop, e: unchanged,
    // g: new here, h: new on the laptop
    h.write('Docs/a.txt', 'a edited on the PC', new Date('2025-04-01T10:00:00Z'));
    h.remoteEdit('alex', `${R}/b.txt`, 'b edited on the laptop');
    rmSync(path.join(h.data, 'Docs/c.txt'));
    h.remoteTrash('alex', `${R}/d.txt`);
    h.write('Docs/g.txt', 'g new on the PC', T);
    h.remoteEdit('alex', `${R}/sub/h.txt`, 'h new on the laptop');
    const mark = h.mark();
    const r2 = await h.sync();
    expect(r2.status).toBe('ok');
    const cmds = h.commands('alex', mark);

    // a -> new revision of the same node, nothing else uploaded as a revision
    expect(uploadsWith(cmds, 'create-new-revision')).toHaveLength(1);
    const a = h.remoteNode('alex', `${R}/a.txt`)!;
    expect(a.revisions).toHaveLength(2);
    // b, h -> downloaded; the old local b went to the trash (never deleted)
    expect(h.read('Docs/b.txt')).toBe('b edited on the laptop');
    expect(h.read('Docs/sub/h.txt')).toBe('h new on the laptop');
    const trash = path.join(h.dir, 'trash');
    expect(trashFiles(trash)).toContain('b.txt');
    // c -> Proton trash
    expect(h.remoteNode('alex', `${R}/c.txt`)).toBeUndefined();
    expect(Object.values(h.remoteState().nodes).find((n) => n.name === 'c.txt')?.trashed).toBeTruthy();
    // d -> local trash with a proper .trashinfo
    expect(h.exists('Docs/d.txt')).toBe(false);
    expect(readFileSync(path.join(trash, 'files/d.txt'), 'utf8')).toBe('d');
    expect(readFileSync(path.join(trash, 'info/d.txt.trashinfo'), 'utf8')).toMatch(
      /^\[Trash Info\]\nPath=.*\/Docs\/d\.txt\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/,
    );
    // g -> uploaded with -f skip
    expect(h.remoteNode('alex', `${R}/g.txt`)).toBeDefined();
    // e untouched on both sides
    expect(h.remoteNode('alex', `${R}/e.txt`)!.revisions).toHaveLength(1);
    expect(cmds.filter((c) => c.cmd === 'filesystem trash')).toHaveLength(1);
    for (const rel of ['a.txt', 'b.txt', 'e.txt', 'g.txt', 'sub/f.txt', 'sub/h.txt'])
      expect(h.entry(1, rel)?.state, rel).toBe('synced');
    expect(h.entry(1, 'c.txt')).toBeUndefined();
    expect(h.entry(1, 'd.txt')).toBeUndefined();
    const acts = h.engine.activity(100);
    expect(acts.some((x) => x.action === 'trashed_remote' && x.relPath === 'c.txt')).toBe(true);
    expect(acts.some((x) => x.action === 'trashed_local' && x.relPath === 'd.txt')).toBe(true);

    // idempotent: a further run only lists
    const mark2 = h.mark();
    await h.sync();
    expect(h.commands('alex', mark2).every((c) => c.cmd === 'filesystem list')).toBe(true);
  });

  it('a deletion meets a change on the other side: the change wins and the case is listed', async () => {
    h = await makeHarness({
      pairs: [pair],
      localFiles: { 'Docs/x.txt': 'x', 'Docs/y.txt': 'y', 'Docs/keep.txt': 'k' },
      mtime: T,
    });
    await h.sync();
    rmSync(path.join(h.data, 'Docs/x.txt')); // deleted here ...
    h.remoteEdit('alex', `${R}/x.txt`, 'x edited on the laptop'); // ... but edited there
    h.write('Docs/y.txt', 'y edited here', new Date('2025-05-01T10:00:00Z')); // edited here ...
    h.remoteTrash('alex', `${R}/y.txt`); // ... but deleted there
    const r = await h.sync();
    expect(r.status).toBe('ok');
    expect(h.read('Docs/x.txt')).toBe('x edited on the laptop'); // restored locally
    expect(h.remoteNode('alex', `${R}/y.txt`)).toBeDefined(); // uploaded again
    const conflicts = h.engine.conflicts();
    expect(conflicts.map((c) => [c.relPath, c.kind]).sort()).toEqual([
      ['x.txt', 'remote_changed_local_deleted'],
      ['y.txt', 'local_changed_remote_deleted'],
    ]);
    expect(conflicts.every((c) => c.keptBoth && c.direction === 'two-way')).toBe(true);
    expect(h.engine.status().openConflicts).toBe(2);
    // review items do not block the entries: both are synced
    expect(h.entry(1, 'x.txt')!.state).toBe('synced');
    expect(h.entry(1, 'y.txt')!.state).toBe('synced');

    // "my deletion wins" for x: local trash, then the next run trashes it in Proton too
    const cx = conflicts.find((c) => c.relPath === 'x.txt')!;
    h.engine.resolveConflict(cx.id, 'keep_local', 'test');
    await h.drain();
    await h.engine.waitIdle();
    await h.sync();
    expect(h.exists('Docs/x.txt')).toBe(false);
    expect(h.remoteNode('alex', `${R}/x.txt`)).toBeUndefined();
    // y: keep it (dismiss)
    const cy = h.engine.conflicts().find((c) => c.relPath === 'y.txt')!;
    h.engine.resolveConflict(cy.id, 'keep_both', 'test');
    expect(h.engine.conflicts()).toHaveLength(0);
    expect(h.read('Docs/y.txt')).toBe('y edited here');
  });

  it('remote rename/move: the local file follows (no trash, no download); local rename -> remote move', async () => {
    h = await makeHarness({
      pairs: [pair],
      localFiles: { 'Docs/old.txt': 'content of old', 'Docs/dir1/m.txt': 'm', 'Docs/dir2/.keep': '' },
      mtime: T,
    });
    await h.sync();
    h.remoteRename('alex', `${R}/old.txt`, 'new.txt');
    h.remoteMove('alex', `${R}/dir1/m.txt`, `${R}/dir2`);
    const mark = h.mark();
    await h.sync();
    expect(h.read('Docs/new.txt')).toBe('content of old');
    expect(h.exists('Docs/old.txt')).toBe(false);
    expect(h.read('Docs/dir2/m.txt')).toBe('m');
    expect(h.exists('Docs/dir1/m.txt')).toBe(false);
    expect(h.commands('alex', mark).filter((c) => c.cmd === 'filesystem download')).toHaveLength(0);
    expect(trashFiles(path.join(h.dir, 'trash'))).toHaveLength(0);
    expect(h.entry(1, 'new.txt')!.state).toBe('synced');
    expect(h.entry(1, 'dir2/m.txt')!.state).toBe('synced');
    // the emptied local folder goes away on the next run (it was removed in Proton? no: dir1 still exists there)
    expect(h.remoteNode('alex', `${R}/dir1`)).toBeDefined();

    // local rename -> one remote rename of the same node
    const uid = h.remoteNode('alex', `${R}/new.txt`)!.uid;
    (await import('node:fs')).renameSync(path.join(h.data, 'Docs/new.txt'), path.join(h.data, 'Docs/renamed.txt'));
    const mark2 = h.mark();
    await h.sync();
    const cmds = h.commands('alex', mark2);
    expect(cmds.filter((c) => c.cmd === 'filesystem rename')).toHaveLength(1);
    expect(cmds.filter((c) => c.cmd === 'filesystem upload' || c.cmd === 'filesystem trash')).toHaveLength(0);
    expect(h.remoteNode('alex', `${R}/renamed.txt`)!.uid).toBe(uid);
  });

  it('an unreadable local folder is unknown, not deleted', async () => {
    h = await makeHarness({
      pairs: [pair],
      localFiles: { 'Docs/locked/a.txt': 'a', 'Docs/locked/b.txt': 'b', 'Docs/ok.txt': 'o' },
      mtime: T,
    });
    await h.sync();
    const { chmodSync } = await import('node:fs');
    chmodSync(path.join(h.data, 'Docs/locked'), 0o000);
    try {
      const mark = h.mark();
      await h.sync();
      expect(h.commands('alex', mark).filter((c) => c.cmd === 'filesystem trash')).toHaveLength(0);
      expect(h.remoteNode('alex', `${R}/locked/a.txt`)).toBeDefined();
      expect(h.entry(1, 'locked/a.txt')!.l_exists).toBe(1);
      expect(h.engine.activity(20).some((x) => /not readable/.test(x.message ?? ''))).toBe(true);
    } finally {
      chmodSync(path.join(h.data, 'Docs/locked'), 0o755);
    }
  });

  it('a folder deleted here that still holds untracked files in Proton is kept (converges)', async () => {
    h = await makeHarness({
      pairs: [pair],
      seed: { alex: [{ to: `${R}/Fotos`, files: { 'desktop.ini': 'windows junk' } }] },
      localFiles: { 'Docs/Fotos/a.jpg': 'a', 'Docs/stay.txt': 's' },
      mtime: T,
    });
    await h.sync();
    rmSync(path.join(h.data, 'Docs/Fotos'), { recursive: true });
    await h.sync();
    expect(h.remoteNode('alex', `${R}/Fotos/a.jpg`)).toBeUndefined(); // the tracked file went to the Proton trash
    expect(h.remoteNode('alex', `${R}/Fotos/desktop.ini`)).toBeDefined(); // untracked: never touched
    expect(h.exists('Docs/Fotos')).toBe(true); // folder kept here as well
    const mark = h.mark();
    await h.sync();
    expect(h.commands('alex', mark).every((c) => c.cmd === 'filesystem list')).toBe(true);
  });

  it('folders deleted on one side are removed on the other once empty', async () => {
    h = await makeHarness({
      pairs: [pair],
      localFiles: { 'Docs/gone-here/a.txt': 'a', 'Docs/gone-there/b.txt': 'b', 'Docs/stay.txt': 's' },
      mtime: T,
    });
    await h.sync();
    rmSync(path.join(h.data, 'Docs/gone-here'), { recursive: true });
    h.remoteTrash('alex', `${R}/gone-there`);
    await h.sync();
    expect(h.remoteNode('alex', `${R}/gone-here`)).toBeUndefined();
    expect(h.exists('Docs/gone-there')).toBe(false);
    expect(readFileSync(path.join(h.dir, 'trash/files/b.txt'), 'utf8')).toBe('b');
    expect(h.remoteNode('alex', `${R}/stay.txt`)).toBeDefined();
    const mark = h.mark();
    await h.sync();
    expect(h.commands('alex', mark).every((c) => c.cmd === 'filesystem list')).toBe(true);
  });
});
