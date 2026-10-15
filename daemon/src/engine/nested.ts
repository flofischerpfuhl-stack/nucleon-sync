// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Nested pairs: a pair whose local folder (or, for the same account, whose Proton folder) lies
 * inside another pair's folder owns that sub folder. The outer pair excludes it automatically (selection rule
 * source 'pair'), and the executor refuses jobs of the outer pair on it — two pairs never act on the same file.
 *
 * Example (Alex's PC): `/srv/sync/Documents ⇄ /devices/Workstation/Documents` [backup] and
 * `/srv/sync/Documents/01_Haushalt ⇄ /devices/Workstation/Documents/01_Haushalt` [two-way]: the backup pair
 * skips `01_Haushalt` on both sides.
 */
import type { PairRow } from '../db/repo.ts';

export interface OwnedPath {
  /** path relative to the outer pair's roots ('/'-separated, NFC) */
  rel: string;
  pairId: number;
  pairName: string;
}

/** `child` relative to `parent` when child lies strictly inside parent, else null (absolute or remote paths). */
export function relInside(child: string, parent: string): string | null {
  const c = child.normalize('NFC').replace(/\/+$/, '');
  const p = parent.normalize('NFC').replace(/\/+$/, '');
  if (!p || c === p || !c.startsWith(p + '/')) return null;
  return c.slice(p.length + 1);
}

type PairLike = Pick<PairRow, 'id' | 'name' | 'account_id' | 'local_root' | 'remote_root'>;

/** Sub folders of `pair` owned by other (inner) pairs. */
export function ownedPaths(pair: PairLike, all: PairLike[]): OwnedPath[] {
  const out: OwnedPath[] = [];
  for (const q of all) {
    if (q.id === pair.id) continue;
    const local = relInside(q.local_root, pair.local_root);
    if (local !== null) out.push({ rel: local, pairId: q.id, pairName: q.name });
    if (q.account_id === pair.account_id) {
      const remote = relInside(q.remote_root, pair.remote_root);
      if (remote !== null && remote !== local) out.push({ rel: remote, pairId: q.id, pairName: q.name });
    }
  }
  return out;
}

/** Name of the pair that owns `rel` inside `pair`, or null. */
export function ownerOf(rel: string, owned: OwnedPath[]): OwnedPath | null {
  const r = rel.normalize('NFC');
  for (const o of owned) if (r === o.rel || r.startsWith(o.rel + '/')) return o;
  return null;
}
