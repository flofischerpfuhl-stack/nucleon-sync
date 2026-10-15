// SPDX-License-Identifier: GPL-3.0-or-later
import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const files = {
  'Dokumente/a.txt': 'a',
  'Dokumente/b.txt': 'b',
  'Dokumente/sub/c.txt': 'c',
  'Dokumente/sub/d.txt': 'd',
};

describe('S3 deletions', () => {
  it('local delete -> pending deletion only; trash_remote decision -> Proton trash', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: files,
    });
    expect((await h.sync()).status).toBe('ok');
    rmSync(path.join(h.data, 'Dokumente/a.txt'));
    const mark = h.mark();
    const run = await h.sync();
    expect(run.counters.pendingDeletions).toBe(1);
    expect(h.commands('alex', mark).every((c) => c.cmd === 'filesystem list')).toBe(true);
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/a.txt')).toBeDefined();
    const pend = h.engine.deletions();
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ relPath: 'a.txt', remoteChangedSinceDelete: false, size: 1 });
    expect(h.entry(1, 'a.txt')!.state).toBe('pending_remote_delete');

    // a further run keeps it pending (never automatic)
    await h.sync();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/a.txt')).toBeDefined();

    const { jobIds } = h.engine.decideDeletions({ ids: [pend[0]!.id], decision: 'trash_remote' }, 'test');
    expect(jobIds).toHaveLength(1);
    await h.drain();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/a.txt')).toBeUndefined(); // trashed
    const trashed = Object.values(h.remoteState().nodes).find((n) => n.name === 'a.txt');
    expect(trashed?.trashed).toBeTruthy(); // in the Proton trash, not deleted
    expect(h.entry(1, 'a.txt')).toBeUndefined();
    expect(h.engine.deletions()).toHaveLength(0);
    expect(h.engine.activity(20).some((a) => a.action === 'trashed_remote' && a.relPath === 'a.txt')).toBe(true);
  });

  it('remote changed after the local delete -> warning, never trashed automatically, decision re-checked', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: files,
    });
    await h.sync();
    rmSync(path.join(h.data, 'Dokumente/b.txt'));
    await h.sync();
    h.otherUpload('alex', '/devices/Workstation/Documents', 'b.txt', 'b edited on the phone');
    await h.sync();
    const pend = h.engine.deletions();
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ relPath: 'b.txt', remoteChangedSinceDelete: true });
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/b.txt')).toBeDefined();

    // decision taken, but Proton changes again before the job runs -> back to pending, nothing trashed
    h.engine.pause({ scope: 'account', id: 'alex' });
    h.engine.decideDeletions({ ids: [pend[0]!.id], decision: 'trash_remote' }, 'test');
    h.otherUpload('alex', '/devices/Workstation/Documents', 'b.txt', 'edited once more');
    h.engine.resume({ scope: 'account', id: 'alex' });
    await h.drain();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/b.txt')).toBeDefined();
    expect(h.jobs().find((j) => j.type === 'trash_remote')?.state).toBe('cancelled');
    expect(h.engine.deletions()).toHaveLength(1);
    expect(h.commands().some((c) => c.cmd === 'filesystem trash')).toBe(false);
  });
});
