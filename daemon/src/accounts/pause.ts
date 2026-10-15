// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Daemon-side timed pauses (`POST /v1/pause` with `until`): persisted in `pause_timers`, resumed by the daemon even when
 * no UI runs. A plain pause (no `until`) or a resume of the same scope clears the timer.
 */
import { msg, type PauseRequest } from '@nucleon-sync/shared';

import { badRequest, notFound } from '../util/http.ts';
import type { ServiceContext } from './context.ts';

export class PauseTimers {
  private readonly c: ServiceContext;
  private timer: NodeJS.Timeout | null = null;

  constructor(c: ServiceContext) {
    this.c = c;
  }

  static target(req: PauseRequest): string {
    return req.scope === 'all' ? '' : String(req.id ?? '');
  }

  /** Validates scope/id/until (400/404). */
  validate(req: unknown): PauseRequest {
    const r = (req ?? { scope: 'all' }) as PauseRequest;
    if (typeof r !== 'object') throw badRequest('body must be a PauseRequest');
    const scope = r.scope ?? 'all';
    if (!['all', 'account', 'pair'].includes(scope)) throw badRequest('scope must be all|account|pair');
    if (scope === 'account') {
      if (!this.c.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(String(r.id ?? '')))
        throw notFound(`unknown account ${String(r.id)}`);
    } else if (scope === 'pair') {
      if (!this.c.db.prepare('SELECT 1 FROM pairs WHERE id = ?').get(Number(r.id)))
        throw notFound(`unknown pair ${String(r.id)}`);
    }
    if (r.until !== undefined) {
      const t = Date.parse(String(r.until));
      if (!Number.isFinite(t)) throw badRequest('until must be an ISO timestamp');
      if (t <= Date.now()) throw badRequest('until must be in the future');
      if (t > Date.now() + 31 * 86400_000) throw badRequest('until must be within 31 days');
    }
    return { ...r, scope, ...(scope === 'pair' ? { id: Number(r.id) } : {}) };
  }

  set(req: PauseRequest): void {
    const target = PauseTimers.target(req);
    if (req.until) {
      this.c.db
        .prepare(
          `INSERT INTO pause_timers (scope, target, until, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, target) DO UPDATE SET until = excluded.until, created_at = excluded.created_at`,
        )
        .run(req.scope, target, Date.parse(req.until), Date.now());
    } else this.clear(req);
    this.schedule();
  }

  clear(req: PauseRequest): void {
    this.c.db
      .prepare('DELETE FROM pause_timers WHERE scope = ? AND target = ?')
      .run(req.scope, PauseTimers.target(req));
    this.schedule();
  }

  /** End of the global timed pause (status.pausedUntil). */
  globalUntil(): string | null {
    const r = this.c.db.prepare("SELECT until FROM pause_timers WHERE scope = 'all'").get() as
      { until: number } | undefined;
    return r ? new Date(r.until).toISOString() : null;
  }

  start(): void {
    this.fire();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.c.db.prepare('SELECT MIN(until) AS t FROM pause_timers').get() as { t: number | null };
    if (next.t === null) return;
    // re-check at least every minute (wall clock jumps after suspend)
    this.timer = setTimeout(() => this.fire(), Math.max(0, Math.min(next.t - Date.now(), 60_000)));
    this.timer.unref();
  }

  private fire(): void {
    const due = this.c.db.prepare('SELECT scope, target FROM pause_timers WHERE until <= ?').all(Date.now()) as {
      scope: PauseRequest['scope'];
      target: string;
    }[];
    for (const d of due) {
      const req: PauseRequest = {
        scope: d.scope,
        ...(d.scope === 'all' ? {} : { id: d.scope === 'pair' ? Number(d.target) : d.target }),
      };
      this.c.db.prepare('DELETE FROM pause_timers WHERE scope = ? AND target = ?').run(d.scope, d.target);
      this.c.engine.resume(req);
      const accountId =
        d.scope === 'account'
          ? d.target
          : d.scope === 'pair'
            ? ((
                this.c.db.prepare('SELECT account_id FROM pairs WHERE id = ?').get(Number(d.target)) as
                  { account_id: string } | undefined
              )?.account_id ?? '-')
            : (this.c.engine.accounts()[0]?.id ?? '-');
      this.c.engine.addActivity({
        accountId,
        pairId: d.scope === 'pair' ? Number(d.target) : null,
        action: 'info',
        message: msg('activity.pauseExpired'),
      });
    }
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
