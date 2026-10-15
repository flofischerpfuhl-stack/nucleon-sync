// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * several active runs at once (Alex's long background run, Sam's pair run in the priority lane,
 * a queued Alex run) render in the overview hero, the account cards and the tray flyout. Demo fixtures.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { RunDto, StatusDto } from '@nucleon-sync/shared';

import { displayEnv, flyoutPage, launchUi, tempDir, cleanup, type Launched } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

const SHOTS = process.env.NUCLEON_SYNC_SHOTS_DIR ?? path.join(tempDir('par-shots'));

const fx = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      (window as unknown as { __psFixtures: Record<string, (...x: unknown[]) => unknown> }).__psFixtures[n as string]!(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  );

const counters = (scanned: number): RunDto['counters'] => ({
  scannedLocal: scanned,
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

function withRuns(s: StatusDto): StatusDto {
  const samPair = s.pairs.find((p) => p.accountId === 'sam')!;
  const long: RunDto = {
    id: 19,
    trigger: 'schedule',
    mode: 'full',
    accountId: 'alex',
    pairId: null,
    startedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    finishedAt: null,
    status: 'running',
    lane: 'background',
    activeAccounts: ['alex'],
    counters: counters(441_020),
  };
  const pairRun: RunDto = {
    id: 23,
    trigger: 'api',
    mode: 'incremental',
    accountId: 'sam',
    pairId: samPair.id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    lane: 'priority',
    activeAccounts: ['sam'],
    counters: counters(812),
  };
  const queued: RunDto = { ...long, id: 24, mode: 'incremental', status: 'queued', waitingFor: [19] };
  delete (queued as Partial<RunDto>).activeAccounts;
  return {
    ...s,
    state: 'syncing',
    currentRun: pairRun,
    activeRuns: [long, pairRun],
    queuedRuns: [queued],
    accounts: s.accounts.map((a) => ({
      ...a,
      activeRunIds: a.id === 'alex' ? [19] : [23],
      queuedRunIds: a.id === 'alex' ? [24] : [],
    })),
  };
}

let ui: Launched;
let home: string;
test.beforeAll(async () => {
  home = tempDir('par-ui');
  mkdirSync(SHOTS, { recursive: true });
  ui = await launchUi({ home, fixtures: 'demo' });
});
test.afterAll(async () => {
  await ui?.close();
  cleanup(home);
});

test('overview: hero lists both runs, account cards show their own run and the queued one', async () => {
  const { page } = ui;
  await expect(page.getByTestId('account-alex')).toBeVisible();
  const status = (await fx(page, 'call', 'GET', '/v1/status')) as StatusDto;
  await fx(page, 'emit', { type: 'status', status: withRuns(status) });
  await expect(page.getByTestId('hero-title')).toHaveText('2 Läufe aktiv');
  await expect(page.getByTestId('hero-run-19')).toContainText('#19 Alex · Vollprüfung');
  await expect(page.getByTestId('hero-run-23')).toContainText('(Vorrang)');
  await expect(page.getByTestId('account-run-alex')).toContainText('Lauf #19: Vollprüfung seit');
  await expect(page.getByTestId('account-run-alex')).toContainText('Lauf #24 wartet auf #19');
  await expect(page.getByTestId('account-run-sam')).toContainText('Lauf #23: Ordner');
  // Sam has no background run: "Jetzt synchronisieren" stays available
  await expect(page.getByRole('button', { name: 'Jetzt synchronisieren' })).toBeEnabled();
  await page.screenshot({ path: path.join(SHOTS, 'overview-parallel-runs.png'), fullPage: true });
});

test('tray flyout: per-account run notes', async () => {
  const fly = await flyoutPage(ui.app);
  await fly.waitForSelector('[data-testid="flyout"]');
  const status = (await fx(fly, 'call', 'GET', '/v1/status')) as StatusDto;
  await fx(fly, 'emit', { type: 'status', status: withRuns(status) });
  await expect(fly.getByTestId('fly-acc-alex')).toContainText('#19 läuft');
  await expect(fly.getByTestId('fly-acc-sam')).toContainText('#23 läuft');
  await expect(fly.getByTestId('fly-title')).toHaveText('Synchronisiere …');
});
