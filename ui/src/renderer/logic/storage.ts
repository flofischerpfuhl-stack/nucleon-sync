// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Storage numbers (docs/SYNC-RULES.md) — the single source of truth for "how much does this account use" in the overview
 * cards, the tray flyout and the Speicher page: the latest measurement from GET /v1/storage. Before the first
 * measurement there is no number ("noch nicht gemessen"), never a fallback that disagrees elsewhere. Pure; unit-tested.
 */
import type { StorageDto, StoragePoolDto } from '@nucleon-sync/shared';

import { fmtBytes } from '../format.ts';
import { t } from '../i18n/index.ts';
import { msgRef } from './normalize.ts';

export interface AccountUsage {
  /** latest measured total (all areas, trash excluded); null = never measured */
  bytes: number | null;
  measuredAt: string | null;
  /** share of the configured shared storage pool (0..1), null without pool size or measurement */
  poolShare: number | null;
  measuring: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Defensive copy of a StorageDto: missing arrays/numbers (older daemons, partial fixtures) become empty/0. */
export function normalizeStorage(raw: unknown): StorageDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StorageDto>;
  if (typeof s.accountId !== 'string') return null;
  return {
    accountId: s.accountId,
    measuredAt: typeof s.measuredAt === 'string' ? s.measuredAt : null,
    areas: Array.isArray(s.areas)
      ? s.areas
          .filter((a) => a && typeof a === 'object')
          .map((a) => ({
            path: String(a.path ?? ''),
            label: String(a.label ?? a.path ?? ''),
            ...(msgRef(a.labelMsg) ? { labelMsg: msgRef(a.labelMsg) } : {}),
            bytes: num(a.bytes),
            files: num(a.files),
          }))
      : [],
    activeBytes: num(s.activeBytes),
    totalBytes: num(s.totalBytes),
    reclaimableOldRevisionsBytes: num(s.reclaimableOldRevisionsBytes),
    trashBytes: num(s.trashBytes),
  };
}

/** Defensive copy of GET /v1/storage. */
export function normalizePool(raw: unknown): StoragePoolDto {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoragePoolDto>;
  return {
    poolBytes: typeof p.poolBytes === 'number' && p.poolBytes > 0 ? p.poolBytes : null,
    accounts: Array.isArray(p.accounts)
      ? p.accounts.map(normalizeStorage).filter((x): x is StorageDto => x !== null)
      : [],
    measuring: Array.isArray(p.measuring) ? p.measuring.filter((x): x is string => typeof x === 'string') : [],
  };
}

export function accountUsage(pool: StoragePoolDto | null | undefined, accountId: string): AccountUsage {
  const s = pool?.accounts?.find((a) => a.accountId === accountId) ?? null;
  const measuring = !!pool?.measuring?.includes(accountId);
  if (!s || !s.measuredAt) return { bytes: null, measuredAt: null, poolShare: null, measuring };
  const poolBytes = pool?.poolBytes ?? null;
  return {
    bytes: s.totalBytes,
    measuredAt: s.measuredAt,
    poolShare: poolBytes ? s.totalBytes / poolBytes : null,
    measuring,
  };
}

/** "382 GB" or "noch nicht gemessen" */
export function usageText(u: AccountUsage): string {
  return u.bytes === null ? t.storage.notMeasured : fmtBytes(u.bytes);
}

/** latest measurement time over all accounts (null = none yet) */
export function lastMeasured(pool: StoragePoolDto | null | undefined): string | null {
  return (
    (pool?.accounts ?? [])
      .map((a) => a.measuredAt)
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null
  );
}
