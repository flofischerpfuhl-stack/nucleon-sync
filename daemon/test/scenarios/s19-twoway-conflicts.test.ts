// SPDX-License-Identifier: GPL-3.0-or-later
/** S19 two-way conflicts: keep both, never overwrite; review resolutions; races with another device. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { twoWayConflictName } from '@nucleon-sync/shared';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents';
const T = new Date('2025-03-01T10:00:00Z');
const T2 = new Date('2025-06-01T10:00:00Z');
const pair = { account: 'alex', name: 'Docs', local: 'Docs', remote: R, direction: 'two-way' as const };
const copyOf = (rel: string, host = 'pc') => twoWayConflictName(rel, host, new Date());

describe('S19 two-way conflicts', () => {
  it('both changed: Proton version keeps the name, the local one becomes a conflict copy (uploaded too)', async () => {
    h = await makeHarness({ pairs: [pair], localFiles: { 'Docs/x.txt': 'base', 'Docs/y.txt': 'base y' }, mtime: T });
    await h.sync();
    h.write('Docs/x.txt', 'edited on the PC', T2);
    h.remoteEdit('alex', `${R}/x.txt`, 'edited on the laptop');
    const xUid = h.remoteNode('alex', `${R}/x.txt`)!.uid;
    const mark = h.mark();
    const r = await h.sync();
    expect(r.status).toBe('ok');
    const copy = copyOf('x.txt');
    expect(copy).toMatch(/^x \(conflict pc \d{4}-\d\d-\d\d\)\.txt$/);
    // never overwritten: no new revision of x, the laptop's version stays the active one
    expect(uploadsWith(h.commands('alex', mark), 'create-new-revision')).toHaveLength(0);
    expect(h.remoteNode('alex', `${R}/x.txt`)!.uid).toBe(xUid);
    expect(h.remoteNode('alex', `${R}/x.txt`)!.revisions).toHaveLength(2);
    expect(h.read('Docs/x.txt')).toBe('edited on the laptop');
    expect(h.read(`Docs/${copy}`)).toBe('edited on the PC');
    expect(h.remoteNode('alex', `${R}/${copy}`)).toBeDefined();
    const [c] = h.engine.conflicts();
    expect(c).toMatchObject({ relPath: 'x.txt', kind: 'both_changed', keptBoth: { copyRelPath: copy } });
    expect(c!.local!.sha1).toBeTruthy();
    expect(h.entry(1, 'x.txt')!.state).toBe('synced');
    expect(h.entry(1, copy)!.state).toBe('synced');
    // nothing went to the trash: both versions live on both sides
    expect(() => readdirSync(path.join(h.dir, 'trash/files'))).toThrow();

    // review "keep local": the copy replaces the original (old local version -> trash), Proton gets a new revision
    h.engine.resolveConflict(c!.id, 'keep_local', 'test');
    await h.drain();
    await h.engine.waitIdle();
    expect(h.read('Docs/x.txt')).toBe('edited on the PC');
    expect(h.exists(`Docs/${copy}`)).toBe(false);
    expect(readFileSync(path.join(h.dir, 'trash/files/x.txt'), 'utf8')).toBe('edited on the laptop');
    expect(h.remoteNode('alex', `${R}/x.txt`)!.revisions).toHaveLength(3);
    expect(h.remoteNode('alex', `${R}/${copy}`)).toBeUndefined(); // copy -> Proton trash
    expect(h.engine.conflicts()).toHaveLength(0);
    expect(h.entry(1, 'x.txt')!.state).toBe('synced');

    // a second conflict, review "keep remote": the copy goes to both trashes
    h.write('Docs/y.txt', 'y on the PC', T2);
    h.remoteEdit('alex', `${R}/y.txt`, 'y on the laptop');
    await h.sync();
    const cy = h.engine.conflicts().find((x) => x.relPath === 'y.txt')!;
    const ycopy = cy.keptBoth!.copyRelPath!;
    h.engine.resolveConflict(cy.id, 'keep_remote', 'test');
    await h.drain();
    await h.engine.waitIdle();
    expect(h.read('Docs/y.txt')).toBe('y on the laptop');
    expect(h.exists(`Docs/${ycopy}`)).toBe(false);
    expect(h.remoteNode('alex', `${R}/${ycopy}`)).toBeUndefined();
    expect(readFileSync(path.join(h.dir, 'trash/files', ycopy), 'utf8')).toBe('y on the PC');
  });

  it('review "keep local" while the Proton version is still downloading: the choice wins', async () => {
    const dir = (await import('../helpers.ts')).tmp('hang2-');
    const hangFile = path.join(dir, 'hang');
    h = await makeHarness({
      pairs: [pair],
      localFiles: { 'Docs/k.txt': 'base' },
      mtime: T,
      accountEnv: { alex: { MOCK_HANG_FILE: hangFile } },
    });
    await h.sync();
    h.write('Docs/k.txt', 'pc version', T2);
    h.remoteEdit('alex', `${R}/k.txt`, 'laptop version');
    (await import('node:fs')).writeFileSync(hangFile, 'filesystem download\n');
    void h.engine.requestSync({}, 'manual');
    const copy = copyOf('k.txt');
    const until = async (f: () => unknown) => {
      for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    await until(() => h.remoteNode('alex', `${R}/${copy}`));
    await until(() => h.engine.conflicts().length === 1);
    const c = h.engine.conflicts()[0]!;
    h.engine.resolveConflict(c.id, 'keep_local', 'test');
    await until(() => h.jobs().some((j) => j.type === 'move_local' && j.state === 'done'));
    (await import('node:fs')).rmSync(hangFile);
    await h.engine.waitIdle();
    await h.drain();
    await h.engine.waitIdle();
    await h.sync();
    expect(h.read('Docs/k.txt')).toBe('pc version');
    expect(h.exists(`Docs/${copy}`)).toBe(false);
    expect(h.remoteNode('alex', `${R}/${copy}`)).toBeUndefined();
    const node = h.remoteNode('alex', `${R}/k.txt`)!;
    expect(node.revisions).toHaveLength(3); // base, laptop, then the chosen PC version
    expect(h.engine.conflicts()).toHaveLength(0);
    expect(h.entry(1, 'k.txt')!.state).toBe('synced');
  });

  it('Proton changes between the listing and our revision upload: detected, kept both, nothing overwritten', async () => {
    h = await makeHarness({ pairs: [pair], localFiles: { 'Docs/r.txt': 'v1' }, mtime: T });
    await h.sync();
    h.write('Docs/r.txt', 'v2 from the PC', T2);
    // the laptop uploads right before our pre-upload check (after our listing)
    h.inject('alex', [{ before: 'filesystem info', op: 'edit', path: `${R}/r.txt`, content: 'v2 from the laptop' }]);
    const mark = h.mark();
    await h.sync();
    expect(uploadsWith(h.commands('alex', mark), 'create-new-revision')).toHaveLength(0);
    expect(h.engine.jobs({}).find((j) => j.type === 'upload_revision')?.state).toBe('cancelled');
    await h.sync(); // re-planned with the fresh remote state -> both changed -> keep both
    expect(h.read('Docs/r.txt')).toBe('v2 from the laptop');
    expect(h.read(`Docs/${copyOf('r.txt')}`)).toBe('v2 from the PC');
    expect(h.remoteNode('alex', `${R}/r.txt`)!.revisions).toHaveLength(2);
    expect(uploadsWith(h.commands('alex', mark), 'create-new-revision')).toHaveLength(0);
  });

  it('both devices create the same new name: -f skip never overwrites, both files are kept', async () => {
    h = await makeHarness({ pairs: [pair], localFiles: { 'Docs/seed.txt': 's' }, mtime: T });
    await h.sync();
    h.write('Docs/new.txt', 'new on the PC', T2);
    // the laptop creates new.txt after our pre-upload listing, right before our upload command
    h.inject('alex', [{ before: 'filesystem upload', op: 'create', path: `${R}/new.txt`, content: 'new on laptop' }]);
    await h.sync();
    await h.drain();
    await h.sync();
    expect(h.remoteNode('alex', `${R}/new.txt`)!.revisions).toHaveLength(1); // the laptop's file, untouched
    expect(h.read('Docs/new.txt')).toBe('new on laptop');
    expect(h.read(`Docs/${copyOf('new.txt')}`)).toBe('new on the PC');
    expect(h.remoteNode('alex', `${R}/${copyOf('new.txt')}`)).toBeDefined();
    expect(h.engine.conflicts()).toEqual([
      expect.objectContaining({
        relPath: 'new.txt',
        kind: 'initial_mismatch',
        keptBoth: { copyRelPath: copyOf('new.txt') },
      }),
    ]);
  });

  it('the local file changes while the remote version downloads: the local edit is kept as a copy', async () => {
    h = await makeHarness({
      pairs: [pair],
      localFiles: { 'Docs/d.txt': 'v1' },
      mtime: T,
      accountEnv: { alex: { MOCK_LATENCY_MS: '0' } },
    });
    await h.sync();
    h.remoteEdit('alex', `${R}/d.txt`, 'v2 from the laptop');
    // right before the download command, the user saves the file on the PC
    const abs = path.join(h.data, 'Docs/d.txt');
    const orig = h.engine.remote('alex').download.bind(h.engine.remote('alex'));
    h.engine.remote('alex').download = async (...args) => {
      h.write('Docs/d.txt', 'v2 typed on the PC', T2);
      return orig(...args);
    };
    await h.sync();
    expect(readFileSync(abs, 'utf8')).toBe('v2 from the laptop');
    expect(h.read(`Docs/${copyOf('d.txt')}`)).toBe('v2 typed on the PC');
    await h.sync();
    expect(h.remoteNode('alex', `${R}/${copyOf('d.txt')}`)).toBeDefined();
    expect(h.engine.conflicts().map((c) => c.relPath)).toEqual(['d.txt']);
  });
});
