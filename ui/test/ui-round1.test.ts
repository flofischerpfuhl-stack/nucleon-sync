// SPDX-License-Identifier: GPL-3.0-or-later
/** fix-ui-round1: regression tests for the pure parts of the UI fixes (storage source, status line, screens, …). */
import { describe, expect, it } from 'vitest';

import type { RunDto, StoragePoolDto } from '@nucleon-sync/shared';

import { fmtStamp } from '../src/renderer/format.ts';
import { histogramFor, hourlyHistogram } from '../src/renderer/logic/activity.ts';
import { memoSelector, shallowEqual } from '../src/renderer/logic/memo.ts';
import { normalizeStatus } from '../src/renderer/logic/normalize.ts';
import { validateLocalRoot } from '../src/renderer/logic/paths.ts';
import { isScreen, screenOr, SCREEN_IDS } from '../src/renderer/logic/screens.ts';
import { accountFootLine } from '../src/renderer/logic/status.ts';
import { accountUsage, lastMeasured, normalizePool, usageText } from '../src/renderer/logic/storage.ts';
import { status } from './helpers.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

const GiB = 1024 ** 3;

const pool = (patch: Partial<StoragePoolDto> = {}): StoragePoolDto => ({
  poolBytes: 1000 * GiB,
  accounts: [
    {
      accountId: 'alex',
      measuredAt: '2026-10-10T08:00:00Z',
      areas: [
        { path: '/devices/Workstation', label: 'Workstation', bytes: 388 * GiB, files: 1 },
        { path: '/devices/Laptop', label: 'Laptop', bytes: 206 * GiB, files: 1 },
        { path: '/my-files', label: 'Meine Dateien', bytes: 160 * GiB, files: 1 },
      ],
      activeBytes: 0,
      totalBytes: 382 * GiB,
      reclaimableOldRevisionsBytes: 0,
      trashBytes: 0,
    },
    {
      accountId: 'sam',
      measuredAt: null,
      areas: [],
      activeBytes: 0,
      totalBytes: 0,
      reclaimableOldRevisionsBytes: 0,
      trashBytes: 0,
    },
  ],
  measuring: [],
  ...patch,
});

describe('#1/#2/#4 storage: one source of truth, "noch nicht gemessen"', () => {
  it('uses the measured total of all areas (not one device, not bytesTracked)', () => {
    const u = accountUsage(pool(), 'alex');
    expect(u.bytes).toBe(382 * GiB);
    expect(usageText(u)).toBe('382 GB');
    expect(u.poolShare).toBeCloseTo(0.382, 3);
  });

  it('never-measured accounts have no number instead of "0 B"', () => {
    const u = accountUsage(pool(), 'sam');
    expect(u.bytes).toBeNull();
    expect(usageText(u)).toBe('noch nicht gemessen');
    expect(accountUsage(null, 'alex').bytes).toBeNull();
    expect(accountUsage(pool({ accounts: [] }), 'alex').bytes).toBeNull();
  });

  it('reports measurements in progress and the latest measurement time', () => {
    expect(accountUsage(pool({ measuring: ['sam'] }), 'sam').measuring).toBe(true);
    expect(lastMeasured(pool())).toBe('2026-10-10T08:00:00Z');
    expect(lastMeasured(pool({ accounts: [] }))).toBeNull();
  });

  it('normalises partial/malformed storage answers', () => {
    expect(normalizePool(null)).toEqual({ poolBytes: null, accounts: [], measuring: [] });
    expect(normalizePool({ accounts: 'x', poolBytes: 0 })).toEqual({ poolBytes: null, accounts: [], measuring: [] });
    const p = normalizePool({ accounts: [{ accountId: 'a' }, { nope: 1 }, null] });
    expect(p.accounts).toEqual([
      {
        accountId: 'a',
        measuredAt: null,
        areas: [],
        activeBytes: 0,
        totalBytes: 0,
        reclaimableOldRevisionsBytes: 0,
        trashBytes: 0,
      },
    ]);
  });
});

describe('#2 account card footer', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('leaves out "zuletzt OK" when there was no successful contact yet (no stray "–")', () => {
    const line = accountFootLine({ workers: { active: 0, configured: 2 }, status: 'ok', lastOkAt: null }, 1, null, now);
    expect(line).toBe('Worker 0/2 · 1 Paar');
    expect(line).not.toContain('–');
    expect(line).not.toMatch(/·\s*·/);
  });

  it('keeps latency and last OK when known', () => {
    expect(
      accountFootLine(
        { workers: { active: 1, configured: 2 }, status: 'ok', lastOkAt: '2026-10-10T11:56:00Z' },
        2,
        210,
        now,
      ),
    ).toBe('Worker 1/2 · Latenz 0,21 s · zuletzt OK vor 4 min · 2 Paare');
    // latency only for healthy accounts
    expect(
      accountFootLine({ workers: { active: 0, configured: 1 }, status: 'offline', lastOkAt: null }, 0, 210, now),
    ).toBe('Worker 0/1 · 0 Paare');
  });
});

