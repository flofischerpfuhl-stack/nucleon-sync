// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * API + CLI surface of "Neue Dateien vom PC hochladen" (pairs.options.uploadLocalNew) and the pair sync an agent
 * triggers right after filing a document (`nucleon-sync sync --pair N --wait`, agent token).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityItem, PairDto, RunDto, SyncResponse } from '@nucleon-sync/shared';

import { startMockDaemon, type MockDaemon } from './c-helpers.ts';
import { ROOT } from './helpers.ts';

const BIN = path.join(ROOT, 'daemon/bin/nucleon-sync');
let m: MockDaemon;
let mirror: PairDto;

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { env: m.env, encoding: 'utf8', timeout: 90_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

beforeAll(async () => {
  m = await startMockDaemon({ latencyMs: 30 });
  await m.req('POST', '/v1/sync', {});
  await m.d.engine.waitIdle();
  mirror = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.direction === 'mirror-down')!;
});
afterAll(async () => {
  await m.close();
});

describe('pair option uploadLocalNew', () => {
  it('ui token only, mirror-down only; the daemon stamps uploadLocalNewSince once', async () => {
    expect(
      (await m.req('PATCH', `/v1/pairs/${mirror.id}`, { options: { uploadLocalNew: true } }, 'agent')).status,
    ).toBe(403);
    const backup = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.direction === 'backup')!;
    expect((await m.req('PATCH', `/v1/pairs/${backup.id}`, { options: { uploadLocalNew: true } })).status).toBe(400);
    expect((await m.req('PATCH', `/v1/pairs/${mirror.id}`, { options: { uploadLocalNew: 'yes' } })).status).toBe(400);

    const t0 = Date.now();
    const on = await m.req<PairDto>('PATCH', `/v1/pairs/${mirror.id}`, {
      options: { uploadLocalNew: true, uploadLocalNewSince: 1 },
    });
    expect(on.status).toBe(200);
    expect(on.body.options?.uploadLocalNew).toBe(true);
    const since = on.body.options!.uploadLocalNewSince!;
    expect(since).toBeGreaterThanOrEqual(t0); // client-supplied value ignored
    const again = await m.req<PairDto>('PATCH', `/v1/pairs/${mirror.id}`, { options: { uploadLocalNew: true } });
    expect(again.body.options?.uploadLocalNewSince).toBe(since);

    const off = await m.req<PairDto>('PATCH', `/v1/pairs/${mirror.id}`, { options: { uploadLocalNew: false } });
    expect(off.body.options?.uploadLocalNew).toBeUndefined();
    expect(off.body.options?.uploadLocalNewSince).toBeUndefined();

    // CLI: pairs set <id> options.uploadLocalNew=true (ui token)
    const r = await cli(['pairs', 'set', String(mirror.id), 'options.uploadLocalNew=true', '--ui-token', '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as PairDto).options?.uploadLocalNew).toBe(true);
    expect((await cli(['pairs'])).stdout).toContain('uploads new local files');
  });

  it('agent: file a document, `sync --pair N --wait` returns after that pair ran; it was uploaded', async () => {
    await new Promise((r) => setTimeout(r, 20));
    const dir = path.join(mirror.localRoot, 'Dokumente/Rechnungen');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2026-10-11 Rechnung.pdf'), 'filed by an agent'); // fresh: the run waits for it

    // a full run is already active: since 0.2 the pair request does not queue behind it, it runs at
    // once in the pair's priority lane, and --wait waits for exactly that run
    const first = (await m.req<SyncResponse>('POST', '/v1/sync', { mode: 'full' }, 'agent')).body;
    const r = await cli(['sync', '--pair', String(mirror.id), '--wait', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as RunDto & {
      followUp: boolean;
      requestedRunId: number;
      runIds: number[];
      notRunnable: string | null;
      writesBlocked: string | null;
      blockedJobs: number;
    };
    expect(out.followUp).toBe(false);
    expect(out.requestedRunId).toBe(out.id);
    expect(out.runIds).toEqual([out.id]);
    expect(out.id).toBeGreaterThan(first.runId);
    expect(out.pairId).toBe(mirror.id);
    expect(out.lane).toBe('priority');
    expect(out.status).toBe('ok');
    // uploaded by the full run or by the follow-up, exactly once
    expect(out.notRunnable).toBeNull();
    expect(out.writesBlocked).toBeNull();

    const items = (
      await m.req<ActivityItem[]>('GET', `/v1/activity?pair=${mirror.id}&action=uploaded`, undefined, 'agent')
    ).body;
    expect(items.filter((i) => i.relPath?.endsWith('2026-10-11 Rechnung.pdf'))).toHaveLength(1);
    expect(items[0]).toMatchObject({
      relPath: 'Dokumente/Rechnungen/2026-10-11 Rechnung.pdf',
      message: 'uploaded from the PC',
      msg: { key: 'activity.uploadedFromPc' },
    });
  });

  it('a disabled pair is reported as not runnable (exit 4), nothing waits forever', async () => {
    await m.req('PATCH', `/v1/pairs/${mirror.id}`, { enabled: false });
    const api = await m.req<SyncResponse>('POST', '/v1/sync', { pairId: mirror.id }, 'agent');
    expect(api.status).toBe(200);
    expect(api.body.notRunnable).toMatch(/is disabled/);
    expect(api.body.notRunnableMsg).toEqual({ key: 'gate.pairDisabled', params: { id: mirror.id, pair: mirror.name } });
    const r = await cli(['sync', '--pair', String(mirror.id), '--wait']);
    expect(r.code).toBe(4);
    expect(r.stdout).toMatch(/not synced: Pair #\d+ .* is disabled/);
    await m.req('PATCH', `/v1/pairs/${mirror.id}`, { enabled: true });
    await m.d.engine.waitIdle();
  });
});
