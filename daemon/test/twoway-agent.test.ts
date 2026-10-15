// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Agent layer × two-way pairs (ARCHITECTURE §10): the scope model of the two-way routes and CLI commands.
 * - held deletions: deny (restore) = `manage`; approve = `destructive` + the user's approval;
 * - deletion decisions that trash (`trash_local`, `trash_remote`) = `destructive` + approval; restores = `manage`;
 * - review clean-ups that trash = `destructive` + approval;
 * - switching a pair to two-way = `manage` + approval (direction change), creating a (nested) two-way pair = `manage`;
 * - the CLI follows the `--json` / exit-code contract (2 usage, 5 confirmation, 6 forbidden, 7 pending).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ApprovalDto,
  ApprovalRequiredResponse,
  ConflictDto,
  CreateAgentTokenResponse,
  PairDto,
  PendingDeletionDto,
} from '@nucleon-sync/shared';

import { startMockDaemon, type MockDaemon } from './c-helpers.ts';
import { ROOT, SEED_BIN, tmp } from './helpers.ts';

const BIN = path.join(ROOT, 'daemon/bin/nucleon-sync');
const T = new Date('2025-03-01T10:00:00Z');
let m: MockDaemon;
let manager: CreateAgentTokenResponse;
let cleaner: CreateAgentTokenResponse;

type Json = Record<string, unknown> & { confirm?: { summary: unknown }; error?: string };
function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: <T = Json>() => T }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { env: m.env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        json: <T>() => JSON.parse(stdout) as T,
      }),
    );
  });
}
const remoteOp = (args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile(SEED_BIN, ['--remote', path.join(m.mockDir, 'remote-alex'), ...args], (e) => (e ? reject(e) : resolve())),
  );
const syncPair = async (id: number) => {
  await m.req('POST', '/v1/sync', { pairId: id });
  await m.d.engine.waitIdle();
};
const pairById = async (id: number) => (await m.req<PairDto>('GET', `/v1/pairs/${id}`)).body;
const held = async (id: number) =>
  (await m.req<PendingDeletionDto[]>('GET', '/v1/deletions')).body.filter((d) => d.pairId === id && d.held);

