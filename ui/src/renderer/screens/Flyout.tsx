// SPDX-License-Identifier: GPL-3.0-or-later
/** Tray flyout (docs/SYNC-RULES.md): status, account summaries, last activity, quick actions. Like the Windows app's popup. */
import { useEffect } from 'react';

import { api } from '../api.ts';
import { actionIcon } from '../components/ActivityRow.tsx';
import { Icon } from '../components/Icon.tsx';
import { Avatar, Button, Dot, PauseControl, accountTone } from '../components/ui.tsx';
import { fmtClock, fmtWhen, shortPath } from '../format.ts';
import { t } from '../i18n/index.ts';
import { ACTION_CATEGORY, activityMessage } from '../logic/activity.ts';
import { globalStatus, pairStateText } from '../logic/status.ts';
import { canSyncAll, runsOfAccount } from '../logic/runs.ts';
import { accountUsage, normalizePool, usageText } from '../logic/storage.ts';
import { toastError, useApi, useStore } from '../store.ts';

export function Flyout() {
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.connection);
  const pauseUntil = useStore((s) => s.ui.pauseUntil);
  const recent = useStore((s) => s.recent);
  // same source and aggregation as the overview cards and the Speicher page (logic/storage.ts)
  const storage = useApi(() => api.storage(), [], ['storage']);
  const pool = storage.data ? normalizePool(storage.data) : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && window.nucleonSync.closeFlyout();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const g = globalStatus(status, connection, pauseUntil);
  const online = connection === 'connected';
  const accName = (id: string) => status?.accounts.find((a) => a.id === id)?.displayName ?? id;
  const last = status?.lastRun;
  return (
    <div className="flyout" data-testid="flyout">
      <header className="fly-head">
        <span className="brand-mark small">
          <Icon name="logo" size={18} />
        </span>
        <b>{t.appName}</b>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          title={t.actions.openDashboard}
          aria-label={t.actions.openDashboard}
          onClick={() => window.nucleonSync.openMain()}
        >
          <Icon name="external" size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t.flyout.settings}
          aria-label={t.flyout.settings}
          onClick={() => window.nucleonSync.openMain('settings')}
        >
          <Icon name="settings" size={18} />
        </button>
      </header>
      <div className={`fly-status tone-bg-${g.tone}`}>
        <Dot tone={g.tone} pulse={g.state === 'syncing'} />
        <div>
          <div className="fly-title" data-testid="fly-title">
            {g.title}
          </div>
          <div className="muted small">
            {last
              ? t.flyout.errorsLine(fmtWhen(last.finishedAt ?? last.startedAt), last.counters.errors)
              : t.status.noRunYet}
            {g.detail && g.state !== 'idle' ? ` · ${g.detail}` : ''}
          </div>
        </div>
      </div>
      <div className="fly-accounts">
        {status?.accounts.map((a) => {
          const pairs = status.pairs.filter((p) => p.accountId === a.id && p.enabled);
          const tone = a.paused ? 'muted' : accountTone(a.status);
          const pending = pairs.map(pairStateText).find((s) => s.tone !== 'ok');
          const runsOf = runsOfAccount(status, a.id);
          const runNote = runsOf.active.length
            ? ` · ${runsOf.active.map((r) => `#${r.id}`).join(', ')} ${t.flyout.runs}`
            : runsOf.queued.length
              ? ` · #${runsOf.queued[0]!.id} ${t.flyout.waits}`
              : '';
          return (
            <button
              type="button"
              key={a.id}
              className="fly-acc"
              onClick={() => window.nucleonSync.openMain('overview')}
            >
              <Avatar name={a.displayName} accountId={a.id} />
              <span className="grow">
                <span className="fly-acc-line">
                  <b>{a.displayName}</b>
                  <Dot tone={tone} />
                  <span className="small">{a.paused ? t.account.paused : t.account.status[a.status]}</span>
                </span>
                <span className="muted small" data-testid={`fly-acc-${a.id}`}>
                  {usageText(accountUsage(pool, a.id))} · {t.account.pairs(pairs.length)}
                  {pending ? ` · ${pending.text}` : ''}
                  {runNote}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="fly-list">
        {recent.slice(0, 9).map((i) => (
          <div key={i.id} className="fly-item" title={i.relPath ?? activityMessage(i) ?? ''}>
            <span className={`action action-${ACTION_CATEGORY[i.action] ?? 'other'}`}>
              <Icon name={actionIcon(i.action)} size={16} />
            </span>
            <span className="ellipsis grow">
              {i.relPath ? shortPath(i.relPath.split('/').pop() ?? i.relPath, 34) : (activityMessage(i) ?? '')}
              {status && status.accounts.length > 1 && i.accountId !== status.accounts[0]?.id ? (
                <span className="muted"> ({accName(i.accountId)})</span>
              ) : null}
            </span>
            <span className="muted small mono">{fmtClock(i.ts)}</span>
          </div>
        ))}
      </div>
      <footer className="fly-foot">
        <Button
          variant="primary"
          icon="sync"
          disabled={!online || !!status?.paused || !status || !canSyncAll(status)}
          onClick={() => void api.sync({}).catch(toastError)}
        >
          {t.actions.syncNow}
        </Button>
        <PauseControl paused={!!status?.paused} disabled={!online} />
      </footer>
    </div>
  );
}
