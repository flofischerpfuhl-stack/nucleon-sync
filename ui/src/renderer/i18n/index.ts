// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * UI language. `t` is the active string table (an ES live binding: `import { t }` always sees the current one).
 * English (en.ts) is the source of truth; every other language is typed as `Strings`.
 *
 * Adding a language: create xx.ts (`export const xx: Strings = { … }`, copy en.ts and translate), register it in
 * LOCALES below, done — the typecheck and ui/test/i18n.test.ts report missing keys.
 *
 * Choice: the user's preference (Settings → Language, stored by the main process) or `system` = the first supported
 * language of the OS preference list (Electron app.getPreferredSystemLanguages / navigator.languages), else English.
 */
import { de } from './de.ts';
import { en, type Strings } from './en.ts';
import { setNumberLocale } from './num.ts';

export type { Strings };
export { n, intlTag } from './num.ts';

export const LOCALES = {
  en: { strings: en, name: 'English' },
  de: { strings: de, name: 'Deutsch' },
} satisfies Record<string, { strings: Strings; name: string }>;

export type Locale = keyof typeof LOCALES;
export type LanguagePreference = 'system' | Locale;
export const DEFAULT_LOCALE: Locale = 'en';

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && v in LOCALES;
export const isLanguagePreference = (v: unknown): v is LanguagePreference => v === 'system' || isLocale(v);

/** first supported language of a preference list like ['de-DE', 'en-US'] */
export function systemLocale(languages: readonly string[]): Locale {
  for (const l of languages) {
    const base = l.toLowerCase().split(/[-_.]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

export function resolveLocale(pref: LanguagePreference | null | undefined, languages: readonly string[]): Locale {
  return pref && pref !== 'system' && isLocale(pref) ? pref : systemLocale(languages);
}

export let t: Strings = en;
export let locale: Locale = DEFAULT_LOCALE;

export function setLocale(l: Locale): void {
  locale = l;
  t = LOCALES[l].strings;
  setNumberLocale(t.intl);
}

/**
 * A section of the active string table that follows language switches, for module-level aliases
 * (`const S = section('settings')` → `S.saved` is always in the current language).
 */
export function section<K extends keyof Strings>(k: K): Strings[K] {
  const cur = () => t[k] as unknown as object;
  return new Proxy({} as object, {
    get: (_o, p) => Reflect.get(cur(), p),
    has: (_o, p) => Reflect.has(cur(), p),
    ownKeys: () => Reflect.ownKeys(cur()),
    getOwnPropertyDescriptor: (_o, p) => {
      const d = Reflect.getOwnPropertyDescriptor(cur(), p);
      return d ? { ...d, configurable: true } : undefined;
    },
  }) as Strings[K];
}
