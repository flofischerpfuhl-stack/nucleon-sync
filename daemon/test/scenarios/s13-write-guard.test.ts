// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';

import { decodeMsg } from '@nucleon-sync/shared';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const WRITES = [
  'filesystem upload',
  'filesystem download',
  'filesystem move',
  'filesystem rename',
  'filesystem trash',
  'filesystem create-folder',
  'filesystem delete',
  'filesystem empty-trash',
];

describe('S13 write guard', () => {
  it('production mode without NUCLEON_SYNC_ALLOW_WRITES=1: jobs blocked, no write command reaches the CLI', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: { alex: [{ to: '/devices/Workstation/Documents', files: { 'remote.pdf': 'r' } }] },
      localFiles: { 'Dokumente/new/local.txt': 'l', 'Dokumente/top.txt': 't' },
      engine: { mode: 'production', env: { ...process.env, NUCLEON_SYNC_ALLOW_WRITES: '0' } },
    });
    const run = await h.sync();
    expect(run.status).toBe('ok');
    const jobs = h.jobs();
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    expect(jobs.every((j) => j.state === 'blocked')).toBe(true);
    expect(decodeMsg(jobs[0]!.last_error).text).toMatch(/Writing disabled/);
    expect(decodeMsg(jobs[0]!.last_error).msg?.key).toBe('guard.writesDisabled');
    expect(h.commands().filter((c) => WRITES.includes(c.cmd))).toHaveLength(0);
    expect(h.engine.status().queue.blocked).toBe(jobs.length);
    expect(h.exists('Dokumente/remote.pdf')).toBe(false);
    await expect(h.engine.emptyTrash('alex', 'test')).rejects.toThrow(/Writing disabled/);
    // the RemoteOps layer refuses on its own as well
    await expect(h.engine.remote('alex').mkdir({ path: '/devices/Workstation/Documents' }, 'x')).rejects.toThrow(
      /write blocked/,
    );

    // enabling writes (daemon restart with the flag) releases the blocked jobs
    await h.restart({ env: { ...process.env, NUCLEON_SYNC_ALLOW_WRITES: '1' } });
    await h.drain();
    expect(h.jobs().every((j) => j.state === 'done')).toBe(true);
    expect(h.exists('Dokumente/remote.pdf')).toBe(true);
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/new/local.txt')).toBeDefined();
  });

  it('a large queue is blocked in one statement (no per-job loop starving the event loop)', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      engine: { mode: 'production', env: { ...process.env, NUCLEON_SYNC_ALLOW_WRITES: '0' } },
    });
    const ins = h.db.prepare(
      "INSERT INTO jobs (run_id, account_id, pair_id, entry_id, type, payload, priority, state, created_at) VALUES (NULL, 'alex', 1, NULL, 'download', ?, 40, 'queued', ?)",
    );
    h.db.exec('BEGIN');
    for (let i = 0; i < 30_000; i++) ins.run(JSON.stringify({ rel: `f${i}` }), Date.now());
    h.db.exec('COMMIT');
    const t0 = Date.now();
    h.engine.kick('alex');
    for (let i = 0; i < 200 && h.jobs('blocked').length < 30_000; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.jobs('blocked')).toHaveLength(30_000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
