// SPDX-License-Identifier: GPL-3.0-or-later
/** GET /v1/maintenance/summary (Wartung screen): digest-less files, trash per account, latest digest backfill. */
import type { MaintenanceSummaryDto } from '@nucleon-sync/shared';

import { FLAG } from '../db/repo.ts';
import type { AccountsService } from './accounts.ts';
import type { ServiceContext } from './context.ts';
import type { StorageService } from './storage.ts';

export function maintenanceSummary(
  c: ServiceContext,
  accounts: AccountsService,
  storage: StorageService,
): MaintenanceSummaryDto {
  const db = c.db;
  const digest = db.prepare(
    `SELECT COUNT(*) AS files, COALESCE(SUM(COALESCE(e.l_size, e.r_size)), 0) AS bytes,
            COUNT(bp.uid) AS dupFiles, COALESCE(SUM(bp.reclaimable), 0) AS dupBytes
     FROM entries e JOIN pairs p ON p.id = e.pair_id
     LEFT JOIN backfill_priority bp ON bp.account_id = p.account_id AND bp.uid = e.r_uid
     WHERE p.account_id = ? AND e.kind = 'file' AND (e.flags & ${FLAG.DIGEST_MISSING}) != 0 AND e.r_exists = 1`,
  );
  // trash items created by nucleon-sync since the last successful empty-trash of the account
  const own = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND state = 'done' AND type IN ('trash_remote', 'digest_backfill')
       AND finished_at > COALESCE((SELECT MAX(finished_at) FROM jobs WHERE account_id = ? AND type = 'empty_trash' AND state = 'done'), 0)`,
  );
  const out: MaintenanceSummaryDto = { digestMissing: [], trash: [], backfill: null };
  for (const a of accounts.rows()) {
    const d = digest.get(a.id) as { files: number; bytes: number; dupFiles: number; dupBytes: number };
    out.digestMissing.push({
      accountId: a.id,
      files: d.files,
      bytes: d.bytes,
      duplicateFiles: d.dupFiles,
      duplicateBytes: d.dupBytes,
    });
    const t = storage.trash(a.id);
    out.trash.push({
      accountId: a.id,
      items: t.items,
      bytes: t.bytes,
      ownItems: (own.get(a.id, a.id) as { n: number }).n,
    });
  }
  const run = db
    .prepare(
      `SELECT j.run_id AS runId, MIN(j.pair_id) AS pairId, COUNT(*) AS total, SUM(CASE WHEN j.state = 'done' THEN 1 ELSE 0 END) AS done
       FROM jobs j WHERE j.type = 'digest_backfill' AND j.run_id = (SELECT MAX(run_id) FROM jobs WHERE type = 'digest_backfill')
       GROUP BY j.run_id`,
    )
    .get() as { runId: number; pairId: number; total: number; done: number } | undefined;
  if (run) out.backfill = { runId: run.runId, pairId: run.pairId, relPrefix: null, done: run.done, total: run.total };
  return out;
}
