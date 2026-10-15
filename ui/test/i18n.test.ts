// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * i18n: every language has exactly the keys of English (the source of truth), with the same value kinds; locale
 * choice; English formatting; localized confirm summaries. Plus the Omarchy theme palette.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { omarchyPalette, parseColorsToml, themeMode } from '../src/common/omarchyTheme.ts';
import { resolveTheme } from '../src/main/theme.ts';
import { fmtAgo, fmtBytes, fmtCount, fmtEta, fmtWhen } from '../src/renderer/format.ts';
import { en } from '../src/renderer/i18n/en.ts';
import { LOCALES, resolveLocale, section, setLocale, systemLocale, t } from '../src/renderer/i18n/index.ts';
import { confirmText } from '../src/renderer/logic/confirmText.ts';
import { daemonText } from '../src/renderer/logic/daemonText.ts';
import { DAEMON_MESSAGES_EN, msg, nested, refOf } from '../src/renderer/shared.ts';

type Shape = string | { [k: string]: Shape } | Shape[];

/** structural fingerprint: key paths with the kind of value (string, function, array length) */
function shape(v: unknown, at = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v === 'function') out[at] = `fn/${(v as (...a: unknown[]) => unknown).length}`;
  else if (Array.isArray(v)) out[at] = `array/${v.length}`;
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) Object.assign(out, shape(x, at ? `${at}.${k}` : k));
  else out[at] = typeof v;
  return out;
}

describe('i18n completeness', () => {
  const ref = shape(en);
  for (const [id, l] of Object.entries(LOCALES)) {
    it(`${id} has every key of en with the same kind (no missing, no extra)`, () => {
      const got = shape(l.strings);
      const missing = Object.keys(ref).filter((k) => !(k in got));
      const extra = Object.keys(got).filter((k) => !(k in ref));
      const kind = Object.keys(ref).filter((k) => k in got && got[k] !== ref[k]);
      expect({ missing, extra, kind }).toEqual({ missing: [], extra: [], kind: [] });
    });
    it(`${id} has no empty strings`, () => {
      const empty = Object.entries(shape(l.strings)).filter(
        ([k, v]) => v === 'string' && !k.startsWith('activity.histStart') && !get(l.strings, k),
      );
      expect(empty).toEqual([]);
    });
  }
  it('German is really German and English really English (spot checks)', () => {
    expect(LOCALES.de.strings.nav.overview).toBe('Übersicht');
    expect(LOCALES.en.strings.nav.overview).toBe('Overview');
    expect(LOCALES.de.strings.intl).toBe('de-DE');
  });
});

function get(o: unknown, p: string): unknown {
  return p.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);
}

