// SPDX-License-Identifier: GPL-3.0-or-later
/** Activity table with 50k rows stays virtualised and responsive; renderer bundle size budget. */
import { statSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { UI_DIR, cleanup, displayEnv, launchUi, tempDir } from './helpers.ts';

test('renderer bundle < 2 MB minified', () => {
  expect(statSync(path.join(UI_DIR, 'out/renderer.js')).size).toBeLessThan(2 * 1024 * 1024);
});

test('activity table handles 50k rows (virtualised)', async () => {
  test.skip(!displayEnv(), 'needs an X display');
  const home = tempDir('perf');
  const ui = await launchUi({ home, fixtures: 'demo' });
  try {
    const { page } = ui;
    await page.evaluate(() =>
      (window as unknown as { __psFixtures: { seedActivity: (n: number) => void } }).__psFixtures.seedActivity(50_000),
    );
    await page.locator('[data-nav="activity"]').click();
    await expect(page.getByTestId('activity-count')).toContainText('500 Einträge');
    // endless scroll until everything is loaded
    const t0 = Date.now();
    for (let i = 0; i < 400; i++) {
      const done = await page.evaluate(() => {
        const el = document.querySelector('.vlist')!;
        el.scrollTop = el.scrollHeight;
        return document.querySelector('[data-testid=activity-count]')!.textContent!.includes('50.000');
      });
      if (done) break;
      await page.waitForTimeout(30);
    }
    await expect(page.getByTestId('activity-count')).toContainText('50.000 Einträge');
    const loadMs = Date.now() - t0;
    // only a window of rows is in the DOM
    const domRows = await page.locator('.vrow').count();
    expect(domRows).toBeLessThan(120);
    // scrolling through the full list: average frame cost stays low
    const avg = await page.evaluate(async () => {
      const el = document.querySelector('.vlist')!;
      const steps = 40;
      const t = performance.now();
      for (let i = 0; i < steps; i++) {
        el.scrollTop = (el.scrollHeight * i) / steps;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return (performance.now() - t) / steps;
    });
    console.log(`50k rows: loaded in ${loadMs} ms, ${domRows} DOM rows, ${avg.toFixed(1)} ms per scroll frame`);
    expect(avg).toBeLessThan(50);
  } finally {
    await ui.close();
    cleanup(home);
  }
});
