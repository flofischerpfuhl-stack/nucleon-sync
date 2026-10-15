// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Theme choice (pure, unit-tested). Order: NUCLEON_SYNC_UI_THEME=light|dark › the current Omarchy theme (colours +
 * light/dark, common/omarchyTheme.ts) › KDE (Chromium does not always pick up KDE's colour scheme on X11, so main
 * reads ~/.config/kdeglobals [Colors:Window] BackgroundNormal) › the system light/dark preference (nativeTheme
 * 'system': GTK/portal color-scheme). The built-in palette (styles.css) is the look whenever no Omarchy theme applies.
 */
import { omarchyPalette, type OmarchyColors } from '../common/omarchyTheme.ts';
import type { ThemeState } from '../common/ipc.ts';

export type ThemeChoice = 'dark' | 'light' | 'system';

export function parseKdeTheme(kdeglobals: string): ThemeChoice | null {
  let section = '';
  for (const raw of kdeglobals.split('\n')) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!;
      continue;
    }
    if (section !== 'Colors:Window') continue;
    const m = /^BackgroundNormal\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(line);
    if (!m) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => Number(x) / 255) as [number, number, number];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 0.5 ? 'dark' : 'light';
  }
  return null;
}

export function chooseTheme(env: NodeJS.ProcessEnv, kdeglobals: string | null): ThemeChoice {
  if (env.NUCLEON_SYNC_UI_THEME === 'light' || env.NUCLEON_SYNC_UI_THEME === 'dark') return env.NUCLEON_SYNC_UI_THEME;
  return (kdeglobals ? parseKdeTheme(kdeglobals) : null) ?? 'system';
}

/** full theme decision incl. Omarchy colours; `follow: false` = the user chose the built-in look */
export function resolveTheme(
  env: NodeJS.ProcessEnv,
  o: { kdeglobals: string | null; omarchy: { name: string; colors: OmarchyColors } | null; follow: boolean },
): ThemeState {
  if (env.NUCLEON_SYNC_UI_THEME === 'light' || env.NUCLEON_SYNC_UI_THEME === 'dark')
    return { source: 'env', name: null, mode: env.NUCLEON_SYNC_UI_THEME, vars: null };
  if (o.follow && o.omarchy) {
    const p = omarchyPalette(o.omarchy.colors);
    if (p) return { source: 'omarchy', name: o.omarchy.name, mode: p.mode, vars: p.vars };
  }
  const kde = o.kdeglobals ? parseKdeTheme(o.kdeglobals) : null;
  if (kde) return { source: 'kde', name: null, mode: kde, vars: null };
  return { source: 'system', name: null, mode: 'system', vars: null };
}
