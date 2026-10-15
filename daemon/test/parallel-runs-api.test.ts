// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Per-account runs through the API and the `nucleon-sync` CLI (agent token): while Alex's account has a long run,
 * `nucleon-sync sync --pair <Sam's pair> --wait` starts at once and returns when that pair is done; status (JSON and
 * text) shows several runs; a request for the busy account answers with the id of its queued run.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityItem, PairDto, RunDto, StatusDto, SyncResponse } from '@nucleon-sync/shared';

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

async function until(cond: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  // Alex's transfers are slow (80 KB files take 2 s each), Sam's are not
  m = await startMockDaemon({ latencyMs: 0, accountEnv: { alex: { MOCK_TRANSFER_BPS: '40000' } } });
  await m.req('POST', '/v1/sync', {});
  await m.d.engine.waitIdle();
  mirror = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.direction === 'mirror-down')!;
  expect((await m.req('PATCH', `/v1/pairs/${mirror.id}`, { options: { uploadLocalNew: true } })).status).toBe(200);
});
afterAll(async () => {
  await m.close();
});

describe('parallel runs via API and CLI', () => {
  it("agent `sync --pair <Sam> --wait` does not wait for Alex's long run", async () => {
    for (let i = 0; i < 16; i++) {
      const d = path.join(m.data, `Dokumente/Projekt ${i}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, `scan-${i}.pdf`), 'x'.repeat(80_000));
    }
    const long = (await m.req<SyncResponse>('POST', '/v1/sync', { accountId: 'alex' }, 'agent')).body;
    expect(long.followUp).toBe(false);
    expect(long.runIds).toEqual([long.runId]);
    await until(
      async () =>
        (await m.req<{ state: string }[]>('GET', '/v1/jobs?state=running', undefined, 'agent')).body.length > 0,
    );

    // a second request for Alex: queued, with its final run id, behind the long run
    const queued = await cli(['sync', '--account', 'alex']);
    expect(queued.code).toBe(0);
    expect(queued.stdout).toMatch(new RegExp(`^queued after run #${long.runId} \\(as run #(\\d+)\\)`));
    const queuedId = Number(/as run #(\d+)/.exec(queued.stdout)![1]);

    const st = (await m.req<StatusDto>('GET', '/v1/status', undefined, 'agent')).body;
    expect(st.activeRuns!.map((r) => r.id)).toEqual([long.runId]);
    expect(st.queuedRuns!.map((r) => [r.id, r.status, r.waitingFor])).toEqual([[queuedId, 'queued', [long.runId]]]);
    const text = await cli(['status']);
    expect(text.stdout).toContain(`current run: #${long.runId}`);
    expect(text.stdout).toContain(`#${queuedId} incremental alex queued after #${long.runId}`);

    // an agent files a document for Sam and syncs her pair
    const dir = path.join(mirror.localRoot, 'Dokumente/Rechnungen');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '2026-10-12 Rechnung.pdf'), 'filed by an agent');
    const t0 = Date.now();
    const r = await cli(['sync', '--pair', String(mirror.id), '--wait', '--json']);
    const elapsed = Date.now() - t0;
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as RunDto & { followUp: boolean; runIds: number[]; runs: RunDto[] };
    expect(out.followUp).toBe(false);
    expect(out.lane).toBe('priority');
    expect(out.pairId).toBe(mirror.id);
    expect(out.accountId).toBe('sam');
    expect(out.status).toBe('ok');
    expect(out.runIds).toEqual([out.id]);
    expect(elapsed).toBeLessThan(8000); // Alex's 16 x 2 s / 2 workers take >= 16 s
    // Alex's run is still running, the queued one still waits
    expect((await m.req<RunDto>('GET', `/v1/runs/${long.runId}`, undefined, 'agent')).body.status).toBe('running');
    expect((await m.req<RunDto>('GET', `/v1/runs/${queuedId}`, undefined, 'agent')).body.status).toBe('queued');
    expect((await m.req('GET', '/v1/runs/999999', undefined, 'agent')).status).toBe(404);

    const items = (
      await m.req<ActivityItem[]>('GET', `/v1/activity?pair=${mirror.id}&action=uploaded`, undefined, 'agent')
    ).body;
    expect(items.filter((i) => i.relPath === 'Dokumente/Rechnungen/2026-10-12 Rechnung.pdf')).toHaveLength(1);

    // --wait for the queued Alex run returns once it ran (after the long one)
    const w = await cli(['sync', '--account', 'alex', '--wait', '--json']);
    expect(w.code, w.stderr).toBe(0);
    const wr = JSON.parse(w.stdout) as RunDto & { followUp: boolean };
    expect(wr.followUp).toBe(true);
    expect(wr.id).toBe(queuedId); // merged into the queued run
    expect(wr.status).toBe('ok');
    const longDone = (await m.req<RunDto>('GET', `/v1/runs/${long.runId}`, undefined, 'agent')).body;
    expect(longDone.status).toBe('ok');
    expect(longDone.counters.uploaded).toBe(16);
    await m.d.engine.waitIdle();
  });

  it('a global sync while one account is busy is split per account; --wait waits for all parts', async () => {
    for (let i = 0; i < 4; i++) {
      const d = path.join(m.data, `Dokumente/Global ${i}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, `g-${i}.pdf`), 'y'.repeat(80_000));
    }
    const long = (await m.req<SyncResponse>('POST', '/v1/sync', { accountId: 'alex' }, 'agent')).body;
    const g = (await m.req<SyncResponse>('POST', '/v1/sync', {}, 'agent')).body;
    expect(g.followUp).toBe(true);
    expect(g.runIds).toHaveLength(2);
    expect(g.queuedBehind).toEqual([long.runId]);
    const parts = await Promise.all(
      g.runIds!.map(async (id) => (await m.req<RunDto>('GET', `/v1/runs/${id}`, undefined, 'agent')).body),
    );
    const sam = parts.find((p) => p.accountId === 'sam')!;
    const alexPart = parts.find((p) => p.accountId === 'alex')!;
    expect(alexPart.status).toBe('queued');
    expect(['running', 'ok']).toContain(sam.status); // Sam's part started at once
    const w = await cli(['sync', '--wait', '--json']);
    expect(w.code, w.stderr).toBe(0);
    const out = JSON.parse(w.stdout) as RunDto & { runs: RunDto[] };
    expect(out.runs.every((x) => x.status === 'ok')).toBe(true);
    await m.d.engine.waitIdle();
  });
});