describe('locale choice', () => {
  it('system language list: first supported, else English', () => {
    expect(systemLocale(['de_DE.UTF-8'])).toBe('de');
    expect(systemLocale(['fr-FR', 'de-AT', 'en-US'])).toBe('de');
    expect(systemLocale(['fr-FR'])).toBe('en');
    expect(systemLocale([])).toBe('en');
    expect(resolveLocale('system', ['de-DE'])).toBe('de');
    expect(resolveLocale('en', ['de-DE'])).toBe('en');
    expect(resolveLocale('xx' as never, ['de-DE'])).toBe('de');
  });

  it('`t` and section() follow setLocale (live binding)', () => {
    const S = section('settings');
    setLocale('de');
    expect(t.nav.overview).toBe('Übersicht');
    expect(S.saved).toBe('Einstellungen gespeichert.');
    expect(Object.keys(S)).toContain('saved');
    setLocale('en');
    expect(t.nav.overview).toBe('Overview');
    expect(S.saved).toBe('Settings saved.');
  });

  it('formatting follows the language', () => {
    setLocale('en');
    expect(fmtCount(1234567)).toBe('1,234,567');
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(fmtEta(3 * 86400)).toBe('3 days');
    const now = new Date('2026-10-13T10:00:00');
    expect(fmtWhen('2026-10-14T03:00:00', now)).toBe('tomorrow 03:00');
    expect(fmtAgo('2026-10-13T09:55:00', now)).toBe('5 min ago');
    setLocale('de');
    expect(fmtCount(1234567)).toBe('1.234.567');
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1,5 GB');
    expect(fmtWhen('2026-10-14T03:00:00', now)).toBe('morgen 03:00');
    expect(fmtAgo('2026-10-13T09:55:00', now)).toBe('vor 5 min');
    setLocale('en');
  });

  it('every confirm kind the daemon sends has a translation; unknown kinds keep the daemon text', () => {
    // kinds produced by daemon/src/api/routes.ts (scanned, so a new confirm step without a translation fails here)
    const routes = readFileSync(new URL('../../daemon/src/api/routes.ts', import.meta.url), 'utf8');
    const kinds = [...routes.matchAll(/kind: (?:remote \? )?'([a-z][\w.]+)'(?: : '([a-z][\w.]+)')?/gi)]
      .flatMap((m) => [m[1]!, m[2]])
      .filter((k): k is string => !!k);
    expect(kinds).toEqual(expect.arrayContaining(['pair.heldDeletions', 'deletions.trashLocal', 'token.revoke']));
    for (const loc of Object.values(LOCALES))
      for (const k of kinds) expect(Object.keys(loc.strings.confirmKind)).toContain(k);
    setLocale('de');
    const r = confirmText({
      kind: 'deletions.trashRemote',
      params: { count: 2, size: '1.0 GB', more: 0 },
      title: 'Delete 2 files in Proton (trash)',
      items: 2,
      bytes: 1024 ** 3,
      details: ['1.0 GB are moved to the Proton trash.', 'a.txt', 'b.txt'],
    });
    expect(r.title).toBe('2 Dateien in Proton löschen (Papierkorb)');
    expect(r.details).toEqual(['1.0 GB werden in den Proton-Papierkorb verschoben.', 'a.txt', 'b.txt']);
    // two-way: held deletions keep the daemon's path list after the side lines
    expect(
      confirmText({
        kind: 'pair.heldDeletions',
        params: { name: 'Zwei', count: 3, local: 2, remote: 1 },
        title: 'Carry out 3 held deletions in "Zwei"',
        items: 3,
        bytes: 0,
        details: [
          '2 files deleted here → Proton trash',
          '1 files deleted in Proton → local trash',
          'b.txt',
          '… and 2 more',
        ],
      }),
    ).toEqual({
      title: '3 angehaltene Löschungen in „Zwei“ ausführen',
      details: [
        '2 lokal gelöschte Dateien → Proton-Papierkorb',
        '1 in Proton gelöschte Datei → lokaler Papierkorb',
        'b.txt',
        '… +2',
      ],
    });
    expect(confirmText({ kind: 'future.kind', title: 'X', items: 1, bytes: 0, details: ['y'] })).toEqual({
      title: 'X',
      details: ['y'],
    });
    setLocale('en');
  });
});

