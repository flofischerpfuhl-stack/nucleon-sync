// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S17 per-account runs: runs of different accounts run in parallel, a pair-scoped run
 * (agent `sync --pair N`) gets a priority lane next to a long background run of the same account, the global
 * process cap holds, a restart during parallel runs resumes both, and nothing is uploaded twice.
 *
 * "Long run": alex's files are throttled by the mock (MOCK_TRANSFER_BPS), each in its own folder, so every file is
 * one ~2 s upload command and the run takes well over 10 s with 2 workers.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { RunDto } from '@nucleon-sync/shared';

import { writeEngineSetting } from '../../src/engine/settings.ts';
import { makeHarness, type Harness, type PairSpec } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const KB = 1000;
/** n files of `size` bytes, each in its own folder (= one upload command per file) */
const bigFiles = (prefix: string, n: number, size = 80 * KB): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}/Ordner${i}/datei-${i}.bin`, 'x'.repeat(size)]));

const SLOW = { MOCK_TRANSFER_BPS: String(40 * KB) }; // 80 KB -> 2 s per file

const alexPair: PairSpec = {
  account: 'alex',
  name: 'Dokumente',
  local: 'Dokumente',
  remote: '/devices/Workstation/Documents',
};
const samPair: PairSpec = {
  account: 'sam',
  name: 'Sam Dokumente',
  local: 'Sam/Dokumente',
  remote: '/my-files/Dokumente',
  direction: 'mirror-down',
  options: { uploadLocalNew: true, uploadLocalNewSince: 1 },
};

async function until(cond: () => boolean, timeoutMs = 20_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const pairId = (name: string) => (h.db.prepare('SELECT id FROM pairs WHERE name = ?').get(name) as { id: number }).id;

/** non-trashed remote nodes per (parent, name): every file must exist exactly once */
function duplicateNodes(account: string): string[] {
  const seen = new Map<string, number>();
  for (const n of Object.values(h.remoteState(account).nodes)) {
    if (n.trashed || n.parentUid === null) continue; // roots (my-files, devices)
    const k = `${n.parentUid}/${n.name}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen].filter(([, c]) => c > 1).map(([k]) => k);
}

const uploadCmdsFor = (account: string, name: string) =>
  h.commands(account).filter((c) => c.cmd === 'filesystem upload' && c.args.some((a) => a.endsWith(`/${name}`)));

const run = (id: number): RunDto => h.engine.runs(200).find((r) => r.id === id)!;

