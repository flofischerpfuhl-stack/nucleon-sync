// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Localized text of a confirm summary (daemon routes.ts sends English text + a stable `kind` + `params`).
 * Known kinds are rendered from the active language; data lines the daemon appends (file paths of a deletion,
 * measurement dates, …) are kept. Unknown kinds show the daemon's text unchanged.
 */
import type { ConfirmSummaryDto } from '@nucleon-sync/shared';

import { t } from '../i18n/index.ts';

type KindFn = (p: never) => { title: string; details: string[] };

export function confirmText(s: ConfirmSummaryDto): { title: string; details: string[] } {
  const fn = s.kind ? (t.confirmKind as Record<string, KindFn | undefined>)[s.kind] : undefined;
  if (!fn) return { title: s.title, details: s.details };
  const local = fn((s.params ?? {}) as never);
  // the daemon lists affected paths after its fixed lines: keep them (deletions: up to 20 paths + "… and N more")
  const fixed = PATH_LISTS[s.kind!]?.((s.params ?? {}) as Record<string, string | number>);
  const extra =
    fixed === undefined
      ? []
      : s.details.slice(fixed).map((d) => (/^… and \d+ more$/.test(d) ? `… +${d.replace(/\D/g, '')}` : d));
  return { title: local.title, details: [...local.details, ...extra] };
}

/** kinds whose daemon details end with a path list: number of fixed lines before it */
const PATH_LISTS: Record<string, (p: Record<string, string | number>) => number> = {
  'deletions.trashRemote': () => 1,
  'deletions.trashLocal': () => 1,
  'pair.heldDeletions': (p) => (Number(p.local) ? 1 : 0) + (Number(p.remote) ? 1 : 0),
};
