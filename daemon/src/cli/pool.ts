// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CliPool — N CLI workers (REPL processes) for ONE account (ARCHITECTURE §4.1, §5.2, §5.3).
 *
 *  - size from accounts.workers, capped by the AccountLimiter (normal/reduced/cooldown) and the global semaphore
 *  - warm-up: only w0 is used until its first command succeeded (a due token refresh happens once, not N times)
 *  - restart on 'auth' (stale in-memory session after a lost refresh race; retried once), on timeouts and crashes
 *    (backoff 1 s, 5 s, 30 s, 2 min)
 *  - recycle after 2,000 commands or 6 h
 *  - markStale(): shim reported `rm suppressed` -> every worker of the account restarts before its next command
 *  - gate (pause, foreign proton-drive process on the same session): while it reports a reason no command is started,
 *    idle workers are stopped at once and busy ones when their command returns (enforceGate(true) kills them too) —
 *    a paused account never keeps a proton-drive process
 *  - idle workers are stopped after `idleMs` (default 10 min); a timed-out worker (cli_timeout) is dropped at once
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Msg } from '@nucleon-sync/shared';
import type { CliResult } from './replWorker.ts';
import { CliError, isCliTimeout } from './replWorker.ts';

/**
 * Set by the executor while a job runs. A *soft* gate (pause "finish the current file") lets commands of jobs that
 * already started through (post-upload listing, rename after a temp-name upload); a hard gate (foreign process,
 * immediate pause) blocks them too.
 */
export const cliJobScope = new AsyncLocalStorage<{ jobId: number }>();

/**
 * Priority of CLI commands issued in this async context: priority-lane jobs and pair-scoped
 * interactive runs set a small number, so their commands get the account's worker slots and the global budget
 * before the commands of a long background run. Lower = earlier; the smaller of this and the caller's value wins.
 */
export const cliPriorityScope = new AsyncLocalStorage<number | undefined>();

/**
 * Global cap on live proton-drive processes over all accounts. Pools ask before they start a
 * process; when the cap is reached, the least recently used process that is not running a command (idle, or waiting
 * for the global command semaphore) is stopped first. The command semaphore (`global`) bounds the processes that
 * run commands, so a reservation never waits forever.
 */
export class ProcessBudget {
  private readonly pools = new Set<CliPool>();
  /** reservations whose process is being started (counted until the worker reports alive) */
  private readonly pending = new Set<{ w: PoolWorker | null }>();
  private readonly cap: () => number;
  private readonly pollMs: number;
  /** highest number of live + starting processes seen (tests, diagnostics) */
  peak = 0;

  constructor(cap: () => number, pollMs = 100) {
    this.cap = cap;
    this.pollMs = pollMs;
  }

  register(p: CliPool): void {
    this.pools.add(p);
  }

  unregister(p: CliPool): void {
    this.pools.delete(p);
  }

  alive(): number {
    let n = 0;
    for (const p of this.pools) n += p.liveCount();
    return n;
  }

  /** live processes + reservations whose process is not alive yet */
  used(): number {
    let n = this.alive();
    for (const r of this.pending) if (!r.w?.alive) n++;
    return n;
  }

