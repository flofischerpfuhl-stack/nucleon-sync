// SPDX-License-Identifier: GPL-3.0-or-later
/** docs/SYNC-RULES.md Aktivität: filters, 30-day histogram, virtualised run-grouped table, detail panel, endless scroll. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ActivityItemWithRun, PairDto, RunDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { ActionBadge } from '../components/ActivityRow.tsx';
import { Histogram } from '../components/Histogram.tsx';
import { Icon } from '../components/Icon.tsx';
import { AccountChips, Button, Chips, Empty, Spinner } from '../components/ui.tsx';
import { VirtualList } from '../components/VirtualList.tsx';
import { fmtBytes, fmtClock, fmtDateTime, fmtDuration, fmtRange, fmtStamp, joinPath, shortPath } from '../format.ts';
import { KEY_EVENTS } from '../components/a11y.ts';
import { t } from '../i18n/index.ts';
import {
  ACTION_CATEGORY,
  CATEGORIES,
  EMPTY_FILTERS,
  activityLabel,
  activityMessage,
  activityQuery,
  flattenGroups,
  groupByRun,
  histogramFor,
  matchesFilters,
  type ActionCategory,
  type ActivityFilters,
  type Row,
  type TimeRange,
} from '../logic/activity.ts';
import { asArray } from '../logic/normalize.ts';
import { toastError, useApi, useStore } from '../store.ts';

const PAGE = 500;
const ROW_H = 42;

export function Activity() {
  const status = useStore((s) => s.status);
  const recent = useStore((s) => s.recent);
  const epoch = useStore((s) => s.epoch);
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [qInput, setQInput] = useState('');
  const [items, setItems] = useState<ActivityItemWithRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [end, setEnd] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ActivityItemWithRun | null>(null);
  const loadingRef = useRef(false);
  const runs = useApi(() => api.runs(500), [], ['run']);
  const accounts = status?.accounts ?? [];
  const pairs = status?.pairs ?? [];

  // debounce the search box
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput })), 250);
    return () => clearTimeout(timer);
  }, [qInput]);
  // `/` or Ctrl+F (app.tsx): focus the search box
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener(KEY_EVENTS.search, focus);
    return () => window.removeEventListener(KEY_EVENTS.search, focus);
  }, []);

  const load = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const before = reset ? undefined : items[items.length - 1]?.id;
        const page = asArray(await api.activity(activityQuery(filters, PAGE, before)));
        const filtered = page.filter((i) => matchesFilters(i, filters));
        setItems((prev) => (reset ? filtered : [...prev, ...filtered]));
        setEnd(page.length < PAGE);
      } catch (e) {
        toastError(e);
        setEnd(true);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [filters, items],
  );

  // reload on filter change and reconnect
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    setItems([]);
    setEnd(false);
    void loadRef.current(true);
  }, [filters, epoch]);

  // live rows from SSE (store.recent is newest first)
  useEffect(() => {
    setItems((prev) => {
      const top = prev[0]?.id ?? 0;
      const fresh = recent.filter((i) => i.id > top && matchesFilters(i, filters));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
  }, [recent, filters]);

  const runList: RunDto[] = Array.isArray(runs.data) ? runs.data : [];
  const groups = useMemo(
    () =>
      groupByRun(items, runList, {
        includeEmptyRuns: !filters.q && !filters.categories.size && !filters.accountId && filters.pairId === null,
        oldestLoaded: end ? null : (items[items.length - 1]?.ts ?? null),
      }),
    [items, runList, filters, end],
  );
  const rows = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);
  // the chart follows the time filter (today: per hour, 7 days, 30 days/all)
  const bars = useMemo(() => histogramFor(filters.range, runList), [runList, filters.range]);
  const onNearEnd = useCallback(() => {
    if (!end && !loadingRef.current) void loadRef.current(false);
  }, [end]);

  const toggleCat = (c: ActionCategory) =>
    setFilters((f) => {
      const next = new Set(f.categories);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return { ...f, categories: next };
    });
  const pairById = (id: number | null) => pairs.find((p) => p.id === id);
  const accName = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;

  return (
    <div className="activity-screen">
      <div className="toolbar">
        <AccountChips
          accounts={accounts}
          value={filters.accountId}
          onChange={(v) => setFilters({ ...filters, accountId: v, pairId: null })}
        />
        <label className="field-inline">
          <span>{t.activity.pair}</span>
          <select
            value={filters.pairId ?? ''}
            onChange={(e) => setFilters({ ...filters, pairId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">{t.activity.allPairs}</option>
            {pairs
              .filter((p) => !filters.accountId || p.accountId === filters.accountId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {accName(p.accountId)} · {p.name}
                </option>
              ))}
          </select>
        </label>
        <div className="chips" role="group" aria-label={t.activity.action_}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={filters.categories.has(c)}
              className={`chip chip-cat action-${c}${filters.categories.has(c) ? ' on' : ''}`}
              onClick={() => toggleCat(c)}
              title={t.activity.category[c]}
            >
              <ActionBadge action={firstAction(c)} compact />
              {t.activity.category[c]}
            </button>
          ))}
        </div>
        <Chips<TimeRange>
          label={t.activity.period}
          options={(['today', '7d', '30d', 'all'] as TimeRange[]).map((r) => ({
            value: r,
            label: t.activity.range[r],
          }))}
          value={filters.range}
          onChange={(range) => setFilters({ ...filters, range })}
        />
        <label className="search">
          <Icon name="search" size={18} />
          <input
            ref={searchRef}
            type="search"
            aria-keyshortcuts="/ Control+F"
            data-testid="activity-search"
            value={qInput}
            placeholder={t.activity.search}
            onChange={(e) => setQInput(e.target.value)}
            aria-label={t.activity.search}
          />
        </label>
      </div>

      {runList.length ? (
        <div className="card hist-card">
          <Histogram bars={bars} range={filters.range} />
        </div>
      ) : null}

      <div className={`activity-body${selected ? ' with-detail' : ''}`}>
        <div className="card table-card">
          <div className="thead atable-grid">
            <span>{t.activity.col.time}</span>
            <span>{t.activity.col.account}</span>
            <span>{t.activity.col.action}</span>
            <span>{t.activity.col.path}</span>
            <span className="num">{t.activity.col.size}</span>
            <span className="num">{t.activity.col.duration}</span>
          </div>
          {rows.length === 0 && !loading ? (
            <Empty icon="activity">{t.activity.empty}</Empty>
          ) : (
            <VirtualList
              rows={rows}
              rowHeight={ROW_H}
              rowKey={(r) => (r.kind === 'group' ? r.group.key : `i${r.item.id}`)}
              onNearEnd={onNearEnd}
              className="atable"
              render={(r) => (
                <RowView
                  row={r}
                  selectedId={selected?.id ?? null}
                  maxPath={selected ? 52 : 96}
                  accName={accName}
                  pair={r.kind === 'item' ? pairById(r.item.pairId) : undefined}
                  onToggle={(key) =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      if (n.has(key)) n.delete(key);
                      else n.add(key);
                      return n;
                    })
                  }
                  onSelect={setSelected}
                />
              )}
            />
          )}
          <div className="tfoot muted">
            {loading ? <Spinner /> : null}
            <span data-testid="activity-count">{t.activity.rows(items.length)}</span>
            {end && items.length ? <span>· {t.activity.endReached}</span> : null}
          </div>
        </div>
        {selected ? (
          <Detail
            item={selected}
            pair={pairById(selected.pairId)}
            accName={accName(selected.accountId)}
            run={runList.find((r) => r.id === selected.runId)}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function firstAction(c: ActionCategory) {
  return (Object.keys(ACTION_CATEGORY) as (keyof typeof ACTION_CATEGORY)[]).find((a) => ACTION_CATEGORY[a] === c)!;
}

function RowView({
  row,
  selectedId,
  maxPath,
  accName,
  pair,
  onToggle,
  onSelect,
}: {
  row: Row;
  selectedId: number | null;
  maxPath: number;
  accName: (id: string) => string;
  pair: PairDto | undefined;
  onToggle: (key: string) => void;
  onSelect: (i: ActivityItemWithRun) => void;
}) {
  if (row.kind === 'group') {
    const r = row.group.run!;
    const c = r.counters;
    const counters = t.activity.runCounters(c.uploaded, fmtBytes(c.uploadedBytes), c.downloaded, c.moved);
    return (
      <button type="button" className="run-row" onClick={() => onToggle(row.group.key)} aria-expanded={!row.collapsed}>
        <Icon name={row.collapsed ? 'chevronRight' : 'chevronDown'} size={16} />
        <b>{t.activity.run(r.id)}</b>
        <span>
          {t.runMode[r.mode]} · {t.runTrigger[r.trigger]} ·{' '}
          {r.finishedAt ? fmtRange(r.startedAt, r.finishedAt) : `${fmtClock(r.startedAt)} · ${t.activity.runRunning}`}
        </span>
        <span className="run-counters">{counters || t.activity.runNoChanges}</span>
        <span className={c.errors ? 'tone-err' : 'muted'}>{t.status.errors(c.errors)}</span>
      </button>
    );
  }
  const i = row.item;
  const text = i.relPath ? (pair ? `${pair.name}/${i.relPath}` : i.relPath) : (activityMessage(i) ?? '');
  const { label, detail } = activityLabel(i, t.activity.action);
  return (
    <button
      type="button"
      className={`item-row atable-grid${selectedId === i.id ? ' selected' : ''}`}
      onClick={() => onSelect(i)}
      data-testid="activity-row"
    >
      <span className="mono atime" title={fmtDateTime(i.ts)}>
        {fmtStamp(i.ts)}
      </span>
      <span>{accName(i.accountId)}</span>
      <ActionBadge action={i.action} label={label} />
      <span className="ellipsis" title={text}>
        {i.relPath ? shortPath(text, maxPath) : text}
        {i.relPath && detail ? <span className="muted"> · {detail}</span> : null}
      </span>
      <span className="num">{i.bytes ? fmtBytes(i.bytes) : ''}</span>
      <span className="num muted">{i.durationMs ? fmtDuration(i.durationMs) : ''}</span>
    </button>
  );
}

function Detail({
  item: i,
  pair,
  accName,
  run,
  onClose,
}: {
  item: ActivityItemWithRun;
  pair: PairDto | undefined;
  accName: string;
  run: RunDto | undefined;
  onClose: () => void;
}) {
  const d = t.activity.detail;
  const local = pair && i.relPath ? joinPath(pair.localRoot, i.relPath) : null;
  const remote = pair && i.relPath ? joinPath(pair.remoteRoot, i.relPath) : null;
  const rows: [string, string | null][] = [
    [d.time, fmtDateTime(i.ts)],
    [d.account, accName],
    [d.pair, pair?.name ?? null],
    [d.action, activityLabel(i, t.activity.action).label],
    [d.localPath, local],
    [d.remotePath, remote],
    [d.size, i.bytes ? fmtBytes(i.bytes) : null],
    [d.duration, i.durationMs ? fmtDuration(i.durationMs) : null],
    [d.run, run ? `${t.activity.run(run.id)} · ${t.runMode[run.mode]}` : i.runId ? t.activity.run(i.runId) : null],
    [d.message, activityMessage(i)],
    [d.nodeInfo, d.nodeInfoMissing],
  ];
  return (
    <aside className="card detail" data-testid="activity-detail">
      <div className="card-head">
        <h2>{d.title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t.actions.close}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <dl>
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={k === d.localPath || k === d.remotePath ? 'mono break' : k === d.nodeInfo ? 'muted' : ''}>
                {v}
              </dd>
            </div>
          ))}
      </dl>
      <div className="detail-actions">
        <Button icon="folder" disabled={!local} onClick={() => local && void window.nucleonSync.showInFolder(local)}>
          {d.showInFolder}
        </Button>
        <Button icon="external" onClick={() => void window.nucleonSync.openExternal('https://drive.proton.me/')}>
          {d.openProton}
        </Button>
      </div>
    </aside>
  );
}