describe('S17 per-account runs, priority lane, process cap', () => {
  it("a short pair run on Sam's account finishes while Alex's long run is still uploading", async () => {
    h = await makeHarness({
      accounts: [
        { id: 'alex', workers: 2 },
        { id: 'sam', workers: 1 },
      ],
      pairs: [alexPair, samPair],
      localFiles: bigFiles('Dokumente', 10),
      accountEnv: { alex: SLOW },
    });
    // the scheduled run covers both accounts; Sam's part is done at once, Alex's takes > 10 s
    const long = h.engine.requestSyncTicket({}, 'schedule');
    expect(long.followUp).toBe(false);
    await until(() => h.jobs('running').length > 0, 20_000, "alex's uploads");
    await until(() => !(h.engine.status().accounts.find((a) => a.id === 'sam')!.activeRunIds ?? []).length);

    // an agent files a document for Sam and syncs her pair
    h.write('Sam/Dokumente/Rechnungen/2026-10-12 Stadtwerke.pdf', 'rechnung');
    const t0 = Date.now();
    const t = h.engine.requestSyncTicket({ pairId: pairId('Sam Dokumente') }, 'api');
    expect(t.followUp).toBe(false); // not "queued after run #…"
    const st = h.engine.status();
    expect(st.activeRuns!.map((r) => r.id).sort()).toEqual([long.runIds[0], t.runIds[0]].sort());
    expect(st.currentRun!.id).toBe(t.runIds[0]); // most recent
    expect(st.accounts.find((a) => a.id === 'sam')!.activeRunIds).toEqual([t.runIds[0]]);
    expect(st.accounts.find((a) => a.id === 'alex')!.activeRunIds).toEqual([long.runIds[0]]);

    const pr = await h.engine.waitRun(t.runIds[0]!);
    expect(pr!.status).toBe('ok');
    expect(pr!.lane).toBe('priority');
    expect(pr!.accountId).toBe('sam');
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(run(long.runIds[0]!).status).toBe('running'); // Alex's run is still busy
    expect(h.remoteNode('sam', '/my-files/Dokumente/Rechnungen/2026-10-12 Stadtwerke.pdf')).toBeDefined();
    expect(pr!.counters.uploaded).toBe(1);

    await h.engine.waitIdle();
    await h.drain();
    expect(run(long.runIds[0]!).status).toBe('ok');
    expect(run(long.runIds[0]!).counters.uploaded).toBe(10);
    expect(duplicateNodes('alex')).toEqual([]);
    expect(duplicateNodes('sam')).toEqual([]);
    expect(uploadCmdsFor('sam', '2026-10-12 Stadtwerke.pdf')).toHaveLength(1);
  });

  it('same account: a pair run jumps the backlog of the long run (priority lane) and --wait returns early', async () => {
    h = await makeHarness({
      accounts: [{ id: 'alex', workers: 2 }],
      pairs: [alexPair],
      localFiles: bigFiles('Dokumente', 12),
      accountEnv: { alex: SLOW },
      // the backlog files were written a moment ago; "recently changed" (lifted too) means: after this test's start
      engine: { priorityRecentMs: 400 },
    });
    await new Promise((r) => setTimeout(r, 500));
    const long = h.engine.requestSyncTicket({ accountId: 'alex' }, 'manual');
    await until(() => h.jobs('running').length > 0, 20_000, 'backlog uploads');
    // background requests for the busy account queue (one queued run per lane, merged, final id at once)
    const q1 = h.engine.requestSyncTicket({ accountId: 'alex' }, 'api');
    const q2 = h.engine.requestSyncTicket({}, 'schedule');
    expect(q1.followUp).toBe(true);
    expect(q1.queuedBehind).toEqual(long.runIds);
    expect(q2.runIds).toEqual(q1.runIds);
    expect(run(q1.runIds[0]!).status).toBe('queued');
    expect(h.engine.status().queuedRuns!.map((r) => r.id)).toEqual(q1.runIds);
    expect(h.engine.status().accounts[0]!.queuedRunIds).toEqual(q1.runIds);

    // an urgent document in the SAME pair: pair-scoped run in the priority lane
    h.write('Dokumente/Eilig/Brief an Sam.txt', 'eilig');
    const t0 = Date.now();
    const t = h.engine.requestSyncTicket({ pairId: pairId('Dokumente') }, 'api');
    expect(t.followUp).toBe(false);
    const pr = await h.engine.waitRun(t.runIds[0]!);
    expect(pr!.status).toBe('ok');
    expect(pr!.lane).toBe('priority');
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/Eilig/Brief an Sam.txt')).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(9000); // <= one in-flight 2 s upload + own work, not 12 x 2 s / 2
    expect(run(long.runIds[0]!).status).toBe('running');
    // the urgent upload ran before (most of) the backlog
    const ups = h.commands('alex').filter((c) => c.cmd === 'filesystem upload');
    const urgent = ups.findIndex((c) => c.args.some((a) => a.endsWith('/Brief an Sam.txt')));
    expect(urgent).toBeGreaterThanOrEqual(0);
    expect(urgent).toBeLessThan(ups.length);
    const backlogDoneBefore = ups.slice(0, urgent).length;
    expect(backlogDoneBefore).toBeLessThan(8);

    await h.engine.waitIdle();
    await h.drain();
    expect(run(long.runIds[0]!).status).toBe('ok');
    expect(run(q1.runIds[0]!).status).toBe('ok'); // the queued run ran after the long one
    // it started when the long run released the account (its last pair done, the row is finalised a moment later)
    expect(Date.parse(run(q1.runIds[0]!).startedAt)).toBeGreaterThanOrEqual(
      Date.parse(run(long.runIds[0]!).finishedAt!) - 100,
    );
    expect(duplicateNodes('alex')).toEqual([]);
    expect(uploadCmdsFor('alex', 'Brief an Sam.txt')).toHaveLength(1);
    // lane jobs are done; nothing left with a lane priority
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE priority < 0 AND state NOT IN ('done','cancelled')").get(),
    ).toEqual({ n: 0 });
  });

  it('a document the background run already planned is lifted into the lane, so --wait covers it', async () => {
    h = await makeHarness({
      accounts: [{ id: 'alex', workers: 1 }],
      pairs: [alexPair],
      localFiles: bigFiles('Dokumente', 6),
      accountEnv: { alex: SLOW },
      engine: { priorityRecentMs: 1500 },
    });
    await new Promise((r) => setTimeout(r, 1600)); // the backlog is "old"
    h.write('Dokumente/Post/Brief.txt', 'brief'); // filed just before the background run scans
    const long = h.engine.requestSyncTicket({ accountId: 'alex' }, 'manual');
    await until(() => h.jobs('running').length > 0, 20_000, 'backlog uploads');
    const brief = () =>
      h.jobs().find((j) => j.type === 'upload' && j.payload.includes('Brief.txt')) as
        { id: number; state: string; priority: number } | undefined;
    expect(brief()?.priority).toBeGreaterThanOrEqual(0); // planned by the background run, normal priority
    const t = h.engine.requestSyncTicket({ pairId: pairId('Dokumente') }, 'api');
    const pr = await h.engine.waitRun(t.runIds[0]!);
    expect(pr!.status).toBe('ok');
    expect(brief()?.state).toBe('done'); // --wait returned after the document was uploaded
    expect(brief()!.priority).toBeLessThan(0);
    expect(run(long.runIds[0]!).status).toBe('running');
    // only the fresh file was lifted, the old backlog kept its place
    const lane = h.jobs().filter((j) => (j as unknown as { priority: number }).priority < 0);
    expect(lane.length).toBeGreaterThanOrEqual(1);
    expect(lane.every((j) => j.payload.includes('Post'))).toBe(true);
    await h.engine.waitIdle();
    expect(duplicateNodes('alex')).toEqual([]);
  });

  it('a second request for the same pair while its priority run is active is queued and merged', async () => {
    h = await makeHarness({
      accounts: [{ id: 'alex', workers: 2 }],
      pairs: [alexPair],
      localFiles: bigFiles('Dokumente', 3),
      accountEnv: { alex: SLOW },
    });
    const id = pairId('Dokumente');
    const a = h.engine.requestSyncTicket({ pairId: id }, 'api');
    const b = h.engine.requestSyncTicket({ pairId: id }, 'api');
    const c = h.engine.requestSyncTicket({ pairId: id }, 'manual');
    expect(a.followUp).toBe(false);
    expect(b.followUp).toBe(true);
    expect(c.runIds).toEqual(b.runIds);
    expect(b.queuedBehind).toEqual(a.runIds);
    await h.engine.waitIdle();
    expect(run(a.runIds[0]!).status).toBe('ok');
    expect(run(b.runIds[0]!).status).toBe('ok');
    expect(run(b.runIds[0]!).lane).toBe('priority');
    expect(duplicateNodes('alex')).toEqual([]);
  });

  it('the global process cap holds over all accounts (idle workers of another account are stopped first)', async () => {
    h = await makeHarness({
      accounts: [
        { id: 'alex', workers: 2 },
        { id: 'sam', workers: 2 },
      ],
      pairs: [alexPair, { account: 'sam', name: 'Sam Backup', local: 'Sam/Backup', remote: '/my-files/Backup' }],
      localFiles: { ...bigFiles('Dokumente', 6, 40 * KB), ...bigFiles('Sam/Backup', 6, 40 * KB) },
      accountEnv: { alex: SLOW, sam: SLOW },
    });
    writeEngineSetting(h.db, 'transfer', { maxWorkersTotal: 2, maxWorkersPerAccount: 2 });
    await h.engine.reload();
    let maxAlive = 0;
    let maxPids = 0;
    let both = false;
    const sample = setInterval(() => {
      const s = h.engine.processStats();
      maxAlive = Math.max(maxAlive, s.alive);
      const f = h.engine.poolFor('alex').pids().length;
      const a = h.engine.poolFor('sam').pids().length;
      maxPids = Math.max(maxPids, f + a);
      if (f && a) both = true;
    }, 5);
    try {
      const t = h.engine.requestSyncTicket({}, 'schedule');
      // the sam pair request runs in parallel to the global run's work
      h.engine.requestSyncTicket({ pairId: pairId('Sam Backup') }, 'api');
      await h.engine.waitIdle();
      await h.drain();
      expect(run(t.runIds[0]!).status).toBe('ok');
    } finally {
      clearInterval(sample);
    }
    const stats = h.engine.processStats();
    expect(stats.cap).toBe(2);
    expect(stats.peak).toBeLessThanOrEqual(2);
    expect(maxAlive).toBeLessThanOrEqual(2);
    expect(maxPids).toBeLessThanOrEqual(2);
    expect(both).toBe(true); // both accounts had a process at the same time (they ran in parallel)
    expect(h.commands('alex').filter((c) => c.cmd === 'filesystem upload')).toHaveLength(6);
    expect(h.commands('sam').filter((c) => c.cmd === 'filesystem upload')).toHaveLength(6);
    expect(duplicateNodes('alex')).toEqual([]);
    expect(duplicateNodes('sam')).toEqual([]);
  });

  it('a restart during parallel runs of both accounts resumes both, without duplicate uploads', async () => {
    h = await makeHarness({
      accounts: [
        { id: 'alex', workers: 2 },
        { id: 'sam', workers: 1 },
      ],
      pairs: [alexPair, { account: 'sam', name: 'Sam Backup', local: 'Sam/Backup', remote: '/my-files/Backup' }],
      localFiles: { ...bigFiles('Dokumente', 8), ...bigFiles('Sam/Backup', 4) },
      accountEnv: { alex: SLOW, sam: SLOW },
    });
    const f = h.engine.requestSyncTicket({ accountId: 'alex' }, 'manual');
    const a = h.engine.requestSyncTicket({ accountId: 'sam' }, 'manual');
    expect(a.followUp).toBe(false); // independent lanes
    await until(
      () =>
        h.commands('alex').some((c) => c.cmd === 'filesystem upload') &&
        h.commands('sam').some((c) => c.cmd === 'filesystem upload'),
      20_000,
      'uploads of both accounts',
    );
    expect(h.engine.status().activeRuns!.map((r) => r.id)).toEqual([...f.runIds, ...a.runIds]);

    const e2 = await h.restart({ resumeRunsDelayMs: 0 });
    // the interrupted runs are cancelled and their scopes requested again ('startup')
    await until(() => e2.status().activeRuns!.length === 2, 10_000, 'resumed runs');
    const resumed = e2.status().activeRuns!;
    expect(resumed.map((r) => r.trigger)).toEqual(['startup', 'startup']);
    expect(resumed.map((r) => r.accountId).sort()).toEqual(['alex', 'sam']);
    await e2.waitIdle();
    await h.drain();
    expect(run(f.runIds[0]!).status).toBe('cancelled');
    expect(run(a.runIds[0]!).status).toBe('cancelled');
    for (const r of resumed) expect(run(r.id).status).toBe('ok');
    // every file arrived exactly once; at most the one in-flight file per worker was sent again
    expect(duplicateNodes('alex')).toEqual([]);
    expect(duplicateNodes('sam')).toEqual([]);
    for (let i = 0; i < 8; i++) {
      expect(h.remoteNode('alex', `/devices/Workstation/Documents/Ordner${i}/datei-${i}.bin`)).toBeDefined();
      expect(uploadCmdsFor('alex', `datei-${i}.bin`).length).toBeLessThanOrEqual(2);
    }
    for (let i = 0; i < 4; i++) {
      expect(h.remoteNode('sam', `/my-files/Backup/Ordner${i}/datei-${i}.bin`)).toBeDefined();
      expect(uploadCmdsFor('sam', `datei-${i}.bin`).length).toBeLessThanOrEqual(2);
    }
    const resent = [...Array(8).keys()].filter((i) => uploadCmdsFor('alex', `datei-${i}.bin`).length > 1).length;
    expect(resent).toBeLessThanOrEqual(2); // alex has 2 workers
  });
});
