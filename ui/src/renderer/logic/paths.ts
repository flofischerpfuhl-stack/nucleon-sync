// SPDX-License-Identifier: GPL-3.0-or-later
/** Path/name helpers for the pair wizard and account form (pure; unit-tested). */
import type { PairDto } from '@nucleon-sync/shared';

import { t } from '../i18n/index.ts';
import { HARD_EXCLUDED_LOCAL_PATHS } from '../shared.ts';

/** Returns the hard-excluded path a local root touches (inside it or containing it), else null. */
export function hardExclusion(localRoot: string, hard: readonly string[] = HARD_EXCLUDED_LOCAL_PATHS): string | null {
  const p = localRoot.replace(/\/+$/, '');
  for (const h of hard) if (p === h || p.startsWith(h + '/') || h.startsWith(p + '/')) return h;
  return null;
}

/** `child` relative to `parent` when it lies strictly inside, else null */
function relInside(child: string, parent: string): string | null {
  const c = child.replace(/\/+$/, '') || '/';
  const p = parent.replace(/\/+$/, '') || '/';
  if (c === p) return null;
  const prefix = p === '/' ? '/' : p + '/';
  return c.startsWith(prefix) ? c.slice(prefix.length) : null;
}

type PairRef = Pick<PairDto, 'name' | 'localRoot'> & Partial<Pick<PairDto, 'accountId' | 'remoteRoot'>>;

/**
 * Pair wizard check of the local folder (same rules as the daemon's pair validation): absolute, not `/`, no hard
 * exclusion, not the folder of another pair. Nesting inside another pair (or around it) is allowed — the outer pair
 * excludes the sub folder — as long as the Proton folder (`target`, same account) is nested at the
 * same sub path. Returns an error text, null when valid. Empty input is "not valid yet" (null error, but the caller
 * must not allow "Weiter").
 */
export function validateLocalRoot(
  localRoot: string,
  pairs: readonly PairRef[] = [],
  target?: { accountId: string; remoteRoot: string },
): string | null {
  const raw = localRoot.trim();
  if (!raw) return null;
  if (!raw.startsWith('/')) return t.wizard.notAbsolute;
  const p = raw.replace(/\/+$/, '') || '/';
  if (p === '/') return t.wizard.rootNotAllowed;
  const hard = hardExclusion(p);
  if (hard) return t.wizard.hardExcluded(hard);
  for (const pair of pairs) {
    const other = pair.localRoot.replace(/\/+$/, '') || '/';
    if (p === other) return t.wizard.samePair(pair.name);
    const innerL = relInside(p, other);
    const outerL = relInside(other, p);
    if (!target || !pair.remoteRoot || pair.accountId !== target.accountId) continue;
    const innerR = relInside(target.remoteRoot, pair.remoteRoot);
    const outerR = relInside(pair.remoteRoot, target.remoteRoot);
    if (target.remoteRoot.replace(/\/+$/, '') === pair.remoteRoot.replace(/\/+$/, ''))
      return t.wizard.overlapsPair(pair.name, pair.remoteRoot);
    if ((innerL !== null || innerR !== null) && (outerL !== null || outerR !== null))
      return t.wizard.overlapsPair(pair.name, pair.localRoot);
    if ((innerR !== null && innerL === null) || (outerR !== null && outerL === null))
      return t.wizard.overlapsPair(pair.name, pair.remoteRoot);
    if (
      (innerL !== null && innerR !== null && innerL !== innerR) ||
      (outerL !== null && outerR !== null && outerL !== outerR)
    )
      return t.wizard.nestedMismatch(pair.name);
  }
  return null;
}

/** Hint for a valid nested local folder: which pair excludes what (null when not nested). */
export function nestingHint(localRoot: string, pairs: readonly PairRef[] = []): string | null {
  const p = localRoot.trim().replace(/\/+$/, '') || '/';
  if (!p.startsWith('/') || p === '/') return null;
  for (const pair of pairs) {
    const inner = relInside(p, pair.localRoot);
    if (inner !== null) return t.wizard.nestedIn(pair.name, inner);
    const outer = relInside(pair.localRoot, p);
    if (outer !== null) return t.wizard.contains(pair.name, outer);
  }
  return null;
}

/** Account id from a display name: "Grandpa Joe" -> "grandpa-joe", "Jörg" -> "jorg". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}
