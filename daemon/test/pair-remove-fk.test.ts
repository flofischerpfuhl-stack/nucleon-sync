// SPDX-License-Identifier: GPL-3.0-or-later
/** Removing a pair whose two-way deletions point at its jobs (pending_deletions.job_id has no cascade). */
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePaths, type PairDto } from '@nucleon-sync/shared';

import { confirmed, startMockDaemon, type MockDaemon } from './c-helpers.ts';

let m: MockDaemon;
beforeAll(async () => {
  m = await startMockDaemon({ accounts: 'alex' });
});
afterAll(async () => m?.close());

describe('pair removal', () => {
  it('works when decided deletions still reference the pair jobs', async () => {
    const pid = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.accountId === 'alex')!.id;
    const db = new DatabaseSync(resolvePaths({ ...process.env, NUCLEON_SYNC_HOME: m.home }).dbFile);
    const now = Date.now();
    const entry = db
      .prepare(
        "INSERT INTO entries (pair_id, rel_path, kind, updated_at) VALUES (?, 'gone.txt', 'file', ?) RETURNING id",
      )
      .get(pid, now) as { id: number };
    const job = db
      .prepare(
        "INSERT INTO jobs (account_id, pair_id, entry_id, type, state, created_at) VALUES ('alex', ?, ?, 'trash_remote', 'done', ?) RETURNING id",
      )
      .get(pid, entry.id, now) as { id: number };
    db.prepare(
      "INSERT INTO pending_deletions (entry_id, detected_at, decision, job_id, side) VALUES (?, ?, 'trash_remote', ?, 'local')",
    ).run(entry.id, now, job.id);
    db.close();
    expect((await confirmed(m, 'DELETE', `/v1/pairs/${pid}`)).second.status).toBe(200);
    expect((await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.id === pid)).toBeUndefined();
  });
});
