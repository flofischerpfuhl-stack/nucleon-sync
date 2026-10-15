// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Notifier: consumes engine `notice` events and forwards them to the user's own notify command. Desktop
 * notifications are the dashboard's job; the daemon has one optional channel:
 *
 *  - notify command (daemon.json `notifyCommand`, argv without a shell) — for anything beyond the desktop (a chat bot,
 *    ntfy, mail, another agent). The event is passed in NUCLEON_SYNC_* environment variables (see DaemonFileConfig);
 *    the README has example scripts.
 *
 * Rules:
 *  - warn/error notices: sent right away, de-duplicated per notice key within `minIntervalMinutes`
 *  - pending decisions (new conflicts, pending deletions, adoption proposals): only in one daily digest
 *  - info notices: never
 *  - every attempt is logged in `notifications` (channel 'command')
 */
import { spawn } from 'node:child_process';

import type { DaemonEvent, Notice, NotificationLogItem, NotificationTestResult } from '@nucleon-sync/shared';

import { readSettings } from '../engine/settings.ts';
import { log } from '../util/log.ts';
import type { ServiceContext } from '../accounts/context.ts';

/** Notice keys that only go into the daily digest. */
export function isDigestKey(key: string): boolean {
  return key === 'conflicts:new' || key === 'deletions:pending' || key.startsWith('adoption:');
}

export type Channel = 'command';

/** What a channel gets: the full text plus the structured parts (for the command's environment). */
export interface Delivery {
  event: 'notice' | 'digest' | 'test';
  key: string;
  severity: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  text: string;
  accountId?: string;
  accountName?: string;
}

