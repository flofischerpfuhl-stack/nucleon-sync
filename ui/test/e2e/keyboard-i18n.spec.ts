// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * agent-omarchy e2e (offscreen Electron on demo fixtures, Xvfb): English default + language switch, keyboard
 * shortcuts and help overlay, focus handling, the agent approval dialog, agent tokens in Settings, and the Omarchy
 * theme (colors.toml of a fake HOME, live re-read after a theme switch).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { de } from '../../src/renderer/i18n/de.ts';
import { en } from '../../src/renderer/i18n/en.ts';
import { cleanup, displayEnv, fixtureCalls, launchUi, tempDir, type Launched } from './helpers.ts';

test.skip(!displayEnv(), 'needs an X display');

let home: string;
let ui: Launched | null = null;
test.beforeEach(() => {
  home = tempDir('kbd');
});
test.afterEach(async () => {
  await ui?.close();
  ui = null;
  cleanup(home);
});

const press = (page: Page, key: string) => page.keyboard.press(key);

test('English is the default; Settings → Language switches to German and back', async () => {
  // no override, an English system locale → English
  ui = await launchUi({
    home,
    fixtures: 'demo',
    env: { NUCLEON_SYNC_UI_LANG: '', LANGUAGE: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'en_US.UTF-8' },
  });
  const { page } = ui;
  await expect(page.locator('[data-nav="overview"]')).toContainText(en.nav.overview);
  await page.locator('[data-nav="settings"]').click();
  const select = page.getByTestId('language-select');
  await select.selectOption('de');
  await expect(page.locator('[data-nav="overview"]')).toContainText(de.nav.overview);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  // numbers/dates follow the language too (German weekday in the next-run text etc.)
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.locator('[data-nav="overview"]')).toContainText(en.nav.overview);
});