  /**
   * Waits until one more process fits under the cap (stopping the least recently used idle process of any account
   * if needed). `attach` the new worker as soon as it exists, `release` once it started (or failed).
   */
  async reserve(closed: () => boolean): Promise<{ attach: (w: PoolWorker) => void; release: () => void }> {
    for (;;) {
      if (closed()) throw new CliError('pool closed', 'transient');
      const cap = Math.max(1, this.cap());
      if (this.used() < cap) {
        const r: { w: PoolWorker | null } = { w: null };
        this.pending.add(r);
        this.peak = Math.max(this.peak, this.used());
        return {
          attach: (w) => {
            r.w = w;
          },
          release: () => {
            this.pending.delete(r);
            this.peak = Math.max(this.peak, this.used());
          },
        };
      }
      // least recently used evictable process of any account
      let best: { pool: CliPool; lastUsed: number } | null = null;
      for (const p of this.pools) {
        const t = p.evictableSince();
        if (t !== null && (!best || t < best.lastUsed)) best = { pool: p, lastUsed: t };
      }
      if (best) await best.pool.evictOne();
      else await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}

export interface GateState {
  /** English text */
  reason: string;
  /** the reason as a message (key + params for the dashboard) */
  msg?: Msg;
  /** soft: running jobs may finish (their commands pass), nothing new starts */
  soft: boolean;
}

/** The account may not run CLI commands right now (paused, foreign CLI process); never counts as a job attempt. */
export class CliGatedError extends CliError {
  readonly gated = true;
  readonly reason: string;
  readonly msg: Msg | null;
  constructor(accountId: string, gate: GateState | string) {
    const g: { reason: string; msg?: Msg } = typeof gate === 'string' ? { reason: gate } : gate;
    super(`${accountId}: ${g.reason}`, 'transient');
    this.reason = g.reason;
    this.msg = g.msg ?? null;
  }
}
import type { AccountLimiter, Semaphore } from '../engine/limiter.ts';

export interface PoolWorker {
  readonly name: string;
  readonly alive: boolean;
  /** pid of the CLI process while running (progress monitoring), null otherwise */
  readonly pid?: number | null;
  commandsRun: number;
  startedAt: number;
  start(): Promise<void>;
  run(args: string[], timeoutMs?: number): Promise<CliResult>;
  json<T>(args: string[], timeoutMs?: number): Promise<T>;
  kill(): void;
  stop(): Promise<void>;
  on(ev: 'command', fn: (e: { durationMs: number; ok: boolean; args?: string[] }) => void): unknown;
  on(ev: 'exit', fn: (e: unknown) => void): unknown;
}

export interface CliPoolOptions {
  accountId: string;
  size: number;
  makeWorker: (index: number) => PoolWorker;
  limiter: AccountLimiter;
  global: Semaphore;
  recycleCommands?: number;
  recycleMs?: number;
  restartBackoffMs?: number[];
  /** reports metadata latency samples (list/info/size) — defaults to limiter.recordLatency */
  onLatency?: (ms: number) => void;
  /** why this account must not run CLI commands now (pause = soft, foreign process = hard), else null */
  gate?: () => GateState | null;
  /** stop workers idle for longer than this (default 10 min) */
  idleMs?: number;
  /** global cap on live CLI processes over all pools */
  budget?: ProcessBudget;
}

const META = new Set(['list', 'info', 'size']);

interface Slot {
  index: number;
  worker: PoolWorker | null;
  busy: boolean;
  /** busy, but still waiting for the global command semaphore (its process may be stopped by the budget) */
  waitingGlobal: boolean;
  stale: boolean;
  failures: number;
  notBefore: number;
  lastUsed: number;
}

interface Waiter {
  prio: number;
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

export class CliPool {
  readonly accountId: string;
  private readonly o: CliPoolOptions;
  private size: number;
  private slots: Slot[] = [];
  private waiters: Waiter[] = [];
  private seq = 0;
  private warmed = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;

  private reaper: NodeJS.Timeout | null = null;
  private readonly stopping = new Set<PoolWorker>();

  constructor(o: CliPoolOptions) {
    this.o = o;
    this.accountId = o.accountId;
    this.size = Math.max(1, o.size);
    this.o.limiter.on('change', () => this.pump());
    this.o.budget?.register(this);
    const idle = this.o.idleMs ?? 10 * 60_000;
    this.reaper = setInterval(() => this.reapIdle(), Math.max(50, Math.min(30_000, idle / 2)));
    this.reaper.unref();
  }

  /** Number of live CLI processes of this account (tests, diagnostics). */
  aliveCount(): number {
    return this.slots.filter((s) => s.worker?.alive).length;
  }

  /** live processes including ones that are being stopped (global process budget) */
  liveCount(): number {
    return this.aliveCount() + this.stopping.size;
  }

  /** stops a worker that was already detached from its slot; it counts as live until it is gone */
  private async stopWorker(w: PoolWorker): Promise<void> {
    this.stopping.add(w);
    try {
      await stopQuick(w);
    } finally {
      this.stopping.delete(w);
    }
  }

  /** pids of the live CLI processes */
  pids(): number[] {
    return this.slots.map((s) => s.worker?.pid ?? null).filter((p): p is number => typeof p === 'number');
  }

  private gateReason(): string | null {
    return this.o.gate?.()?.reason ?? null;
  }

  /** gate that applies to a command issued right now (soft gates let running jobs finish) */
  private blockedNow(): GateState | null {
    const g = this.o.gate?.();
    if (!g) return null;
    if (g.soft && cliJobScope.getStore()) return null;
    return g;
  }

  /**
   * The gate closed (pause, foreign process): stop idle workers now; with `hard` also kill workers in the middle of
   * a command (their jobs go back to the queue). Busy workers are otherwise stopped when their command returns.
   */
  enforceGate(hard = false): void {
    if (!this.gateReason()) return;
    for (const s of this.slots) {
      if (!s.worker) continue;
      if (!s.busy) void this.retire(s);
      else if (hard) s.worker.kill();
    }
    // nobody outside a running job may wait for a slot while gated
    if (hard)
      for (const w of this.waiters.splice(0)) w.reject(new CliGatedError(this.accountId, this.o.gate?.() ?? 'gated'));
  }

  private reapIdle(): void {
    if (this.closed) return;
    const gated = !!this.gateReason();
    const idle = this.o.idleMs ?? 10 * 60_000;
    const now = Date.now();
    for (const s of this.slots) {
      if (!s.worker || s.busy) continue;
      if (gated || now - s.lastUsed >= idle) void this.retire(s);
    }
  }

  /** Workers that may run concurrently right now (limiter state + warm-up). */
  effectiveSize(): number {
    const allowed = this.o.limiter.allowedWorkers(this.size);
    return this.warmed ? allowed : Math.min(1, allowed);
  }

  get busyCount(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  get configuredSize(): number {
    return this.size;
  }

  setSize(n: number): void {
    this.size = Math.max(1, n);
    for (const s of this.slots.slice(this.size)) if (!s.busy) void this.retire(s);
    this.pump();
  }

  /** Shim saw `rm suppressed` for this account: in-memory sessions of all workers may be stale. */
  markStale(): void {
    for (const s of this.slots) s.stale = true;
  }

  /** Abort everything that is running right now (pause "immediately"). */
  killAll(): void {
    for (const s of this.slots) s.worker?.kill();
  }

  /** lastUsed of the least recently used process that may be stopped for the global budget, else null */
  evictableSince(): number | null {
    let t: number | null = null;
    for (const s of this.slots)
      if (s.worker?.alive && (!s.busy || s.waitingGlobal) && (t === null || s.lastUsed < t)) t = s.lastUsed;
    return t;
  }

  /** stop the least recently used evictable process (global process budget) */
  async evictOne(): Promise<void> {
    let best: Slot | null = null;
    for (const s of this.slots)
      if (s.worker?.alive && (!s.busy || s.waitingGlobal) && (!best || s.lastUsed < best.lastUsed)) best = s;
    if (!best?.worker) return;
    const w = best.worker;
    best.worker = null;
    await this.stopWorker(w);
  }

  async withWorker<T>(fn: (w: PoolWorker) => Promise<T>, opts: { priority?: number } = {}): Promise<T> {
    const g0 = this.blockedNow();
    if (g0) throw new CliGatedError(this.accountId, g0);
    const prio = Math.min(opts.priority ?? 100, cliPriorityScope.getStore() ?? Infinity);
    const slot = await this.acquireSlot(prio);
    let releaseGlobal: (() => void) | null = null;
    try {
      slot.waitingGlobal = true;
      releaseGlobal = await this.o.global.acquire(prio);
      slot.waitingGlobal = false;
      if (this.closed) throw new CliError(`${this.accountId}: pool closed`, 'transient');
      const g1 = this.blockedNow();
      if (g1) throw new CliGatedError(this.accountId, g1);
      let w = await this.ready(slot);
      try {
        const r = await fn(w);
        this.onSuccess(slot);
        return r;
      } catch (e) {
        if (!(e instanceof CliError) || e instanceof CliGatedError) throw e;
        if (e.errorClass === 'rate_limited') this.o.limiter.recordRateLimited();
        if (e.errorClass === 'auth' && !this.gateReason()) {
          // lost refresh race or stale session -> restart this worker (reloads the stored session) and retry once
          await this.restart(slot);
          w = await this.ready(slot);
          const r = await fn(w);
          this.onSuccess(slot);
          return r;
        }
        // a timed-out worker was killed: drop it now (it may still be exiting) and back off before the next start
        if (isCliTimeout(e) || !slot.worker?.alive) this.onCrash(slot);
        throw e;
      }
    } finally {
      releaseGlobal?.();
      slot.waitingGlobal = false;
      slot.busy = false;
      slot.lastUsed = Date.now();
      if (slot.index >= this.size || this.gateReason()) void this.retire(slot);
      this.pump();
    }
  }

  private onSuccess(slot: Slot): void {
    slot.failures = 0;
    slot.notBefore = 0;
    if (!this.warmed) {
      this.warmed = true;
      this.pump();
    }
  }

  private onCrash(slot: Slot): void {
    const steps = this.o.restartBackoffMs ?? [1000, 5000, 30_000, 120_000];
    slot.notBefore = Date.now() + steps[Math.min(slot.failures, steps.length - 1)]!;
    slot.failures++;
    slot.worker = null;
  }

  private acquireSlot(prio: number): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        prio,
        seq: this.seq++,
        resolve: () => {
          const s = this.freeSlot();
          if (!s) return; // pump guarantees one
          s.busy = true;
          resolve(s);
        },
        reject,
      };
      this.waiters.push(waiter);
      this.waiters.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      this.pump();
    });
  }

