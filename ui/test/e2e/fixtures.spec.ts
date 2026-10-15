// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * e2e with NUCLEON_SYNC_UI_FIXTURES=demo (originally =1 while daemon endpoints answered 501/404): served by the
 * renderer fixture adapter, which records every call (window.__psFixtures.calls).
 */
import { expect, test } from '@playwright/test';

import type { SelectionRule } from '@nucleon-sync/shared';

import {
  cleanup,
  displayEnv,
  fixtureCalls,
  launchUi,
  startDaemon,
  tempDir,
  type Launched,
  type MockDaemon,
} from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

let home: string;
let daemon: MockDaemon;
let ui: Launched;

test.beforeAll(async () => {
  home = tempDir('fixtures');
  daemon = await startDaemon(home);
  // every endpoint is implemented by the daemon now, so the fallback adapter would never answer:
  // drive the same flows through the full fixture backend (it records every call)
  ui = await launchUi({ home, fixtures: 'demo' });
});

test.afterAll(async () => {
  await ui?.close();
  await daemon?.stop();
  cleanup(home);
});

const row = (path: string) => `[data-path="${path}"]`;

test('folder tree toggling produces the right SelectionRule[]', async () => {
  const { page } = ui;
  await page.locator('[data-nav="folders"]').click();
  await expect(page.locator(row('Home'))).toBeVisible();
  await expect(page.locator(`${row('Old-Archive')} [role=checkbox]`)).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator(`${row('Scratch')} [role=checkbox]`)).toHaveAttribute('aria-checked', 'mixed');

  await page.locator(`${row('Old-Archive')} [role=checkbox]`).click(); // re-include (user rule removed)
  await page.locator(`${row('Work')} [role=checkbox]`).click(); // exclude
  await page.locator(`${row('Projects')} button[aria-expanded]`).click();
  await page.locator(`${row('Projects/nucleon-sync')} button[aria-expanded]`).click();
  const nm = page.locator(`${row('Projects/nucleon-sync/node_modules')} [role=checkbox]`);
  await expect(nm).toHaveAttribute('aria-checked', 'false'); // default exclude
  await nm.click(); // include a default-excluded folder -> explicit rule
  await expect(page.getByTestId('changes-bar')).toContainText('1 Ordner ausgeschlossen, 2 Ordner eingeschlossen');
  await page.getByTestId('changes-bar').getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByTestId('changes-bar')).toBeHidden();

  const puts = await fixtureCalls(page, 'PUT', '/v1/pairs/1/rules');
  expect(puts).toHaveLength(1);
  const rule = (kind: SelectionRule['kind'], pattern: string): SelectionRule => ({
    kind,
    patternType: 'prefix',
    pattern,
    source: 'user',
  });
  expect(puts[0]!.body).toEqual([
    rule('include', 'Projects/nucleon-sync/node_modules'),
    rule('exclude', 'Scratch/Inbox'),
    rule('exclude', 'Work'),
  ]);
  // tree reloaded from the new rules
  await expect(page.locator(`${row('Work')} [role=checkbox]`)).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator(`${row('Old-Archive')} [role=checkbox]`)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator(`${row('Projects/nucleon-sync')} [role=checkbox]`)).toHaveAttribute('aria-checked', 'true');
});

