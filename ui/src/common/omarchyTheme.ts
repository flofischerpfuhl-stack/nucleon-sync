// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Omarchy theme → dashboard palette (pure; unit-tested in ui/test/i18n-theme.test.ts).
 *
 * Omarchy 4 keeps the current theme as a real directory `~/.local/state/omarchy/current/theme/` (replaced as a
 * whole on every `omarchy-theme-set`: rm + mv, so watch the parent dir) with a machine-readable `colors.toml`
 * (`mode = "dark"|"light"`, accent, background, foreground, red, green, yellow, blue, …). Omarchy 3 used
 * `~/.config/omarchy/current/theme` (a symlink). The main process reads the file, maps it to the CSS variables of
 * styles.css and sends them to the renderers; nothing here touches the Omarchy installation.
 */

export type OmarchyColors = Record<string, string>;

/** candidate theme dirs, newest layout first (relative to $HOME) */
export const OMARCHY_THEME_DIRS = ['.local/state/omarchy/current/theme', '.config/omarchy/current/theme'];
/** dirs to watch for theme switches (the parent of the theme dir; the theme dir itself is replaced) */
export const OMARCHY_WATCH_DIRS = ['.local/state/omarchy/current', '.config/omarchy/current'];

/** `key = "value"` lines of colors.toml (strings only; comments and tables ignored) */
export function parseColorsToml(text: string): OmarchyColors {
  const out: OmarchyColors = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const m = /^([A-Za-z0-9_]+)\s*=\s*["']([^"']*)["']$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

type Rgb = [number, number, number];

function hex(c: string | undefined): Rgb | null {
  if (!c) return null;
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: Rgb, b: Rgb, w: number): Rgb => [0, 1, 2].map((i) => a[i]! * (1 - w) + b[i]! * w) as Rgb;
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

function luminance([r, g, b]: Rgb): number {
  const f = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export function themeMode(c: OmarchyColors): 'dark' | 'light' {
  if (c.mode === 'light' || c.mode === 'dark') return c.mode;
  const bg = hex(c.background);
  return bg && luminance(bg) > 0.4 ? 'light' : 'dark';
}

/** dashboard fallbacks for status colours that are missing or unreadable on the theme background */
const FALLBACK: Record<'dark' | 'light', Record<'ok' | 'info' | 'warn' | 'err', string>> = {
  dark: { ok: '#3fcf8e', info: '#5aa9ff', warn: '#f5b041', err: '#ff6b7a' },
  light: { ok: '#128a57', info: '#1f6fd1', warn: '#a85f00', err: '#c8283c' },
};

/**
 * CSS custom properties (styles.css :root) for an Omarchy colour set; null when the set has no usable
 * background/foreground (the built-in look stays).
 */
export function omarchyPalette(c: OmarchyColors): { mode: 'dark' | 'light'; vars: Record<string, string> } | null {
  const bg = hex(c.background);
  const fg = hex(c.foreground);
  if (!bg || !fg) return null;
  const mode = themeMode(c);
  const accent = hex(c.accent) ?? hex(c.blue) ?? mix(bg, fg, 0.6);
  // a status colour must stay readable: theme colour, else its bright_ variant, else the dashboard default
  const status = (keys: string[], fb: string) => {
    for (const k of keys) {
      const v = hex(c[k]);
      if (v && contrast(v, bg) >= 3) return v; // WCAG non-text contrast 3:1
    }
    return hex(fb)!;
  };
  const ok = status(['green', 'bright_green'], FALLBACK[mode].ok);
  const info = status(['blue', 'bright_blue', 'cyan'], FALLBACK[mode].info);
  const warn = status(['yellow', 'bright_yellow'], FALLBACK[mode].warn);
  const err = status(['red', 'bright_red'], FALLBACK[mode].err);
  const accentText = contrast(accent, bg) >= 3 ? accent : mix(accent, fg, 0.45);
  const lift = (w: number) => toHex(mix(bg, fg, w));
  return {
    mode,
    vars: {
      '--bg': toHex(bg),
      '--bg-side': lift(0.035),
      '--bg-card': lift(0.06),
      '--bg-card-2': lift(0.09),
      '--bg-hover': lift(0.13),
      '--bg-input': toHex(hex(c.dark_background) ?? mix(bg, [0, 0, 0], 0.15)),
      '--bg-flyout': lift(0.05),
      '--border': rgba(fg, 0.1),
      '--border-strong': rgba(fg, 0.2),
      '--text': toHex(fg),
      '--text-2': toHex(mix(fg, bg, 0.22)),
      '--text-3': toHex(mix(fg, bg, 0.38)),
      '--muted': toHex(mix(fg, bg, 0.42)),
      '--accent': toHex(accent),
      '--accent-hover': toHex(mix(accent, fg, 0.15)),
      '--accent-soft': rgba(accent, 0.18),
      '--accent-text': toHex(accentText),
      '--ok': toHex(ok),
      '--ok-soft': rgba(ok, 0.14),
      '--info': toHex(info),
      '--info-soft': rgba(info, 0.14),
      '--warn': toHex(warn),
      '--warn-soft': rgba(warn, 0.14),
      '--err': toHex(err),
      '--err-soft': rgba(err, 0.14),
      '--series-1': toHex(accent),
      '--series-2': toHex(hex(c.cyan) && contrast(hex(c.cyan)!, bg) >= 2 ? hex(c.cyan)! : ok),
      '--free': lift(0.18),
      '--badge-text': toHex(bg),
      '--focus': toHex(contrast(accent, bg) >= 3 ? accent : fg),
    },
  };
}
