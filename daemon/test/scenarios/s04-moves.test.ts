// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S4 moves', () => {
  it('file rename, file move and folder move become remote rename/move without uploads; entries are rewritten', async () => {
    const localFiles: Record<string, string> = {
      'Dokumente/a/one.txt': 'one',
      'Dokumente/b/three.txt': 'three',
      'Dokumente/z.txt': 'zzz',
    };
    for (let i = 1; i <= 5; i++) localFiles[`Dokumente/folder/sub/x${i}.txt`] = `content ${i}`;
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles,
    });
    expect((await h.sync()).status).toBe('ok');
    const R = '/devices/Workstation/Documents';
    const uidOne = h.remoteNode('alex', `${R}/a/one.txt`)!.uid;
    const uidThree = h.remoteNode('alex', `${R}/b/three.txt`)!.uid;
    const uidFolder = h.remoteNode('alex', `${R}/folder`)!.uid;
    const nodesBefore = Object.keys(h.remoteState().nodes).length;

    const d = (p: string) => path.join(h.data, 'Dokumente', p);
    renameSync(d('a/one.txt'), d('a/uno.txt')); // rename
    renameSync(d('b/three.txt'), d('a/three.txt')); // move
    mkdirSync(d('b'), { recursive: true });
    renameSync(d('folder'), d('b/moved-folder')); // folder move + rename

    const mark = h.mark();
    const run = await h.sync();
    expect(run.status).toBe('ok');
    const cmds = h.commands('alex', mark);
    expect(cmds.filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);
    expect(cmds.filter((c) => c.cmd === 'filesystem rename').length).toBeGreaterThanOrEqual(2);
    expect(cmds.filter((c) => c.cmd === 'filesystem move')).toHaveLength(2); // three.txt + the folder
    expect(h.remoteNode('alex', `${R}/a/uno.txt`)!.uid).toBe(uidOne);
    expect(h.remoteNode('alex', `${R}/a/three.txt`)!.uid).toBe(uidThree);
    expect(h.remoteNode('alex', `${R}/b/moved-folder`)!.uid).toBe(uidFolder);
    expect(h.remoteNode('alex', `${R}/b/moved-folder/sub/x3.txt`)).toBeDefined();
    expect(h.remoteNode('alex', `${R}/folder`)).toBeUndefined();
    expect(Object.keys(h.remoteState().nodes).length).toBe(nodesBefore); // no new nodes

    expect(h.entry(1, 'a/one.txt')).toBeUndefined();
    expect(h.entry(1, 'a/uno.txt')!.state).toBe('synced');
    expect(h.entry(1, 'a/three.txt')!.state).toBe('synced');
    expect(h.entry(1, 'b/moved-folder/sub/x5.txt')!.state).toBe('synced');
    expect(h.entry(1, 'folder/sub/x5.txt')).toBeUndefined();
    expect(h.engine.deletions()).toHaveLength(0);
    expect(h.engine.conflicts()).toHaveLength(0);
    expect(run.counters.moved).toBe(3);

    // and nothing more to do afterwards
    const mark2 = h.mark();
    await h.sync();
    expect(h.commands('alex', mark2).every((c) => c.cmd === 'filesystem list')).toBe(true);
  });
});
