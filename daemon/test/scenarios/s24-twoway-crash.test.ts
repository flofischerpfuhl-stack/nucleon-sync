// SPDX-License-Identifier: GPL-3.0-or-later
/** S24 two-way crash recovery: a daemon killed mid-run finishes without duplicate nodes, revisions or copies. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NucleonSyncClient,
  resolvePaths,
  twoWayConflictName,
  type PairDto,
  type StatusDto,
} from '@nucleon-sync/shared';

import { ROOT, SEED_BIN, tmp } from '../helpers.ts';
import { makeHarness, type Harness } from './harness.ts';

let h: Harness | undefined;
let daemon: ChildProcess | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  daemon?.kill('SIGKILL');
  daemon = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, timeoutMs = 20_000, step = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await sleep(step);
  }
}

const R = '/devices/Workstation/Documents';
const T = new Date('2025-03-01T10:00:00Z');

describe('S24 two-way crash recovery', () => {
  it('restart while the remote version of a conflict downloads: one copy, no duplicates', async () => {
    const hang = path.join(tmp('hang-'), 'hang');
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Docs', local: 'Docs', remote: R, direction: 'two-way' }],
      localFiles: { 'Docs/x.txt': 'base' },
      mtime: T,
      accountEnv: { alex: { MOCK_HANG_FILE: hang } },
    });
    await h.sync();
    h.write('Docs/x.txt', 'pc version', new Date('2025-04-01T10:00:00Z'));
    h.remoteEdit('alex', `${R}/x.txt`, 'laptop version');
    writeFileSync(hang, 'filesystem download\n');
    void h.engine.requestSync({}, 'manual');
    const copy = twoWayConflictName('x.txt', 'pc', new Date());
    await until(() => h!.remoteNode('alex', `${R}/${copy}`)); // copy uploaded, the download hangs
    await h.restart(); // the daemon goes down mid-download
    rmSync(hang);
    await h.drain();
    await h.sync();
    await h.sync();
    expect(h.read('Docs/x.txt')).toBe('laptop version');
    expect(h.read(`Docs/${copy}`)).toBe('pc version');
    expect(readdirSync(path.join(h.data, 'Docs')).sort()).toEqual([copy, 'x.txt'].sort());
    const remote = Object.values(h.remoteState().nodes).filter((n) => !n.trashed && n.type === 'file');
    expect(remote.map((n) => n.name).sort()).toEqual([copy, 'x.txt'].sort());
    expect(remote.find((n) => n.name === copy)!.revisions).toHaveLength(1);
    expect(h.engine.conflicts()).toHaveLength(1);
    expect(h.jobs('failed')).toHaveLength(0);
  });

  it('crash between upload and bookkeeping: the restarted daemon finds its upload, no second upload', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Docs', local: 'Docs', remote: R, direction: 'two-way' }],
      localFiles: { 'Docs/seed.txt': 's' },
      mtime: T,
    });
    await h.sync();
    h.write('Docs/new.pdf', 'new file', T);
    await h.sync();
    const done = h.jobs('done').find((j) => j.type === 'upload' && j.payload.includes('new.pdf'))!;
    const e = h.entry(1, 'new.pdf')!;
    h.db
      .prepare(
        `UPDATE entries SET r_exists = 0, r_uid = NULL, r_rev_uid = NULL, r_sha1 = NULL, b_sha1 = NULL, b_size = NULL,
         b_l_mtime_us = NULL, b_r_rev_uid = NULL, synced_at = NULL, state = 'local_new' WHERE id = ?`,
      )
      .run(e.id);
    h.db
      .prepare(
        `INSERT INTO jobs (run_id, account_id, pair_id, entry_id, type, payload, priority, state, bytes, dedupe_key, created_at, started_at)
         VALUES (NULL, 'alex', 1, ?, 'upload', ?, 30, 'running', ?, ?, ?, ?)`,
      )
      .run(e.id, done.payload, e.l_size, 'upload:1:new.pdf', Date.now(), Date.now());
    const mark = h.mark();
    await h.restart();
    await h.drain();
    await h.sync();
    expect(h.commands('alex', mark).filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);
    expect(h.entry(1, 'new.pdf')!.state).toBe('synced');
    expect(h.engine.conflicts()).toHaveLength(0); // its own upload is not mistaken for another device's file
  });

  it('daemon SIGKILLed mid-run (real process, two-way pair via the API): no duplicates after restart', async () => {
    const home = tmp('kill2-');
    const { seedMock } = (await import(path.join(ROOT, 'scripts/mock-seed.mjs'))) as {
      seedMock: (h: string) => string;
    };
    const mock = seedMock(home);
    const local = path.join(mock, 'data/Zwei');
    for (let i = 0; i < 12; i++) {
      mkdirSync(path.join(local, `ordner${i % 3}`), { recursive: true });
      const f = path.join(local, `ordner${i % 3}/datei${i}.bin`);
      writeFileSync(f, Buffer.alloc(9 * 1024 * 1024, i)); // > 8 MiB: one file per upload command
      utimesSync(f, T, T);
    }
    // files that only exist in Proton (another device put them there): downloaded by the pair
    const remoteSrc = path.join(home, 'remote-src');
    for (let i = 0; i < 6; i++) {
      mkdirSync(path.join(remoteSrc, 'vom-laptop'), { recursive: true });
      writeFileSync(path.join(remoteSrc, `vom-laptop/bild${i}.jpg`), Buffer.alloc(2 * 1024 * 1024, 100 + i));
    }
    const env = {
      ...process.env,
      NUCLEON_SYNC_HOME: home,
      NUCLEON_SYNC_MOCK: '1',
      MOCK_LATENCY_MS: '120',
      NUCLEON_SYNC_LOG_LEVEL: 'warn',
    };
    const paths = resolvePaths(env);
    const start = () => {
      daemon = spawn(process.execPath, [path.join(ROOT, 'daemon/src/main.ts')], { env, stdio: 'ignore' });
    };
    const client = async () => {
      await until(() => existsSync(paths.socketFile) && existsSync(paths.tokenFile));
      const c = new NucleonSyncClient({
        socketPath: paths.socketFile,
        token: readFileSync(paths.tokenFile, 'utf8').trim(),
      });
      await until(() =>
        c
          .status()
          .then(() => true)
          .catch(() => false),
      );
      return c;
    };
    start();
    let c = await client();
    const pair = await c.request<PairDto>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Zwei',
      localRoot: local,
      remoteRoot: '/my-files/Zwei',
      direction: 'two-way',
      enabled: true,
      createRemote: true,
    });
    expect(pair.direction).toBe('two-way');
    expect(pair.options?.twoWayAdoption).toBe(true);
    const { execFileSync } = await import('node:child_process');
    execFileSync(SEED_BIN, ['--remote', path.join(mock, 'remote-alex'), '--from', remoteSrc, '--to', '/my-files/Zwei']);
    await c.sync({ pairId: pair.id });
    const remoteState = () =>
      JSON.parse(readFileSync(path.join(mock, 'remote-alex/state.json'), 'utf8')) as {
        nodes: Record<
          string,
          { parentUid: string | null; name: string; trashed: string | null; revisions?: unknown[] }
        >;
      };
    await until(
      () => Object.values(remoteState().nodes).filter((n) => n.name.startsWith('datei')).length >= 3,
      60_000,
      100,
    );
    daemon!.kill('SIGKILL');
    await new Promise((r) => daemon!.once('exit', r));
    await sleep(300);
    rmSync(paths.socketFile, { force: true });
    start();
    c = await client();
    await c.sync({ pairId: pair.id });
    const idle = (s: StatusDto) => !s.currentRun && s.queue.queued + s.queue.running + s.queue.retryWait === 0;
    const final = await until(
      async () => {
        const s = await c.status().catch(() => null);
        return s && idle(s) && s.pairs.find((p) => p.id === pair.id)?.lastRunAt ? s : null;
      },
      90_000,
      200,
    );
    expect(final!.queue.failed).toBe(0);
    await c.sync({ pairId: pair.id });
    await until(async () => {
      const s = await c.status().catch(() => null);
      return s && idle(s);
    }, 60_000);
    const nodes = Object.values(remoteState().nodes).filter((n) => !n.trashed);
    const seen = new Map<string, number>();
    for (const n of nodes.filter((x) => x.parentUid))
      seen.set(`${n.parentUid}/${n.name}`, (seen.get(`${n.parentUid}/${n.name}`) ?? 0) + 1);
    expect([...seen.entries()].filter(([, k]) => k > 1)).toEqual([]);
    expect(nodes.filter((n) => / \(\d+\)/.test(n.name) || /\(conflict /.test(n.name))).toEqual([]);
    const uploaded = nodes.filter((n) => n.name.startsWith('datei'));
    expect(uploaded).toHaveLength(12);
    expect(uploaded.every((n) => (n.revisions ?? []).length === 1)).toBe(true);
    expect(nodes.filter((n) => n.name.startsWith('bild')).every((n) => (n.revisions ?? []).length === 1)).toBe(true);
    // local side: the downloads arrived once, nothing duplicated or renamed
    expect(readdirSync(path.join(local, 'vom-laptop')).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `bild${i}.jpg`).sort(),
    );
    expect(readdirSync(local).sort()).toEqual(['ordner0', 'ordner1', 'ordner2', 'vom-laptop']);
    const conflicts = await c.request<unknown[]>('GET', '/v1/conflicts');
    expect(conflicts).toEqual([]);
    const pd = (await c.request<PairDto[]>('GET', '/v1/pairs')).find((p) => p.id === pair.id)!;
    expect(pd.options?.twoWayAdoption).toBeUndefined(); // adoption finished after the complete run
  }, 150_000);
});
