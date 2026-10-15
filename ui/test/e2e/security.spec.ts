// SPDX-License-Identifier: GPL-3.0-or-later
/** Security properties of the renderer and the IPC surface. */
import { expect, test } from '@playwright/test';

import { cleanup, displayEnv, launchUi, tempDir, type Launched } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
test.skip(!displayEnv(), 'needs an X display');

let home: string;
let ui: Launched;
test.beforeAll(async () => {
  home = tempDir('security');
  ui = await launchUi({ home, fixtures: 'demo' });
});
test.afterAll(async () => {
  await ui?.close();
  cleanup(home);
});

test('renderer has no Node globals', async () => {
  const r = await ui.page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return [typeof g.require, typeof g.process, typeof g.module, typeof g.Buffer];
  });
  expect(r).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
});

test('IPC rejects non-/v1/ paths and traversal', async () => {
  const tryReq = (method: string, p: string) =>
    ui.page.evaluate(
      ([m, path]) =>
        window.nucleonSync.request(m!, path!).then(
          () => 'ok',
          (e: Error) => e.message,
        ),
      [method, p],
    );
  expect(await tryReq('GET', '/etc/passwd')).toContain('blocked request');
  expect(await tryReq('GET', '/v1/../etc/passwd')).toContain('blocked request');
  expect(await tryReq('GET', 'http://127.0.0.1:47821/v1/status')).toContain('blocked request');
  expect(await tryReq('TRACE', '/v1/status')).toContain('blocked request');
  // an allowed path reaches main (no daemon here -> transport error, not "blocked")
  expect(await tryReq('GET', '/v1/health')).not.toContain('blocked request');
  const ext = await ui.page.evaluate(() => window.nucleonSync.openExternal('https://evil.example.com/'));
  expect(ext).toBe(false);
  const folder = await ui.page.evaluate(() => window.nucleonSync.showInFolder('/etc/passwd'));
  expect(folder).toBe(false);
});

test('navigation and new windows are blocked', async () => {
  const { page, app } = ui;
  const before = page.url();
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  const opened = await page.evaluate(() => window.open('https://example.com/') === null);
  expect(opened).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2); // main + flyout
});

test('CSP is present and blocks inline scripts', async () => {
  const { page } = ui;
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  const inline = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = 1';
    document.head.appendChild(s);
    return (window as unknown as { __inline?: number }).__inline ?? null;
  });
  expect(inline).toBeNull();
});
