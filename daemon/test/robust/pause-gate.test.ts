// SPDX-License-Identifier: GPL-3.0-or-later
/** Pause is airtight (no proton-drive process for a paused account) + idle reaper + foreign-process gate. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliGatedError } from '../../src/cli/pool.ts';
import { makeHarness, type Harness } from '../scenarios/harness.ts';
import { startMockDaemon, type MockDaemon } from '../c-helpers.ts';
import { MOCK_BIN, SHIM_DIR } from '../helpers.ts';

let h: Harness | null = null;
let md: MockDaemon | null = null;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  await h?.close();
  await md?.close();
  h = null;
  md = null;
});

const PAIR = { account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' };

/** pids of mock CLI processes working on this mock remote */
function cliProcs(remote: string): number[] {
  const out: number[] = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (env.includes(`MOCK_PROTON_REMOTE=${remote}`)) out.push(Number(pid));
    } catch {
      /* gone */
    }
  }
  return out;
}

async function until(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('pause is airtight', () => {
  it('account pause stops idle workers at once; nothing starts a CLI process while paused', async () => {
    h = await makeHarness({ pairs: [PAIR], localFiles: { 'Dokumente/a.txt': 'a' } });
    await h.sync();
    await h.drain();
    const remote = h.remotes.alex!;
    expect(h.engine.poolFor('alex').aliveCount()).toBeGreaterThan(0);
    expect(cliProcs(remote).length).toBeGreaterThan(0);
    h.engine.pause({ scope: 'account', id: 'alex' });
    await until(() => cliProcs(remote).length === 0);
    expect(h.engine.poolFor('alex').aliveCount()).toBe(0);
    const mark = h.mark();
    // every path into the CLI is gated: runs, the remote browser/storage (RemoteOps), new jobs
    h.write('Dokumente/b.txt', 'b');
    await h.sync();
    await expect(h.engine.remote('alex').list({ path: '/devices/Workstation/Documents' })).rejects.toBeInstanceOf(
      CliGatedError,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(cliProcs(remote)).toEqual([]);
    expect(h.commands('alex', mark)).toEqual([]);
    h.engine.resume({ scope: 'account', id: 'alex' });
    await h.sync();
    await h.drain();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/b.txt')).toBeDefined();
  });

  it('pause during a transfer: the current file finishes, then the worker stops; queued files wait', async () => {
    h = await makeHarness({
      pairs: [PAIR],
      // > 8 MiB each: not batched into one command
      localFiles: { 'Dokumente/big.bin': 'x'.repeat(9_000_000), 'Dokumente/big2.bin': 'y'.repeat(9_000_000) },
      accounts: [{ id: 'alex', workers: 1 }],
      accountEnv: { alex: { MOCK_TRANSFER_BPS: '6000000' } },
    });
    const remote = h.remotes.alex!;
    h.engine.requestSync({}, 'manual');
    await until(() => h!.jobs('running').some((j) => j.type === 'upload'));
    h.engine.pause({ scope: 'all' });
    await until(() => h!.jobs().filter((j) => j.type === 'upload' && j.state === 'done').length === 1, 10_000);
    await until(() => cliProcs(remote).length === 0);
    await new Promise((r) => setTimeout(r, 500));
    const ups = h.jobs().filter((j) => j.type === 'upload');
    expect(ups.filter((j) => j.state === 'done')).toHaveLength(1);
    expect(ups.filter((j) => j.state === 'queued')).toHaveLength(1);
    expect(cliProcs(remote)).toEqual([]);
    h.engine.resume({ scope: 'all' });
    await h.drain();
    expect(h.jobs().filter((j) => j.type === 'upload' && j.state === 'done')).toHaveLength(2);
  });

  it('immediate pause kills the worker; the job goes back to the queue without an attempt', async () => {
    h = await makeHarness({
      pairs: [PAIR],
      localFiles: { 'Dokumente/big.bin': 'x'.repeat(600_000) },
      accountEnv: { alex: { MOCK_TRANSFER_BPS: '200000' } },
    });
    const remote = h.remotes.alex!;
    h.engine.requestSync({}, 'manual');
    await until(() => h!.jobs('running').some((j) => j.type === 'upload'));
    h.engine.pause({ scope: 'account', id: 'alex', immediate: true });
    await until(() => cliProcs(remote).length === 0, 8000);
    await until(() => h!.jobs().some((j) => j.type === 'upload' && j.state === 'queued'));
    const job = h.jobs().find((j) => j.type === 'upload')! as unknown as { attempts: number };
    expect(job.attempts).toBe(0);
  });

  it('idle workers are stopped after poolIdleMs', async () => {
    h = await makeHarness({ pairs: [PAIR], localFiles: { 'Dokumente/a.txt': 'a' }, engine: { poolIdleMs: 300 } });
    await h.sync();
    await h.drain();
    await until(() => cliProcs(h!.remotes.alex!).length === 0, 5000);
    expect(h.engine.poolFor('alex').aliveCount()).toBe(0);
  });
});

describe('foreign proton-drive process on the same session', () => {
  function foreign(env: NodeJS.ProcessEnv): ChildProcess {
    const c = spawn(MOCK_BIN, [], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(c);
    return c;
  }

  it('the account waits (no CLI process of ours), other accounts continue; released when it exits', async () => {
    md = await startMockDaemon({
      env: { NUCLEON_SYNC_FOREIGN_GATE: '1', NUCLEON_SYNC_FOREIGN_GATE_CACHE_MS: '200' },
      engine: { gateCheckMs: 200 },
    });
    const secrets = path.join(md.mockDir, 'secrets');
    const remote = path.join(md.mockDir, 'remote-alex');
    // first sync: our workers run
    md.d.engine.requestSync({ accountId: 'alex' }, 'manual');
    await md.d.engine.waitIdle();
    // a manual CLI call / script on Alex's session (same shim item, not started by this daemon)
    const base = {
      ...process.env,
      MOCK_PROTON_REMOTE: remote,
      PROTON_DRIVE_CACHE_DIR: path.join(md.home, 'foreign-cache'),
      PROTON_DRIVE_CREDENTIALS_STORE: 'pass',
      PATH: `${SHIM_DIR}${path.delimiter}${process.env.PATH}`,
      NUCLEON_SYNC_ACCOUNT: 'alex',
      NUCLEON_SYNC_SECRET_BACKEND: 'file',
      NUCLEON_SYNC_SECRET_FILE_DIR: secrets,
    };
    // a process on Sam's session gates Sam only
    const other = foreign({
      ...base,
      NUCLEON_SYNC_ACCOUNT: 'sam',
      MOCK_PROTON_REMOTE: path.join(md.mockDir, 'remote-sam'),
    });
    await until(() => !!md!.d.engine.cliGate('sam'));
    expect(md.d.engine.cliGate('alex')).toBeNull();
    other.kill('SIGKILL');
    const f = foreign(base);
    await until(() => !!md!.d.engine.cliGate('alex'));
    const acc = md.d.engine.accounts().find((a) => a.id === 'alex')!;
    expect(acc.status).toBe('error');
    expect(acc.lastError).toMatch(/Another proton-drive process/);
    expect(acc.lastErrorMsg?.key).toBe('account.foreignCli');
    // our own workers of alex are gone; the foreign one keeps running
    await until(() => cliProcs(remote).every((p) => p === f.pid));
    expect(md.d.engine.syncBlocker({ accountId: 'alex' })).toMatch(/is waiting/);
    f.kill('SIGKILL');
    await until(() => md!.d.engine.cliGate('alex') === null, 10_000);
    await until(() => md!.d.engine.accounts().find((a) => a.id === 'alex')!.status === 'ok', 10_000);
  });
});