describe('texts of the sync service (message keys, shared/src/messages.ts)', () => {
  /** sample params: every param reads as 3 (numbers format, strings interpolate) */
  const sample = new Proxy({}, { get: () => 3 }) as never;

  it('every key of DAEMON_MESSAGES_EN exists in every language and gives a non-empty text', () => {
    const keys = Object.keys(DAEMON_MESSAGES_EN);
    expect(keys.length).toBeGreaterThan(100);
    for (const [id, l] of Object.entries(LOCALES)) {
      const table = l.strings.daemon as unknown as Record<string, ((p: never) => string) | undefined>;
      const missing = keys.filter((k) => typeof table[k] !== 'function');
      const extra = Object.keys(table).filter((k) => !keys.includes(k));
      expect({ id, missing, extra }).toEqual({ id, missing: [], extra: [] });
      for (const k of keys) {
        const text = table[k]!(sample);
        expect(typeof text, `${id} ${k}`).toBe('string');
        expect(text.trim(), `${id} ${k}`).not.toBe('');
      }
    }
    // English is the service's own table
    expect(LOCALES.en.strings.daemon).toBe(DAEMON_MESSAGES_EN);
  });

  it('translates key + params in the UI language, nested messages included; numbers in the locale', () => {
    setLocale('de');
    try {
      expect(daemonText('back online', { key: 'activity.backOnline' })).toBe('wieder online');
      const brake = msg('activity.brake', {
        reason: nested(msg('brake.massDeleteDetected', { gone: 1200, tracked: 5000 })),
      });
      expect(brake.text).toBe(
        'Safety brake: Mass deletion detected: 1200 of 5000 files are missing locally – really deleted?',
      );
      expect(daemonText(brake.text, refOf(brake))).toBe(
        'Sicherheitsbremse: Massenlöschung erkannt: 1.200 von 5.000 Dateien fehlen lokal – wirklich gelöscht?',
      );
      setLocale('en');
      expect(daemonText('stale English', refOf(brake))).toBe(brake.text);
    } finally {
      setLocale('en');
    }
  });

  it('unknown keys, missing refs and malformed params fall back to the English text of the service', () => {
    setLocale('de');
    try {
      expect(daemonText('Something new happened', { key: 'future.unknownKey', params: { n: 1 } })).toBe(
        'Something new happened',
      );
      expect(daemonText('plain CLI error', null)).toBe('plain CLI error');
      expect(daemonText('plain CLI error')).toBe('plain CLI error');
      expect(daemonText(null, { key: 'future.unknownKey' })).toBe('');
      expect(daemonText('x', { key: 'toString' })).toBe('x');
      expect(daemonText('x', { key: 'constructor' })).toBe('x');
      // a param that is missing / of the wrong kind must not break the screen
      expect(daemonText('fallback', { key: 'doctor.diskSpace', params: { path: '/x' } })).toBe('fallback');
      // a nested message with an unknown key shows that key, the rest is translated
      expect(daemonText('', { key: 'activity.brake', params: { reason: 'msg:{"key":"future.reason"}' } })).toBe(
        'Sicherheitsbremse: future.reason',
      );
    } finally {
      setLocale('en');
    }
  });
});

describe('Omarchy theme', () => {
  const SOLITUDE = `mode = "dark"
accent = "#798186"
background = "#101315"
dark_background = "#0c0e10"
foreground = "#cacccc"
red = "#565d60"
bright_red = "#de6145"
yellow = "#d9dbdc"
green = "#9fa5a9"
cyan = "#707070"
blue = "#798186"
hyprland_active_border = "rgba(798186ee) rgba(caccccee)"
`;
  it('parses colors.toml (strings only)', () => {
    const c = parseColorsToml(SOLITUDE + '# comment\n[table]\nnum = 3\n');
    expect(c.background).toBe('#101315');
    expect(c.mode).toBe('dark');
    expect(c.num).toBeUndefined();
    expect(themeMode({ background: '#ffffff' })).toBe('light');
    expect(themeMode({ mode: 'dark', background: '#ffffff' })).toBe('dark');
  });

  it('maps to the dashboard CSS variables; unreadable status colours fall back', () => {
    const p = omarchyPalette(parseColorsToml(SOLITUDE))!;
    expect(p.mode).toBe('dark');
    expect(p.vars['--bg']).toBe('#101315');
    expect(p.vars['--text']).toBe('#cacccc');
    expect(p.vars['--accent']).toBe('#798186');
    expect(p.vars['--bg-input']).toBe('#0c0e10');
    // red #565d60 is too dark on #101315 → bright_red
    expect(p.vars['--err']).toBe('#de6145');
    expect(omarchyPalette({ accent: '#123456' })).toBeNull();
  });

  it('theme decision: env › Omarchy (if followed) › KDE › system', () => {
    const omarchy = { name: 'solitude', colors: parseColorsToml(SOLITUDE) };
    expect(resolveTheme({ NUCLEON_SYNC_UI_THEME: 'light' }, { kdeglobals: null, omarchy, follow: true }).source).toBe(
      'env',
    );
    const o = resolveTheme({}, { kdeglobals: null, omarchy, follow: true });
    expect(o).toMatchObject({ source: 'omarchy', name: 'solitude', mode: 'dark' });
    expect(resolveTheme({}, { kdeglobals: null, omarchy, follow: false })).toMatchObject({
      source: 'system',
      mode: 'system',
      vars: null,
    });
    expect(
      resolveTheme({}, { kdeglobals: '[Colors:Window]\nBackgroundNormal=239,240,241\n', omarchy: null, follow: true }),
    ).toMatchObject({ source: 'kde', mode: 'light' });
  });
});

export type { Shape };
