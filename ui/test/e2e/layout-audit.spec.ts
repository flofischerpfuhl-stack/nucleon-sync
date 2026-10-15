// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Layout audit: every screen at several window widths, in English and German, checked for text that overflows its
 * box, leaves the window, or wraps inside short controls (buttons, badges, nav, chips). Fails with a readable list.
 * Screenshots of each combination go to LAYOUT_AUDIT_OUT when set (for a human look).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { cleanup, displayEnv, launchUi, tempDir } from './helpers.ts';

test.skip(!displayEnv(), 'needs an X display');
test.setTimeout(240_000);

const SCREENS = ['overview', 'activity', 'folders', 'issues', 'storage', 'accounts', 'settings', 'maintenance'];
const WIDTHS = [900, 1024, 1180, 1440];
const OUT = process.env.LAYOUT_AUDIT_OUT;

interface Finding {
  kind: string;
  where: string;
  text: string;
}

function audit(): Finding[] {
  const out: Finding[] = [];
  const short = 'button, a, .badge, .chip, .pill, .mode-chip, .nav-item, .link-btn, th, .tab, [role=tab], .statusline';
  const desc = (el: Element): string => {
    const parts: string[] = [];
    let e: Element | null = el;
    for (let i = 0; e && i < 3; i++, e = e.parentElement) {
      const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      parts.unshift(e.tagName.toLowerCase() + (cls ? '.' + cls : ''));
    }
    return parts.join(' > ');
  };
  const visible = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push({ kind: 'page-hscroll', where: 'html', text: '' });
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el)) continue;
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    const r = el.getBoundingClientRect();
    // clipped text without an ellipsis (or with an ellipsis that hides almost everything)
    if (
      ownText &&
      el.scrollWidth > el.clientWidth + 1 &&
      cs.overflowX !== 'auto' &&
      cs.overflowX !== 'scroll' &&
      cs.textOverflow !== 'ellipsis'
    ) {
      out.push({ kind: 'overflow', where: desc(el), text: ownText.slice(0, 60) });
    }
    // text sticking out of the window
    if (ownText && r.right > vw + 1 && !el.closest('[data-offscreen-ok]')) {
      out.push({ kind: 'off-window', where: desc(el), text: ownText.slice(0, 60) });
    }
    // text sticking out of a visually bounded parent (sidebar, card, dialog)
    const box = el.closest('.sidebar, .card, [role=dialog], [role=alertdialog], .detail, .topbar');
    if (ownText && box && box !== el) {
      const b = box.getBoundingClientRect();
      if (r.right > b.right + 1 || r.left < b.left - 1)
        out.push({ kind: 'outside-box', where: desc(el), text: ownText.slice(0, 60) });
    }
    // short controls that wrap onto several lines
    if (el.matches(short) && !el.closest('.aline, .activity-row, .conflict-card, .review-card, .vrow')) {
      // a single text run broken over several lines (icons and flex children don't count)
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? '').trim();
        if (!t) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const tops = new Set(
          Array.from(range.getClientRects())
            .filter((x) => x.width > 0 && x.height > 0)
            .map((x) => Math.round(x.top / 4)),
        );
        if (tops.size > 1) {
          out.push({ kind: 'wraps', where: desc(el), text: t.slice(0, 60) });
          break;
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.kind}|${f.where}|${f.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

for (const lang of ['en', 'de'] as const) {
  test(`layout audit (${lang})`, async () => {
    const home = tempDir('layout');
    const ui = await launchUi({ home, fixtures: 'demo', colorScheme: 'dark', lang });
    const all: string[] = [];
    try {
      const { page, app } = ui;
      for (const w of WIDTHS) {
        await app.evaluate(
          ({ BrowserWindow }, size) => {
            const win = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().endsWith('#flyout'));
            win?.setContentSize(size.w, size.h);
          },
          { w, h: 860 },
        );
        await page.waitForTimeout(300);
        for (const s of SCREENS) {
          await page.locator(`[data-nav="${s}"]`).click();
          await expect(page.locator(`.screen-${s}`)).toBeVisible();
          await page.waitForTimeout(250);
          for (const f of await page.evaluate(audit))
            all.push(`${lang} ${w}px ${s}: ${f.kind} — ${f.where} — "${f.text}"`);
          if (OUT) {
            mkdirSync(OUT, { recursive: true });
            await page.screenshot({ path: path.join(OUT, `${lang}-${w}-${s}.png`) });
          }
        }
      }
    } finally {
      await ui.close();
      cleanup(home);
    }
    expect(all, all.join('\n')).toEqual([]);
  });
}
