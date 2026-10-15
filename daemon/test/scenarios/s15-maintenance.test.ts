// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FLAG } from '../../src/db/repo.ts';
import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents';

describe('S15 conflict resolution, digest backfill, empty trash, one-shot fallback', () => {
  it('resolves conflicts keep_local / keep_remote / keep_both / ignore', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: R }],
      seed: {
        alex: [
          { to: R, files: { 'c1.txt': 'remote 1', 'c2.txt': 'remote 2', 'c3.txt': 'remote 3', 'c4.txt': 'remote 4' } },
        ],
      },
      localFiles: {
        'Dokumente/c1.txt': 'local 1',
        'Dokumente/c2.txt': 'local 2',
        'Dokumente/c3.txt': 'local 3',
        'Dokumente/c4.txt': 'local 4',
      },
    });
    await h.sync();
    const byPath = Object.fromEntries(h.engine.conflicts().map((c) => [c.relPath, c]));
    expect(Object.keys(byPath).sort()).toEqual(['c1.txt', 'c2.txt', 'c3.txt', 'c4.txt']);
    expect(byPath['c1.txt']!.local!.sha1).toMatch(/^[0-9a-f]{40}$/);
    h.engine.resolveConflict(byPath['c1.txt']!.id, 'keep_local', 'test');
    h.engine.resolveConflict(byPath['c2.txt']!.id, 'keep_remote', 'test');
    h.engine.resolveConflict(byPath['c3.txt']!.id, 'keep_both', 'test');
    h.engine.resolveConflict(byPath['c4.txt']!.id, 'ignore', 'test');
    await h.drain();
    expect(h.engine.conflicts()).toHaveLength(0);
    const blob = (rel: string) => h.remoteNode('alex', `${R}/${rel}`)!.revisions!.length;
    expect(blob('c1.txt')).toBe(2); // local content as a new revision
    expect(h.entry(1, 'c1.txt')!.state).toBe('synced');
    expect(h.read('Dokumente/c2.txt')).toBe('remote 2');
    expect(readFileSync(path.join(h.dir, 'trash/files/c2.txt'), 'utf8')).toBe('local 2');
    const copy = readdirSync(path.join(h.data, 'Dokumente')).find((n) => n.startsWith('c3 (Proton '))!;
    expect(copy).toMatch(/^c3 \(Proton \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.txt$/);
    expect(h.read(`Dokumente/${copy}`)).toBe('remote 3');
    expect(h.read('Dokumente/c3.txt')).toBe('local 3');
    expect(blob('c3.txt')).toBe(2);
    expect(h.entry(1, 'c4.txt')!.flags & FLAG.CONFLICT_IGNORED).toBeTruthy();
    const mark = h.mark();
    await h.sync();
    const cmds = h.commands('alex', mark);
    expect(uploadsWith(cmds, 'skip')).toHaveLength(1); // the "keep both" copy goes to Proton as well
    expect(uploadsWith(cmds, 'create-new-revision')).toHaveLength(0);
    expect(h.engine.conflicts()).toHaveLength(0);
  });

  it('digest backfill (duplicate-revision list first) and empty trash', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: R }],
      seed: {
        alex: [{ to: R, noDigest: true, files: { 'a/d1.pdf': 'one', 'b/d2.pdf': 'two', 'b/d3.pdf': 'three' } }],
      },
      localFiles: { 'Dokumente/a/d1.pdf': 'one', 'Dokumente/b/d2.pdf': 'two', 'Dokumente/b/d3.pdf': 'three' },
    });
    await h.sync();
    expect(h.entry(1, 'b/d2.pdf')!.flags & FLAG.DIGEST_MISSING).toBeTruthy();
    const d3 = h.remoteNode('alex', `${R}/b/d3.pdf`)!;
    h.db
      .prepare("INSERT INTO backfill_priority (account_id, remote_path, uid, reclaimable) VALUES ('alex', ?, ?, 1000)")
      .run(`${R}/b/d3.pdf`, d3.uid);
    const runId = h.engine.startDigestBackfill(1, 'b');
    expect(runId).toBeGreaterThan(0);
    const queued = h.jobs().filter((j) => j.type === 'digest_backfill');
    expect(queued.map((j) => JSON.parse(j.payload).rel)).toEqual(['b/d3.pdf', 'b/d2.pdf']); // priority first, prefix filter
    await h.drain();
    for (const rel of ['b/d2.pdf', 'b/d3.pdf']) {
      const n = h.remoteNode('alex', `${R}/${rel}`)!;
      expect(n.revisions![0]!.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(h.entry(1, rel)!.flags & FLAG.DIGEST_MISSING).toBe(0);
      expect(h.entry(1, rel)!.r_uid).toBe(n.uid);
    }
    expect(h.entry(1, 'a/d1.pdf')!.flags & FLAG.DIGEST_MISSING).toBeTruthy(); // outside the prefix
    expect(Object.values(h.remoteState().nodes).filter((n) => n.trashed)).toHaveLength(2); // replaced nodes in the trash
    const mark = h.mark();
    await h.sync();
    expect(h.commands('alex', mark).every((c) => c.cmd === 'filesystem list')).toBe(true);
    await h.engine.emptyTrash('alex', 'test');
    expect(Object.values(h.remoteState().nodes).filter((n) => n.trashed)).toHaveLength(0);
  });

  it('one-shot fallback (NUCLEON_SYNC_CLI_ONESHOT=1) runs the same pipeline', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: R }],
      seed: { alex: [{ to: R, files: { 'r.txt': 'r' } }] },
      localFiles: { 'Dokumente/l.txt': 'l' },
      engine: { env: { ...process.env, NUCLEON_SYNC_CLI_ONESHOT: '1' } },
    });
    const run = await h.sync();
    expect(run.status).toBe('ok');
    expect(h.read('Dokumente/r.txt')).toBe('r');
    expect(h.remoteNode('alex', `${R}/l.txt`)).toBeDefined();
  });
});
