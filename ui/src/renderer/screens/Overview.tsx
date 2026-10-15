// SPDX-License-Identifier: GPL-3.0-or-later
/** docs/SYNC-RULES.md Übersicht: global status hero, attention strip, per-account cards, recent activity, next runs. */
import type { AccountDto, PairDto, StatusDto, StoragePoolDto } from '@nucleon-sync/shared';

import { ActivityLine } from '../components/ActivityRow.tsx';
import { Icon } from '../components/Icon.tsx';
import {
  Avatar,
  Button,
  Dot,
  Empty,
  MenuButton,
  PauseControl,
  Pill,
  Progress,
  accountTone,
} from '../components/ui.tsx';
import { fmtBytes, fmtClock, fmtDuration, fmtEta, fmtRate, fmtWhen } from '../format.ts';
import { t } from '../i18n/index.ts';
import { daemonText } from '../logic/daemonText.ts';
import { DIRECTION_ICON, accountFootLine, globalStatus, pairStateText, remoteCheckText } from '../logic/status.ts';
import { accountUsage, normalizePool, usageText } from '../logic/storage.ts';
import { accountRunText, activeRuns, canSyncAll, runLabel } from '../logic/runs.ts';
import { api } from '../api.ts';
import { goTo, toast, toastError, useApi, useStore, withConfirm } from '../store.ts';

export function Overview() {
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.connection);
  const pauseUntil = useStore((s) => s.ui.pauseUntil);
  const recent = useStore((s) => s.recent);
  const storage = useApi(() => api.storage(), [], ['storage']);
  const adoptions = useApi(() => api.adoptions(), [], ['run']);
  if (!status) return <Empty icon="sync">{t.shell.connecting}</Empty>;
  const g = globalStatus(status, connection, pauseUntil);
  const online = connection === 'connected';
  const adoptCount = adoptions.data?.length ?? 0;
  const pairsOf = (a: AccountDto) => status.pairs.filter((p) => p.accountId === a.id);
  const accName = (id: string) => status.accounts.find((a) => a.id === id)?.displayName ?? id;
  const run = status.currentRun;
  const runs = activeRuns(status);
  const attention = status.openConflicts + status.pendingDeletions + adoptCount;
  return (
    <div className="stack">
      <section className={`hero hero-${g.tone}`} data-testid="hero">
        <div className="hero-icon">
          <Icon
            name={
              g.state === 'syncing'
                ? 'sync'
                : g.state === 'paused'
                  ? 'pause'
                  : g.tone === 'ok'
                    ? 'check'
                    : g.tone === 'err'
                      ? 'error'
                      : 'warn'
            }
            size={30}
            className={g.state === 'syncing' ? 'spin' : ''}
          />
        </div>
        <div className="hero-main">
          <div className="hero-title" data-testid="hero-title">
            {runs.length > 1
              ? t.runs.active(runs.length)
              : run
                ? t.status.running(t.runMode[run.mode], fmtClock(run.startedAt))
                : g.title}
          </div>
          <div className="hero-sub">
            {runs.length > 1 ? (
              <span className="hero-runs" data-testid="hero-runs">
                {runs.map((r) => (
                  <span key={r.id} className="hero-run" data-testid={`hero-run-${r.id}`}>
                    #{r.id} {runLabel(status, r)} · {t.runs.since(fmtClock(r.startedAt))} ·{' '}
                    {t.status.scanned(r.counters.scannedLocal)}
                  </span>
                ))}
                {status.rate.uploadBps ? <span>{t.status.up(fmtRate(status.rate.uploadBps))}</span> : null}
                {status.rate.downloadBps ? <span>{t.status.down(fmtRate(status.rate.downloadBps))}</span> : null}
              </span>
            ) : run ? (
              <>
                {t.status.scanned(run.counters.scannedLocal)}
                {status.rate.uploadBps ? ` · ${t.status.up(fmtRate(status.rate.uploadBps))}` : ''}
                {status.rate.downloadBps ? ` · ${t.status.down(fmtRate(status.rate.downloadBps))}` : ''}
              </>
            ) : (
              <LastRunLine status={status} />
            )}
          </div>
          {run ? (
            <div className="hero-progress">
              <Progress value={0} indeterminate tone="info" />
              <span>{t.status.queue(status.queue.queued, status.queue.retryWait, status.queue.failed)}</span>
            </div>
          ) : null}
        </div>
        <div className="hero-actions">
          <Button
            variant="primary"
            icon="sync"
            disabled={!online || status.paused || !canSyncAll(status)}
            onClick={() => void api.sync({}).catch(toastError)}
          >
            {t.actions.syncNow}
          </Button>
          <PauseControl paused={status.paused} disabled={!online} />
          <MenuButton
            label={t.actions.more}
            disabled={!online || status.paused}
            items={[
              { label: t.actions.fullCheckAll, onClick: () => void api.sync({ mode: 'full' }).catch(toastError) },
              { label: t.actions.verifyNow, onClick: () => void api.sync({ mode: 'verify' }).catch(toastError) },
            ]}
          />
        </div>
      </section>

      {attention > 0 ? (
        <button type="button" className="attention" onClick={() => goTo('issues')} data-testid="attention">
          <Icon name="warn" size={20} />
          <span>{t.overview.attention(status.openConflicts, status.pendingDeletions, adoptCount)}</span>
          <span className="attention-cta">
            {t.actions.view} <Icon name="chevronRight" size={16} />
          </span>
        </button>
      ) : null}

      {status.pairs
        .filter((p) => p.brake)
        .map((p) => (
          <div key={p.id} className="attention brake" data-testid={`brake-${p.id}`}>
            <Icon name="error" size={20} />
            <span>
              <b>{t.overview.brakeTitle(p.name)}</b> — {daemonText(p.brake!.reason, p.brake!.reasonMsg)}
            </span>
            <Button small variant="secondary" disabled={!online} onClick={() => void releaseBrake(p.id)}>
              {t.overview.brakeRelease}
            </Button>
          </div>
        ))}

      <TransfersCard status={status} />

      <div className="account-grid">
        {status.accounts.map((a) => (
          <AccountCard
            key={a.id}
            account={a}
            runText={accountRunText(status, a.id)}
            pairs={pairsOf(a)}
            pool={storage.data ? normalizePool(storage.data) : null}
            latency={status.rate.metaLatencyMsEwma}
            online={online}
          />
        ))}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>{t.overview.recent}</h2>
          <Button variant="ghost" small onClick={() => goTo('activity')}>
            {t.actions.showAll}
          </Button>
        </div>
        {recent.length === 0 ? (
          <Empty icon="activity">{t.overview.noActivity}</Empty>
        ) : (
          <div className="alist" data-testid="recent-activity">
            {recent.slice(0, 8).map((i) => (
              <ActivityLine
                key={i.id}
                item={i}
                accountName={accName(i.accountId)}
                pair={status.pairs.find((p) => p.id === i.pairId)}
                maxPath={90}
              />
            ))}
          </div>
        )}
        <div className="card-foot muted">
          <Icon name="clock" size={16} />
          {t.status.nextRuns}:{' '}
          {status.nextRuns.length
            ? status.nextRuns
                .map((r) =>
                  r.mode === 'full' ? t.status.fullCheck(fmtWhen(r.at)) : t.status.incremental(fmtWhen(r.at)),
                )
                .join(' · ')
            : '–'}
        </div>
      </section>
    </div>
  );
}

