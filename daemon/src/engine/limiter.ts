// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Adaptive limiter (ARCHITECTURE §11, docs/SYNC-RULES.md): a global worker semaphore (maxWorkersTotal across all accounts)
 * plus one AccountLimiter per account that tracks an EWMA of metadata-call latency and moves between
 *   normal (configured workers) -> reduced (1 worker) -> cooldown (0 workers for 15 min)
 * when Proton starts to tarpit. HTTP 429 jumps straight to cooldown. Bandwidth pacing sleeps between transfers.
 */
import { EventEmitter } from 'node:events';

export interface LimiterConfig {
  ewmaAlpha: number;
  /** absolute "high" threshold for the EWMA (default 1.2 s) */
  highLatencyMs: number;
  /** relative threshold: EWMA > factor x baseline (default 4x) ... */
  baselineFactor: number;
  /** ... but only above this floor (protects against jitter at tiny baselines) */
  relativeFloorMs: number;
  /** how long "high" must persist before stepping down (default 2 min) */
  sustainMs: number;
  cooldownMs: number;
  rateLimitCooldownMs: number;
}

export const DEFAULT_LIMITER_CONFIG: LimiterConfig = {
  ewmaAlpha: 0.2,
  highLatencyMs: 1200,
  baselineFactor: 4,
  relativeFloorMs: 400,
  sustainMs: 120_000,
  cooldownMs: 15 * 60_000,
  rateLimitCooldownMs: 15 * 60_000,
};

export type LimiterState = 'normal' | 'reduced' | 'cooldown';

/** Counting semaphore with priorities (lower number = earlier). Capacity can change at runtime. */
export class Semaphore {
  private capacity: number;
  private used = 0;
  private waiters: { prio: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get inUse(): number {
    return this.used;
  }

  get size(): number {
    return this.capacity;
  }

  setCapacity(n: number): void {
    this.capacity = Math.max(0, n);
    this.pump();
  }

  acquire(prio = 100): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiters.push({
        prio,
        seq: this.seq++,
        resolve: () => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.used--;
            this.pump();
          });
        },
      });
      this.waiters.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    while (this.used < this.capacity && this.waiters.length) {
      const w = this.waiters.shift()!;
      this.used++;
      w.resolve();
    }
  }
}

export class AccountLimiter extends EventEmitter {
  readonly accountId: string;
  private readonly cfg: LimiterConfig;
  state: LimiterState = 'normal';
  ewma: number | null = null;
  baseline: number | null = null;
  cooldownUntil = 0;
  private highSince: number | null = null;
  private lowSince: number | null = null;
  private samples = 0;
  private readonly now: () => number;

  constructor(accountId: string, cfg: LimiterConfig, now: () => number = Date.now) {
    super();
    this.accountId = accountId;
    this.cfg = cfg;
    this.now = now;
  }

  /** Allowed concurrent workers for this account right now. */
  allowedWorkers(configured: number): number {
    this.tick();
    if (this.state === 'cooldown') return 0;
    if (this.state === 'reduced') return Math.min(1, configured);
    return configured;
  }

  isHigh(): boolean {
    if (this.ewma === null) return false;
    if (this.ewma > this.cfg.highLatencyMs) return true;
    return (
      this.baseline !== null &&
      this.ewma > this.cfg.relativeFloorMs &&
      this.ewma > this.cfg.baselineFactor * this.baseline
    );
  }

  /** Feed one metadata-call latency (list/info/size command duration or CLI `INFO [api] ... (NNNms)` line). */
  recordLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.ewma = this.ewma === null ? ms : this.cfg.ewmaAlpha * ms + (1 - this.cfg.ewmaAlpha) * this.ewma;
    this.samples++;
    // baseline = lowest settled EWMA seen (after a few samples), i.e. "how fast Proton normally answers"
    if (this.samples >= 5 && (this.baseline === null || this.ewma < this.baseline)) this.baseline = this.ewma;
    this.tick();
  }

  recordRateLimited(): void {
    this.enterCooldown(this.cfg.rateLimitCooldownMs, 'HTTP 429');
  }

  private enterCooldown(ms: number, reason: string): void {
    this.state = 'cooldown';
    this.cooldownUntil = this.now() + ms;
    this.highSince = null;
    this.lowSince = null;
    this.emit('change', this.state, reason);
  }

  /** Evaluate time-based transitions. Called on every sample and by the pool/engine periodically. */
  tick(): void {
    const t = this.now();
    if (this.state === 'cooldown') {
      if (t < this.cooldownUntil) return;
      // after the pause start carefully with one worker and forget the stale EWMA
      this.state = 'reduced';
      this.ewma = null;
      this.highSince = null;
      this.lowSince = t;
      this.emit('change', this.state, 'cooldown over');
      return;
    }
    const high = this.isHigh();
    if (high) {
      this.lowSince = null;
      this.highSince ??= t;
      if (t - this.highSince >= this.cfg.sustainMs) {
        if (this.state === 'normal') {
          this.state = 'reduced';
          this.highSince = t;
          this.emit('change', this.state, 'latency high');
        } else {
          this.enterCooldown(this.cfg.cooldownMs, 'latency still high');
        }
      }
    } else {
      this.highSince = null;
      if (this.state === 'reduced' && this.ewma !== null) {
        this.lowSince ??= t;
        if (t - this.lowSince >= this.cfg.sustainMs) {
          this.state = 'normal';
          this.lowSince = null;
          this.emit('change', this.state, 'latency normal');
        }
      }
    }
  }
}

/** Parses the CLI's own request log lines: `... INFO [api] GET /drive/... 200 (123ms)` -> 123. */
export function parseApiLogLatency(line: string): number | null {
  const m = /INFO \[api\].*\((\d+)\s*ms\)\s*$/.exec(line);
  return m ? Number(m[1]) : null;
}

export interface BandwidthWindow {
  from: string; // "22:00"
  to: string; // "07:00"
  bandwidthLimitKBps: number | null;
}

/** Effective bandwidth limit in bytes/s at `date` (quiet hours override the base limit). null = unlimited. */
export function effectiveBandwidthBps(
  baseKBps: number | null,
  quiet: BandwidthWindow | null,
  date = new Date(),
): number | null {
  let kbps = baseKBps;
  if (quiet && inWindow(quiet.from, quiet.to, date)) kbps = quiet.bandwidthLimitKBps;
  return kbps && kbps > 0 ? kbps * 1024 : null;
}

export function inWindow(from: string, to: string, date: Date): boolean {
  const mins = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = date.getHours() * 60 + date.getMinutes();
  const a = mins(from);
  const b = mins(to);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** Average-rate pacing: after B bytes in t ms, wait max(0, B/limit - t). */
export function pacingDelayMs(bytes: number, durationMs: number, limitBps: number | null): number {
  if (!limitBps) return 0;
  return Math.max(0, (bytes / limitBps) * 1000 - durationMs);
}
