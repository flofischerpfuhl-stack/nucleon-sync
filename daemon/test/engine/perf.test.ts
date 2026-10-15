// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Performance budget: synthetic tree on tmpfs — no-change local scan < 60 s, planning < 30 s,
 * DB < 300 MB for 200k files. Default runs use 20k files with proportional budgets; the full size is opt-in:
 *   NUCLEON_SYNC_PERF=1 pnpm vitest run daemon/test/engine/perf.test.ts
 */
import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDb } from '../../src/db/db.ts';
import type { PairRow } from '../../src/db/repo.ts';
import { planPair } from '../../src/engine/planner.ts';
import { RuleMatcher } from '../../src/engine/rules.ts';
import { applyScanResult, scanLocal } from '../../src/engine/scanner.ts';
import { defaultGlobalExcludes } from '@nucleon-sync/shared';
import { tmp } from '../helpers.ts';

const FULL = process.env.NUCLEON_SYNC_PERF === '1';
const N = Number(process.env.NUCLEON_SYNC_PERF_FILES ?? (FULL ? 200_000 : 20_000));
const scale = N / 200_000;

describe('performance', () => {
  it(
    `${N} files: no-change scan, planning and DB size within budget`,
    async () => {
      const dir = tmp('perf-');
      const root = path.join(dir, 'Dokumente');
      const t0 = Date.now();
      const perDir = 100;
      for (let d = 0; d < N / perDir; d++) {
        const sub = path.join(root, `ordner-${Math.floor(d / 50)}`, `projekt-${d}`);
        mkdirSync(sub, { recursive: true });
        for (let f = 0; f < perDir; f++) writeFileSync(path.join(sub, `datei-${f}.txt`), `inhalt ${d}/${f}`);
      }
      const createMs = Date.now() - t0;
      const dbFile = path.join(dir, 'state.sqlite');
      const db = openDb(dbFile);
      db.prepare(
        "INSERT INTO accounts (id, display_name, credential_backend, created_at) VALUES ('alex', 'F', 'mock', 0)",
      ).run();
      db.prepare(
        "INSERT INTO pairs (id, account_id, name, local_root, remote_root, remote_section, remote_root_uid, direction, created_at) VALUES (1, 'alex', 'D', ?, '/devices/R/D', '/devices/R', 'root', 'backup', 0)",
      ).run(root);
      const pair = db.prepare('SELECT * FROM pairs WHERE id = 1').get() as unknown as PairRow;
      const matcher = new RuleMatcher({ rules: defaultGlobalExcludes(), localRoot: root });

      const t1 = Date.now();
      const first = await scanLocal({
        db,
        pair,
        scanId: 1,
        mode: 'incremental',
        matcher,
        freshMs: 0,
        hashConcurrency: 4,
      });
      applyScanResult(db, 1, first);
      const firstMs = Date.now() - t1;
      expect(first.files).toBe(N);
      expect(first.hashed).toBe(N);
      // pretend everything is in sync remotely (as after a full first run)
      db.exec(`UPDATE entries SET r_exists = 1, r_uid = 'u' || id, r_parent_uid = 'p', r_rev_uid = 'r' || id, r_size = l_size,
      r_sha1 = l_sha1, b_sha1 = l_sha1, b_size = l_size, b_l_mtime_us = l_mtime_us, b_r_rev_uid = 'r' || id, synced_at = 1`);

      const t2 = Date.now();
      const second = await scanLocal({ db, pair, scanId: 2, mode: 'incremental', matcher, freshMs: 0 });
      applyScanResult(db, 2, second);
      const scanMs = Date.now() - t2;
      expect(second.hashed).toBe(0);
      expect(second.missing).toHaveLength(0);

      const t3 = Date.now();
      const plan = planPair({ db, pair, runId: null, matcher });
      const planMs = Date.now() - t3;
      expect(plan.jobs).toBe(0);

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const dbBytes = statSync(dbFile).size + (existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0);
      console.log(
        JSON.stringify({
          files: N,
          createMs,
          firstScanWithHashMs: firstMs,
          noChangeScanMs: scanMs,
          planMs,
          dbMB: +(dbBytes / 1e6).toFixed(1),
        }),
      );
      expect(scanMs).toBeLessThan(Math.max(5_000, 60_000 * scale));
      expect(planMs).toBeLessThan(Math.max(3_000, 30_000 * scale));
      expect(dbBytes).toBeLessThan(Math.max(30e6, 300e6 * scale));
      db.close();
    },
    FULL ? 900_000 : 120_000,
  );
});
