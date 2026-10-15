// SPDX-License-Identifier: GPL-3.0-or-later
/** Several active runs: overview hero, account cards, flyout, normaliser. */
import { describe, expect, it } from 'vitest';

import type { AccountDto, PairDto, RunDto } from '@nucleon-sync/shared';

import { normalizeStatus } from '../src/renderer/logic/normalize.ts';
import { accountRunText, activeRuns, canSyncAll, runLabel, runsOfAccount } from '../src/renderer/logic/runs.ts';
import { globalStatus } from '../src/renderer/logic/status.ts';
import { status } from './helpers.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

const counters = (): RunDto['counters'] => ({
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
});
const run = (p: Partial<RunDto>): RunDto => ({
  id: 1,
  trigger: 'schedule',
  mode: 'incremental',
  accountId: null,
  pairId: null,
  startedAt: '2026-10-12T06:00:00Z',
  finishedAt: null,
  status: 'running',
  counters: counters(),
  ...p,
});
const sam: AccountDto = {
  id: 'sam',
  displayName: 'Sam',
  email: null,
  status: 'ok',
  lastError: null,
  lastOkAt: null,
  credentialBackend: 'mock',
  workers: { configured: 1, active: 1 },
  paused: false,
};
const samPair = {
  id: 5,
  accountId: 'sam',
  name: 'Sam Dokumente',
  localRoot: '/srv/sync/Sam/Dokumente',
  remoteRoot: '/my-files/Dokumente',
  direction: 'mirror-down',
  enabled: true,
  paused: false,
  counts: {},
  bytesTracked: 0,
  lastRunAt: null,
  lastFullAt: null,
} satisfies PairDto;

const long = run({ id: 19, mode: 'full', accountId: 'alex', lane: 'background', activeAccounts: ['alex'] });
const pairRun = run({
  id: 23,
  trigger: 'api',
  accountId: 'sam',
  pairId: 5,
  lane: 'priority',
  activeAccounts: ['sam'],
  startedAt: '2026-10-12T21:04:00Z',
});
const queued = run({ id: 24, accountId: 'alex', status: 'queued', lane: 'background', waitingFor: [19] });

describe('runs logic', () => {
  const s = status({
    state: 'syncing',
    currentRun: pairRun,
    activeRuns: [long, pairRun],
    queuedRuns: [queued],
    accounts: [...status().accounts.map((a) => ({ ...a, displayName: 'Alex' })), sam],
    pairs: [samPair],
  });

  it('lists active runs per account, with labels', () => {
    expect(activeRuns(s).map((r) => r.id)).toEqual([19, 23]);
    expect(runsOfAccount(s, 'alex')).toEqual({ active: [long], queued: [queued] });
    expect(runsOfAccount(s, 'sam')).toEqual({ active: [pairRun], queued: [] });
    expect(runLabel(s, long)).toBe('Alex · Vollprüfung');
    expect(runLabel(s, pairRun)).toBe('Sam · Ordner „Sam Dokumente“ (Vorrang)');
    expect(accountRunText(s, 'alex')).toMatch(/^Lauf #19: Vollprüfung seit \d\d:\d\d · Lauf #24 wartet auf #19$/);
    expect(accountRunText(s, 'sam')).toMatch(/^Lauf #23: Ordner „Sam Dokumente“ \(Vorrang\) seit/);
  });

  it('hero/flyout status line names both runs; "sync all" stays possible while an account is free', () => {
    const g = globalStatus(s, 'connected', null);
    expect(g.state).toBe('syncing');
    expect(g.detail).toBe('2 Läufe aktiv: Alex · Vollprüfung · Sam · Ordner „Sam Dokumente“ (Vorrang)');
    // Sam only has a priority run: her background lane is free
    expect(canSyncAll(s)).toBe(true);
    const allBusy = status({
      activeRuns: [run({ id: 30, lane: 'background', activeAccounts: ['alex'] })],
      currentRun: null,
    });
    expect(canSyncAll(allBusy)).toBe(false);
    expect(canSyncAll(status())).toBe(true);
  });

  it('a global run that released an account no longer counts for it', () => {
    const g = run({ id: 40, lane: 'background', activeAccounts: ['alex'] });
    const st = status({ activeRuns: [g], accounts: [...status().accounts, sam] });
    expect(runsOfAccount(st, 'sam').active).toEqual([]);
    expect(runsOfAccount(st, 'alex').active).toEqual([g]);
  });

  it('older daemons (only currentRun) still work', () => {
    const old = normalizeStatus({ ...status({ currentRun: long }), activeRuns: undefined, queuedRuns: undefined });
    expect(old!.activeRuns!.map((r) => r.id)).toEqual([19]);
    expect(old!.queuedRuns).toEqual([]);
    const legacy = run({ id: 7 }); // no activeAccounts, accountId null = global
    expect(runsOfAccount(status({ currentRun: legacy }), 'alex').active).toEqual([legacy]);
    const n = normalizeStatus(s)!;
    expect(n.activeRuns!.map((r) => r.id)).toEqual([19, 23]);
    expect(n.queuedRuns!.map((r) => r.waitingFor)).toEqual([[19]]);
  });
});
