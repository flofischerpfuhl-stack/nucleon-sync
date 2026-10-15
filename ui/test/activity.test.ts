// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import type { ActivityItemWithRun, RunDto } from '@nucleon-sync/shared';

import {
  EMPTY_FILTERS,
  activityQuery,
  flattenGroups,
  groupByRun,
  histogram,
  matchesFilters,
} from '../src/renderer/logic/activity.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

const counters = {
  scannedLocal: 0,
  listedRemoteFolders: 0,
  uploaded: 0,
  uploadedBytes: 0,
  downloaded: 0,
  downloadedBytes: 0,
  moved: 0,
  adopted: 0,
  conflicts: 0,
  pendingDeletions: 0,
  errors: 0,
};
const run = (id: number, start: string, end: string | null, extra: Partial<RunDto['counters']> = {}): RunDto => ({
  id,
  trigger: 'schedule',
  mode: 'incremental',
  accountId: null,
  pairId: null,
  startedAt: start,
  finishedAt: end,
  status: end ? 'ok' : 'running',
  counters: { ...counters, ...extra },
});
const item = (id: number, ts: string, extra: Partial<ActivityItemWithRun> = {}): ActivityItemWithRun => ({
  id,
  ts,
  accountId: 'alex',
  pairId: 1,
  action: 'uploaded',
  relPath: `f${id}.txt`,
  bytes: 10,
  durationMs: 5,
  message: null,
  ...extra,
});

describe('activity', () => {
  it('groups by runId and by time range, keeps empty runs in the window', () => {
    const runs = [
      run(3, '2026-10-10T12:00:00Z', '2026-10-10T12:04:00Z'),
      run(2, '2026-10-10T10:00:00Z', '2026-10-10T10:02:00Z'),
      run(1, '2026-10-10T08:00:00Z', '2026-10-10T08:05:00Z'),
    ];
    const items = [
      item(5, '2026-10-10T12:03:00Z'),
      item(4, '2026-10-10T12:01:00Z', { runId: 3 }),
      item(3, '2026-10-10T11:00:00Z'), // between runs -> loose
      item(2, '2026-10-10T08:01:00Z'),
    ];
    const g = groupByRun(items, runs, { includeEmptyRuns: true, oldestLoaded: null });
    expect(g.map((x) => [x.run?.id ?? null, x.items.map((i) => i.id)])).toEqual([
      [3, [5, 4]],
      [null, [3]],
      [2, []],
      [1, [2]],
    ]);
    const rows = flattenGroups(g, new Set(['run-3']));
    expect(rows[0]).toMatchObject({ kind: 'group', collapsed: true });
    expect(rows[1]).toMatchObject({ kind: 'item', item: { id: 3 } }); // loose items have no header
  });

  it('filters and builds the API query', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const f = { ...EMPTY_FILTERS, accountId: 'sam', categories: new Set(['down' as const]), q: 'img' };
    expect(
      matchesFilters(
        item(1, '2026-10-10T11:00:00Z', { accountId: 'sam', action: 'downloaded', relPath: 'IMG_1.jpg' }),
        f,
        now,
      ),
    ).toBe(true);
    expect(
      matchesFilters(
        item(1, '2026-10-10T11:00:00Z', { accountId: 'sam', action: 'uploaded', relPath: 'IMG_1.jpg' }),
        f,
        now,
      ),
    ).toBe(false);
    const q = new URLSearchParams(activityQuery(f, 500, 77, now));
    expect(q.get('limit')).toBe('500');
    expect(q.get('before')).toBe('77');
    expect(q.get('account')).toBe('sam');
    expect(q.get('action')).toBe('downloaded');
    expect(q.get('q')).toBe('img');
  });

  it('30-day histogram from run counters', () => {
    const now = new Date(2026, 9, 10, 15);
    const runs = [
      run(1, new Date(2026, 9, 10, 10).toISOString(), null, { uploadedBytes: 100, downloadedBytes: 5 }),
      run(2, new Date(2026, 9, 10, 12).toISOString(), null, { uploadedBytes: 50 }),
      run(3, new Date(2026, 8, 1, 12).toISOString(), null, { uploadedBytes: 999 }), // older than 30 days
    ];
    const h = histogram(runs, 30, now);
    expect(h).toHaveLength(30);
    expect(h[29]).toEqual({ day: '2026-10-10', up: 150, down: 5 });
    expect(h.reduce((s, b) => s + b.up, 0)).toBe(150);
  });
});

describe('activityLabel (uploads from the PC into a mirror)', () => {
  it('labels "uploaded from the PC" in the UI language and keeps only the extra detail', async () => {
    const { activityLabel } = await import('../src/renderer/logic/activity.ts');
    const i18n = await import('../src/renderer/i18n/index.ts');
    i18n.setLocale('de');
    try {
      const labels = i18n.t.activity.action;
      expect(
        activityLabel(
          { action: 'uploaded', message: 'uploaded from the PC', msg: { key: 'activity.uploadedFromPc' } },
          labels,
        ),
      ).toEqual({ label: 'vom PC hochgeladen', detail: null });
      const renamed = {
        action: 'uploaded' as const,
        message: 'uploaded from the PC (renamed, "a.txt" already existed in Proton)',
        msg: { key: 'activity.uploadedFromPcRenamed', params: { name: 'a.txt' } },
      };
      expect(activityLabel(renamed, labels)).toEqual({
        label: 'vom PC hochgeladen',
        detail: 'umbenannt, „a.txt“ gab es in Proton schon',
      });
      // rows written before message keys existed (German text of earlier versions)
      expect(
        activityLabel(
          { action: 'uploaded', message: 'vom PC hochgeladen (umbenannt, „a.txt“ gab es in Proton schon)' },
          labels,
        ),
      ).toEqual({ label: 'vom PC hochgeladen', detail: 'umbenannt, „a.txt“ gab es in Proton schon' });
      expect(activityLabel({ action: 'uploaded', message: null }, labels)).toEqual({
        label: 'hochgeladen',
        detail: null,
      });
      expect(
        activityLabel({ action: 'adopted', message: 'adopted', msg: { key: 'activity.adopted' } }, labels),
      ).toEqual({ label: labels.adopted, detail: 'übernommen' });
      i18n.setLocale('en');
      expect(activityLabel(renamed, i18n.t.activity.action)).toEqual({
        label: 'uploaded from the PC',
        detail: 'renamed, "a.txt" already existed in Proton',
      });
    } finally {
      i18n.setLocale('en');
    }
  });
});
