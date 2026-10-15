// SPDX-License-Identifier: GPL-3.0-or-later
/** Big-file progress (activity/status/ETA), resume after a daemon restart, and the .git "local wins" rule. */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonEvent, JobDto } from '@nucleon-sync/shared';

import { makeHarness, uploadsWith, type Harness } from '../scenarios/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const PAIR = { account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' };
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

async function until(fn: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('big uploads: progress, ETA, restart', () => {
  it.each([
    ['fd', {}],
    ['io', { MOCK_PREAD: '1' }],
  ] as const)('reports bytes done / total (%s), an overall ETA, and learns the throughput', async (source, extra) => {
    h = await makeHarness({
      pairs: [PAIR],
      localFiles: { 'Dokumente/Geo/ortho.las': 'L'.repeat(9_000_000), 'Dokumente/small.txt': 'small' },
      accountEnv: { alex: { MOCK_TRANSFER_BPS: '2000000', ...extra } },
    });
    const jobEvents: JobDto[] = [];
    h.engine.on('event', (e: DaemonEvent) => e.type === 'job' && jobEvents.push(e.job));
    h.engine.requestSync({}, 'manual');
    let mid: ReturnType<typeof h.engine.status> | null = null;
    await until(() => {
      const s = h.engine.status();
      const a = s.transfers?.active.find((x) => x.relPath === 'Geo/ortho.las');
      if (a && a.bytesDone > 0 && a.bytesDone < a.bytesTotal && a.source === source) mid = s;
      return !!mid;
    });
    const s = mid!;
    const a = s.transfers!.active.find((x) => x.relPath === 'Geo/ortho.las')!;
    expect(a.bytesTotal).toBe(9_000_000);
    expect(s.transfers!.upload.files).toBeGreaterThanOrEqual(1);
    expect(s.transfers!.upload.bytes).toBeGreaterThanOrEqual(9_000_000);
    await h.engine.waitIdle();
    await h.drain();
    const progress = jobEvents.filter((j) => j.relPath === 'Geo/ortho.las' && j.state === 'running' && j.bytesDone);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((j) => (j.progress ?? 0) > 0 && (j.progress ?? 0) < 1)).toBe(true);
    // throughput learned (EWMA, persisted) -> ETA of the remaining backlog is known
    const rate = Number(
      (h.db.prepare("SELECT value FROM meta WHERE key = 'rate:upload'").get() as { value: string }).value,
    );
    expect(rate).toBeGreaterThan(500_000);
    expect(h.engine.status().transfers!.upload).toMatchObject({ files: 0, etaSeconds: 0 });
    // the activity feed announced the big file (>= 100 MB only) -> not for 9 MB; the upload row is there
    expect(h.engine.activity(50).some((x) => x.action === 'uploaded' && x.relPath === 'Geo/ortho.las')).toBe(true);
  });

  it('a daemon restart during a big upload re-uploads only that file', async () => {
    h = await makeHarness({
      pairs: [PAIR],
      accounts: [{ id: 'alex', workers: 1 }],
      localFiles: {
        'Dokumente/a.txt': 'a',
        'Dokumente/b.txt': 'b',
        'Dokumente/huge.bin': 'H'.repeat(9_000_000),
      },
      accountEnv: { alex: { MOCK_TRANSFER_BPS: '2000000' } },
    });
    h.engine.requestSync({}, 'manual');
    await until(() => h.jobs('running').some((j) => j.type === 'upload' && j.payload.includes('huge.bin')));
    await until(() => (h.engine.status().transfers?.active[0]?.bytesDone ?? 0) > 1_000_000);
    const mark = h.mark();
    await h.restart(); // kills the worker mid-upload; the job is recovered on start
    const re = h.jobs().find((j) => j.payload.includes('huge.bin'))! as unknown as { state: string; attempts: number };
    expect(['queued', 'running']).toContain(re.state); // back in the queue (no attempt burnt), picked up again
    expect(re.attempts).toBe(0);
    await h.drain(30_000);
    const ups = uploadsWith(h.commands('alex', mark), 'skip');
    expect(ups.length).toBeGreaterThanOrEqual(1);
    for (const u of ups) expect(u.args.filter((x) => x.endsWith('.txt'))).toEqual([]);
    const node = h.remoteNode('alex', '/devices/Workstation/Documents/huge.bin')!;
    expect(node.revisions!.at(-1)!.sha1).toBe(sha1('H'.repeat(9_000_000)));
    const st = h.remoteState('alex');
    expect(Object.values(st.nodes).filter((n) => n.name === 'huge.bin' && !n.trashed)).toHaveLength(1);
  });
});

describe('.git internals: local wins', () => {
  it('initial_mismatch inside .git/ is resolved automatically with keep_local (logged); other conflicts stay', async () => {
    const remoteFiles = {
      'repo/.git/index': 'remote index',
      'repo/.git/worktrees/wt1/gitdir': '/old/path',
      'repo/README.md': 'remote readme',
    };
    h = await makeHarness({
      pairs: [PAIR, { account: 'alex', name: 'Sam', local: 'Sam', remote: '/my-files/Sam', direction: 'mirror-down' }],
      seed: {
        alex: [
          { files: remoteFiles, to: '/devices/Workstation/Documents' },
          { files: { 'r/.git/HEAD': 'remote head' }, to: '/my-files/Sam' },
        ],
      },
      localFiles: {
        'Dokumente/repo/.git/index': 'local index',
        'Dokumente/repo/.git/worktrees/wt1/gitdir': '/new/path',
        'Dokumente/repo/README.md': 'local readme',
        'Sam/r/.git/HEAD': 'local head',
      },
    });
    await h.sync();
    await h.drain();
    const open = h.engine
      .conflicts()
      .map((c) => c.relPath)
      .sort();
    expect(open).toEqual(['r/.git/HEAD', 'repo/README.md']); // mirror-down and non-.git conflicts are untouched
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/repo/.git/index')!.revisions!.at(-1)!.sha1).toBe(
      sha1('local index'),
    );
    expect(
      h.remoteNode('alex', '/devices/Workstation/Documents/repo/.git/worktrees/wt1/gitdir')!.revisions!.at(-1)!.sha1,
    ).toBe(sha1('/new/path'));
    const resolved = h.db
      .prepare("SELECT resolution, resolved_by FROM conflicts WHERE resolved_by = 'auto:.git'")
      .all() as { resolution: string }[];
    expect(resolved).toHaveLength(2);
    expect(resolved.every((r) => r.resolution === 'keep_local')).toBe(true);
    expect(h.engine.activity(100).filter((a) => /\.git internals/.test(a.message ?? ''))).toHaveLength(2);
  });
});

describe('files still being written during a user-triggered run', () => {
  it('get one automatic re-run once they are old enough', async () => {
    h = await makeHarness({ pairs: [PAIR], engine: { freshMs: 1500 } });
    h.write('Dokumente/eben-gespeichert.txt', 'fresh');
    h.engine.requestSync({}, 'api'); // whole-account run: no in-run waiting for fresh files
    await h.engine.waitIdle();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/eben-gespeichert.txt')).toBeUndefined();
    await until(() => !!h.remoteNode('alex', '/devices/Workstation/Documents/eben-gespeichert.txt'), 10_000);
    await h.engine.waitIdle();
    // no endless chain: exactly one follow-up
    await new Promise((r) => setTimeout(r, 2500));
    expect(h.engine.runs(10)).toHaveLength(2);
  });
});
