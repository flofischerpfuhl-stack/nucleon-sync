// SPDX-License-Identifier: GPL-3.0-or-later
/** CLI pool, limiter, scheduler, classify, compat — unit level (fake workers, fake clock). */
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { classifyCliError } from '../../src/cli/classify.ts';
import { isCompatible, parseVersionOutput } from '../../src/cli/compat.ts';
import { CliPool, type PoolWorker } from '../../src/cli/pool.ts';
import { CliError, type CliResult } from '../../src/cli/replWorker.ts';
import {
  AccountLimiter,
  DEFAULT_LIMITER_CONFIG,
  effectiveBandwidthBps,
  inWindow,
  pacingDelayMs,
  parseApiLogLatency,
  Semaphore,
} from '../../src/engine/limiter.ts';
import { nextFull, nextWeekly, Scheduler, type NextRun } from '../../src/engine/scheduler.ts';

class FakeWorker extends EventEmitter implements PoolWorker {
  static created: FakeWorker[] = [];
  readonly name: string;
  alive = false;
  commandsRun = 0;
  startedAt = 0;
  stopped = false;
  failAuth = 0;
  constructor(name: string) {
    super();
    this.name = name;
    FakeWorker.created.push(this);
  }
  async start() {
    this.alive = true;
    this.startedAt = Date.now();
  }
  async run(args: string[]): Promise<CliResult> {
    this.commandsRun++;
    await new Promise((r) => setTimeout(r, 20));
    if (this.failAuth > 0) {
      this.failAuth--;
      throw new CliError('You need to login first', 'auth');
    }
    this.emit('command', { durationMs: 20, ok: true, args });
    return { stdout: '[]', stderr: '', durationMs: 20 };
  }
  async json<T>(args: string[]): Promise<T> {
    return JSON.parse((await this.run(args)).stdout) as T;
  }
  kill() {
    this.alive = false;
  }
  async stop() {
    this.stopped = true;
    this.alive = false;
  }
}

function pool(size: number, extra: Partial<ConstructorParameters<typeof CliPool>[0]> = {}) {
  FakeWorker.created = [];
  const limiter = new AccountLimiter('a', DEFAULT_LIMITER_CONFIG);
  return {
    limiter,
    p: new CliPool({
      accountId: 'a',
      size,
      makeWorker: (i) => new FakeWorker(`a/w${i}`),
      limiter,
      global: new Semaphore(10),
      ...extra,
    }),
  };
}

describe('CliPool', () => {
  it('warm-up: only w0 until the first success, then parallel', async () => {
    const { p } = pool(2);
    const used: string[] = [];
    const spans: [number, number][] = [];
    await Promise.all(
      [1, 2].map(() =>
        p.withWorker(async (w) => {
          const s = Date.now();
          await w.json(['filesystem', 'list', '/']);
          spans.push([s, Date.now()]);
        }),
      ),
    );
    expect(FakeWorker.created[1] === undefined || spans[1]![0] >= spans[0]![1]).toBe(true); // no overlap during warm-up
    await Promise.all(
      [1, 2].map(() => p.withWorker(async (w) => (used.push(w.name), w.json(['filesystem', 'list', '/'])))),
    );
    expect(used.sort()).toEqual(['a/w0', 'a/w1']);
    await p.shutdown();
  });

  it('auth error: restarts the worker (fresh session) and retries once; persistent auth propagates', async () => {
    const { p } = pool(1);
    await p.withWorker((w) => w.json(['filesystem', 'list', '/']));
    FakeWorker.created[0]!.failAuth = 1;
    await expect(p.withWorker((w) => w.json(['filesystem', 'list', '/']))).resolves.toEqual([]);
    expect(FakeWorker.created[0]!.stopped).toBe(true);
    expect(FakeWorker.created).toHaveLength(2);
    let calls = 0;
    await expect(
      p.withWorker(async (w) => {
        calls++;
        (w as FakeWorker).failAuth = 5;
        return w.json(['filesystem', 'list', '/']);
      }),
    ).rejects.toMatchObject({ errorClass: 'auth' });
    expect(calls).toBe(2);
    await p.shutdown();
  });

  it('recycles workers after N commands and restarts stale ones (shim rm suppressed)', async () => {
    const { p } = pool(1, { recycleCommands: 3 });
    for (let i = 0; i < 4; i++) await p.withWorker((w) => w.json(['filesystem', 'list', '/']));
    expect(FakeWorker.created).toHaveLength(2);
    p.markStale();
    await p.withWorker((w) => w.json(['filesystem', 'list', '/']));
    expect(FakeWorker.created).toHaveLength(3);
    await p.shutdown();
  });

  it('limiter caps concurrency: reduced -> 1, cooldown -> 0', async () => {
    const { p, limiter } = pool(2);
    await p.withWorker((w) => w.json(['filesystem', 'list', '/']));
    expect(p.effectiveSize()).toBe(2);
    limiter.state = 'reduced';
    expect(p.effectiveSize()).toBe(1);
    limiter.recordRateLimited();
    expect(p.effectiveSize()).toBe(0);
    await p.shutdown();
  });
});

