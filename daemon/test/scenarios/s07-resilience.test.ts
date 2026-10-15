// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NucleonSyncClient, resolvePaths, type StatusDto } from '@nucleon-sync/shared';

import { ROOT, tmp } from '../helpers.ts';
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

describe('S7 resilience', () => {
  it('network drop mid-run: retry_wait, account offline, automatic resume, no failed jobs', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 16; i++) files[`Dokumente/f${i}/file${i}.txt`] = `content ${i}`;
    const dir = tmp('offline-');
    const offline = path.join(dir, 'offline');
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: files,
      accountEnv: { alex: { MOCK_OFFLINE_FILE: offline, MOCK_LATENCY_MS: '40', MOCK_OFFLINE_DELAY_MS: '20' } },
    });
    const engine = h.engine;
    const runId = engine.requestSync({}, 'manual');
    await until(() => h!.jobs('done').length >= 4);
    writeFileSync(offline, '1');
    await until(() => engine.accounts()[0]!.status === 'offline');
    expect(h.jobs('retry_wait').length).toBeGreaterThan(0);
    expect(engine.status().state).toBe('offline');
    await sleep(400);
    rmSync(offline);
    await engine.waitIdle();
    const run = engine.runs(5).find((r) => r.id === runId)!;
    expect(h.jobs('failed')).toHaveLength(0);
    expect(h.jobs().every((j) => j.state === 'done')).toBe(true);
    expect(run.status).toBe('ok');
    expect(engine.accounts()[0]!.status).toBe('ok');
    for (let i = 0; i < 16; i++)
      expect(h.remoteNode('alex', `/devices/Workstation/Documents/f${i}/file${i}.txt`)).toBeDefined();
    expect(engine.activity(200).some((a) => a.message === 'back online' && a.msg?.key === 'activity.backOnline')).toBe(
      true,
    );
  });

  it('daemon killed mid-run: the restarted daemon finishes without duplicate nodes or revisions', async () => {
    const home = tmp('kill-');
    const { seedMock } = (await import(path.join(ROOT, 'scripts/mock-seed.mjs'))) as {
      seedMock: (h: string) => string;
    };
    const mock = seedMock(home);
    const dok = path.join(mock, 'data/Dokumente');
    for (let i = 0; i < 24; i++) {
      mkdirSync(path.join(dok, `neu/ordner${i % 6}`), { recursive: true });
      const f = path.join(dok, `neu/ordner${i % 6}/datei${i}.bin`);
      writeFileSync(f, Buffer.alloc(9 * 1024 * 1024, i)); // > 8 MiB: one file per upload command
      utimesSync(f, new Date('2025-01-01'), new Date('2025-01-01')); // older than the 10 s "file too fresh" window
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
      return new NucleonSyncClient({
        socketPath: paths.socketFile,
        token: readFileSync(paths.tokenFile, 'utf8').trim(),
      });
    };
    start();
    let c = await client();
    await until(() =>
      c
        .status()
        .then(() => true)
        .catch(() => false),
    );
    await c.sync({});
    const remoteState = () =>
      JSON.parse(readFileSync(path.join(mock, 'remote-alex/state.json'), 'utf8')) as {
        nodes: Record<
          string,
          {
            uid: string;
            parentUid: string | null;
            name: string;
            type: string;
            trashed: string | null;
            revisions?: unknown[];
          }
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
    await until(() =>
      c
        .status()
        .then(() => true)
        .catch(() => false),
    );
    await c.sync({});
    const idle = (s: StatusDto) => !s.currentRun && s.queue.queued + s.queue.running + s.queue.retryWait === 0;
    const final = await until(
      async () => {
        const s = await c.status().catch(() => null);
        return s && idle(s) ? s : null;
      },
      90_000,
      200,
    );
    expect(final!.queue.failed).toBe(0);
    const nodes = Object.values(remoteState().nodes).filter((n) => !n.trashed);
    const seen = new Map<string, number>();
    for (const n of nodes.filter((x) => x.parentUid))
      seen.set(`${n.parentUid}/${n.name}`, (seen.get(`${n.parentUid}/${n.name}`) ?? 0) + 1);
    expect([...seen.entries()].filter(([, k]) => k > 1)).toEqual([]); // no duplicate nodes
    expect(nodes.filter((n) => / \(\d+\)/.test(n.name))).toEqual([]); // no "name (1)" copies
    const uploaded = nodes.filter((n) => n.name.startsWith('datei'));
    expect(uploaded).toHaveLength(24);
    expect(uploaded.every((n) => (n.revisions ?? []).length === 1)).toBe(true); // no duplicate revisions
  }, 120_000);
});
