// SPDX-License-Identifier: GPL-3.0-or-later
/** Applies the main process' theme decision (common/ipc.ts ThemeState) to the document: Omarchy colours as CSS variables. */
import type { ThemeState } from '../../common/ipc.ts';

let applied: string[] = [];

export function applyTheme(theme: ThemeState | undefined, root: HTMLElement = document.documentElement): void {
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  root.dataset.themeSource = theme?.source ?? 'system';
  if (theme?.vars) {
    for (const [k, v] of Object.entries(theme.vars)) {
      if (!/^--[a-z0-9-]+$/.test(k)) continue;
      root.style.setProperty(k, v);
      applied.push(k);
    }
    root.style.setProperty('color-scheme', theme.mode === 'light' ? 'light' : 'dark');
    applied.push('color-scheme');
  }
}
