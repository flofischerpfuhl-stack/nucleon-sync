// SPDX-License-Identifier: GPL-3.0-or-later
/** S20 two-way mass-delete guard: too many deletions in one run are held, the pair pauses until approved/denied. */
import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { insertJob } from '../../src/engine/queue.ts';
import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents';
const T = new Date('2025-03-01T10:00:00Z');
const files: Record<string, string> = {};
for (let i = 0; i < 30; i++) files[`Docs/f${String(i).padStart(2, '0')}.txt`] = `content ${i}`;
files['Docs/edit-me.txt'] = 'v1';
const pair = { account: 'alex', name: 'Docs', local: 'Docs', remote: R, direction: 'two-way' as const };
const WRITES = ['filesystem upload', 'filesystem trash', 'filesystem move', 'filesystem rename', 'filesystem download'];

describe('S20 two-way mass-delete guard', () => {
  it('25 local deletions are held, nothing is deleted, the pair pauses; approve -> Proton trash', async () => {
    h = await makeHarness({ pairs: [pair], localFiles: files, mtime: T });
    await h.sync();
    for (let i = 0; i < 25; i++) rmSync(path.join(h.data, `Docs/f${String(i).padStart(2, '0')}.txt`));
    h.write('Docs/edit-me.txt', 'v2', new Date('2025-04-01T10:00:00Z'));
    const mark = h.mark();
    const r = await h.sync();
    expect(r.counters.pendingDeletions).toBe(25);
    expect(h.commands('alex', mark).filter((c) => WRITES.includes(c.cmd))).toEqual([]); // nothing at all ran
    const pair1 = h.engine.pairs()[0]!;
    expect(pair1.heldDeletions).toBe(25);
    expect(pair1.brake?.reason).toMatch(/Mass deletion held: 25 of 31/);
    const held = h.engine.deletions();
    expect(held).toHaveLength(25);
    expect(held.every((d) => d.held && d.side === 'local')).toBe(true);
    for (let i = 0; i < 25; i++) expect(h.remoteNode('alex', `${R}/f${String(i).padStart(2, '0')}.txt`)).toBeDefined();

    // still paused on the next runs (the edited file waits too)
    const mark2 = h.mark();
    await h.sync();
    expect(h.commands('alex', mark2).filter((c) => WRITES.includes(c.cmd))).toEqual([]);

    // approve: every held deletion goes to the Proton trash, the pair runs again (edit-me uploaded)
    const res = h.engine.decideHeld(1, true, 'test');
    expect(res.decided).toBe(25);
    await h.drain();
    await h.engine.waitIdle();
    for (let i = 0; i < 25; i++)
      expect(h.remoteNode('alex', `${R}/f${String(i).padStart(2, '0')}.txt`)).toBeUndefined();
    const trashed = Object.values(h.remoteState().nodes).filter((n) => n.trashed);
    expect(trashed).toHaveLength(25); // in the Proton trash, not deleted
    expect(h.engine.pairs()[0]!.heldDeletions).toBe(0);
    expect(h.engine.pairs()[0]!.brake ?? null).toBeNull();
    await h.sync();
    expect(h.remoteNode('alex', `${R}/edit-me.txt`)!.revisions).toHaveLength(2);
    expect(h.engine.deletions()).toHaveLength(0);
  });

  it('25 files deleted on another device are held; deny -> the local files are uploaded again', async () => {
    h = await makeHarness({ pairs: [pair], localFiles: files, mtime: T });
    await h.sync();
    h.remoteTrash('alex', ...Array.from({ length: 25 }, (_, i) => `${R}/f${String(i).padStart(2, '0')}.txt`));
    await h.sync();
    const held = h.engine.deletions();
    expect(held).toHaveLength(25);
    expect(held.every((d) => d.held && d.side === 'remote')).toBe(true);
    for (let i = 0; i < 25; i++) expect(h.exists(`Docs/f${String(i).padStart(2, '0')}.txt`)).toBe(true);

    const mark = h.mark();
    h.engine.decideHeld(1, false, 'test');
    await h.drain();
    await h.engine.waitIdle();
    expect(uploadsWith(h.commands('alex', mark), 'skip').length).toBeGreaterThan(0);
    expect(uploadsWith(h.commands('alex', mark), 'create-new-revision')).toHaveLength(0);
    for (let i = 0; i < 25; i++) {
      expect(h.exists(`Docs/f${String(i).padStart(2, '0')}.txt`)).toBe(true);
      expect(h.remoteNode('alex', `${R}/f${String(i).padStart(2, '0')}.txt`)).toBeDefined();
    }
    await h.sync();
    expect(h.engine.deletions()).toHaveLength(0);
    expect(h.entry(1, 'f00.txt')!.state).toBe('synced');
  });

  it('approved "deleted in Proton", but the local file was edited meanwhile: the edit is uploaded again', async () => {
    h = await makeHarness({ pairs: [pair], localFiles: files, mtime: T });
    await h.sync();
    h.remoteTrash('alex', ...Array.from({ length: 25 }, (_, i) => `${R}/f${String(i).padStart(2, '0')}.txt`));
    await h.sync();
    expect(h.engine.deletions()).toHaveLength(25);
    h.write('Docs/f03.txt', 'edited after the deletion', new Date('2025-06-01T10:00:00Z'));
    h.engine.decideHeld(1, true, 'test');
    await h.drain();
    await h.engine.waitIdle();
    await h.sync();
    expect(h.exists('Docs/f00.txt')).toBe(false); // approved: local trash
    expect(h.read('Docs/f03.txt')).toBe('edited after the deletion'); // never trashed ...
    expect(h.remoteNode('alex', `${R}/f03.txt`)).toBeDefined(); // ... and uploaded again
    expect(h.engine.deletions()).toHaveLength(0);
    expect(h.engine.conflicts().map((c) => [c.relPath, c.kind])).toEqual([['f03.txt', 'local_changed_remote_deleted']]);
  });

  it('a pair waiting for approval never blocks the other pairs of the account', async () => {
    h = await makeHarness({
      pairs: [pair, { account: 'alex', name: 'Other', local: 'Other', remote: '/devices/Workstation/Other' }],
      localFiles: { ...files, 'Other/x.txt': 'x' },
      mtime: T,
    });
    await h.sync();
    // a long backlog of the held pair sits at the front of the queue
    for (let i = 0; i < 60; i++)
      insertJob(h.db, {
        runId: null,
        accountId: 'alex',
        pairId: 1,
        entryId: null,
        type: 'upload',
        payload: { rel: `queued${i}.txt`, kind: 'file' },
        priority: 0,
        bytes: 1,
        dedupeKey: `upload:1:queued${i}.txt`,
      });
    h.db.prepare('UPDATE pairs SET paused = 1 WHERE id = 1').run();
    h.write('Other/y.txt', 'new in the other pair', T);
    await h.sync({ pairId: 2 });
    expect(h.remoteNode('alex', '/devices/Workstation/Other/y.txt')).toBeDefined();
  });

  it('below the threshold deletions run at once; thresholds are pair options', async () => {
    h = await makeHarness({ pairs: [{ ...pair, options: { massDeleteMaxFiles: 2 } }], localFiles: files, mtime: T });
    await h.sync();
    rmSync(path.join(h.data, 'Docs/f00.txt'));
    rmSync(path.join(h.data, 'Docs/f01.txt'));
    await h.sync();
    expect(h.remoteNode('alex', `${R}/f00.txt`)).toBeUndefined();
    expect(h.engine.deletions()).toHaveLength(0);
    rmSync(path.join(h.data, 'Docs/f02.txt'));
    rmSync(path.join(h.data, 'Docs/f03.txt'));
    rmSync(path.join(h.data, 'Docs/f04.txt'));
    await h.sync();
    expect(h.engine.deletions()).toHaveLength(3); // 3 > 2: held
    expect(h.remoteNode('alex', `${R}/f02.txt`)).toBeDefined();
    // single decisions work as well; the pair resumes once all held deletions are decided
    const ids = h.engine.deletions().map((d) => d.id);
    h.engine.decideDeletions({ ids: ids.slice(0, 1), decision: 'trash_remote' }, 'test');
    expect(h.engine.pairs()[0]!.heldDeletions).toBe(2);
    h.engine.decideDeletions({ ids: ids.slice(1), decision: 'restore_local' }, 'test');
    await h.drain();
    expect(h.engine.pairs()[0]!.heldDeletions).toBe(0);
    expect(h.remoteNode('alex', `${R}/f02.txt`)).toBeUndefined();
    expect(h.read('Docs/f03.txt')).toBe('content 3');
    expect(h.read('Docs/f04.txt')).toBe('content 4');
  });
});