describe('AccountLimiter', () => {
  it('normal -> reduced -> cooldown -> reduced -> normal; 429 jumps to cooldown', () => {
    let t = 0;
    const l = new AccountLimiter('a', { ...DEFAULT_LIMITER_CONFIG, sustainMs: 1000, cooldownMs: 5000 }, () => t);
    for (let i = 0; i < 10; i++) l.recordLatency(150);
    expect(l.baseline).toBeGreaterThan(0);
    expect(l.state).toBe('normal');
    for (let i = 0; i < 20; i++) l.recordLatency(1700);
    expect(l.isHigh()).toBe(true);
    t += 1000;
    l.tick();
    expect(l.state).toBe('reduced');
    expect(l.allowedWorkers(2)).toBe(1);
    t += 1000;
    l.recordLatency(1700);
    expect(l.state).toBe('cooldown');
    expect(l.allowedWorkers(2)).toBe(0);
    t += 5000;
    expect(l.allowedWorkers(2)).toBe(1); // cooldown over -> carefully with one worker
    for (let i = 0; i < 10; i++) l.recordLatency(150);
    t += 1000;
    l.tick();
    expect(l.state).toBe('normal');
    l.recordRateLimited();
    expect(l.state).toBe('cooldown');
  });
  it('relative threshold needs the floor (no flapping at tiny baselines)', () => {
    const l = new AccountLimiter('a', DEFAULT_LIMITER_CONFIG, () => 0);
    for (let i = 0; i < 10; i++) l.recordLatency(5);
    for (let i = 0; i < 10; i++) l.recordLatency(60); // 12x baseline but below 400 ms
    expect(l.isHigh()).toBe(false);
  });
  it('bandwidth helpers', () => {
    expect(parseApiLogLatency('2026-10-10T10:00:00Z INFO [api] GET /drive/v2/links 200 (231ms)')).toBe(231);
    expect(parseApiLogLatency('DEBUG something')).toBeNull();
    expect(pacingDelayMs(1024 * 1024, 500, 1024 * 1024)).toBe(500);
    expect(pacingDelayMs(100, 500, null)).toBe(0);
    const night = new Date('2026-10-10T23:30:00');
    expect(inWindow('22:00', '07:00', night)).toBe(true);
    expect(inWindow('22:00', '07:00', new Date('2026-10-10T12:00:00'))).toBe(false);
    expect(effectiveBandwidthBps(1000, { from: '22:00', to: '07:00', bandwidthLimitKBps: null }, night)).toBeNull();
    expect(effectiveBandwidthBps(1000, null, night)).toBe(1024000);
  });
});

