// SPDX-License-Identifier: GPL-3.0-or-later
/** Activity feed logic (docs/SYNC-RULES.md): filters, run grouping, virtual rows, 30-day histogram. Pure; unit-tested. */
import { intlTag } from '../i18n/index.ts';
import type { ActivityAction, MsgRef, RunDto } from '@nucleon-sync/shared';
import type { ActivityItemWithRun } from '@nucleon-sync/shared';
import { daemonText } from './daemonText.ts';

export type ActionCategory = 'up' | 'down' | 'move' | 'trash' | 'error' | 'warn' | 'other';

export const ACTION_CATEGORY: Record<ActivityAction, ActionCategory> = {
  uploaded: 'up',
  new_revision: 'up',
  downloaded: 'down',
  moved: 'move',
  renamed: 'move',
  trashed_remote: 'trash',
  trashed_local: 'trash',
  error: 'error',
  conflict: 'warn',
  deletion_pending: 'warn',
  adopted: 'other',
  skipped: 'other',
  info: 'other',
};

/** Message the daemon writes for uploads from the PC into a mirror-down pair (option uploadLocalNew). */
const FROM_PC_REF: MsgRef = { key: 'activity.uploadedFromPc' };
/** its English text and the German text of rows written before message keys existed */
const FROM_PC_TEXTS = ['uploaded from the PC', 'vom PC hochgeladen'];

/** Message of an activity item in the UI language (English text of the service as fallback). */
export function activityMessage(i: { message: string | null; msg?: MsgRef | null }): string | null {
  return daemonText(i.message, i.msg) || null;
}

/**
 * Label + remaining detail text of an activity item: uploads from the PC into a mirror are labelled "uploaded from
 * the PC" (instead of "uploaded"); the message then only carries what follows that label.
 */
export function activityLabel(
  i: { action: ActivityAction; message: string | null; msg?: MsgRef | null },
  labels: Record<ActivityAction, string>,
): { label: string; detail: string | null } {
  const text = activityMessage(i);
  if (i.action === 'uploaded' && text) {
    const fromPc = daemonText(FROM_PC_TEXTS[0], FROM_PC_REF);
    const prefix = [fromPc, ...FROM_PC_TEXTS].find((x) => text.startsWith(x));
    if (prefix) {
      const rest = text.slice(prefix.length).trim();
      return { label: fromPc, detail: rest ? rest.replace(/^\((.*)\)$/, '$1') : null };
    }
  }
  return { label: labels[i.action], detail: text };
}

export const CATEGORIES: ActionCategory[] = ['up', 'down', 'move', 'trash', 'error', 'warn', 'other'];

export type TimeRange = 'today' | '7d' | '30d' | 'all';

export interface ActivityFilters {
  accountId: string | null;
  pairId: number | null;
  categories: ReadonlySet<ActionCategory>; // empty = all
  range: TimeRange;
  q: string;
}

export const EMPTY_FILTERS: ActivityFilters = {
  accountId: null,
  pairId: null,
  categories: new Set(),
  range: 'all',
  q: '',
};

export function rangeStart(range: TimeRange, now: Date = new Date()): Date | null {
  if (range === 'all') return null;
  const d = new Date(now);
  if (range === 'today') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  d.setDate(d.getDate() - (range === '7d' ? 7 : 30));
  return d;
}

export function matchesFilters(i: ActivityItemWithRun, f: ActivityFilters, now: Date = new Date()): boolean {
  if (f.accountId && i.accountId !== f.accountId) return false;
  if (f.pairId !== null && i.pairId !== f.pairId) return false;
  if (f.categories.size && !f.categories.has(ACTION_CATEGORY[i.action] ?? 'other')) return false;
  const start = rangeStart(f.range, now);
  if (start && new Date(i.ts) < start) return false;
  if (f.q) {
    const q = f.q.toLocaleLowerCase(intlTag());
    const hay = `${i.relPath ?? ''} ${i.message ?? ''} ${i.msg ? (activityMessage(i) ?? '') : ''}`;
    if (!hay.toLocaleLowerCase(intlTag()).includes(q)) return false;
  }
  return true;
}

/** Query string for GET /v1/activity (the daemon may ignore filters; the UI filters again client-side). */
export function activityQuery(f: ActivityFilters, limit: number, before?: number, now: Date = new Date()): string {
  const p = new URLSearchParams();
  p.set('limit', String(limit));
  if (before) p.set('before', String(before));
  if (f.accountId) p.set('account', f.accountId);
  if (f.pairId !== null) p.set('pair', String(f.pairId));
  if (f.categories.size) {
    const actions = (Object.keys(ACTION_CATEGORY) as ActivityAction[]).filter((a) =>
      f.categories.has(ACTION_CATEGORY[a]),
    );
    p.set('action', actions.join(','));
  }
  const start = rangeStart(f.range, now);
  if (start) p.set('since', start.toISOString());
  if (f.q) p.set('q', f.q);
  return p.toString();
}

export interface RunGroup {
  key: string;
  run: RunDto | null;
  items: ActivityItemWithRun[];
}

