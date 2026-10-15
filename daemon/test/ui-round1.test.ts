// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * fix-ui-round1 (daemon side): background storage measurement with SSE progress, the first measurement soon after
 * start, and a fresh status (pair counts) right after a user decision so the tray flyout and the main window agree.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonEvent, StatusDto, StoragePoolDto } from '@nucleon-sync/shared';

import { startMockDaemon, waitFor, type MockDaemon } from './c-helpers.ts';
import { makeHarness, type Harness } from './scenarios/harness.ts';

let m: MockDaemon | undefined;
let h: Harness | undefined;
afterEach(async () => {
  await m?.close();
  await h?.close();
  m = undefined;
  h = undefined;
});

function events(target: { on: (e: 'event', cb: (ev: DaemonEvent) => void) => unknown }): DaemonEvent[] {
  const list: DaemonEvent[] = [];
  target.on('event', (ev) => list.push(ev));
  return list;
}

describe('storage measurement (UI "Aktualisieren")', () => {
  it('wait:false answers at once, reports progress via `measuring` + SSE `storage`, then stores new samples', async () => {
    m = await startMockDaemon({ latencyMs: 30 });
    const evs = events(m.d.engine);
    const before = await m.req<StoragePoolDto>('GET', '/v1/storage');
    expect(before.body.accounts.every((a) => a.measuredAt === null)).toBe(true);
    expect(before.body.measuring).toEqual([]);

    const r = await m.req<StoragePoolDto & { started: string[]; skipped: unknown[] }>('POST', '/v1/storage/measure', {
      wait: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.started.sort()).toEqual(['alex', 'sam']);
    expect(r.body.skipped).toEqual([]);
    expect(r.body.measuring?.sort()).toEqual(['alex', 'sam']);
    expect(r.body.accounts.every((a) => a.measuredAt === null)).toBe(true); // not finished yet

    await waitFor(() => evs.filter((e) => e.type === 'storage' && e.phase === 'done').length === 2, 20_000);
    const starts = evs
      .filter((e) => e.type === 'storage' && e.phase === 'start')
      .map((e) => (e as { accountId: string }).accountId);
    expect(starts.sort()).toEqual(['alex', 'sam']);
    const after = await m.req<StoragePoolDto>('GET', '/v1/storage');
    expect(after.body.measuring).toEqual([]);
    expect(after.body.accounts.every((a) => a.measuredAt !== null)).toBe(true);
    expect(after.body.accounts.find((a) => a.accountId === 'alex')!.totalBytes).toBeGreaterThan(0);
  });

  it('wait:false skips accounts that are not ready instead of failing the request', async () => {
    m = await startMockDaemon();
    m.d.db.prepare("UPDATE accounts SET status = 'needs_login' WHERE id = 'sam'").run();
    const r = await m.req<{ started: string[]; skipped: { accountId: string; reason: string }[] }>(
      'POST',
      '/v1/storage/measure',
      { wait: false, accountId: 'sam' },
    );
    expect(r.status).toBe(200);
    expect(r.body.started).toEqual([]);
    expect(r.body.skipped).toEqual([
      expect.objectContaining({ accountId: 'sam', reason: expect.stringMatching(/not ready/) }),
    ]);
  });

  it('measures never-measured accounts at any hour; measured accounts only once a day after dailyHour', async () => {
    m = await startMockDaemon({ config: { dailyHour: 9 } });
    const storage = m.d.services.storage;
    const early = new Date();
    early.setHours(3, 0, 0, 0);
    await storage.daily(early);
    const first = await m.req<StoragePoolDto>('GET', '/v1/storage');
    const at = first.body.accounts.map((a) => a.measuredAt);
    expect(at.every(Boolean)).toBe(true);
    // second check the same night: already measured -> nothing new before dailyHour
    await storage.daily(early);
    expect((await m.req<StoragePoolDto>('GET', '/v1/storage')).body.accounts.map((a) => a.measuredAt)).toEqual(at);
  });

  it('runs the first measurement shortly after start (NUCLEON_SYNC_STORAGE_FIRST_MS), not after 15 minutes', async () => {
    m = await startMockDaemon({ env: { NUCLEON_SYNC_STORAGE_FIRST_MS: '50' } });
    m.d.services.storage.start();
    await waitFor(() => {
      const n = m!.d.db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM storage_samples').get() as { n: number };
      return n.n === 2;
    }, 20_000);
    m.d.services.storage.stop();
  });
});

describe('fresh status after user decisions', () => {
  it('resolving a conflict emits a status event with the updated pair counts right away', async () => {
    h = await makeHarness({
      accounts: [{ id: 'sam', workers: 1, devices: [] }],
      pairs: [
        {
          account: 'sam',
          name: 'Laptop-Backup',
          local: 'Sam/Laptop-Backup',
          remote: '/my-files/Laptop-Backup',
          direction: 'mirror-down',
        },
      ],
      seed: { sam: [{ to: '/my-files/Laptop-Backup', files: { 'b.txt': 'b' } }] },
    });
    await h.sync();
    h.write('Sam/Laptop-Backup/b.txt', 'edited locally');
    await h.sync();
    const c = h.engine.conflicts();
    expect(c).toHaveLength(1);
    const status = () => h!.engine.status() as StatusDto;
    expect(status().pairs[0]!.counts.conflict).toBe(1);
    const evs = events(h.engine);
    h.engine.resolveConflict(c[0]!.id, 'ignore', 'test');
    // synchronously: no waiting for the 1 s coalesced status
    const st = evs.filter((e): e is Extract<DaemonEvent, { type: 'status' }> => e.type === 'status').pop();
    expect(st).toBeTruthy();
    expect(st!.status.openConflicts).toBe(0);
    expect(st!.status.pairs[0]!.counts.conflict ?? 0).toBe(0);
    expect(evs.some((e) => e.type === 'conflicts_changed' && e.open === 0)).toBe(true);
  });
});