describe('Scheduler', () => {
  const settings = {
    incrementalEveryMinutes: 120,
    fullWeekly: { weekday: 0 as const, hour: 3 },
    fullEveryWeeks: 1,
    runOnStartupDelayMinutes: 5,
  };
  it('full run every 4 weeks (≈ monthly): the next Sunday 03:00 plus three weeks', () => {
    const fri = new Date('2026-10-09T12:00:00').getTime();
    const next = new Date(nextFull(fri, { ...settings, fullEveryWeeks: 4 }));
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([10, 1, 3]); // 11 Oct + 21 days = 1 Nov
  });
  it('weekly full run: next Sunday 03:00', () => {
    const fri = new Date('2026-10-09T12:00:00').getTime();
    const next = new Date(nextWeekly(fri, 0, 3));
    expect([next.getDay(), next.getHours(), next.getDate()]).toEqual([0, 3, 11]);
    const sunLate = new Date('2026-10-11T04:00:00').getTime();
    expect(new Date(nextWeekly(sunLate, 0, 3)).getDate()).toBe(18);
  });
  it('catch-up after a missed run, due runs fire, wall-clock jump (suspend) schedules a catch-up', () => {
    let t = new Date('2026-10-10T10:00:00').getTime();
    let saved: NextRun[] | null = [
      { mode: 'incremental', at: t - 3600_000 },
      { mode: 'full', at: t + 86400_000 },
    ];
    const due: string[] = [];
    const s = new Scheduler({
      settings: () => settings,
      load: () => saved,
      save: (r) => (saved = r),
      onDue: (m, tr) => due.push(`${m}:${tr}`),
      now: () => t,
      tickMs: 30_000,
    });
    s.start();
    s.stop();
    expect(s.nextRuns()[0]).toEqual({ mode: 'incremental', at: t + 5 * 60_000 }); // catch-up in 5 min
    for (let i = 0; i < 20 && !due.length; i++) {
      t += 30_000; // regular ticks
      s.tick();
    }
    expect(due).toEqual(['incremental:schedule']);
    expect(s.nextRuns().find((r) => r.mode === 'incremental')!.at).toBe(t + 120 * 60_000);
    t += 3 * 3600_000; // suspended for 3 h
    s.tick();
    expect(due).toHaveLength(1);
    expect(s.nextRuns().find((r) => r.mode === 'incremental')!.at).toBe(t + 5 * 60_000);
    expect(saved).toEqual(s.nextRuns().sort((a, b) => (a.mode < b.mode ? 1 : -1)));
  });
});

describe('classify + compat', () => {
  it('maps CLI error texts', () => {
    expect(classifyCliError('Request failed with status 429 Too Many Requests')).toBe('rate_limited');
    expect(classifyCliError('Insufficient storage quota')).toBe('quota');
    expect(classifyCliError('Integrity verification failed for file')).toBe('integrity');
    expect(classifyCliError('Failed to load session in pass: exit code 1')).toBe('auth');
    expect(classifyCliError('ENOSPC: no space left on device')).toBe('local_io');
    expect(classifyCliError('Node not found: /x')).toBe('not_found');
    expect(classifyCliError('socket hang up')).toBe('transient');
  });
  it('version check', () => {
    // output of the real CLI 0.9.0 (recorded 2026-10-11)
    const real = parseVersionOutput(
      'Proton Drive CLI cli-drive@0.9.0+75612299\nProton Drive SDK js@0.22.2+75612299\nYou are running the latest version.\n',
    );
    expect(real).toMatchObject({ cliVersion: '0.9.0+75612299', sdkVersion: '0.22.2+75612299', compatible: true });
    expect(parseVersionOutput('Proton Drive CLI cli-drive@0.10.1+abc').compatible).toBe(false);
    const v = parseVersionOutput('Proton Drive CLI 0.9.0\nProton Drive SDK 0.14.0\nA new version 0.10.0 is available');
    expect(v).toMatchObject({ cliVersion: '0.9.0', sdkVersion: '0.14.0', compatible: true });
    expect(v.updateHint).toMatch(/new version/);
    expect(isCompatible('0.10.1')).toBe(false);
    expect(isCompatible(null)).toBe(false);
  });
});