/** a two-way pair with `n` synced files and a low mass-delete threshold */
async function twoWayPair(name: string, n: number): Promise<{ pair: PairDto; dir: string }> {
  const dir = path.join(tmp('tw-agent-'), name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(path.join(dir, `f${i}.txt`), `content ${i}`);
    utimesSync(path.join(dir, `f${i}.txt`), T, T);
  }
  const r = await m.req<PairDto>('POST', '/v1/pairs', {
    accountId: 'alex',
    name,
    localRoot: dir,
    remoteRoot: `/my-files/${name}`,
    direction: 'two-way',
    enabled: true,
    createRemote: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await m.req('PATCH', `/v1/pairs/${r.body.id}`, { options: { massDeleteMaxFiles: 2 } });
  await syncPair(r.body.id);
  return { pair: r.body, dir };
}

beforeAll(async () => {
  m = await startMockDaemon({ accounts: 'alex' });
  await m.req('POST', '/v1/sync', {});
  await m.d.engine.waitIdle();
  manager = (await m.req<CreateAgentTokenResponse>('POST', '/v1/tokens', { name: 'manager', scopes: ['manage'] })).body;
  cleaner = (
    await m.req<CreateAgentTokenResponse>('POST', '/v1/tokens', {
      name: 'cleaner',
      scopes: ['sync', 'manage', 'destructive'],
    })
  ).body;
});
afterAll(async () => {
  await m.close();
});

describe('two-way actions in the agent-token scope model', () => {
  it('a manage token creates a two-way pair (nested in the backup pair) without an approval', async () => {
    const parent = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.name === 'Dokumente')!;
    const r = await m.req<PairDto>(
      'POST',
      '/v1/pairs',
      {
        accountId: 'alex',
        name: 'Haus',
        localRoot: path.join(parent.localRoot, '01_Haushalt'),
        remoteRoot: `${parent.remoteRoot}/01_Haushalt`,
        direction: 'two-way',
        enabled: true,
      },
      manager.token,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ direction: 'two-way', options: { twoWayAdoption: true } });
    // the read-only default token may not
    const denied = await m.req<{ needs?: string }>(
      'POST',
      '/v1/pairs',
      { accountId: 'alex', name: 'X', localRoot: '/tmp/x', remoteRoot: '/my-files/X', direction: 'two-way' },
      'agent',
    );
    expect(denied.status).toBe(403);
    expect(denied.body.needs).toBe('manage');
  });

  it('switching a pair to two-way: manage + the user approval (kind pair.direction, two-way detail)', async () => {
    const dir = path.join(tmp('tw-switch-'), 'Switch');
    mkdirSync(dir, { recursive: true });
    const p = (
      await m.req<PairDto>('POST', '/v1/pairs', {
        accountId: 'alex',
        name: 'Switch',
        localRoot: dir,
        remoteRoot: '/my-files/Switch',
        direction: 'upload-only',
        createRemote: true,
      })
    ).body;
    const r = await m.req<ApprovalRequiredResponse>(
      'PATCH',
      `/v1/pairs/${p.id}`,
      { direction: 'two-way' },
      manager.token,
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('approval required');
    expect(r.body.summary).toMatchObject({ kind: 'pair.direction', params: { to: 'two-way' } });
    expect(r.body.summary.details.join(' ')).toMatch(/^Two-way: changes and deletions go both ways/);
    expect((await pairById(p.id)).direction).toBe('upload-only');
  });

  it('held deletions: deny is manage, approve needs destructive and the user approval', async () => {
    const { pair, dir } = await twoWayPair('Held', 6);
    // deleted here (→ Proton trash) and deleted in Proton (→ local trash)
    for (const i of [0, 1]) rmSync(path.join(dir, `f${i}.txt`));
    await remoteOp(['--trash', '/my-files/Held/f2.txt', '--trash', '/my-files/Held/f3.txt']);
    await syncPair(pair.id);
    const h = await held(pair.id);
    expect(h.map((d) => d.side).sort()).toEqual(['local', 'local', 'remote', 'remote']);
    expect((await pairById(pair.id)).heldDeletions).toBe(4);

    // manage only: approving is refused before any approval is created; trash_local too
    const noScope = await m.req<{ needs?: string }>(
      'POST',
      `/v1/pairs/${pair.id}/held-deletions`,
      { approve: true },
      manager.token,
    );
    expect(noScope.status).toBe(403);
    expect(noScope.body.needs).toBe('destructive');
    const remoteSide = h.filter((d) => d.side === 'remote');
    const trashLocal = await m.req<{ needs?: string }>(
      'POST',
      '/v1/deletions/decide',
      { ids: [remoteSide[0]!.id], decision: 'trash_local' },
      manager.token,
    );
    expect(trashLocal.status).toBe(403);
    expect(trashLocal.body.needs).toBe('destructive');
    // a single restore is a manage decision (no approval)
    const restore = await m.req(
      'POST',
      '/v1/deletions/decide',
      { ids: [remoteSide[0]!.id], decision: 'restore_remote' },
      manager.token,
    );
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    expect((await m.req<ApprovalDto[]>('GET', '/v1/approvals')).body.filter((a) => a.state === 'pending')).toEqual([]);

    // destructive token: trash_local of a single file also waits for the user (kind deletions.trashLocal)
    const tl = await m.req<ApprovalRequiredResponse>(
      'POST',
      '/v1/deletions/decide',
      { ids: [remoteSide[1]!.id], decision: 'trash_local' },
      cleaner.token,
    );
    expect(tl.status).toBe(409);
    expect(tl.body.summary).toMatchObject({ kind: 'deletions.trashLocal', items: 1 });

    // approve through the CLI: --json without --yes → exit 5 (nothing shown to the user)
    const noYes = await cli(['deletions', 'approve', String(pair.id), '--agent', 'cleaner', '--json']);
    expect(noYes.code, noYes.stdout).toBe(5);
    expect(noYes.json()).toMatchObject({ ok: false, exitCode: 5, code: 'confirmation_required' });
    expect(noYes.json().confirm!.summary).toMatchObject({ kind: 'pair.heldDeletions', params: { name: 'Held' } });
    // manage-only agent via the CLI → exit 6
    const forb = await cli(['deletions', 'approve', String(pair.id), '--agent', 'manager', '--yes', '--json']);
    expect(forb.code, forb.stdout).toBe(6);
    expect(forb.json()).toMatchObject({ ok: false, exitCode: 6, code: 'forbidden' });
    // --yes --no-wait → exit 7 pending; the user approves; --confirm-token carries it out once
    const pend = await cli([
      'deletions',
      'approve',
      String(pair.id),
      '--agent',
      'cleaner',
      '--yes',
      '--no-wait',
      '--json',
    ]);
    expect(pend.code, pend.stdout).toBe(7);
    const body = pend.json<{ approval: ApprovalDto; confirmToken: string }>();
    expect(body.approval).toMatchObject({ state: 'pending', tokenName: 'cleaner' });
    expect(body.approval.summary.kind).toBe('pair.heldDeletions');
    expect((await held(pair.id)).length).toBe(3); // nothing decided yet
    expect((await m.req('POST', `/v1/approvals/${body.approval.id}/approve`, {})).status).toBe(200);
    const run = await cli([
      'deletions',
      'approve',
      String(pair.id),
      '--agent',
      'cleaner',
      '--confirm-token',
      body.confirmToken,
      '--json',
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ ok: true, decided: 3 });
    await m.d.engine.waitIdle();
    expect((await pairById(pair.id)).heldDeletions ?? 0).toBe(0);
  });

  it('held deletions: a manage agent may deny (restore) without an approval', async () => {
    const { pair, dir } = await twoWayPair('Deny', 6);
    for (const i of [0, 1, 2]) rmSync(path.join(dir, `f${i}.txt`));
    await syncPair(pair.id);
    expect((await held(pair.id)).length).toBe(3);
    const r = await cli(['deletions', 'deny', String(pair.id), '--agent', 'manager', '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, decided: 3 });
    await m.d.engine.waitIdle();
    await syncPair(pair.id);
    expect((await held(pair.id)).length).toBe(0);
  });

  it('review clean-ups that trash need destructive + approval; keep both is manage', async () => {
    const { pair, dir } = await twoWayPair('Review', 3);
    writeFileSync(path.join(dir, 'f1.txt'), 'edited here');
    utimesSync(path.join(dir, 'f1.txt'), new Date('2025-05-01'), new Date('2025-05-01'));
    await remoteOp(['--edit', '/my-files/Review/f1.txt', '--content', 'edited elsewhere']);
    await syncPair(pair.id);
    const c = (await m.req<ConflictDto[]>('GET', '/v1/conflicts')).body.find(
      (x) => x.pairId === pair.id && x.relPath === 'f1.txt',
    )!;
    expect(c.keptBoth?.copyRelPath).toBeTruthy();
    const no = await m.req<{ needs?: string }>(
      'POST',
      `/v1/conflicts/${c.id}/resolve`,
      { resolution: 'keep_remote' },
      manager.token,
    );
    expect(no.status).toBe(403);
    expect(no.body.needs).toBe('destructive');
    const ask = await m.req<ApprovalRequiredResponse>(
      'POST',
      `/v1/conflicts/${c.id}/resolve`,
      { resolution: 'keep_local' },
      cleaner.token,
    );
    expect(ask.status).toBe(409);
    expect(ask.body.summary).toMatchObject({ kind: 'conflict.reviewKeepLocal', params: { path: 'f1.txt' } });
    // dismissing the review item ("keep both") deletes nothing
    const keep = await cli(['conflicts', 'resolve', String(c.id), 'keep_both', '--agent', 'manager', '--json']);
    expect(keep.code, keep.stdout + keep.stderr).toBe(0);
  });

  it('CLI usage errors exit 2', async () => {
    const a = await cli(['deletions', 'approve', '--json']);
    expect(a.code).toBe(2);
    expect(a.json()).toMatchObject({ ok: false, exitCode: 2, code: 'usage' });
    expect((await cli(['deletions', 'deny', 'x', '--json'])).code).toBe(2);
    const d = await cli([
      'pairs',
      'add',
      '--account',
      'alex',
      '--local',
      '/tmp/a',
      '--remote',
      '/x',
      '--direction',
      'both',
      '--json',
    ]);
    expect(d.code).toBe(2);
    expect(d.json().error).toMatch(/two-way/);
  });
});