async function releaseBrake(pairId: number): Promise<void> {
  try {
    if ((await withConfirm((t) => api.releaseBrake(pairId, t))) !== null) toast('ok', t.overview.brakeReleased);
  } catch (e) {
    toastError(e);
  }
}

function LastRunLine({ status }: { status: StatusDto }) {
  const r = status.lastRun;
  if (!r) return <>{t.status.noRunYet}</>;
  const dur = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null;
  return (
    <>
      {t.status.lastRun(fmtWhen(r.finishedAt ?? r.startedAt))} ({fmtDuration(dur)}) ·{' '}
      {t.status.errors(r.counters.errors)}
      {status.nextRuns[0] ? ` · ${t.status.nextRun(fmtWhen(status.nextRuns[0].at))}` : ''}
    </>
  );
}

function AccountCard({
  account: a,
  runText,
  pairs,
  pool,
  latency,
  online,
}: {
  account: AccountDto;
  runText: string | null;
  pairs: PairDto[];
  pool: StoragePoolDto | null;
  latency: number | null;
  online: boolean;
}) {
  const tone = accountTone(a.status);
  const usage = accountUsage(pool, a.id);
  return (
    <section className="card account-card" data-testid={`account-${a.id}`}>
      <div className="acc-head">
        <Avatar name={a.displayName} accountId={a.id} />
        <div className="acc-title">
          <div className="acc-name">{a.displayName}</div>
          <div className="muted small">{a.email ?? '–'}</div>
        </div>
        <Pill tone={a.paused ? 'muted' : tone}>
          <Dot tone={a.paused ? 'muted' : tone} />
          {a.paused ? t.account.paused : t.account.status[a.status]}
        </Pill>
      </div>
      {a.lastError && a.status !== 'ok' ? (
        <div className="acc-error">{daemonText(a.lastError, a.lastErrorMsg)}</div>
      ) : null}
      {runText ? (
        <div className="acc-run small" data-testid={`account-run-${a.id}`}>
          <Icon name="sync" size={14} className="spin" />
          <span>{runText}</span>
        </div>
      ) : null}
      <div className="pair-rows">
        {pairs.length === 0 ? <div className="muted">{t.account.noPairs}</div> : null}
        {pairs.map((p) => {
          const st = pairStateText(p);
          return (
            <button
              type="button"
              key={p.id}
              className="pair-row"
              onClick={() => goTo('folders')}
              title={[`${p.localRoot} ⇄ ${p.remoteRoot}`, remoteCheckText(p)].filter(Boolean).join('\n')}
              data-testid={`pair-row-${p.id}`}
            >
              <span className="pair-name">{p.name}</span>
              <span className={`pair-dir dir-${p.direction}`} title={t.pair.direction[p.direction]}>
                <Icon name={DIRECTION_ICON[p.direction]} size={16} />
                {t.pair.directionShort[p.direction]}
              </span>
              <span className={`pair-state tone-${st.tone}`}>{st.text}</span>
              <span className="pair-time">{p.enabled && p.lastRunAt ? fmtClock(p.lastRunAt) : ''}</span>
            </button>
          );
        })}
      </div>
      <div className="acc-storage">
        <div className="acc-storage-line" data-testid={`account-storage-${a.id}`}>
          <span>{usage.bytes === null ? t.account.storageNotMeasured : t.account.storage(usageText(usage))}</span>
          {usage.poolShare !== null ? (
            <span className="muted">{t.account.poolShare(Math.round(usage.poolShare * 100))}</span>
          ) : null}
        </div>
        <Progress value={usage.poolShare ?? 0} indeterminate={usage.measuring} tone="accent" />
      </div>
      <div className="acc-foot">
        <span className="muted small" data-testid={`account-foot-${a.id}`}>
          {accountFootLine(a, pairs.length, latency)}
        </span>
        <Button
          small
          icon="sync"
          disabled={!online || a.paused}
          onClick={() => void api.sync({ accountId: a.id }).catch(toastError)}
        >
          {t.actions.sync}
        </Button>
        <Button
          small
          icon={a.paused ? 'play' : 'pause'}
          disabled={!online}
          onClick={() =>
            void (
              a.paused ? api.resume({ scope: 'account', id: a.id }) : api.pause({ scope: 'account', id: a.id })
            ).catch(toastError)
          }
        >
          {a.paused ? t.actions.resume : t.actions.pause}
        </Button>
      </div>
    </section>
  );
}

