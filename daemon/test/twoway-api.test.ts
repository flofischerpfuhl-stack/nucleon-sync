// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Two-way pairs through the API and the `nucleon-sync` CLI: creating (also nested in a backup pair), options,
 * switching an existing pair (adoption first), held deletions (approve/deny), conflicts, periodic remote checks.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConflictDto, PairDto, PendingDeletionDto } from '@nucleon-sync/shared';

import { confirmed, startMockDaemon, type MockDaemon } from './c-helpers.ts';
import { ROOT, SEED_BIN, tmp } from './helpers.ts';

const BIN = path.join(ROOT, 'daemon/bin/nucleon-sync');
const R = '/devices/Workstation/Documents';
const T = new Date('2025-03-01T10:00:00Z');
let m: MockDaemon;

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { env: m.env, encoding: 'utf8', timeout: 90_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const pairs = async () => (await m.req<PairDto[]>('GET', '/v1/pairs')).body;
const syncPair = async (id: number) => {
  await m.req('POST', '/v1/sync', { pairId: id });
  await m.d.engine.waitIdle();
};
const remoteSync = (args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile(SEED_BIN, ['--remote', path.join(m.mockDir, 'remote-alex'), ...args], (e) => (e ? reject(e) : resolve())),
  );
const mkTree = (root: string, files: Record<string, string>) => {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    utimesSync(p, T, T);
  }
};

beforeAll(async () => {
  m = await startMockDaemon({ accounts: 'alex' });
  await m.req('POST', '/v1/sync', {});
  await m.d.engine.waitIdle();
});
afterAll(async () => {
  await m.close();
});

