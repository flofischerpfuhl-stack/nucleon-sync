// SPDX-License-Identifier: GPL-3.0-or-later
/** Screen ids of the main window and validation of persisted/requested ids (pure; unit-tested). */
import { t } from '../i18n/index.ts';

export type Screen = keyof typeof t.nav;

export const SCREEN_IDS = Object.keys(t.nav) as Screen[];

/** Own keys only: "constructor", "toString", "__proto__" etc. are not screens. */
export function isScreen(id: unknown): id is Screen {
  return typeof id === 'string' && Object.hasOwn(t.nav, id);
}

/** persisted `ps.screen` → a valid screen, otherwise the overview */
export function screenOr(id: unknown, fallback: Screen = 'overview'): Screen {
  return isScreen(id) ? id : fallback;
}
