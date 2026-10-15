// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Neue Dateien vom PC hochladen": the switch appears only for mirror-down pairs and writes
 * pairs.options.uploadLocalNew through the real mock daemon API.
 */
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { NucleonSyncClient, resolvePaths, type PairDto } from '@nucleon-sync/shared';

import { de as t } from '../../src/renderer/i18n/de.ts';
import { cleanup, displayEnv, launchUi, startDaemon, tempDir, type Launched, type MockDaemon } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

test.describe('mirror-down pair: upload new files from the PC', () => {
  let home: string;
  let daemon: MockDaemon;
  let ui: Launched;
  let client: NucleonSyncClient;
  test.beforeAll(async () => {
    home = tempDir('sam-outbox');
    daemon = await startDaemon(home);
    const paths = resolvePaths({ NUCLEON_SYNC_HOME: home });
    client = new NucleonSyncClient({
      socketPath: paths.socketFile,
      token: readFileSync(paths.tokenFile, 'utf8').trim(),
    });
    ui = await launchUi({ home });
  });
  test.afterAll(async () => {
    await ui?.close();
    await daemon?.stop();
    cleanup(home);
  });

  test('switch only on mirror-down pairs; toggling stores the option', async () => {
    const { page } = ui;
    const pairs = await client.request<PairDto[]>('GET', '/v1/pairs');
    const backup = pairs.find((p) => p.direction === 'backup')!;
    const mirror = pairs.find((p) => p.direction === 'mirror-down')!;
    await page.locator('[data-nav="folders"]').click();
    const select = page.getByTestId('pair-select');
    await select.selectOption(String(backup.id));
    await expect(page.getByTestId('upload-local-new')).toHaveCount(0);

    await select.selectOption(String(mirror.id));
    const sw = page.getByTestId('upload-local-new');
    await expect(sw).toContainText(t.folders.uploadLocalNew);
    await sw.getByRole('switch').click();
    await expect
      .poll(async () => (await client.request<PairDto>('GET', `/v1/pairs/${mirror.id}`)).options?.uploadLocalNew)
      .toBe(true);
    await expect(sw.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await sw.getByRole('switch').click();
    await expect
      .poll(async () => (await client.request<PairDto>('GET', `/v1/pairs/${mirror.id}`)).options?.uploadLocalNew)
      .toBeUndefined();
  });
});