/** Live transfers (big files: bytes done / total, ETA) and the open upload/download backlog with an overall ETA. */
function TransfersCard({ status }: { status: StatusDto }) {
  const tr = status.transfers;
  if (!tr) return null;
  const dirs = (['upload', 'download'] as const).filter((d) => tr[d].files > 0 || tr[d].blockedFiles > 0);
  if (!tr.active.length && !dirs.length) return null;
  const shown = tr.active.slice(0, 4);
  return (
    <section className="card" data-testid="transfers">
      <div className="card-head">
        <h2>{t.overview.transfers}</h2>
      </div>
      {dirs.map((d) => {
        const b = tr[d];
        return (
          <div key={d} className="muted" data-testid={`backlog-${d}`}>
            {b.files > 0
              ? t.overview.backlog(
                  d,
                  b.files,
                  fmtBytes(Math.max(0, b.bytes - b.bytesDone)),
                  b.rateBps ? fmtRate(b.rateBps) : null,
                  fmtEta(b.etaSeconds),
                )
              : null}
            {b.blockedFiles > 0 ? <div>{t.overview.blocked(b.blockedFiles, fmtBytes(b.blockedBytes))}</div> : null}
          </div>
        );
      })}
      {shown.map((a) => {
        const frac = a.bytesTotal ? Math.min(1, a.bytesDone / a.bytesTotal) : 0;
        const eta = fmtEta(a.etaSeconds);
        return (
          <div key={a.jobIds[0]} className="transfer-row" data-testid="transfer-row">
            <div className="transfer-head">
              <Icon name={a.kind === 'upload' ? 'up' : 'down'} size={16} />
              <span className="transfer-name" title={a.relPath ?? ''}>
                {a.relPath ?? ''}
                {a.files > 1 ? ` ${t.overview.more(a.files - 1)}` : ''}
              </span>
              <span className="muted">
                {fmtBytes(a.bytesDone)} / {fmtBytes(a.bytesTotal)}
                {a.rateBps ? ` · ${fmtRate(a.rateBps)}` : ''}
                {eta ? ` · ${t.overview.etaShort(eta)}` : ''}
              </span>
            </div>
            <Progress value={frac} tone="info" indeterminate={a.source === 'estimate' && frac === 0} />
          </div>
        );
      })}
    </section>
  );
}
