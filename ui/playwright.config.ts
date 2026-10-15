// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from '@playwright/test';

/**
 * Electron e2e tests. Windows render offscreen (NUCLEON_SYNC_UI_OFFSCREEN=1), so nothing
 * appears on the desktop; an X display is still needed for Electron/GTK (borrowed from the systemd user env).
 * Run: pnpm --filter @nucleon-sync/ui test:e2e
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.ts',
});
