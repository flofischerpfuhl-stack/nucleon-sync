// SPDX-License-Identifier: GPL-3.0-or-later
/** e2e against the real mock daemon (scripts/dev-env.mjs in a temp NUCLEON_SYNC_HOME). */
import { expect, test } from '@playwright/test';

import {
  cleanup,
  displayEnv,
  launchUi,
  startDaemon,
  tempDir,
  trayState,
  type Launched,
  type MockDaemon,
} from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

let home: string;
let daemon: MockDaemon;
let ui: Launched;

test.beforeAll(async () => {
  home = tempDir('daemon');
  daemon = await startDaemon(home);
  ui = await launchUi({ home });
});

test.afterAll(async () => {
  await ui?.close();
  await daemon?.stop();
  cleanup(home);
});

test('overview lists both mock accounts', async () => {
  const { page } = ui;
  await expect(page.getByTestId('account-alex')).toBeVisible();
  await expect(page.getByTestId('account-sam')).toBeVisible();
  await expect(page.getByTestId('account-alex')).toContainText('alex@mock.test');
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'idle');
  await expect.poll(() => trayState(ui.app)).toBe('idle');
});

test('"Jetzt synchronisieren" starts a run; new activity rows arrive via SSE without reload', async () => {
  const { page } = ui;
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42));
  await page.getByTestId('hero').getByRole('button', { name: 'Jetzt synchronisieren' }).click();
  await expect(page.getByTestId('recent-activity')).toContainText('hochgeladen', { timeout: 20_000 }); // real engine: alex uploads, sam downloads
  await expect(page.getByTestId('recent-activity')).toContainText('Sam');
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(42);
  await expect(page.getByTestId('hero-title')).toContainText('Alles synchronisiert');
});

test('pause/resume reflect in the header and tray state', async () => {
  const { page, app } = ui;
  await page.getByTestId('hero').getByRole('button', { name: 'Pausieren' }).click();
  await page.getByRole('menuitem', { name: 'Unbegrenzt' }).click();
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'paused');
  await expect(page.getByTestId('statusline')).toContainText('Pausiert');
  await expect.poll(() => trayState(app)).toBe('paused');
  await page.getByTestId('hero').getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'idle');
  await expect.poll(() => trayState(app)).toBe('idle');

  // timed pause: main remembers the end time and shows it
  await page.getByTestId('hero').getByRole('button', { name: 'Pausieren' }).click();
  await page.getByRole('menuitem', { name: '1 Stunde' }).click();
  await expect(page.getByTestId('statusline')).toContainText('Pausiert bis');
  const until = await app.evaluate(() =>
    (globalThis as unknown as { __psTest: { pauseUntil: () => string | null } }).__psTest.pauseUntil(),
  );
  expect(Date.parse(until!) - Date.now()).toBeGreaterThan(55 * 60_000);
  const labels = await app.evaluate(() =>
    (globalThis as unknown as { __psTest: { menuLabels: () => string[] } }).__psTest.menuLabels(),
  );
  expect(labels.some((l) => l.startsWith('Fortsetzen (pausiert bis'))).toBe(true);
  await page.getByTestId('hero').getByRole('button', { name: 'Fortsetzen' }).click();
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'idle');
});

test('stopping the daemon shows the disconnect banner; the UI reconnects when it returns', async () => {
  const { page, app } = ui;
  await daemon.stop();
  await expect(page.getByTestId('disconnect-banner')).toBeVisible();
  await expect(page.getByTestId('statusline')).toContainText('Dienst nicht erreichbar');
  await expect.poll(() => trayState(app)).toBe('error');
  daemon = await startDaemon(home);
  await expect(page.getByTestId('disconnect-banner')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('account-sam')).toBeVisible();
});

test('desktop notifications from notice events (de-duplicated)', async () => {
  const { app } = ui;
  const notice = {
    type: 'notice',
    notice: {
      key: 'error:auth:sam',
      severity: 'error',
      // English text + message keys of the service; the notification shows them in the UI language
      title: 'Sign-in required',
      body: 'The account Sam must be signed in again.',
      titleMsg: { key: 'notice.loginNeeded' },
      bodyMsg: { key: 'notice.loginNeededBody', params: { account: 'Sam' } },
    },
  };
  type Hook = { __psTest: { handleEvent: (e: unknown) => void; notifications: { title: string }[] } };
  await app.evaluate((_e, n) => (globalThis as unknown as Hook).__psTest.handleEvent(n), notice);
  await app.evaluate((_e, n) => (globalThis as unknown as Hook).__psTest.handleEvent(n), notice);
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as Hook).__psTest.notifications.length)).toBe(1);
  const n = await app.evaluate(() => (globalThis as unknown as Hook).__psTest.notifications[0]);
  expect(n?.title).toBe('Anmeldung nötig');
});