test('conflict resolution calls the resolve endpoint, with confirm round-trip where required', async () => {
  const { page } = ui;
  await page.locator('[data-nav="issues"]').click();
  await page.getByTestId('conflict-1').getByRole('button', { name: 'Lokal behalten ↑' }).click();
  await expect(page.getByTestId('conflict-1')).toBeHidden();
  expect((await fixtureCalls(page, 'POST', '/v1/conflicts/1/resolve')).map((c) => c.body)).toEqual([
    { resolution: 'keep_local' },
  ]);

  await page.getByTestId('conflict-2').getByRole('button', { name: 'Proton behalten ↓' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('„Proton behalten“: Studies');
  await dialog.getByRole('button', { name: 'Ja, ausführen' }).click();
  await expect(page.getByTestId('conflict-2')).toBeHidden();
  const calls = await fixtureCalls(page, 'POST', '/v1/conflicts/2/resolve');
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).toEqual({ resolution: 'keep_remote' });
  expect(calls[1]!.body).toEqual({ resolution: 'keep_remote', confirmToken: expect.stringMatching(/^ct-/) });

  // cancelling the confirmation sends nothing further
  await page.getByTestId('conflict-3').getByRole('button', { name: 'Proton behalten ↓' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByTestId('conflict-3')).toBeVisible();
  expect(await fixtureCalls(page, 'POST', '/v1/conflicts/3/resolve')).toHaveLength(1);
});

test('deletion decisions call the decide endpoint, including the confirm round-trip', async () => {
  const { page } = ui;
  await page.getByRole('tab', { name: /Ausstehende Löschungen/ }).click();
  // the file changed in Proton after the local deletion is not pre-selected
  await expect(page.getByTestId('deletion-bar')).toContainText('Auswahl: 12 Dateien, 1,5 GB');
  await page.getByTestId('deletion-bar').getByRole('button', { name: 'In Proton löschen (Papierkorb)' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('12 Elemente · 1,5 GB');
  await dialog.getByRole('button', { name: 'Ja, ausführen' }).click();
  await expect(page.getByTestId('deletion-row')).toHaveCount(1);
  const calls = await fixtureCalls(page, 'POST', '/v1/deletions/decide');
  expect(calls).toHaveLength(2);
  const first = calls[0]!.body as { ids: number[]; decision: string; confirmToken?: string };
  expect(first.decision).toBe('trash_remote');
  expect(first.ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]);
  expect(first.confirmToken).toBeUndefined();
  expect((calls[1]!.body as { confirmToken?: string }).confirmToken).toMatch(/^ct-/);

  // small decision: no confirmation needed
  await page.getByTestId('deletion-row').getByRole('checkbox').click();
  await page.getByTestId('deletion-bar').getByRole('button', { name: 'Wiederherstellen ↓' }).click();
  await expect(page.getByText('Keine ausstehenden Löschungen.')).toBeVisible();
  const all = await fixtureCalls(page, 'POST', '/v1/deletions/decide');
  expect(all[2]!.body).toEqual({ ids: [11], decision: 'restore_local' });
});

test('login dialog renders URL + QR from a login event', async () => {
  const { page } = ui;
  await page.locator('[data-nav="accounts"]').click();
  await page.getByRole('button', { name: 'Konto hinzufügen' }).click();
  await page.getByLabel('Anzeigename').fill('Grandpa Joe');
  await expect(page.getByLabel('Kennung')).toHaveValue('grandpa-joe');
  await page.getByRole('button', { name: 'Anmeldung starten' }).click();
  const dlg = page.getByTestId('login-dialog');
  await expect(dlg.getByTestId('login-url')).toContainText('https://account.proton.me/');
  const url = 'https://account.proton.me/authorize?from=sse-event';
  await page.evaluate(
    (u) =>
      (window as unknown as { __psFixtures: { emit: (e: unknown) => void } }).__psFixtures.emit({
        type: 'login',
        accountId: 'grandpa-joe',
        phase: 'url',
        signInUrl: u,
      }),
    url,
  );
  await expect(dlg.getByTestId('login-url')).toHaveText(url);
  await expect(dlg.locator(`svg.qr[aria-label="${url}"]`)).toBeVisible();
  expect(await dlg.locator('svg.qr path').getAttribute('d')).toMatch(/^M\d/);
  await page.evaluate(() =>
    (window as unknown as { __psFixtures: { completeLogin: (id: string) => void } }).__psFixtures.completeLogin(
      'grandpa-joe',
    ),
  );
  await expect(dlg).toContainText('Angemeldet.');
  expect((await fixtureCalls(page, 'POST', '/v1/accounts')).map((c) => c.body)).toEqual([
    { id: 'grandpa-joe', displayName: 'Grandpa Joe' },
  ]);
});