describe('two-way pairs via API and CLI', () => {
  it('a two-way pair nested in the backup pair: validated, the parent excludes it, adoption flag set', async () => {
    const parent = (await pairs()).find((p) => p.name === 'Dokumente')!;
    // different sub paths locally and in Proton are refused
    const bad = await m.req<{ error: string }>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Falsch',
      localRoot: path.join(m.data, 'Dokumente/01_Haushalt'),
      remoteRoot: `${R}/02_Büro`,
      direction: 'two-way',
      enabled: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/same sub path/);
    const r = await m.req<PairDto>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Household',
      localRoot: path.join(m.data, 'Dokumente/01_Haushalt'),
      remoteRoot: `${R}/01_Haushalt`,
      direction: 'two-way',
      enabled: true,
      createRemote: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.direction).toBe('two-way');
    expect(r.body.options?.twoWayAdoption).toBe(true);
    const p = (await pairs()).find((x) => x.id === parent.id)!;
    expect(p.ownedElsewhere).toEqual([{ relPath: '01_Haushalt', pairId: r.body.id, pairName: 'Household' }]);

    await m.req('POST', '/v1/sync', {});
    await m.d.engine.waitIdle();
    const child = (await pairs()).find((x) => x.id === r.body.id)!;
    expect(child.options?.twoWayAdoption).toBeUndefined();
    expect(child.lastRemoteCheckAt).toBeTruthy();
    // the file below 01_Haushalt exists once in Proton, uploaded by the child pair only
    const rows = m.d.db.prepare("SELECT pair_id, state FROM entries WHERE rel_path LIKE '%Taxes 2025.pdf'").all() as {
      pair_id: number;
      state: string;
    }[];
    expect(rows.find((x) => x.pair_id === r.body.id)?.state).toBe('synced');
    expect(rows.find((x) => x.pair_id === parent.id)?.state ?? 'excluded').toBe('excluded');

    // CLI shows both
    const out = (await cli(['pairs'])).stdout;
    expect(out).toContain('[two-way]');
    expect(out).toContain(`excludes 01_Haushalt (pair #${r.body.id})`);
  });

  it('options: two-way only, validated; the adoption flag is daemon-managed', async () => {
    const tw = (await pairs()).find((x) => x.direction === 'two-way')!;
    const backup = (await pairs()).find((x) => x.direction === 'backup')!;
    expect((await m.req('PATCH', `/v1/pairs/${backup.id}`, { options: { remoteCheckMinutes: 5 } })).status).toBe(400);
    expect((await m.req('PATCH', `/v1/pairs/${tw.id}`, { options: { remoteCheckMinutes: 0 } })).status).toBe(400);
    const ok = await m.req<PairDto>('PATCH', `/v1/pairs/${tw.id}`, {
      options: { remoteCheckMinutes: 5, massDeleteMaxFiles: 3, twoWayAdoption: true },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.options).toMatchObject({ remoteCheckMinutes: 5, massDeleteMaxFiles: 3 });
    expect(ok.body.options?.twoWayAdoption).toBeUndefined();
  });

  it('switching an existing backup pair to two-way is confirmed and goes through adoption first', async () => {
    const dir = path.join(tmp('switch-'), 'Projekte');
    mkTree(dir, { 'a.txt': 'a', 'b.txt': 'b' });
    const created = await m.req<PairDto>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Projekte',
      localRoot: dir,
      remoteRoot: '/my-files/Projekte',
      direction: 'backup',
      enabled: true,
      createRemote: true,
    });
    expect(created.status).toBe(200);
    await syncPair(created.body.id);
    rmSync(path.join(dir, 'a.txt')); // deleted while still a backup pair: a pending deletion
    await syncPair(created.body.id);
    const { first, second } = await confirmed<PairDto>(m, 'PATCH', `/v1/pairs/${created.body.id}`, {
      direction: 'two-way',
    });
    expect(first.status).toBe(409);
    expect(first.body.summary?.title).toMatch(/two-way/);
    expect(second.status).toBe(200);
    expect(second.body.options?.twoWayAdoption).toBe(true);
    await syncPair(created.body.id);
    // nothing deleted by the switch: a.txt still waits for the user's decision in Proton
    const del = (await m.req<PendingDeletionDto[]>('GET', '/v1/deletions')).body;
    expect(del.map((d) => d.relPath)).toContain('a.txt');
    expect((await pairs()).find((p) => p.id === created.body.id)!.options?.twoWayAdoption).toBeUndefined();
  });

  it('held deletions: approve through the API (confirmed) and the CLI', async () => {
    const dir = path.join(tmp('held-'), 'Viele');
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = `content ${i}`;
    mkTree(dir, files);
    const p = (
      await m.req<PairDto>('POST', '/v1/pairs', {
        accountId: 'alex',
        name: 'Viele',
        localRoot: dir,
        remoteRoot: '/my-files/Viele',
        direction: 'two-way',
        enabled: true,
        createRemote: true,
      })
    ).body;
    await m.req('PATCH', `/v1/pairs/${p.id}`, { options: { massDeleteMaxFiles: 3 } });
    await syncPair(p.id);
    for (let i = 0; i < 4; i++) rmSync(path.join(dir, `f${i}.txt`));
    await syncPair(p.id);
    const pd = (await pairs()).find((x) => x.id === p.id)!;
    expect(pd.heldDeletions).toBe(4);
    expect(pd.brake?.reason).toMatch(/Mass deletion held/);
    expect((await cli(['pairs'])).stdout).toContain(`HELD: 4 deletions (deletions approve|deny ${p.id})`);
    expect((await cli(['deletions'])).stdout).toContain(`[held, pair ${p.id}]`);
    // agent token may not decide
    expect((await m.req('POST', `/v1/pairs/${p.id}/held-deletions`, { approve: true }, 'agent')).status).toBe(403);
    const first = await m.req<{ confirmToken?: string }>('POST', `/v1/pairs/${p.id}/held-deletions`, { approve: true });
    expect(first.status).toBe(409);
    const r = await cli(['deletions', 'approve', String(p.id), '--ui-token', '--yes', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, decided: 4 });
    await m.d.engine.waitIdle();
    await syncPair(p.id);
    const after = (await pairs()).find((x) => x.id === p.id)!;
    expect(after.heldDeletions).toBe(0);
    expect(after.brake ?? null).toBeNull();
    const listing = JSON.parse(
      (await cli(['cli', '--account', 'alex', '--', 'filesystem', 'list', '-j', '/my-files/Viele'])).stdout,
    ) as { name: { value: string } }[];
    expect(listing.map((n) => n.name.value).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `f${i + 4}.txt`).sort(),
    );
    expect((await m.req('POST', `/v1/pairs/${p.id}/held-deletions`, { approve: false })).status).toBe(409); // none left

    // conflicts through the CLI: both changed -> listed as "kept both", resolve keep_remote cleans up the copy
    writeFileSync(path.join(dir, 'f5.txt'), 'edited on this computer');
    utimesSync(path.join(dir, 'f5.txt'), new Date('2025-05-01'), new Date('2025-05-01'));
    await remoteSync(['--edit', '/my-files/Viele/f5.txt', '--content', 'edited elsewhere']);
    await syncPair(p.id);
    const list = await cli(['conflicts']);
    expect(list.stdout).toMatch(/both_changed\s+f5\.txt\s+\[kept both: f5 \(conflict .+\)\.txt\]/);
    const c = (await m.req<ConflictDto[]>('GET', '/v1/conflicts')).body.find((x) => x.relPath === 'f5.txt')!;
    const res = await cli(['conflicts', 'resolve', String(c.id), 'keep_remote', '--ui-token', '--yes']);
    expect(res.code, res.stderr).toBe(0);
    await m.d.engine.waitIdle();
    expect(
      (await m.req<ConflictDto[]>('GET', '/v1/conflicts')).body.find((x) => x.relPath === 'f5.txt'),
    ).toBeUndefined();
  });

  it('periodic remote check: due two-way pairs get a pair run, once per interval', async () => {
    const tw = (await pairs()).filter((x) => x.direction === 'two-way' && !x.brake);
    m.d.db.prepare("UPDATE pairs SET last_run_at = 1 WHERE direction = 'two-way'").run();
    const started = m.d.engine.remoteChecks();
    expect(started.length).toBe(tw.length);
    expect(m.d.engine.remoteChecks()).toEqual([]); // requested already
    await m.d.engine.waitIdle();
    const runs = m.d.engine.runs(20).filter((r) => started.includes(r.id));
    expect(runs.every((r) => r.trigger === 'schedule' && r.lane === 'priority')).toBe(true);
  });
});
