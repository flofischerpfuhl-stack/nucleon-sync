// SPDX-License-Identifier: GPL-3.0-or-later
/** Global status line (header, flyout, overview hero). Pure; unit-tested. */
import type { AccountDto, PairDto, StatusDto } from '@nucleon-sync/shared';

import type { ConnectionState } from '../../common/ipc.ts';
import { deriveTrayState, type TrayState } from '../../common/trayState.ts';
import { fmtAgo, fmtWhen } from '../format.ts';
import { intlTag, t } from '../i18n/index.ts';
import { activeRuns, runLabel } from './runs.ts';

export interface GlobalStatus {
  state: TrayState | 'connecting';
  tone: 'ok' | 'info' | 'muted' | 'warn' | 'err';
  title: string;
  detail: string;
}

export function nextRunText(status: StatusDto, now = new Date()): string | null {
  const inc = status.nextRuns.find((r) => r.mode === 'incremental') ?? status.nextRuns[0];
  return inc ? t.status.nextRun(fmtWhen(inc.at, now)) : null;
}

export function globalStatus(
  status: StatusDto | null,
  connection: ConnectionState,
  pauseUntil: string | null,
  now = new Date(),
): GlobalStatus {
  if (connection === 'connecting' && !status)
    return { state: 'connecting', tone: 'muted', title: t.shell.connecting, detail: '' };
  if (connection === 'disconnected')
    return { state: 'error', tone: 'err', title: t.status.disconnected, detail: t.shell.disconnected };
  if (!status) return { state: 'connecting', tone: 'muted', title: t.shell.connecting, detail: '' };
  const state = deriveTrayState(status, connection);
  const next = nextRunText(status, now) ?? '';
  switch (state) {
    case 'paused':
      return {
        state,
        tone: 'muted',
        // daemon-side timed pause (status.pausedUntil) wins over the UI's own timer
        title:
          (status.pausedUntil ?? pauseUntil)
            ? t.status.pausedUntil(fmtWhen((status.pausedUntil ?? pauseUntil)!, now))
            : t.status.paused,
        detail: '',
      };
    case 'syncing': {
      const runs = activeRuns(status);
      return {
        state,
        tone: 'info',
        title: t.status.syncing,
        detail:
          runs.length > 1
            ? `${t.runs.active(runs.length)}: ${runs.map((r) => runLabel(status, r)).join(' · ')}`
            : status.currentRun
              ? t.status.scanned(status.currentRun.counters.scannedLocal)
              : '',
      };
    }
    case 'error': {
      const bad = status.accounts.find((a) => a.status === 'offline' || a.status === 'error');
      return {
        state,
        tone: 'err',
        title: status.state === 'offline' || bad?.status === 'offline' ? t.status.offline : t.status.error,
        detail: bad ? `${bad.displayName}: ${t.account.status[bad.status]}` : '',
      };
    }
    case 'attention': {
      const parts: string[] = [];
      if (status.openConflicts) parts.push(t.pair.conflicts(status.openConflicts));
      if (status.pendingDeletions) parts.push(t.status.deletions(status.pendingDeletions));
      for (const a of status.accounts)
        if (a.status !== 'ok' && a.status !== 'disabled') parts.push(`${a.displayName}: ${t.account.status[a.status]}`);
      if (status.queue.failed) parts.push(t.status.errors(status.queue.failed));
      return { state, tone: 'warn', title: t.status.attention, detail: parts.join(' · ') };
    }
    default:
      return { state, tone: 'ok', title: t.status.idle, detail: next };
  }
}

/** Short per-pair state for overview/flyout rows. */
export function pairStateText(p: PairDto): { text: string; tone: 'ok' | 'info' | 'warn' | 'err' | 'muted' } {
  if (!p.enabled) return { text: t.pair.disabled, tone: 'muted' };
  if (p.paused) return { text: t.pair.paused, tone: 'muted' };
  if (p.heldDeletions) return { text: t.pair.held(p.heldDeletions), tone: 'warn' };
  const c = p.counts;
  if (c.error) return { text: t.pair.errors(c.error), tone: 'err' };
  if (c.conflict) return { text: t.pair.conflicts(c.conflict), tone: 'warn' };
  const up = (c.local_new ?? 0) + (c.local_changed ?? 0) + (c.moved ?? 0);
  const down = (c.remote_new ?? 0) + (c.remote_changed ?? 0);
  if (up) return { text: `↑ ${t.pair.pending(up)}`, tone: 'info' };
  if (down) return { text: `↓ ${t.pair.newRemote(down)}`, tone: 'info' };
  if (!p.lastRunAt) return { text: t.pair.neverRun, tone: 'muted' };
  if (p.options?.twoWayAdoption) return { text: t.pair.adopting, tone: 'info' };
  return { text: t.pair.upToDate, tone: 'ok' };
}

/** two-way pairs: "Proton zuletzt geprüft vor 4 min" (remote changes are found by listing), else null */
export function remoteCheckText(p: Pick<PairDto, 'direction' | 'lastRemoteCheckAt'>, now = new Date()): string | null {
  if (p.direction !== 'two-way') return null;
  return p.lastRemoteCheckAt ? t.pair.remoteChecked(fmtAgo(p.lastRemoteCheckAt, now)) : t.pair.remoteNeverChecked;
}

/**
 * Account card footer: "Worker 1/2 · Latenz 0,21 s · zuletzt OK vor 4 min · 2 Paare". Parts without a value (no
 * successful contact yet, latency unknown or not meaningful) are left out instead of showing "–".
 */
export function accountFootLine(
  a: Pick<AccountDto, 'workers' | 'status' | 'lastOkAt'>,
  pairCount: number,
  latencyMs: number | null,
  now: Date = new Date(),
): string {
  const parts = [t.account.workers(a.workers?.active ?? 0, a.workers?.configured ?? 0)];
  if (latencyMs !== null && Number.isFinite(latencyMs) && a.status === 'ok')
    parts.push(t.account.latency(`${(latencyMs / 1000).toLocaleString(intlTag(), { maximumFractionDigits: 2 })} s`));
  if (a.lastOkAt) parts.push(t.account.lastOk(fmtAgo(a.lastOkAt, now)));
  parts.push(t.account.pairsShort(pairCount));
  return parts.join(' · ');
}

export const DIRECTION_ICON = {
  backup: 'backup',
  'mirror-down': 'mirror',
  'upload-only': 'outbox',
  'two-way': 'twoWay',
} as const;
