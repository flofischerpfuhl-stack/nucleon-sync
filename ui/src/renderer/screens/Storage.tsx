// SPDX-License-Identifier: GPL-3.0-or-later
/** Storage screen: shared storage pool bar, per-account areas, trash, old revisions, 90-day history. */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import type { AccountDto, StorageDto, StorageHistoryPoint } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Avatar, Button, Empty, Progress, Spinner } from '../components/ui.tsx';
import { fmtBytes, fmtCount, fmtDate, fmtDateTime, niceByteTicks } from '../format.ts';
import { section, t } from '../i18n/index.ts';
import { daemonText } from '../logic/daemonText.ts';
import { lastMeasured, normalizePool } from '../logic/storage.ts';
import { goTo, toast, toastError, useApi, useStore } from '../store.ts';

const S = section('storage');
const seriesClass = (i: number) => `series-${(i % 2) + 1}`;

/**
 * "Aktualisieren"/"Jetzt messen": POST /v1/storage/measure {wait:false} starts a new measurement in the daemon;
 * progress comes from `measuring` + SSE `storage` events, the page reloads when they arrive.
 */
function useMeasure(reload: () => void) {
  const [requesting, setRequesting] = useState(false);
  const pending = useRef(new Set<string>());
  const failed = useRef(false);
  const ev = useStore((s) => s.storageEvent);
  useEffect(() => {
    if (!ev || !pending.current.has(ev.accountId) || ev.phase === 'start') return;
    pending.current.delete(ev.accountId);
    if (ev.phase === 'failed') {
      failed.current = true;
      toast('err', S.measureFailed(ev.message ?? ''));
    }
    if (pending.current.size === 0 && !failed.current) toast('ok', S.measureDone);
  }, [ev]);
  const names = useStore((s) => s.status?.accounts ?? []);
  const measure = async () => {
    setRequesting(true);
    failed.current = false;
    try {
      const r = await api.measureStorage();
      for (const id of r.started ?? []) pending.current.add(id);
      if (r.skipped?.length)
        toast(
          'info',
          S.measureSkipped(
            r.skipped.map((x) => names.find((a) => a.id === x.accountId)?.displayName ?? x.accountId).join(', '),
          ),
        );
      if (!r.started) toast('ok', S.measureDone); // older daemon: measured synchronously
    } catch (e) {
      toastError(e);
    } finally {
      setRequesting(false);
      reload();
    }
  };
  return { requesting, measure };
}

export function Storage() {
  const accounts = useStore((s) => s.status?.accounts ?? []);
  const storage = useApi(() => api.storage(), [], ['storage']);
  const history = useApi(() => api.storageHistory(90), [], ['storage']);
  const reloadAll = () => {
    storage.reload();
    history.reload();
  };
  const { requesting, measure } = useMeasure(reloadAll);
  if (storage.error && !storage.data)
    return <Empty icon="storage">{storage.error.notImplemented ? S.unavailable : storage.error.message}</Empty>;
  if (!storage.data) return <Empty icon="storage">{t.shell.connecting}</Empty>;
  const pool = normalizePool(storage.data);
  const measured = lastMeasured(pool);
  const measuring = pool.measuring ?? [];
  const busy = requesting || measuring.length > 0;
  const used = pool.accounts.reduce((s, a) => s + a.totalBytes, 0);
  const total = pool.poolBytes ?? used;
  const free = Math.max(0, total - used);
  const acc = (id: string) => accounts.find((a) => a.id === id);
  const name = (id: string) => acc(id)?.displayName ?? id;
  const points = Array.isArray(history.data) ? history.data : [];
  return (
    <div className="stack">
      <div className="row">
        {busy ? (
          <span className="muted loading-line inline" data-testid="storage-measuring">
            <Spinner /> {measuring.length ? S.measuringAccounts(measuring.map(name).join(', ')) : S.measuring}
          </span>
        ) : (
          <span className="muted" data-testid="storage-measured">
            {measured ? S.measured(fmtDateTime(measured)) : S.notMeasured}
          </span>
        )}
        <span className="spacer" />
        <Button small icon="refresh" busy={busy} onClick={() => void measure()} data-testid="storage-refresh">
          {t.actions.refresh}
        </Button>
      </div>
      {busy ? <Progress value={0} indeterminate tone="info" /> : null}
      {!measured && !busy ? (
        <section className="card first-measure" data-testid="storage-first">
          <span className="grow">{S.firstMeasureHint}</span>
          <Button variant="primary" icon="refresh" onClick={() => void measure()}>
            {S.measureNow}
          </Button>
        </section>
      ) : null}
      <section className="card">
        <h2>{pool.poolBytes ? S.pool(fmtBytes(pool.poolBytes)) : S.poolUnknown}</h2>
        <div
          className="poolbar"
          role="img"
          aria-label={pool.accounts.map((a) => `${name(a.accountId)} ${fmtBytes(a.totalBytes)}`).join(', ')}
        >
          {pool.accounts.map((a, i) =>
            a.totalBytes ? (
              <div
                key={a.accountId}
                className={`poolseg ${seriesClass(i)}`}
                style={{ width: `${(a.totalBytes / Math.max(total, 1)) * 100}%` }}
                title={`${name(a.accountId)}: ${fmtBytes(a.totalBytes)}`}
              />
            ) : null,
          )}
        </div>
        <div className="legend legend-big">
          {pool.accounts.map((a, i) => (
            <span key={a.accountId}>
              <i className={`sw ${seriesClass(i)}`} />
              {name(a.accountId)} <b>{a.measuredAt ? fmtBytes(a.totalBytes) : S.notMeasured}</b>
            </span>
          ))}
          {pool.poolBytes ? (
            <span>
              <i className="sw sw-free" />
              {S.free} <b>{fmtBytes(free)}</b>
            </span>
          ) : null}
        </div>
      </section>
      <div className="account-grid">
        {pool.accounts.map((s) => (
          <AccountStorage key={s.accountId} s={s} account={acc(s.accountId)} />
        ))}
      </div>
      <section className="card">
        <h2>{S.history}</h2>
        {points.length ? (
          <HistoryChart points={points} accounts={pool.accounts.map((a) => a.accountId)} names={name} />
        ) : (
          <Empty icon="storage">{S.noHistory}</Empty>
        )}
      </section>
    </div>
  );
}

