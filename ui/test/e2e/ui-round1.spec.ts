// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * fix-ui-round1 regression e2e (defects found while recording the demo videos):
 *  1 Speicher "Aktualisieren" measures (POST /v1/storage/measure) with progress, then reloads; first measurement offer
 *  2 "noch nicht gemessen" instead of "0 B"; clean account footer without "zuletzt OK –"
 *  3 no blank window: persisted screen validated, every screen survives missing/empty data, error boundary fallback
 *  4 tray flyout and main window show the same storage numbers and conflict counts
 *  5 activity time column on one line, chart follows the time filter
 *  6 pair wizard: "Weiter" disabled while the local folder check is pending
 *  7 unapplied selection changes are never dropped silently (new pair, other screen)
 * Mostly against NUCLEON_SYNC_UI_FIXTURES=demo; the startup case also against the mock daemon.
 */
import { expect, test, type Page } from '@playwright/test';

import { de as t } from '../../src/renderer/i18n/de.ts';
import {
  cleanup,
  displayEnv,
  fixtureCalls,
  flyoutPage,
  launchUi,
  startDaemon,
  tempDir,
  type Launched,
  type MockDaemon,
} from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

type FxName = 'override' | 'clearOverrides' | 'unmeasure' | 'crashScreen' | 'call' | 'emit';
/** calls a `window.__psFixtures` hook in the page (no eval: the renderer CSP forbids it) */
const fx = (page: Page, name: FxName, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      (window as unknown as { __psFixtures: Record<string, (...x: unknown[]) => unknown> }).__psFixtures[n as string]!(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  );

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

const SCREENS = Object.keys(t.nav) as (keyof typeof t.nav)[];
const title = (page: Page) => page.locator('.topbar h1');

// ------------------------------------------------------------------ against the mock daemon

test.describe('mock daemon', () => {
  let home: string;
  let daemon: MockDaemon;
  let ui: Launched;
  test.beforeAll(async () => {
    home = tempDir('round1-daemon');
    daemon = await startDaemon(home);
    ui = await launchUi({ home });
  });
  test.afterAll(async () => {
    await ui?.close();
    await daemon?.stop();
    cleanup(home);
  });

  test('#3 persisted "Speicher" screen renders at startup (status still loading) instead of a blank window', async () => {
    const { page } = ui;
    const errors = collectErrors(page);
    await page.evaluate(() => localStorage.setItem('ps.screen', 'storage'));
    await page.reload();
    await expect(title(page)).toHaveText(t.nav.storage);
    await expect(page.getByTestId('storage-refresh')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('#3 an invalid persisted screen id falls back to the overview', async () => {
    const { page } = ui;
    for (const bad of ['constructor', 'toString', 'gibtsnicht']) {
      await page.evaluate((b) => localStorage.setItem('ps.screen', b), bad);
      await page.reload();
      await expect(title(page)).toHaveText(t.nav.overview);
    }
  });

  test('#1 "Aktualisieren" starts a real measurement in the daemon and shows the new values', async () => {
    const { page } = ui;
    await page.locator('[data-nav="storage"]').click();
    // fresh mock home: never measured -> first-measurement offer, no "0 B" pretending to be a value
    await expect(page.getByTestId('storage-first')).toBeVisible();
    await expect(page.getByTestId('storage-measured')).toHaveText(t.storage.notMeasured);
    await page.getByTestId('storage-refresh').click();
    await expect(page.getByTestId('storage-measured')).toContainText('gemessen ', { timeout: 20_000 });
    await expect(page.getByTestId('storage-first')).toBeHidden();
    await expect(page.getByTestId('storage-alex')).not.toContainText(t.storage.notMeasured);
  });
});

// ------------------------------------------------------------------ demo fixtures

test.describe('demo fixtures', () => {
  let ui: Launched;
  let home: string;
  test.beforeAll(async () => {
    home = tempDir('round1-demo');
    ui = await launchUi({ home, fixtures: 'demo' });
  });
  test.afterAll(async () => {
    await ui?.close();
    cleanup(home);
  });

  test('#3 every screen survives being the persisted start screen', async () => {
    const { page } = ui;
    const errors = collectErrors(page);
    for (const s of SCREENS) {
      await page.evaluate((id) => localStorage.setItem('ps.screen', id), s);
      await page.reload();
      await expect(title(page), s).toHaveText(t.nav[s]);
      await page.waitForTimeout(250); // data arrives after the first render
      await expect(page.getByTestId('screen-crashed'), s).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await page.evaluate(() => localStorage.setItem('ps.screen', 'overview'));
    await page.reload();
  });

  test('#3 every screen renders with empty/missing data from the service', async () => {
    const { page } = ui;
    const errors = collectErrors(page);
    for (const [re, v] of [
      ['^/v1/storage$', {}],
      ['^/v1/storage/history$', []],
      ['^/v1/activity$', []],
      ['^/v1/runs$', []],
      ['^/v1/jobs$', []],
      ['^/v1/conflicts$', []],
      ['^/v1/deletions$', []],
      ['^/v1/adoptions$', []],
      ['^/v1/settings$', {}],
      ['^/v1/maintenance/summary$', {}],
      ['^/v1/doctor$', []],
      ['^/v1/pairs$', []],
      ['^/v1/accounts$', []],
      ['^/v1/pairs/\\d+/rules$', []],
      ['^/v1/pairs/\\d+/tree$', []],
    ] as [string, unknown][])
      await fx(page, 'override', 'GET', re, v);
    await fx(page, 'emit', { type: 'status', status: {} });
    for (const s of SCREENS) {
      await page.locator(`[data-nav="${s}"]`).click();
      await expect(title(page), s).toHaveText(t.nav[s]);
      await page.waitForTimeout(200);
      await expect(page.getByTestId('screen-crashed'), s).toHaveCount(0);
    }
    // and with a status that is missing completely (service answered garbage)
    await fx(page, 'emit', { type: 'status', status: null });
    for (const s of SCREENS) {
      await page.locator(`[data-nav="${s}"]`).click();
      await page.waitForTimeout(100);
      await expect(page.getByTestId('screen-crashed'), s).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await fx(page, 'clearOverrides');
    await page.reload();
  });

  test('#3 a crashing screen falls back to the overview with a notice; the persisted screen is reset', async () => {
    const { page } = ui;
    await fx(page, 'crashScreen', 'storage');
    await page.locator('[data-nav="storage"]').click();
    await expect(title(page)).toHaveText(t.nav.overview);
    await expect(page.getByTestId('screen-crashed')).toContainText('Speicher');
    expect(await page.evaluate(() => localStorage.getItem('ps.screen'))).toBe('overview');
    await fx(page, 'crashScreen', null);
    await page.getByTestId('screen-crashed').getByRole('button', { name: t.shell.screenCrashedRetry }).click();
    await expect(title(page)).toHaveText(t.nav.storage);
    await expect(page.getByTestId('screen-crashed')).toHaveCount(0);
  });

  test('#1 Speicher "Aktualisieren" calls POST /v1/storage/measure, shows progress, then reloads', async () => {
    const { page } = ui;
    await page.locator('[data-nav="storage"]').click();
    const getsBefore = (await fixtureCalls(page, 'GET', '/v1/storage')).filter((c) => c.path === '/v1/storage').length;
    await page.getByTestId('storage-refresh').click();
    await expect(page.getByTestId('storage-measuring')).toBeVisible();
    await expect(page.locator('.screen-storage [role=progressbar].indeterminate')).toBeVisible();
    const posts = await fixtureCalls(page, 'POST', '/v1/storage/measure');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ wait: false });
    await expect(page.getByTestId('storage-measuring')).toBeHidden({ timeout: 10_000 });
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    await expect(page.getByTestId('storage-measured')).toContainText(`gemessen `);
    await expect(page.getByTestId('storage-measured')).toContainText(`${hh}:`);
    const getsAfter = (await fixtureCalls(page, 'GET', '/v1/storage')).filter((c) => c.path === '/v1/storage').length;
    expect(getsAfter).toBeGreaterThan(getsBefore);
  });

  test('#2 never-measured storage reads "noch nicht gemessen" (overview, flyout, Speicher) with a measure offer', async () => {
    const { page, app } = ui;
    await fx(page, 'unmeasure');
    await page.locator('[data-nav="overview"]').click();
    await expect(page.getByTestId('account-storage-alex')).toHaveText(t.account.storageNotMeasured);
    await expect(page.getByTestId('account-storage-alex')).not.toContainText('0 B');
    await page.locator('[data-nav="storage"]').click();
    await expect(page.getByTestId('storage-first')).toContainText(t.storage.measureNow);
    const fly = await flyoutPage(app);
    await fx(fly, 'unmeasure');
    await expect(fly.getByTestId('fly-acc-alex')).toContainText(t.storage.notMeasured);
    // measuring from the offer brings the numbers back
    await page.getByTestId('storage-first').getByRole('button', { name: t.storage.measureNow }).click();
    await expect(page.getByTestId('storage-first')).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId('storage-measured')).toContainText('gemessen ');
  });

  test('#2 account footer without a last run has no stray "–" / separator', async () => {
    const { page } = ui;
    await fx(page, 'call', 'POST', '/v1/accounts', { id: 'robin', displayName: 'Robin' });
    await page.locator('[data-nav="overview"]').click();
    await expect(page.getByTestId('account-foot-robin')).toHaveText('Worker 0/1 · 0 Paare');
    await expect(page.getByTestId('account-storage-robin')).toHaveText(t.account.storageNotMeasured);
    const alex = await page.getByTestId('account-foot-alex').innerText();
    expect(alex).toMatch(/^Worker 2\/2 · Latenz .* · zuletzt OK .* · 3 Paare$/);
  });

  test('#4 tray flyout and main window agree on storage and on the conflict count after resolving', async () => {
    const { page, app } = ui;
    const fly = await flyoutPage(app);
    await fly.reload(); // fresh flyout state: catches up with the main window via the demo channel
    await page.locator('[data-nav="overview"]').click();
    await expect(page.getByTestId('account-storage-alex')).toContainText('392 GB');
    await expect(fly.getByTestId('fly-acc-alex')).toContainText('392 GB'); // the measured total, not only the /devices/Workstation pairs
    await expect(fly.getByTestId('fly-acc-sam')).toContainText('44 GB ·');
    const flyStatus = fly.locator('.fly-status');
    await expect(flyStatus).toContainText('3 Konflikte');
    // resolve one conflict in the main window -> the flyout count follows
    await page.locator('[data-nav="issues"]').click();
    await page.getByTestId('conflict-1').getByRole('button', { name: 'Lokal behalten ↑' }).click();
    await expect(page.getByTestId('conflict-1')).toBeHidden();
    await expect(flyStatus).toContainText('2 Konflikte');
    // a flyout opened only now (first tray click) starts from the same state
    await fly.reload();
    await expect(fly.locator('.fly-status')).toContainText('2 Konflikte');
  });

  test('#5 activity: multi-day time stays on one line; the chart follows the time filter', async () => {
    const { page } = ui;
    await page.locator('[data-nav="activity"]').click();
    await expect(page.getByTestId('activity-row').first()).toBeVisible();
    const fit = await page.evaluate(() => {
      const cell = document.querySelector<HTMLElement>('[data-testid=activity-row] .atime')!;
      cell.textContent = '09.10. 07:00';
      const range = document.createRange();
      range.selectNodeContents(cell);
      return {
        lines: range.getClientRects().length,
        overflow: cell.scrollWidth - cell.clientWidth,
        whiteSpace: getComputedStyle(cell).whiteSpace,
      };
    });
    expect(fit).toEqual({ lines: 1, overflow: 0, whiteSpace: 'nowrap' });
    const hist = page.locator('.hist');
    const chip = (label: string) =>
      page.getByRole('radiogroup', { name: t.activity.period }).getByRole('radio', { name: label, exact: true });
    await chip(t.activity.range.today).click();
    await expect(hist).toHaveAttribute('data-bars', '24');
    await expect(page.getByTestId('hist-title')).toHaveText(t.activity.histogramTitle.today);
    await chip(t.activity.range['7d']).click();
    await expect(hist).toHaveAttribute('data-bars', '7');
    await chip(t.activity.range['30d']).click();
    await expect(hist).toHaveAttribute('data-bars', '30');
    await expect(page.getByTestId('hist-title')).toHaveText(t.activity.histogramTitle['30d']);
    await chip(t.activity.range.all).click();
  });

  test('overview: "Ordner hinzufügen" on an account card opens the pair wizard', async () => {
    const { page } = ui;
    await page.locator('[data-nav="overview"]').click();
    const btn = page.locator('[data-testid^="add-folder-"]').first();
    await expect(btn).toHaveText(t.folders.addPair);
    await btn.click();
    await expect(page.getByTestId('wizard-next')).toBeVisible();
    await page.locator('[data-nav="overview"]').click();
  });

  test('#6 pair wizard: "Weiter" stays disabled until the local folder check finished', async () => {
    const { page } = ui;
    await page.locator('[data-nav="folders"]').click();
    await page.getByTestId('add-pair').click();
    const next = page.getByTestId('wizard-next');
    await next.click(); // account (preselected)
    await page.locator('.browser-item', { hasText: 'devices' }).click();
    await page.locator('.browser-item', { hasText: 'Laptop' }).click();
    await next.click(); // remote chosen
    const input = page.getByRole('textbox', { name: t.wizard.chooseLocal });
    await input.click();
    // the very first character: pending, not clickable — checked in the same task as the keystroke
    const afterFirstKey = await page.evaluate(async () => {
      const el = document.querySelector<HTMLInputElement>('input[aria-label="Lokalen Ordner wählen"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, '/');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      return (document.querySelector('[data-testid=wizard-next]') as HTMLButtonElement).disabled;
    });
    expect(afterFirstKey).toBe(true);
    await expect(page.getByTestId('local-checking')).toBeVisible();
    // "/" itself is rejected once checked
    await expect(page.getByTestId('local-error')).toContainText('Wurzelverzeichnis');
    await expect(next).toBeDisabled();
    await input.pressSequentially('data/Laptop-Kopie', { delay: 20 });
    await expect(next).toBeDisabled(); // still pending right after typing
    await expect(page.getByTestId('local-checking')).toBeHidden();
    await expect(next).toBeEnabled();
    // the folder of an existing pair is refused
    await input.fill('/home/alex/Documents');
    await expect(page.getByTestId('local-error')).toContainText('Documents');
    await expect(next).toBeDisabled();
    // nested inside an existing pair is allowed for two-way (the outer pair excludes it), with a hint
    await input.fill('/home/alex/Documents/Unterordner');
    await expect(page.getByTestId('local-nested')).toContainText('Documents');
    await expect(next).toBeEnabled();
    await page.getByRole('button', { name: t.actions.back }).click();
    await page.getByRole('button', { name: t.actions.back }).click();
    await page.getByRole('button', { name: t.actions.cancel }).click();
  });

  test('#7 "Paar" with unapplied selection changes asks first; apply/discard/back all work', async () => {
    const { page } = ui;
    await page.locator('[data-nav="folders"]').click();
    const cb = page.locator('[data-path="Home"] [role=checkbox]');
    await expect(cb).toBeVisible();
    const dialog = page.getByTestId('choice-dialog');
    const putsBefore = (await fixtureCalls(page, 'PUT', '/v1/pairs/1/rules')).length;

    // back: nothing happens, changes stay
    await cb.click();
    await expect(page.getByTestId('changes-bar')).toBeVisible();
    await page.getByTestId('add-pair').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 Ordner ausgeschlossen');
    await dialog.locator('[data-choice=stay]').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('changes-bar')).toBeVisible();
    await expect(page.locator('.wizard')).toHaveCount(0);

    // leaving via the sidebar asks too
    await page.locator('[data-nav="activity"]').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-choice=stay]').click();
    await expect(title(page)).toHaveText(t.nav.folders);

    // discard: wizard opens, nothing saved
    await page.getByTestId('add-pair').click();
    await dialog.locator('[data-choice=discard]').click();
    await expect(page.locator('.wizard')).toBeVisible();
    expect(await fixtureCalls(page, 'PUT', '/v1/pairs/1/rules')).toHaveLength(putsBefore);
    await page.getByRole('button', { name: t.actions.cancel }).click();

    // apply: rules saved, then the wizard opens
    await cb.click();
    await page.getByTestId('add-pair').click();
    await dialog.locator('[data-choice=apply]').click();
    await expect(page.locator('.wizard')).toBeVisible();
    expect(await fixtureCalls(page, 'PUT', '/v1/pairs/1/rules')).toHaveLength(putsBefore + 1);
    await page.getByRole('button', { name: t.actions.cancel }).click();
    await expect(page.getByTestId('changes-bar')).toHaveCount(0);
  });
});