test('keyboard: screen digits, / search, ? help, s sync, p pause, Esc', async () => {
  ui = await launchUi({ home, fixtures: 'demo', lang: 'en' });
  const { page } = ui;
  await page.locator('#main').focus();
  await press(page, '2');
  await expect(page.locator('.screen-activity')).toBeVisible();
  await press(page, '1');
  await expect(page.locator('.screen-overview')).toBeVisible();
  // / jumps to the activity search box
  await press(page, '/');
  await expect(page.getByTestId('activity-search')).toBeFocused();
  // typing in a field never triggers shortcuts
  await page.keyboard.type('s2');
  await expect(page.locator('.screen-activity')).toBeVisible();
  await page.getByTestId('activity-search').blur();
  // ? opens the help, focus is inside, Esc closes and gives the focus back
  await press(page, '?');
  const help = page.getByTestId('help-dialog');
  await expect(help).toBeVisible();
  await expect(help).toContainText(en.keys.title);
  await expect(help).toContainText(en.keys.syncNow);
  await press(page, 'Tab');
  expect(await help.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await press(page, 'Escape');
  await expect(help).toBeHidden();
  // s = sync now, p = pause
  await press(page, 's');
  await expect.poll(async () => (await fixtureCalls(page, 'POST', '/v1/sync')).length).toBeGreaterThan(0);
  await press(page, 'p');
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'paused');
  await press(page, 'p');
  await expect(page.getByTestId('statusline')).not.toHaveAttribute('data-state', 'paused');
  // 7 = settings; every control is reachable with Tab and shows a focus ring
  await press(page, '7');
  await expect(page.locator('.screen-settings')).toBeVisible();
  await press(page, 'Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
});

test('arrow keys move through the activity table; Enter opens the detail', async () => {
  ui = await launchUi({ home, fixtures: 'demo', lang: 'en' });
  const { page } = ui;
  await page.locator('[data-nav="activity"]').click();
  const first = page.getByTestId('activity-row').first();
  await first.focus();
  await press(page, 'ArrowDown');
  const focusedIsRow = await page.evaluate(
    () =>
      (document.activeElement as HTMLElement | null)?.dataset.testid === 'activity-row' ||
      !!document.activeElement?.closest('.vrow'),
  );
  expect(focusedIsRow).toBe(true);
  await press(page, 'Enter');
  await expect(page.getByTestId('activity-detail')).toBeVisible();
});

test('an agent asks for approval: dialog with the localized summary, approve once', async () => {
  ui = await launchUi({ home, fixtures: 'demo', lang: 'en' });
  const { page } = ui;
  await page.evaluate(() =>
    (window as unknown as { __psFixtures: { demoApproval: () => void } }).__psFixtures.demoApproval(),
  );
  const dlg = page.getByTestId('approval-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(en.agents.approvalTitle('claude'));
  await expect(dlg).toContainText('Remove pair "Outbox"');
  // focus starts on "Deny" (the safe choice); Tab reaches "Approve"
  await expect(dlg.getByRole('button', { name: en.agents.deny })).toBeFocused();
  await press(page, 'Tab');
  await expect(dlg.getByRole('button', { name: en.agents.approve })).toBeFocused();
  await press(page, 'Enter');
  await expect(dlg).toBeHidden();
  expect((await fixtureCalls(page, 'POST', '/v1/approvals/a1b2c3/approve')).length).toBe(1);
});

test('Settings → Agents: create a token with scopes (keyboard only) and see the secret once', async () => {
  ui = await launchUi({ home, fixtures: 'demo', lang: 'en' });
  const { page } = ui;
  await page.locator('[data-nav="settings"]').click();
  const card = page.getByTestId('agents-card');
  await expect(card.getByTestId('token-claude')).toBeVisible();
  await card.getByTestId('create-token').focus();
  await press(page, 'Enter');
  const dlg = page.getByTestId('create-token-dialog');
  await expect(page.getByTestId('token-name')).toBeFocused();
  await page.keyboard.type('codex');
  await press(page, 'Enter');
  await expect(page.getByTestId('token-secret-dialog')).toBeVisible();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('token-secret')).toContainText('nst_demo');
  const calls = await fixtureCalls(page, 'POST', '/v1/tokens');
  expect(calls[0]!.body).toMatchObject({ name: 'codex', scopes: ['read', 'sync'], writeFile: true });
  await press(page, 'Escape');
  await expect(page.getByTestId('token-secret-dialog')).toBeHidden();
  await expect(card.getByTestId('token-codex')).toBeVisible();
});

function writeTheme(fakeHome: string, name: string, colors: Record<string, string>): void {
  const cur = path.join(fakeHome, '.local/state/omarchy/current');
  const next = path.join(cur, 'next-theme');
  mkdirSync(next, { recursive: true });
  writeFileSync(
    path.join(next, 'colors.toml'),
    Object.entries(colors)
      .map(([k, v]) => `${k} = "${v}"`)
      .join('\n') + '\n',
  );
  // like omarchy-theme-set: rm -rf current/theme && mv next-theme current/theme, then theme.name
  rmSync(path.join(cur, 'theme'), { recursive: true, force: true });
  renameSync(next, path.join(cur, 'theme'));
  writeFileSync(path.join(cur, 'theme.name'), name + '\n');
}

test('Omarchy: the UI takes the current theme colours and follows a theme switch', async () => {
  const fakeHome = tempDir('omarchy-home');
  writeTheme(fakeHome, 'solitude', {
    mode: 'dark',
    accent: '#798186',
    background: '#101315',
    foreground: '#cacccc',
    red: '#de6145',
    green: '#9fa5a9',
    yellow: '#d9dbdc',
    blue: '#798186',
  });
  ui = await launchUi({ home, fixtures: 'demo', lang: 'en', env: { HOME: fakeHome, NUCLEON_SYNC_UI_THEME: '' } });
  const { page } = ui;
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  await expect.poll(bg).toBe('#101315');
  await expect(page.locator('html')).toHaveAttribute('data-theme-source', 'omarchy');
  writeTheme(fakeHome, 'white', { mode: 'light', accent: '#3b6ea8', background: '#ffffff', foreground: '#1e1e1e' });
  await expect.poll(bg, { timeout: 10_000 }).toBe('#ffffff');
  await page.locator('[data-nav="settings"]').click();
  await expect(page.getByTestId('appearance-card')).toContainText('Omarchy theme "white"');
  rmSync(fakeHome, { recursive: true, force: true });
});