function AccountStorage({ s, account }: { s: StorageDto; account: AccountDto | undefined }) {
  const max = Math.max(1, ...s.areas.map((a) => a.bytes));
  return (
    <section className="card" data-testid={`storage-${s.accountId}`}>
      <div className="acc-head">
        <Avatar name={account?.displayName ?? s.accountId} accountId={s.accountId} />
        <div className="acc-title">
          <div className="acc-name">{account?.displayName ?? s.accountId}</div>
          <div className="muted small">{s.measuredAt ? fmtBytes(s.totalBytes) : S.notMeasured}</div>
        </div>
      </div>
      {s.measuredAt ? <AreaRows s={s} max={max} /> : null}
    </section>
  );
}

function AreaRows({ s, max }: { s: StorageDto; max: number }) {
  return (
    <div className="areas">
      {s.areas.map((a) => (
        <div key={a.path} className="area">
          <span className="mono ellipsis" title={a.path}>
            {daemonText(a.label, a.labelMsg)}
          </span>
          <span className="area-bar">
            <span style={{ width: `${(a.bytes / max) * 100}%` }} />
          </span>
          <span className="num">{fmtBytes(a.bytes)}</span>
          <span className="num muted small">{fmtCount(a.files)}</span>
        </div>
      ))}
      <div className="area">
        <span>{S.trash}</span>
        <span />
        <span className="num">{fmtBytes(s.trashBytes)}</span>
        <span />
      </div>
      {s.reclaimableOldRevisionsBytes > 0 ? (
        <div className="area">
          <span>{S.oldRevisions}</span>
          <span>
            <Button small variant="ghost" onClick={() => goTo('maintenance')}>
              {S.release}
            </Button>
          </span>
          <span className="num tone-warn">{fmtBytes(s.reclaimableOldRevisionsBytes)}</span>
          <span />
        </div>
      ) : null}
      {s.activeBytes && s.activeBytes < s.totalBytes ? (
        <div className="area">
          <span>{S.target}</span>
          <span />
          <span className="num">≈ {fmtBytes(s.activeBytes)}</span>
          <span />
        </div>
      ) : null}
    </div>
  );
}

/** Line chart, one line per account, shared y axis from 0, crosshair tooltip. */
function HistoryChart({
  points,
  accounts,
  names,
}: {
  points: StorageHistoryPoint[];
  accounts: string[];
  names: (id: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = 220;
  const pad = { l: 64, r: 16, t: 12, b: 28 };
  const series = useMemo(
    () => accounts.map((id) => points.filter((p) => p.accountId === id).sort((a, b) => a.at.localeCompare(b.at))),
    [points, accounts],
  );
  const times = series[0]?.map((p) => p.at) ?? [];
  const ticks = niceByteTicks(Math.max(1, ...points.map((p) => p.bytes)));
  const max = ticks[ticks.length - 1]!;
  const x = (i: number) => pad.l + (i / Math.max(1, times.length - 1)) * (W - pad.l - pad.r);
  const y = (b: number) => pad.t + (1 - b / max) * (H - pad.t - pad.b);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (times.length - 1));
    setHover(i >= 0 && i < times.length ? i : null);
  };
  return (
    <div className="linechart">
      <div className="legend">
        {accounts.map((id, i) => (
          <span key={id}>
            <i className={`sw ${seriesClass(i)}`} />
            {names(id)}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={S.history}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t) + 4} className="axis" textAnchor="end">
              {fmtBytes(t)}
            </text>
          </g>
        ))}
        {series.map((s, i) => (
          <polyline
            key={i}
            className={`line ${seriesClass(i)}`}
            fill="none"
            points={s.map((p, k) => `${x(k)},${y(p.bytes)}`).join(' ')}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* one or two measurements so far: a line alone would be invisible */}
        {series.map((s, i) =>
          s.length < 3
            ? s.map((p, k) => (
                <circle key={`${i}-${k}`} className={`dot ${seriesClass(i)}`} cx={x(k)} cy={y(p.bytes)} r={4} />
              ))
            : null,
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="crosshair" /> : null}
        <text x={pad.l} y={H - 6} className="axis">
          {fmtDate(times[0])}
        </text>
        <text x={W - pad.r} y={H - 6} className="axis" textAnchor="end">
          {fmtDate(times[times.length - 1])}
        </text>
      </svg>
      {hover !== null ? (
        <div className="tooltip" style={{ left: `calc(${(x(hover) / W) * 100}% - 90px)` }}>
          <b>{fmtDate(times[hover])}</b>
          {series.map((s, i) => (
            <div key={i}>
              <i className={`sw ${seriesClass(i)}`} /> {names(accounts[i]!)}: {fmtBytes(s[hover]?.bytes ?? 0)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
