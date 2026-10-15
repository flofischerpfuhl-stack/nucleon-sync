// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Scheduler (ARCHITECTURE §11): incremental every N minutes, a full run every N weeks (weekday + hour), catch-up after boot and
 * after suspend (wall-clock jump > 2 min), persisted nextRuns (settings key 'nextRuns').
 */
import type { RunMode, RunTrigger, ScheduleSettings } from '@nucleon-sync/shared';

export interface NextRun {
  mode: RunMode;
  at: number;
}

export interface SchedulerOptions {
  settings: () => ScheduleSettings;
  load: () => NextRun[] | null;
  save: (runs: NextRun[]) => void;
  onDue: (mode: RunMode, trigger: RunTrigger) => void;
  now?: () => number;
  tickMs?: number;
  jumpThresholdMs?: number;
}

export function nextWeekly(from: number, weekday: number, hour: number): number {
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(hour);
  let add = (weekday - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= from) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

/** Next full run: the next `weekday`/`hour`, plus `fullEveryWeeks - 1` weeks (1 = weekly, 4 ≈ monthly). */
export function nextFull(from: number, s: ScheduleSettings): number {
  const weeks = Math.max(1, Math.min(8, Math.round(s.fullEveryWeeks ?? 1)));
  const d = new Date(nextWeekly(from, s.fullWeekly.weekday, s.fullWeekly.hour));
  d.setDate(d.getDate() + (weeks - 1) * 7);
  return d.getTime();
}

export class Scheduler {
  private readonly o: SchedulerOptions;
  private runs: NextRun[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private readonly now: () => number;

  constructor(o: SchedulerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    const t = this.now();
    const s = this.o.settings();
    const saved = this.o.load();
    const missed = !!saved && saved.some((r) => r.at < t - 60_000);
    this.runs = this.compute(t, s, saved);
    if (missed) this.catchUp('startup');
    this.o.save(this.runs);
    this.lastTick = t;
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Settings changed: recompute (keep a pending catch-up). */
  reschedule(): void {
    const t = this.now();
    const catchUp = this.runs.find(
      (r) => r.mode === 'incremental' && r.at < t + this.o.settings().runOnStartupDelayMinutes * 60_000 + 1000,
    );
    this.runs = this.compute(t, this.o.settings(), null);
    if (catchUp)
      this.runs = this.runs.map((r) => (r.mode === 'incremental' ? { ...r, at: Math.min(r.at, catchUp.at) } : r));
    this.o.save(this.runs);
  }

  nextRuns(): NextRun[] {
    return [...this.runs].sort((a, b) => a.at - b.at);
  }

  /** A run of `mode` happened (any trigger): the next incremental counts from now. */
  ranNow(mode: RunMode): void {
    const t = this.now();
    const s = this.o.settings();
    this.runs = this.runs.map((r) => {
      if (r.mode === 'incremental') return { ...r, at: t + s.incrementalEveryMinutes * 60_000 };
      if (r.mode === 'full' && mode === 'full') return { ...r, at: nextFull(t, s) };
      return r;
    });
    this.o.save(this.runs);
  }

  tick(): void {
    const t = this.now();
    const jumped = this.lastTick && t - this.lastTick > (this.o.tickMs ?? 30_000) + (this.o.jumpThresholdMs ?? 120_000);
    this.lastTick = t;
    if (jumped) {
      // resumed from suspend: catch up instead of firing everything at once
      this.catchUp('resume');
      this.o.save(this.runs);
      return;
    }
    const due = this.runs.filter((r) => r.at <= t);
    if (!due.length) return;
    const full = due.some((r) => r.mode === 'full');
    const s = this.o.settings();
    this.runs = this.runs.map((r) =>
      r.at > t
        ? r
        : r.mode === 'full'
          ? { mode: 'full', at: nextFull(t, s) }
          : { mode: r.mode, at: t + s.incrementalEveryMinutes * 60_000 },
    );
    if (full)
      this.runs = this.runs.map((r) =>
        r.mode === 'incremental' ? { ...r, at: t + s.incrementalEveryMinutes * 60_000 } : r,
      );
    this.o.save(this.runs);
    this.o.onDue(full ? 'full' : 'incremental', 'schedule');
  }

  private catchUp(_trigger: RunTrigger): void {
    const t = this.now();
    const s = this.o.settings();
    const at = t + s.runOnStartupDelayMinutes * 60_000;
    // overdue runs are not fired at once after boot/resume: one catch-up run after the configured delay
    this.runs = this.runs.map((r) => (r.mode === 'incremental' ? { ...r, at: r.at < t ? at : Math.min(r.at, at) } : r));
    const full = this.runs.find((r) => r.mode === 'full');
    if (full && full.at < t) full.at = nextFull(t, s);
  }

  private compute(t: number, s: ScheduleSettings, saved: NextRun[] | null): NextRun[] {
    const inc = saved?.find((r) => r.mode === 'incremental')?.at;
    const full = saved?.find((r) => r.mode === 'full')?.at;
    return [
      {
        mode: 'incremental',
        at:
          inc && inc > t
            ? Math.min(inc, t + s.incrementalEveryMinutes * 60_000)
            : t + s.incrementalEveryMinutes * 60_000,
      },
      { mode: 'full', at: full && full > t ? full : nextFull(t, s) },
    ];
  }
}
