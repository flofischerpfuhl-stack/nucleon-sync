// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Screenshots of every screen (dark + light, English = the default language) on demo fixtures, plus German, the
 * keyboard help, the agent approval dialog, Settings → Agents and an Omarchy theme -> ui/test/screenshots/.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { de } from '../../src/renderer/i18n/de.ts';
import { en } from '../../src/renderer/i18n/en.ts';
import { UI_DIR, cleanup, displayEnv, flyoutPage, launchUi, tempDir } from './helpers.ts';

test.skip(!displayEnv(), 'needs an X display');
const OUT = path.join(UI_DIR, 'test/screenshots');
const SCREENS = ['overview', 'activity', 'folders', 'issues', 'storage', 'accounts', 'settings', 'maintenance'];

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

for (const theme of ['dark', 'light'] as const) {
  test(`all screens (${theme})`, async () => {
    mkdirSync(OUT, { recursive: true });
    const home = tempDir('shots');
    const ui = await launchUi({ home, fixtures: 'demo', colorScheme: theme, lang: 'en' });
    try {
      const { page, app } = ui;
      for (const s of SCREENS) {
        await page.locator(`[data-nav="${s}"]`).click();
        await expect(page.locator(`.screen-${s}`)).toBeVisible();
        await shot(page, `${s}-${theme}`);
      }
      const fly = await flyoutPage(app);
      await expect(fly.getByTestId('flyout')).toBeVisible();
      await fly.waitForTimeout(500);
      await fly.screenshot({ path: path.join(OUT, `flyout-${theme}.png`) });
      if (theme === 'dark') {
        await page.locator('[data-nav="activity"]').click();
        await page.getByTestId('activity-row').first().click();
        await expect(page.getByTestId('activity-detail')).toBeVisible();
        await shot(page, 'activity-detail-dark');
        await page.locator('[data-nav="issues"]').click();
        await page.getByRole('tab', { name: new RegExp(en.issues.tabDeletions) }).click();
        await shot(page, 'issues-deletions-dark');
        await page.getByTestId('deletion-bar').getByRole('button', { name: en.issues.trashRemote }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await shot(page, 'confirm-dialog-dark');
        await page.getByRole('alertdialog').getByRole('button', { name: en.actions.cancel }).click();
        await page.getByRole('tab', { name: new RegExp(en.issues.tabAdoptions) }).click();
        await shot(page, 'issues-adoptions-dark');
        await page.locator('[data-nav="folders"]').click();
        await page.locator('[data-path="Projects"] button[aria-expanded]').click();
        await page.locator('[data-path="Projects/nucleon-sync"] button[aria-expanded]').click();
        await page.locator('[data-path="Old-Archive"] [role=checkbox]').click();
        await shot(page, 'folders-changes-dark');
        await page.getByTestId('add-pair').click();
        // unapplied selection changes: the app asks first (fix-ui-round1 #7)
        await expect(page.getByTestId('choice-dialog')).toBeVisible();
        await shot(page, 'unsaved-dialog-dark');
        await page.getByTestId('choice-dialog').locator('[data-choice=discard]').click();
        await page.locator('.choice').first().click();
        await page.getByRole('button', { name: en.actions.next }).click();
        await shot(page, 'pair-wizard-dark');
        await page.locator('[data-nav="overview"]').click();
        await page.locator('[data-nav="folders"]').click();
        await page.getByTestId('pair-settings').locator('summary').click();
        await shot(page, 'folders-pair-settings-dark');
        await page.locator('[data-nav="accounts"]').click();
        await page.getByRole('button', { name: en.accounts.add.replace('+ ', '') }).click();
        await page.getByLabel(en.accounts.nameLabel).fill('Robin');
        await page.getByRole('button', { name: en.accounts.startLogin }).click();
        await expect(page.getByTestId('login-url')).toBeVisible();
        await shot(page, 'login-dialog-dark');
        // agent layer: Settings → Agents, approval dialog, keyboard help
        await page.locator('[data-nav="settings"]').click();
        await page.getByTestId('agents-card').scrollIntoViewIfNeeded();
        await shot(page, 'settings-agents-dark');
        await page.evaluate(() =>
          (window as unknown as { __psFixtures: { demoApproval: () => void } }).__psFixtures.demoApproval(),
        );
        await expect(page.getByTestId('approval-dialog')).toBeVisible();
        await shot(page, 'approval-dialog-dark');
        await page.keyboard.press('Escape');
        await page.locator('#main').focus();
        await page.keyboard.press('?');
        await expect(page.getByTestId('help-dialog')).toBeVisible();
        await shot(page, 'keyboard-help-dark');
        await page.keyboard.press('Escape');
        await page.locator('[data-nav="maintenance"]').click();
        await page.getByTestId('job-queue').scrollIntoViewIfNeeded();
        await shot(page, 'maintenance-queue-cli-dark');
        await page.locator('[data-nav="overview"]').click();
        await page.getByTestId('hero').getByRole('button', { name: en.actions.syncNow }).click();
        await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'syncing');
        await shot(page, 'overview-syncing-dark');
      }
    } finally {
      await ui.close();
      cleanup(home);
    }
  });
}

test('German UI (second language)', async () => {
  mkdirSync(OUT, { recursive: true });
  const home = tempDir('shots-de');
  const ui = await launchUi({ home, fixtures: 'demo', colorScheme: 'dark', lang: 'de' });
  try {
    const { page } = ui;
    await expect(page.locator('[data-nav="overview"]')).toContainText(de.nav.overview);
    await shot(page, 'de-overview-dark');
    await page.locator('[data-nav="settings"]').click();
    await shot(page, 'de-settings-dark');
  } finally {
    await ui.close();
    cleanup(home);
  }
});

test('Omarchy theme (colors.toml of the current theme)', async () => {
  mkdirSync(OUT, { recursive: true });
  const home = tempDir('shots-omarchy');
  const fakeHome = tempDir('omarchy-home');
  const dir = path.join(fakeHome, '.local/state/omarchy/current/theme');
  mkdirSync(dir, { recursive: true });
  // Omarchy's built-in "tokyo-night"-like palette
  writeFileSync(
    path.join(dir, 'colors.toml'),
    [
      'mode = "dark"',
      'accent = "#7aa2f7"',
      'background = "#1a1b26"',
      'dark_background = "#16161e"',
      'foreground = "#c0caf5"',
      'red = "#f7768e"',
      'green = "#9ece6a"',
      'yellow = "#e0af68"',
      'blue = "#7aa2f7"',
      'cyan = "#7dcfff"',
    ].join('\n') + '\n',
  );
  writeFileSync(path.join(fakeHome, '.local/state/omarchy/current/theme.name'), 'tokyo-night\n');
  const ui = await launchUi({ home, fixtures: 'demo', lang: 'en', env: { HOME: fakeHome, NUCLEON_SYNC_UI_THEME: '' } });
  try {
    const { page } = ui;
    await expect(page.locator('html')).toHaveAttribute('data-theme-source', 'omarchy');
    await shot(page, 'omarchy-overview');
    await page.locator('[data-nav="settings"]').click();
    await shot(page, 'omarchy-settings');
  } finally {
    await ui.close();
    cleanup(home);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