describe('#3 robust start screen and data', () => {
  it('validates persisted screen ids (own keys only)', () => {
    for (const id of SCREEN_IDS) expect(isScreen(id)).toBe(true);
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', 'Storage', null, undefined, 3])
      expect(isScreen(bad), String(bad)).toBe(false);
    expect(screenOr('storage')).toBe('storage');
    expect(screenOr('constructor')).toBe('overview');
    expect(screenOr(null)).toBe('overview');
  });

  it('memoised selectors return a stable snapshot (no render loop with `?? []`)', () => {
    const memo = memoSelector<{ status: { accounts: string[] } | null }, string[]>();
    const st = { status: null };
    const sel = (s: typeof st | { status: { accounts: string[] } | null }) => s.status?.accounts ?? [];
    const a = memo(st, sel);
    expect(memo(st, sel)).toBe(a);
    // a new selector closure (next render) with an equal result keeps the old snapshot
    expect(memo(st, (s) => s.status?.accounts ?? [])).toBe(a);
    // a new state with a shallowly equal result too
    expect(memo({ status: null }, sel)).toBe(a);
    const accounts = ['alex'];
    expect(memo({ status: { accounts } }, sel)).toBe(accounts);
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1], { 0: 1 })).toBe(false);
  });

  it('normalises a partial status so screens can rely on arrays and numbers', () => {
    expect(normalizeStatus(null)).toBeNull();
    const s = normalizeStatus({ state: 'idle', accounts: [{ id: 'x' }, { nope: true }], pairs: null })!;
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({ id: 'x', displayName: 'x', workers: { configured: 0, active: 0 } });
    expect(s.pairs).toEqual([]);
    expect(s.nextRuns).toEqual([]);
    expect(s.queue.failed).toBe(0);
    expect(s.rate.metaLatencyMsEwma).toBeNull();
    // a complete status passes through unchanged in substance
    const full = status();
    expect(normalizeStatus(full)).toMatchObject({ accounts: full.accounts, pairs: full.pairs, queue: full.queue });
  });
});

describe('#5 activity: time column and chart follow the filter', () => {
  const counters = {
    scannedLocal: 0,
    listedRemoteFolders: 0,
    uploaded: 1,
    uploadedBytes: 100,
    downloaded: 0,
    downloadedBytes: 0,
    moved: 0,
    adopted: 0,
    conflicts: 0,
    pendingDeletions: 0,
    errors: 0,
  };
  const run = (id: number, start: Date, up = 100): RunDto => ({
    id,
    trigger: 'schedule',
    mode: 'incremental',
    accountId: null,
    pairId: null,
    startedAt: start.toISOString(),
    finishedAt: start.toISOString(),
    status: 'ok',
    counters: { ...counters, uploadedBytes: up },
  });
  const now = new Date(2026, 9, 10, 15, 30);

  it('multi-day timestamps are one short token pair ("09.10. 07:00"), today shows seconds', () => {
    expect(fmtStamp(new Date(2026, 9, 9, 7, 0).toISOString(), now)).toBe('09.10. 07:00');
    expect(fmtStamp(new Date(2026, 9, 10, 7, 0, 5).toISOString(), now)).toBe('07:00:05');
  });

  it("today → 24 hourly bars with only today's runs", () => {
    const runs = [
      run(1, new Date(2026, 9, 10, 7, 10), 100),
      run(2, new Date(2026, 9, 10, 7, 50), 50),
      run(3, new Date(2026, 9, 9, 7, 0), 999),
    ];
    const bars = histogramFor('today', runs, now);
    expect(bars).toHaveLength(24);
    expect(bars[7]!.up).toBe(150);
    expect(bars.reduce((s, b) => s + b.up, 0)).toBe(150);
    expect(bars[7]!.label).toBe('10.10.2026 07:00');
    expect(hourlyHistogram(runs, now)).toEqual(bars);
  });

  it('7 days → 7 bars, 30 days and "Gesamt" → 30 bars', () => {
    const runs = [
      run(1, new Date(2026, 9, 10, 7, 0)),
      run(2, new Date(2026, 9, 1, 7, 0)),
      run(3, new Date(2026, 8, 20, 7, 0)),
    ];
    const w = histogramFor('7d', runs, now);
    expect(w).toHaveLength(7);
    expect(w.reduce((s, b) => s + b.up, 0)).toBe(100); // only the run of today is within 7 days
    expect(w[6]!.label).toBe('10.10.2026');
    const m = histogramFor('30d', runs, now);
    expect(m).toHaveLength(30);
    expect(m.reduce((s, b) => s + b.up, 0)).toBe(300);
    expect(histogramFor('all', runs, now)).toHaveLength(30);
  });
});

describe('#6 pair wizard: local folder validation', () => {
  const pairs = [{ name: 'Documents', localRoot: '/srv/sync/Documents' }];
  it('accepts a free absolute folder', () => {
    expect(validateLocalRoot('/srv/sync/Pictures', pairs)).toBeNull();
    expect(validateLocalRoot('/srv/sync/Pictures/', pairs)).toBeNull();
  });
  it('empty input is not an error (but not valid either — the wizard requires a checked value)', () => {
    expect(validateLocalRoot('', pairs)).toBeNull();
    expect(validateLocalRoot('   ', pairs)).toBeNull();
  });
  it('rejects relative paths, the root, hard exclusions and overlaps with other pairs', () => {
    expect(validateLocalRoot('d', pairs)).toMatch(/absoluten Pfad/);
    expect(validateLocalRoot('/', pairs)).toMatch(/Wurzelverzeichnis/);
    expect(validateLocalRoot('//', pairs)).toMatch(/Wurzelverzeichnis/);
    expect(validateLocalRoot('/srv/sync/Documents', pairs)).toMatch(/Documents/);
    // nested pairs are allowed for two-way (the outer pair excludes the sub folder; see twoway.test.ts)
    expect(validateLocalRoot('/srv/sync/Documents/Steuer', pairs)).toBeNull();
    expect(validateLocalRoot('/srv/sync', pairs)).toBeNull(); // contains a pair: decided once the Proton side is known
    expect(validateLocalRoot('/srv/sync/Documents2', pairs)).toBeNull();
  });
});
