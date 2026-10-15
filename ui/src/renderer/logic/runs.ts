// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Several runs at once: every account has its own background run, pair runs of an agent or the
 * UI run in a priority lane next to it. Pure helpers for the overview hero, the account cards and the tray flyout;
 * older daemons only report `currentRun`. Unit-tested.
 */
import type { RunDto, StatusDto } from '@nucleon-sync/shared';

import { fmtClock } from '../format.ts';
import { t } from '../i18n/index.ts';

type S = Pick<StatusDto, 'currentRun' | 'accounts' | 'pairs'> & Partial<Pick<StatusDto, 'activeRuns' | 'queuedRuns'>>;

/** active runs, oldest first (falls back to `currentRun` for older daemons) */
export function activeRuns(s: S): RunDto[] {
  if (Array.isArray(s.activeRuns)) return s.activeRuns;
  return s.currentRun ? [s.currentRun] : [];
}

export function queuedRuns(s: S): RunDto[] {
  return Array.isArray(s.queuedRuns) ? s.queuedRuns : [];
}

/** does this run (still) work on the account? */
export function runCoversAccount(r: RunDto, accountId: string): boolean {
  if (Array.isArray(r.activeAccounts)) return r.activeAccounts.includes(accountId);
  return r.accountId === null || r.accountId === accountId;
}

export function runsOfAccount(s: S, accountId: string): { active: RunDto[]; queued: RunDto[] } {
  return {
    active: activeRuns(s).filter((r) => runCoversAccount(r, accountId)),
    queued: queuedRuns(s).filter((r) => r.accountId === accountId),
  };
}

/** "Alex · Vollprüfung", "Sam · Ordner „Dokumente“ (Vorrang)", "alle Konten · inkrementell" */
export function runLabel(s: S, r: RunDto): string {
  const acc = (id: string) => s.accounts.find((a) => a.id === id)?.displayName ?? id;
  const who =
    r.activeAccounts && r.activeAccounts.length
      ? r.activeAccounts.map(acc).join(' + ')
      : r.accountId
        ? acc(r.accountId)
        : t.runs.allAccounts;
  return `${who} · ${runWhat(s, r)}`;
}

/** "Vollprüfung" or "Ordner „Dokumente“ (Vorrang)" */
export function runWhat(s: S, r: RunDto): string {
  if (r.pairId === null) return t.runMode[r.mode];
  const p = s.pairs.find((x) => x.id === r.pairId);
  return `${t.runs.pair(p?.name ?? `#${r.pairId}`)}${r.lane === 'priority' ? ` (${t.runs.priority})` : ''}`;
}

/** one line per account card: what runs for this account right now, and what waits */
export function accountRunText(s: S, accountId: string): string | null {
  const { active, queued } = runsOfAccount(s, accountId);
  const parts = active.map((r) => t.runs.running(r.id, runWhat(s, r), fmtClock(r.startedAt)));
  for (const q of queued) parts.push(t.runs.queued(q.id, q.waitingFor ?? []));
  return parts.length ? parts.join(' · ') : null;
}

/** "Jetzt synchronisieren" (all accounts) is useful while at least one account has no run of its own */
export function canSyncAll(s: S): boolean {
  const runs = activeRuns(s);
  if (!runs.length) return true;
  return s.accounts.some((a) => !runs.some((r) => r.lane !== 'priority' && runCoversAccount(r, a.id)));
}