export type SendFn = (channel: Channel, d: Delivery) => Promise<{ ok: boolean; detail: string }>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export class Notifier {
  private readonly c: ServiceContext;
  private readonly inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly listener = (e: DaemonEvent) => {
    if (e.type === 'notice') void this.handle(e.notice);
  };
  /** for tests: replaces the transports */
  sendOverride: SendFn | null = null;

  constructor(c: ServiceContext) {
    this.c = c;
  }

  start(): void {
    this.c.engine.on('event', this.listener);
    const tick = () => {
      this.timer = setTimeout(tick, 3600_000);
      this.timer.unref();
      void this.dailyDigest();
    };
    this.timer = setTimeout(tick, 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    this.c.engine.off('event', this.listener);
    if (this.timer) clearTimeout(this.timer);
  }

  private settings() {
    return readSettings(this.c.db).notifications;
  }

  /** channels that are switched on (today only the notify command from daemon.json) */
  channels(): Channel[] {
    return this.c.config.notifyCommand?.length ? ['command'] : [];
  }

  private lastSent(key: string, okOnly: boolean): number | null {
    const r = this.c.db
      .prepare(
        `SELECT MAX(ts) AS ts FROM notifications WHERE channel = 'command' AND dedupe_key = ?${okOnly ? ' AND ok = 1' : ''}`,
      )
      .get(key) as { ts: number | null };
    return r.ts;
  }

  /** Returns what happened (for tests/logs): 'disabled' | 'digest' | 'skipped' | 'duplicate' | 'sent' | 'failed'. */
  async handle(n: Notice): Promise<string> {
    const channels = this.channels();
    if (!channels.length) return 'disabled';
    if (isDigestKey(n.key)) return 'digest';
    if (n.severity === 'info') return 'skipped'; // never for routine events
    const s = this.settings();
    const now = Date.now();
    const last = this.lastSent(n.key, true);
    if (last !== null && now - last < s.minIntervalMinutes * 60_000) return 'duplicate';
    const lastTry = this.lastSent(n.key, false);
    if (lastTry !== null && now - lastTry < 5 * 60_000 && lastTry !== last) return 'duplicate'; // failed recently
    if (this.inflight.has(n.key)) return 'duplicate';
    this.inflight.add(n.key);
    try {
      const acc = n.accountId ? this.c.engine.accounts().find((a) => a.id === n.accountId)?.displayName : undefined;
      const icon = n.severity === 'error' ? '❗' : '⚠️';
      const text = `${icon} Nucleon Sync: ${n.title}${acc ? ` (${acc})` : ''}\n${n.body}`.trim();
      const d: Delivery = {
        event: 'notice',
        key: n.key,
        severity: n.severity,
        title: n.title,
        body: n.body,
        text,
        accountId: n.accountId,
        accountName: acc,
      };
      return (await this.deliverAll(channels, d)) ? 'sent' : 'failed';
    } finally {
      this.inflight.delete(n.key);
    }
  }

  /** Daily digest of pending decisions (conflicts, deletions, adoption proposals), once per day after dailyHour. */
  async dailyDigest(now = new Date()): Promise<string> {
    const channels = this.channels();
    if (!channels.length) return 'disabled';
    if (now.getHours() < (this.c.config.dailyHour ?? 9)) return 'skipped';
    const last = this.lastSent('digest:daily', true);
    if (last !== null && now.getTime() - last < 20 * 3600_000) return 'duplicate';
    const st = this.c.engine.status();
    const adoptions = (
      this.c.db.prepare("SELECT COUNT(*) AS n FROM adoption_proposals WHERE state = 'pending'").get() as { n: number }
    ).n;
    if (!st.openConflicts && !st.pendingDeletions && !adoptions) return 'skipped';
    const parts = [
      st.openConflicts ? plural(st.openConflicts, 'conflict', 'conflicts') : null,
      st.pendingDeletions ? plural(st.pendingDeletions, 'pending deletion', 'pending deletions') : null,
      adoptions ? `${plural(adoptions, 'file', 'files')} found in Proton` : null,
    ].filter(Boolean);
    const title = 'Pending decisions';
    const body = `${parts.join(', ')}. Please review them in the dashboard (Conflicts & deletions).`;
    const d: Delivery = {
      event: 'digest',
      key: 'digest:daily',
      severity: 'info',
      title,
      body,
      text: `📋 Nucleon Sync – ${title.toLowerCase()}: ${body}`,
    };
    return (await this.deliverAll(channels, d)) ? 'sent' : 'failed';
  }

  /** "Send a test notification" from the settings. */
  async test(channel?: Channel): Promise<NotificationTestResult[]> {
    const chans: Channel[] = channel ? [channel] : this.channels();
    const d: Delivery = {
      event: 'test',
      key: 'test',
      severity: 'info',
      title: 'Test notification',
      body: 'Notifications from Nucleon Sync arrive here.',
      text: '✅ Nucleon Sync: test notification – notifications arrive here.',
    };
    const out: NotificationTestResult[] = [];
    for (const ch of chans) {
      const res = await this.deliver(ch, d);
      out.push({ channel: ch, ...res });
    }
    return out;
  }

  private async deliverAll(channels: Channel[], d: Delivery): Promise<boolean> {
    let any = false;
    for (const ch of channels) if ((await this.deliver(ch, d)).ok) any = true;
    return any;
  }

  private async deliver(channel: Channel, d: Delivery): Promise<{ ok: boolean; detail: string }> {
    let res: { ok: boolean; detail: string };
    try {
      res = this.sendOverride ? await this.sendOverride(channel, d) : await this.runCommand(d);
    } catch (e) {
      res = { ok: false, detail: (e as Error).message.slice(0, 300) };
    }
    this.c.db
      .prepare('INSERT INTO notifications (ts, channel, dedupe_key, message, ok, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), channel, d.key, d.text, res.ok ? 1 : 0, res.detail);
    log(res.ok ? 'info' : 'warn', 'notification', { channel, key: d.key, ok: res.ok, detail: res.detail });
    return res;
  }

  private runCommand(d: Delivery): Promise<{ ok: boolean; detail: string }> {
    const argv = this.c.config.notifyCommand ?? [];
    if (!argv.length || !argv[0]) return Promise.resolve({ ok: false, detail: 'no notifyCommand configured' });
    return new Promise((resolve) => {
      let stderr = '';
      let settled = false;
      const done = (r: { ok: boolean; detail: string }) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...this.c.env,
          NUCLEON_SYNC_EVENT: d.event,
          NUCLEON_SYNC_SEVERITY: d.severity,
          NUCLEON_SYNC_KEY: d.key,
          NUCLEON_SYNC_TITLE: d.title,
          NUCLEON_SYNC_BODY: d.body,
          NUCLEON_SYNC_TEXT: d.text,
          NUCLEON_SYNC_ACCOUNT_ID: d.accountId ?? '',
          NUCLEON_SYNC_ACCOUNT_NAME: d.accountName ?? '',
        },
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ ok: false, detail: 'notifyCommand timed out after 30 s' });
      }, 30_000);
      timer.unref();
      child.stderr.on('data', (b: Buffer) => {
        if (stderr.length < 300) stderr += b.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, detail: `notifyCommand: ${e.message}`.slice(0, 300) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(
          code === 0
            ? { ok: true, detail: 'command exited 0' }
            : { ok: false, detail: `command exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`.slice(0, 300) },
        );
      });
    });
  }

  log(limit: number): NotificationLogItem[] {
    return (
      this.c.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(Math.min(limit, 500)) as {
        id: number;
        ts: number;
        channel: string;
        dedupe_key: string;
        message: string;
        ok: number | null;
        detail: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      ts: new Date(r.ts).toISOString(),
      channel: (r.channel === 'desktop' ? 'desktop' : 'command') as NotificationLogItem['channel'],
      key: r.dedupe_key,
      message: r.message,
      ok: r.ok === null ? null : !!r.ok,
      detail: r.detail,
    }));
  }
}
