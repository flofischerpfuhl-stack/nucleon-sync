// SPDX-License-Identifier: GPL-3.0-or-later
/** A hung server call never stalls a run: per-command timeouts kill the worker, the job retries with backoff. */
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeHarness, type Harness } from '../scenarios/harness.ts';

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

const PAIR = { account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function captureLog(): string[] {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  return lines;
}

describe('per-command CLI timeouts', () => {
  it('a hung folder move/rename times out (cli_timeout), the worker is killed, the job retries and succeeds', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`Dokumente/A/f${i}.txt`] = `f${i}`;
    h = await makeHarness({
      pairs: [PAIR],
      localFiles: files,
      engine: { cliTimeouts: { mutateMs: 1500 } },
    });
    await h.sync();
    await h.drain();
    const hang = path.join(h.dir, 'hang');
    // MOCK_HANG_FILE is read per command: set it through the account env of a restarted engine
    await h.restart({
      accountEnv: {
        alex: {
          MOCK_PROTON_REMOTE: h.remotes.alex!,
          MOCK_COMMAND_LOG: path.join(h.dir, 'cmd-alex.jsonl'),
          MOCK_HANG_FILE: hang,
        },
      },
    });
    const logs = captureLog();
    writeFileSync(hang, 'filesystem move\nfilesystem rename\n');
    renameSync(path.join(h.data, 'Dokumente/A'), path.join(h.data, 'Dokumente/B'));
    const t0 = Date.now();
    const runId = h.engine.requestSync({}, 'manual');
    const pool = h.engine.poolFor('alex');
    let hungPid = 0;
    await until(() => {
      const pids = pool.pids();
      if (pids.length) hungPid = pids[0]!;
      return h.jobs().some((j) => (j.type === 'move' || j.type === 'rename') && /cli_timeout/.test(j.last_error ?? ''));
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
    const j = h.jobs().find((x) => /cli_timeout/.test(x.last_error ?? ''))!;
    expect(['retry_wait', 'queued', 'running']).toContain(j.state);
    expect(j.error_class).toBe('transient');
    expect(logs.join('')).toMatch(/"msg":"cli_timeout"/);
    if (hungPid) await until(() => !alive(hungPid), 6000); // killed, not left hanging
    rmSync(hang); // the server answers again
    await h.engine.waitIdle();
    await h.drain();
    expect(h.engine.runs(5).find((r) => r.id === runId)!.status).not.toBe('running');
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/B/f0.txt')).toBeDefined();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/A')).toBeUndefined();
    expect(existsSync(hang)).toBe(false);
  });

  it('a stalled upload times out after base + size/rate and is retried', async () => {
    h = await makeHarness({
      pairs: [PAIR],
      localFiles: { 'Dokumente/x.bin': 'x'.repeat(10_000) },
      engine: { cliTimeouts: { transferBaseMs: 1000, minBytesPerSec: 1_000_000_000 } },
    });
    const hang = path.join(h.dir, 'hang');
    writeFileSync(hang, 'filesystem upload\n');
    await h.restart({
      accountEnv: {
        alex: {
          MOCK_PROTON_REMOTE: h.remotes.alex!,
          MOCK_COMMAND_LOG: path.join(h.dir, 'cmd-alex.jsonl'),
          MOCK_HANG_FILE: hang,
        },
      },
    });
    h.engine.requestSync({}, 'manual');
    await until(() => h.jobs().some((j) => j.type === 'upload' && /cli_timeout/.test(j.last_error ?? '')));
    rmSync(hang);
    await h.engine.waitIdle();
    await h.drain();
    const up = h.jobs().find((j) => j.type === 'upload')!;
    expect(up.state).toBe('done');
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/x.bin')).toBeDefined();
  });
});