  private freeSlot(): Slot | null {
    const eff = this.effectiveSize();
    for (let i = 0; i < Math.min(eff, this.size); i++) {
      let s = this.slots[i];
      if (!s) {
        s = {
          index: i,
          worker: null,
          busy: false,
          waitingGlobal: false,
          stale: false,
          failures: 0,
          notBefore: 0,
          lastUsed: Date.now(),
        };
        this.slots[i] = s;
      }
      if (!s.busy) return s;
    }
    return null;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.waiters.length && this.busyCount < this.effectiveSize() && this.freeSlot()) {
      this.waiters.shift()!.resolve();
    }
    // cooldown/backoff: re-check periodically while somebody waits
    if (this.waiters.length && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, 1000);
      this.timer.unref();
    }
  }

  private async ready(slot: Slot): Promise<PoolWorker> {
    const wait = slot.notBefore - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const g = this.blockedNow();
    if (g) throw new CliGatedError(this.accountId, g); // never start a process for a gated account
    const w = slot.worker;
    const recycle =
      w &&
      (w.commandsRun >= (this.o.recycleCommands ?? 2000) ||
        (w.startedAt > 0 && Date.now() - w.startedAt >= (this.o.recycleMs ?? 6 * 3600_000)));
    if (w && (slot.stale || recycle || !w.alive)) await this.restart(slot);
    // a new process must fit under the global process cap (idle processes of any account are stopped first)
    const rsv = !slot.worker && this.o.budget ? await this.o.budget.reserve(() => this.closed) : null;
    try {
      if (!slot.worker) {
        slot.worker = this.create(slot.index);
        rsv?.attach(slot.worker);
      }
      slot.stale = false;
      try {
        await slot.worker.start();
      } catch (e) {
        this.onCrash(slot);
        throw e;
      }
    } finally {
      rsv?.release();
    }
    return slot.worker;
  }

  private create(index: number): PoolWorker {
    const w = this.o.makeWorker(index);
    const onLatency = this.o.onLatency ?? ((ms: number) => this.o.limiter.recordLatency(ms));
    w.on('command', (e) => {
      if (e.ok && e.args && META.has(e.args[1] ?? '')) onLatency(e.durationMs);
    });
    return w;
  }

  private async restart(slot: Slot): Promise<void> {
    const w = slot.worker;
    slot.worker = null;
    if (w) await this.stopWorker(w);
  }

  private async retire(slot: Slot): Promise<void> {
    if (slot.busy) return;
    const w = slot.worker;
    slot.worker = null;
    if (w) await this.stopWorker(w);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.o.budget?.unregister(this);
    if (this.timer) clearTimeout(this.timer);
    if (this.reaper) clearInterval(this.reaper);
    for (const w of this.waiters.splice(0)) w.reject(new CliError(`${this.accountId}: pool closed`, 'transient'));
    await Promise.allSettled(this.slots.map((s) => (s.worker ? stopQuick(s.worker) : Promise.resolve())));
  }
}

async function stopQuick(w: PoolWorker): Promise<void> {
  if (!w.alive) return;
  await Promise.race([w.stop(), new Promise((r) => setTimeout(r, 3000))]);
  if (w.alive) w.kill();
}
