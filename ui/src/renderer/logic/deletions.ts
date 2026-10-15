// SPDX-License-Identifier: GPL-3.0-or-later
/** Pending deletions grouped by folder (docs/SYNC-RULES.md: a gone folder is one decision). Pure; unit-tested. */
import type { PairDto, PendingDeletionDto } from '@nucleon-sync/shared';

export type SortKey = 'path' | 'size' | 'date';
export interface DelGroup {
  key: string;
  folder: string | null;
  pair: PairDto | undefined;
  rows: PendingDeletionDto[];
}

export function groupDeletions(
  list: PendingDeletionDto[],
  pairOf: (id: number) => PairDto | undefined,
  sort: SortKey,
): DelGroup[] {
  const byFolder = new Map<string, PendingDeletionDto[]>();
  for (const d of list) {
    const k = `${d.pairId}:${d.relPath.includes('/') ? d.relPath.slice(0, d.relPath.lastIndexOf('/')) : ''}`;
    byFolder.set(k, [...(byFolder.get(k) ?? []), d]);
  }
  const groups: DelGroup[] = [];
  for (const [k, rows] of byFolder) {
    if (rows.length >= 3)
      groups.push({ key: k, folder: k.slice(k.indexOf(':') + 1), pair: pairOf(rows[0]!.pairId), rows });
    else for (const r of rows) groups.push({ key: `f${r.id}`, folder: null, pair: pairOf(r.pairId), rows: [r] });
  }
  const size = (g: DelGroup) => g.rows.reduce((s, r) => s + r.size, 0);
  const date = (g: DelGroup) => g.rows[0]!.detectedAt;
  const path = (g: DelGroup) => `${g.pair?.name ?? ''}/${g.folder ?? g.rows[0]!.relPath}`;
  groups.sort((a, b) =>
    sort === 'size'
      ? size(b) - size(a)
      : sort === 'date'
        ? date(b).localeCompare(date(a))
        : path(a).localeCompare(path(b), 'de'),
  );
  return groups;
}