/**
 * Groups items (newest first) by run: `runId` when the daemon sends it, otherwise by time range of the run (and
 * account). Runs without items (e.g. "keine Änderungen") are interleaved by start time, but only within the loaded
 * time window (`oldestLoaded`).
 */
export function groupByRun(
  items: ActivityItemWithRun[],
  runs: RunDto[],
  opts: { oldestLoaded?: string | null; includeEmptyRuns?: boolean } = {},
): RunGroup[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const sortedRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const starts = sortedRuns.map((r) => Date.parse(r.startedAt) - 1000); // descending
  const ends = sortedRuns.map((r) => (r.finishedAt ? Date.parse(r.finishedAt) + 2000 : Infinity));
  const findRun = (i: ActivityItemWithRun): RunDto | null => {
    if (i.runId !== undefined && i.runId !== null) return byId.get(i.runId) ?? null;
    const t = Date.parse(i.ts);
    // binary search: first run (newest first) that started at or before t; then check a few older neighbours
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! > t) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < Math.min(lo + 6, sortedRuns.length); k++) {
      const r = sortedRuns[k]!;
      if (t <= ends[k]! && (!r.accountId || r.accountId === i.accountId)) return r;
    }
    return null;
  };
  const groups: RunGroup[] = [];
  const groupOfRun = new Map<number, RunGroup>();
  let loose: RunGroup | null = null;
  for (const i of items) {
    const r = findRun(i);
    if (r) {
      let g = groupOfRun.get(r.id);
      if (!g) {
        g = { key: `run-${r.id}`, run: r, items: [] };
        groupOfRun.set(r.id, g);
        groups.push(g);
      }
      g.items.push(i);
      loose = null;
    } else {
      if (!loose) {
        loose = { key: `loose-${i.id}`, run: null, items: [] };
        groups.push(loose);
      }
      loose.items.push(i);
    }
  }
  if (opts.includeEmptyRuns) {
    const oldest = opts.oldestLoaded ?? null;
    for (const r of sortedRuns) {
      if (groupOfRun.has(r.id)) continue;
      if (oldest && r.startedAt < oldest) continue;
      groups.push({ key: `run-${r.id}`, run: r, items: [] });
    }
    const groupTime = (g: RunGroup) => g.items[0]?.ts ?? g.run?.finishedAt ?? g.run?.startedAt ?? '';
    groups.sort((a, b) => groupTime(b).localeCompare(groupTime(a)));
  }
  return groups;
}

export type Row = { kind: 'group'; group: RunGroup; collapsed: boolean } | { kind: 'item'; item: ActivityItemWithRun };

export function flattenGroups(groups: RunGroup[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.key);
    if (g.run) rows.push({ kind: 'group', group: g, collapsed: isCollapsed });
    if (!g.run || !isCollapsed) for (const item of g.items) rows.push({ kind: 'item', item });
  }
  return rows;
}

export interface DayBar {
  day: string; // YYYY-MM-DD (local), hourly bars: YYYY-MM-DDTHH
  up: number;
  down: number;
  /** tooltip title, e.g. "09.10.2026" or "10.10.2026 14:00" */
  label?: string;
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** bytes up/down per day for the last `days` days (from run counters) */
export function histogram(runs: RunDto[], days = 30, now: Date = new Date()): DayBar[] {
  const bars: DayBar[] = [];
  const idx = new Map<string, DayBar>();
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - k);
    const bar = { day: dayKey(d), up: 0, down: 0 };
    bars.push(bar);
    idx.set(bar.day, bar);
  }
  for (const r of runs) {
    const bar = idx.get(dayKey(new Date(r.startedAt)));
    if (!bar) continue;
    bar.up += r.counters.uploadedBytes;
    bar.down += r.counters.downloadedBytes;
  }
  return bars;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayLabel = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;

/** bytes up/down per hour of today (00–23, from run counters) */
export function hourlyHistogram(runs: RunDto[], now: Date = new Date()): DayBar[] {
  const today = dayKey(now);
  const bars: DayBar[] = Array.from({ length: 24 }, (_, h) => ({
    day: `${today}T${pad2(h)}`,
    up: 0,
    down: 0,
    label: `${dayLabel(now)} ${pad2(h)}:00`,
  }));
  for (const r of runs) {
    const t = new Date(r.startedAt);
    if (dayKey(t) !== today) continue;
    const bar = bars[t.getHours()]!;
    bar.up += r.counters.uploadedBytes;
    bar.down += r.counters.downloadedBytes;
  }
  return bars;
}

/** histogram matching the activity time filter: today → hourly, 7 days → 7 bars, 30 days/all → 30 bars */
export function histogramFor(range: TimeRange, runs: RunDto[], now: Date = new Date()): DayBar[] {
  if (range === 'today') return hourlyHistogram(runs, now);
  return histogram(runs, range === '7d' ? 7 : 30, now).map((b) => ({
    ...b,
    label: dayLabel(new Date(`${b.day}T12:00:00`)),
  }));
}
