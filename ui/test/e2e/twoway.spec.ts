// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Two-way pairs in the UI against the real mock daemon (English, the default language; German after a switch in
 * Settings): direction badge and choice, last remote check, the two-way pair options, the "kept both" conflict
 * review and the mass-delete approval — also by keyboard (safe choice first, the confirm dialog focuses "Cancel").
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { NucleonSyncClient, resolvePaths, type ConflictDto, type PairDto, type StatusDto } from '@nucleon-sync/shared';

import { de } from '../../src/renderer/i18n/de.ts';
import { en } from '../../src/renderer/i18n/en.ts';
import {
  cleanup,
  displayEnv,
  launchUi,
  ROOT,
  startDaemon,
  tempDir,
  type Launched,
  type MockDaemon,
} from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

const SEED = path.join(ROOT, 'mock-cli/bin/mock-proton-drive-seed');
/** TWOWAY_SHOTS=<dir>: save screenshots of the two-way screens there (manual visual check) */
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.TWOWAY_SHOTS) await page.screenshot({ path: path.join(process.env.TWOWAY_SHOTS, `${name}.png`) });
};
const T = new Date('2025-03-01T10:00:00Z');

test.describe('two-way pairs', () => {
  let home: string;
  let daemon: MockDaemon;
  let ui: Launched;
  let client: NucleonSyncClient;
  let pair: PairDto;
  let local: string;
  const idle = async () => {
    await expect
      .poll(
        async () => {
          const s = await client.request<StatusDto>('GET', '/v1/status');
          return !s.currentRun && s.queue.queued + s.queue.running + s.queue.retryWait === 0;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  };
  const syncPair = async () => {
    await client.request('POST', '/v1/sync', { pairId: pair.id });
    await new Promise((r) => setTimeout(r, 300));
    await idle();
  };

  test.beforeAll(async () => {
    home = tempDir('twoway');
    daemon = await startDaemon(home);
    const paths = resolvePaths({ NUCLEON_SYNC_HOME: home });
    client = new NucleonSyncClient({
      socketPath: paths.socketFile,
      token: readFileSync(paths.tokenFile, 'utf8').trim(),
    });
    local = path.join(home, 'Zwei');
    mkdirSync(local, { recursive: true });
    for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      writeFileSync(path.join(local, n), `content of ${n}`);
      utimesSync(path.join(local, n), T, T);
    }
    pair = await client.request<PairDto>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Zwei',
      localRoot: local,
      remoteRoot: '/my-files/Zwei',
      direction: 'two-way',
      enabled: true,
      createRemote: true,
    });
    await syncPair();
    // no language override, so Settings → Language can switch to German later
    ui = await launchUi({
      home,
      env: { NUCLEON_SYNC_UI_LANG: '', LANGUAGE: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'en_US.UTF-8' },
    });
  });
  test.afterAll(async () => {
    await ui?.close();
    await daemon?.stop();
    cleanup(home);
  });

  test('badge on the overview, direction choice, last remote check and two-way options in Folders', async () => {
    const { page } = ui;
    const row = page.getByTestId(`pair-row-${pair.id}`);
    await expect(row).toContainText(en.pair.directionShort['two-way']);
    await page.locator('[data-nav="folders"]').click();
    await page.getByTestId('pair-select').selectOption(String(pair.id));
    await expect(page.getByTestId('pair-notes')).toContainText('Proton last checked');
    await shot(page, 'twoway-folders');
    const options = await page.locator('.pair-controls select').first().locator('option').allTextContents();
    expect(options).toContain(en.pair.direction['two-way']);
    // pair settings: remote check interval and mass-delete thresholds (saved on Enter)
    await page.getByTestId('pair-settings').locator('summary').click();
    const max = page.getByTestId('pair-opt-massDeleteMaxFiles');
    await expect(max).toHaveValue('20');
    await max.fill('1');
    await max.press('Enter');
    await expect
      .poll(async () => (await client.request<PairDto>('GET', `/v1/pairs/${pair.id}`)).options?.massDeleteMaxFiles)
      .toBe(1);
    await shot(page, 'twoway-pair-settings');
  });

  test('both sides changed: both kept, review card, "Keep Proton version" cleans up after a confirm', async () => {
    const { page } = ui;
    writeFileSync(path.join(local, 'a.txt'), 'edited here');
    utimesSync(path.join(local, 'a.txt'), new Date('2025-05-01'), new Date('2025-05-01'));
    execFileSync(SEED, [
      '--remote',
      path.join(home, 'mock/remote-alex'),
      '--edit',
      '/my-files/Zwei/a.txt',
      '--content',
      'edited elsewhere',
    ]);
    await syncPair();
    const c = (await client.request<ConflictDto[]>('GET', '/v1/conflicts')).find((x) => x.relPath === 'a.txt')!;
    expect(c.keptBoth?.copyRelPath).toMatch(/^a \(conflict .+\)\.txt$/);
    await page.locator('[data-nav="issues"]').click();
    const card = page.getByTestId(`conflict-${c.id}`);
    await expect(card).toContainText(en.issues.keptBoth);
    await expect(card.getByTestId(`open-both-${c.id}`)).toBeVisible();
    await expect(page.getByTestId(`conflict-note-${c.id}`)).toContainText(c.keptBoth!.copyRelPath!);
    await shot(page, 'twoway-conflict-review');
    // keyboard: the review buttons are reachable; Enter opens the confirm dialog with "Cancel" focused, Esc = no-op
    const keepRemote = card.getByRole('button', { name: en.issues.reviewKeepRemote });
    await keepRemote.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Clean up conflict: a.txt`);
    await expect(dialog).toContainText('goes to the trash locally and in Proton');
    await expect(dialog.getByRole('button', { name: en.actions.cancel })).toBeFocused();
    await shot(page, 'twoway-review-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // cancelled: the local version's copy is still there
    expect(readFileSync(path.join(local, c.keptBoth!.copyRelPath!), 'utf8')).toBe('edited here');
    await expect(card).toBeVisible();
    // now for real: Tab from "Cancel" to the confirm button
    await keepRemote.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: en.actions.cancel })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: en.confirm.proceed })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card).toHaveCount(0);
    await idle();
    await expect.poll(() => readFileSync(path.join(local, 'a.txt'), 'utf8')).toBe('edited elsewhere');
  });

  test('mass-delete guard: held deletions card (also in German), keyboard, approval dialog, pair runs again', async () => {
    const { page } = ui;
    rmSync(path.join(local, 'b.txt'));
    rmSync(path.join(local, 'c.txt'));
    await syncPair();
    await expect.poll(async () => (await client.request<PairDto>('GET', `/v1/pairs/${pair.id}`)).heldDeletions).toBe(2);
    await page.locator('[data-nav="overview"]').click();
    await expect(page.getByTestId(`pair-row-${pair.id}`)).toContainText('2 deletions held');
    await page.locator('[data-nav="issues"]').click();
    await page.getByRole('tab', { name: new RegExp(en.issues.tabDeletions) }).click();
    const held = page.getByTestId(`held-${pair.id}`);
    await expect(held).toContainText(en.issues.heldTitle('Zwei', 2));
    await expect(held).toContainText(en.issues.heldLocal(2));
    await shot(page, 'twoway-held');
    // the safe choice comes first in the card's tab order
    const deny = held.getByTestId(`held-deny-${pair.id}`);
    const approve = held.getByTestId(`held-approve-${pair.id}`);
    await deny.focus();
    await page.keyboard.press('Tab');
    await expect(approve).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Carry out 2 held deletions in "Zwei"');
    await expect(dialog).toContainText('2 files deleted here → Proton trash');
    await expect(dialog.getByRole('button', { name: en.actions.cancel })).toBeFocused();
    await shot(page, 'twoway-held-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect((await client.request<PairDto>('GET', `/v1/pairs/${pair.id}`)).heldDeletions).toBe(2);

    // German: the same card and dialog in the second language (Settings → Language)
    await page.locator('[data-nav="settings"]').click();
    await page.getByTestId('language-select').selectOption('de');
    await expect(page.locator('[data-nav="overview"]')).toContainText(de.nav.overview);
    await page.locator('[data-nav="issues"]').click();
    await page.getByRole('tab', { name: new RegExp(de.issues.tabDeletions) }).click();
    const heldDe = page.getByTestId(`held-${pair.id}`);
    await expect(heldDe).toContainText(de.issues.heldTitle('Zwei', 2));
    await expect(heldDe.getByTestId(`held-deny-${pair.id}`)).toHaveText(de.issues.heldDeny);
    await shot(page, 'de-twoway-held');
    await heldDe.getByTestId(`held-approve-${pair.id}`).click();
    await expect(dialog).toContainText('2 angehaltene Löschungen in „Zwei“ ausführen');
    await expect(dialog).toContainText('2 lokal gelöschte Dateien → Proton-Papierkorb');
    await shot(page, 'de-twoway-held-dialog');
    await dialog.getByRole('button', { name: de.confirm.proceed }).click();
    await expect.poll(async () => (await client.request<PairDto>('GET', `/v1/pairs/${pair.id}`)).heldDeletions).toBe(0);
    await idle();
    await expect(heldDe).toHaveCount(0);
    await page.locator('[data-nav="settings"]').click();
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.locator('[data-nav="overview"]')).toContainText(en.nav.overview);
  });
});
