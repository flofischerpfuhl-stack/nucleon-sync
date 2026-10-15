// SPDX-License-Identifier: GPL-3.0-or-later
/** API: token scopes, confirm round-trip, settings validation, pairs, activity filters, timed pause, brakes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AccountDto,
  ActivityItem,
  ConfirmRequiredResponse,
  DoctorCheck,
  PairDto,
  PairPreviewDto,
  SettingsDto,
  StatusDto,
  StoragePoolDto,
} from '@nucleon-sync/shared';

import { confirmed, seedRemote, startMockDaemon, waitFor, type MockDaemon } from './c-helpers.ts';

let m: MockDaemon;

beforeAll(async () => {
  m = await startMockDaemon();
  // one real sync so activity, entries and runs exist
  await m.req('POST', '/v1/sync', {});
  await m.d.engine.waitIdle();
});
afterAll(async () => {
  await m.close();
});

describe('token scopes', () => {
  it('agent token may read and sync/pause/resume', async () => {
    for (const p of [
      '/v1/status',
      '/v1/accounts',
      '/v1/pairs',
      '/v1/activity',
      '/v1/settings',
      '/v1/conflicts',
      '/v1/deletions',
      '/v1/storage',
      '/v1/doctor',
      '/v1/runs',
      '/v1/maintenance/summary',
      '/v1/pairs/1/rules',
    ])
      expect((await m.req('GET', p, undefined, 'agent')).status, p).toBe(200);
    expect((await m.req('POST', '/v1/pause', { scope: 'all' }, 'agent')).status).toBe(200);
    expect((await m.req('POST', '/v1/resume', { scope: 'all' }, 'agent')).status).toBe(200);
  });

  it('agent token gets 403 on ui routes', async () => {
    const cases: [string, string, unknown?][] = [
      ['POST', '/v1/accounts', { id: 'x', displayName: 'X' }],
      ['POST', '/v1/accounts/alex/login'],
      ['DELETE', '/v1/accounts/alex/session', {}],
      ['PUT', '/v1/settings', {}],
      ['POST', '/v1/pairs', {}],
      ['DELETE', '/v1/pairs/1', {}],
      ['PUT', '/v1/pairs/1/rules', []],
      ['POST', '/v1/pairs/1/release-brake', {}],
      ['GET', '/v1/remote/alex/browse?path=/'],
      ['POST', '/v1/conflicts/1/resolve', { resolution: 'ignore' }],
      ['POST', '/v1/deletions/decide', { ids: [1], decision: 'trash_remote' }],
      ['POST', '/v1/maintenance/empty-trash', { accountId: 'alex' }],
      ['POST', '/v1/notifications/test', {}],
      ['GET', '/v1/tokens/agent'],
    ];
    for (const [method, p, body] of cases)
      expect((await m.req(method, p, body, 'agent')).status, `${method} ${p}`).toBe(403);
  });

  it('unknown tokens are rejected, unknown methods are 405', async () => {
    expect((await m.req('GET', '/v1/status', undefined, 'nope')).status).toBe(401);
    expect((await m.req('PATCH', '/v1/status', {})).status).toBe(405);
  });

  it('every documented route is reachable (no 404/501)', async () => {
    const routes: [string, string][] = [
      ['GET', '/v1/health'],
      ['GET', '/v1/accounts/alex'],
      ['GET', '/v1/accounts/alex/storage'],
      ['GET', '/v1/storage/history?days=90'],
      ['GET', '/v1/pairs/1'],
      ['GET', '/v1/pairs/1/tree?path='],
      ['GET', '/v1/jobs?limit=5'],
      ['GET', '/v1/adoptions'],
      ['GET', '/v1/notifications'],
      ['GET', '/v1/remote/alex/browse?path=/'],
      ['GET', '/v1/tokens/agent'],
    ];
    for (const [method, p] of routes) {
      const r = await m.req(method, p);
      expect([200], `${method} ${p}: ${JSON.stringify(r.body).slice(0, 200)}`).toContain(r.status);
    }
  });
});

describe('confirm round-trip', () => {
  it('a destructive call needs the token, bound to the exact action, single use', async () => {
    const created = await m.req<PairDto>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Temp',
      localRoot: mkdirTemp('temp-pair'),
      remoteRoot: '/my-files',
      direction: 'upload-only',
      enabled: false,
    });
    expect(created.status).toBe(200);
    const id = created.body.id;
    const first = await m.req<ConfirmRequiredResponse>('DELETE', `/v1/pairs/${id}`, {});
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('conflict');
    expect(first.body.confirmToken).toBeTruthy();
    expect(first.body.summary.title).toContain('Temp');
    // token of another action does not work
    const other = await m.req<ConfirmRequiredResponse>('DELETE', `/v1/pairs/1`, {
      confirmToken: first.body.confirmToken,
    });
    expect(other.status).toBe(409);
    const ok = await m.req('DELETE', `/v1/pairs/${id}`, { confirmToken: first.body.confirmToken });
    expect(ok.status).toBe(200);
    // single use
    expect((await m.req('DELETE', `/v1/pairs/${id}`, { confirmToken: first.body.confirmToken })).status).toBe(404);
    expect((await m.req<PairDto[]>('GET', '/v1/pairs')).body.some((p) => p.id === id)).toBe(false);
  });

  it('empty trash is always confirmed', async () => {
    const r = await confirmed(m, 'POST', '/v1/maintenance/empty-trash', { accountId: 'alex' });
    expect(r.first.status).toBe(409);
    expect(r.first.body.summary?.title).toContain('trash');
    expect(r.second.status).toBe(200);
  });

  it('agent token rotation is confirmed and invalidates the old token', async () => {
    const old = m.d.tokens.agent!;
    const r = await confirmed<{ token: string; file: string }>(m, 'POST', '/v1/tokens/agent/rotate');
    expect(r.second.status).toBe(200);
    expect(r.second.body.token).not.toBe(old);
    expect(readFileSync(r.second.body.file, 'utf8').trim()).toBe(r.second.body.token);
    expect((await m.req('GET', '/v1/status', undefined, old)).status).toBe(401);
    expect((await m.req('GET', '/v1/status', undefined, r.second.body.token)).status).toBe(200);
  });
});

describe('settings', () => {
  it('validates and persists per section, the engine sees the change', async () => {
    const bad: unknown[] = [
      { schedule: { incrementalEveryMinutes: 5 } },
      { transfer: { maxWorkersTotal: 2, maxWorkersPerAccount: 3 } },
      { transfer: { quietHours: { from: '25:00', to: '07:00', bandwidthLimitKBps: null } } },
      { notifications: { minIntervalMinutes: 0 } },
      { notifications: { sms: true } },
      { globalExcludes: [{ kind: 'exclude', patternType: 'glob', pattern: 'a/b', source: 'user' }] },
      { foo: 1 },
      [1, 2],
    ];
    for (const b of bad) expect((await m.req('PUT', '/v1/settings', b)).status, JSON.stringify(b)).toBe(400);
    const r = await m.req<SettingsDto>('PUT', '/v1/settings', {
      schedule: { incrementalEveryMinutes: 60, fullWeekly: { hour: 4 } },
      storagePoolBytes: 1_000_000_000_000,
    });
    expect(r.status).toBe(200);
    expect(r.body.schedule.incrementalEveryMinutes).toBe(60);
    expect(r.body.schedule.fullWeekly).toEqual({ weekday: 0, hour: 4 });
    const row = m.d.db.prepare("SELECT value FROM settings WHERE key = 'schedule'").get() as { value: string };
    expect(JSON.parse(row.value).incrementalEveryMinutes).toBe(60);
    expect((await m.req<SettingsDto>('GET', '/v1/settings')).body.storagePoolBytes).toBe(1_000_000_000_000);
    expect((await m.req<StoragePoolDto>('GET', '/v1/storage')).body.poolBytes).toBe(1_000_000_000_000);
  });
});

describe('pairs', () => {
  it('refuses hard exclusions, overlaps, missing folders and unsupported remote roots', async () => {
    const base = { accountId: 'alex', name: 'X', direction: 'backup', enabled: true };
    const cases: Record<string, unknown>[] = [
      { ...base, localRoot: '/srv/sync/Scratch/x', remoteRoot: '/my-files/x' },
      { ...base, localRoot: '/data', remoteRoot: '/my-files/x' },
      { ...base, localRoot: path.join(m.data, 'Dokumente/01_Haushalt'), remoteRoot: '/my-files/x' },
      { ...base, localRoot: path.join(m.data, 'does-not-exist'), remoteRoot: '/my-files/x' },
      { ...base, localRoot: mkdirTemp('p1'), remoteRoot: '/photos/x' },
      { ...base, localRoot: mkdirTemp('p2'), remoteRoot: '/devices/Workstation/Documents/04_Studies' },
      { ...base, localRoot: mkdirTemp('p3'), remoteRoot: '/my-files/gibt-es-nicht' },
      { ...base, accountId: 'nobody', localRoot: mkdirTemp('p4'), remoteRoot: '/my-files' },
      { ...base, direction: 'sideways', localRoot: mkdirTemp('p5'), remoteRoot: '/my-files' },
    ];
    for (const c of cases) {
      const r = await m.req<{ error: string }>('POST', '/v1/pairs', c);
      expect(r.status, `${JSON.stringify(c)} -> ${r.body.error}`).toBe(400);
    }
  });

  it('creates a pair with resolved root uid, rules round-trip, direction change is confirmed', async () => {
    const r = await m.req<PairDto>('POST', '/v1/pairs', {
      accountId: 'alex',
      name: 'Studium',
      localRoot: mkdirTemp('studium'),
      remoteRoot: '/my-files',
      direction: 'backup',
      enabled: false,
    });
    expect(r.status).toBe(200);
    const row = m.d.db.prepare('SELECT remote_section, remote_root_uid FROM pairs WHERE id = ?').get(r.body.id) as {
      remote_section: string;
      remote_root_uid: string | null;
    };
    expect(row.remote_section).toBe('/my-files');
    expect(row.remote_root_uid).toBeTruthy();
    const rules = [{ kind: 'exclude', patternType: 'prefix', pattern: 'alt', source: 'user' }];
    expect((await m.req('PUT', `/v1/pairs/${r.body.id}/rules`, rules)).status).toBe(200);
    const got = await m.req<{ pattern: string }[]>('GET', `/v1/pairs/${r.body.id}/rules`);
    expect(got.body.map((x) => x.pattern)).toEqual(['alt']);
    expect((await m.req('PUT', `/v1/pairs/${r.body.id}/rules`, [{ kind: 'nope' }])).status).toBe(400);
    // no entries yet -> no confirmation needed
    expect((await m.req('PATCH', `/v1/pairs/${r.body.id}`, { direction: 'upload-only' })).status).toBe(200);
    expect((await m.req('PATCH', `/v1/pairs/${r.body.id}`, { localRoot: '/x' })).status).toBe(400);
    // the synced pair 1 has entries -> confirm
    const c = await confirmed<PairDto>(m, 'PATCH', '/v1/pairs/1', { direction: 'upload-only' });
    expect(c.first.status).toBe(409);
    expect(c.second.body.direction).toBe('upload-only');
    expect((await m.req<PairDto>('PATCH', '/v1/pairs/1', { direction: 'backup', confirmToken: 'x' })).status).toBe(409);
    const back = await confirmed<PairDto>(m, 'PATCH', '/v1/pairs/1', { direction: 'backup' });
    expect(back.second.body.direction).toBe('backup');
  });

  it('previews the first contact (dry run, counts only)', async () => {
    const local = mkdirTemp('preview');
    writeFileSync(path.join(local, 'same.txt'), 'same');
    writeFileSync(path.join(local, 'local-only.txt'), 'local');
    mkdirSync(path.join(local, 'node_modules'), { recursive: true });
    seedRemote(m.mockDir, 'sam', {
      files: { 'same.txt': 'same', 'remote-only.txt': 'r' },
      to: '/my-files/Extra',
      session: false,
    });
    const r = await m.req<PairPreviewDto>('POST', '/v1/pairs/preview', {
      accountId: 'alex',
      name: 'Preview',
      localRoot: path.join(m.data, 'Dokumente'),
      remoteRoot: '/devices/Workstation/Documents',
      direction: 'backup',
      enabled: true,
    });
    // pair 1 already owns these roots -> validation error, preview of a fresh pair instead:
    expect(r.status).toBe(400);
    const p = await m.req<PairPreviewDto>('POST', '/v1/pairs/preview', {
      accountId: 'sam',
      name: 'Preview',
      localRoot: local,
      remoteRoot: '/my-files/Extra',
      direction: 'backup',
      enabled: true,
    });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      adopt: 1,
      upload: 1,
      uploadBytes: 5,
      download: 1,
      downloadBytes: 1,
      conflicts: 0,
      excluded: 1,
    });
  });

  it('browses the remote tree for the wizard', async () => {
    const root = await m.req<{ name: string }[]>('GET', '/v1/remote/alex/browse?path=/');
    expect(root.body.map((e) => e.name)).toEqual(['my-files', 'devices', 'shared-with-me']);
    const dev = await m.req<{ name: string }[]>('GET', '/v1/remote/alex/browse?path=%2Fdevices');
    expect(dev.body.map((e) => e.name)).toContain('Workstation');
    const docs = await m.req<{ name: string; type: string }[]>(
      'GET',
      `/v1/remote/alex/browse?path=${encodeURIComponent('/devices/Workstation/Documents')}`,
    );
    expect(docs.body.filter((e) => e.type === 'folder').map((e) => e.name)).toEqual([
      '01_Haushalt',
      '02_Büro',
      '04_Studies',
    ]);
    expect((await m.req('GET', '/v1/remote/alex/browse?path=%2Fmy-files%2Fnope')).status).toBe(404);
  });
});

describe('activity, pause, brakes, storage, doctor', () => {
  it('filters activity and carries runId', async () => {
    const all = await m.req<ActivityItem[]>('GET', '/v1/activity?limit=200');
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body.some((a) => typeof a.runId === 'number')).toBe(true);
    const sam = await m.req<ActivityItem[]>('GET', '/v1/activity?account=sam');
    expect(sam.body.length).toBeGreaterThan(0);
    expect(sam.body.every((a) => a.accountId === 'sam')).toBe(true);
    const dl = await m.req<ActivityItem[]>('GET', '/v1/activity?action=downloaded,uploaded');
    expect(dl.body.every((a) => a.action === 'downloaded' || a.action === 'uploaded')).toBe(true);
    const q = await m.req<ActivityItem[]>('GET', `/v1/activity?q=${encodeURIComponent('IMG_0001')}`);
    expect(q.body.length).toBeGreaterThan(0);
    expect((await m.req('GET', '/v1/activity?action=bogus')).status).toBe(400);
    expect((await m.req('GET', '/v1/activity?since=yesterday')).status).toBe(400);
    const future = await m.req<ActivityItem[]>(
      'GET',
      `/v1/activity?since=${new Date(Date.now() + 3600_000).toISOString()}`,
    );
    expect(future.body).toEqual([]);
  });

  it('timed pause is resumed by the daemon', async () => {
    const until = new Date(Date.now() + 1200).toISOString();
    expect((await m.req('POST', '/v1/pause', { scope: 'all', until })).status).toBe(200);
    const s = await m.req<StatusDto>('GET', '/v1/status');
    expect(s.body.paused).toBe(true);
    expect(s.body.pausedUntil).toBe(until);
    await waitFor(async () => !(await m.req<StatusDto>('GET', '/v1/status')).body.paused, 5000, 100);
    expect((await m.req<StatusDto>('GET', '/v1/status')).body.pausedUntil).toBeNull();
    expect((await m.req('POST', '/v1/pause', { scope: 'all', until: '2000-01-01T00:00:00Z' })).status).toBe(400);
    expect((await m.req('POST', '/v1/pause', { scope: 'account', id: 'nobody' })).status).toBe(404);
    // account-scoped pause + resume
    expect((await m.req('POST', '/v1/pause', { scope: 'account', id: 'sam' })).status).toBe(200);
    expect((await m.req<AccountDto[]>('GET', '/v1/accounts')).body.find((a) => a.id === 'sam')!.paused).toBe(true);
    expect((await m.req('POST', '/v1/resume', { scope: 'account', id: 'sam' })).status).toBe(200);
  });

  it('shows and releases a safety brake with confirmation', async () => {
    expect((await m.req('POST', '/v1/pairs/1/release-brake', {})).status).toBe(409); // no brake -> plain 409 conflict
    m.d.db
      .prepare(
        `INSERT INTO pair_state (pair_id, brake_reason, brake_at) VALUES (1, 'Massenlöschung erkannt: 600 von 1000 Dateien fehlen lokal', ?)
         ON CONFLICT (pair_id) DO UPDATE SET brake_reason = excluded.brake_reason, brake_at = excluded.brake_at, brake_released_at = NULL`,
      )
      .run(Date.now());
    const p = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((x) => x.id === 1)!;
    expect(p.brake?.reason).toContain('Massenlöschung');
    const r = await confirmed(m, 'POST', '/v1/pairs/1/release-brake');
    expect(r.first.status).toBe(409);
    expect(r.first.body.summary?.title).toContain('safety brake');
    expect(r.second.status).toBe(200);
    expect((await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((x) => x.id === 1)!.brake).toBeNull();
    await m.d.engine.waitIdle();
  });

  it('measures storage per area and keeps a history', async () => {
    const r = await m.req<StoragePoolDto>('POST', '/v1/storage/measure', { accountId: 'alex' });
    expect(r.status).toBe(200);
    const f = r.body.accounts.find((a) => a.accountId === 'alex')!;
    expect(f.measuredAt).toBeTruthy();
    expect(f.areas.map((a) => a.path).sort()).toEqual(['/devices/Workstation', '/my-files']);
    expect(f.areas.find((a) => a.path === '/devices/Workstation')!.bytes).toBeGreaterThan(0);
    const h = await m.req<{ accountId: string; bytes: number }[]>('GET', '/v1/storage/history?days=90');
    expect(h.body.some((x) => x.accountId === 'alex' && x.bytes > 0)).toBe(true);
    const ms = await m.req<{ trash: { accountId: string }[] }>('GET', '/v1/maintenance/summary');
    expect(ms.body.trash.map((t) => t.accountId)).toEqual(['alex', 'sam']);
  });

  it('doctor reports the mock sessions and never fails on the mock setup', async () => {
    const r = await m.req<DoctorCheck[]>('GET', '/v1/doctor');
    const byId = Object.fromEntries(r.body.map((c) => [c.id, c]));
    expect(byId['keyring:alex']!.ok).toBe(true);
    expect(byId['keyring:sam']!.ok).toBe(true);
    expect(byId['api']!.ok).toBe(true);
    expect(byId['cli_version']!.ok).toBe(true);
  });

  it('cli passthrough: read-only allowlist for agents, writes refused', async () => {
    const ok = await m.req<{ exitCode: number; stdout: string }>(
      'POST',
      '/v1/accounts/alex/cli',
      { args: ['filesystem', 'list', '-j', '/devices'] },
      'agent',
    );
    expect(ok.status).toBe(200);
    expect(ok.body.exitCode).toBe(0);
    expect(JSON.parse(ok.body.stdout)[0].name.value).toBe('Workstation');
    const w = await m.req('POST', '/v1/accounts/alex/cli', { args: ['filesystem', 'trash', '/my-files/x'] }, 'agent');
    expect(w.status).toBe(403);
    const w2 = await m.req(
      'POST',
      '/v1/accounts/alex/cli',
      { args: ['filesystem', 'trash', '/my-files/x'], allowWrite: true },
      'agent',
    );
    expect(w2.status).toBe(403);
    const a = await m.req('POST', '/v1/accounts/alex/cli', { args: ['auth', 'logout'], allowWrite: true });
    expect(a.status).toBe(403);
    const nl = await m.req('POST', '/v1/accounts/alex/cli', { args: ['filesystem', 'list', '/a\nb'] });
    expect(nl.status).toBe(400);
  });
});

describe('conflicts and deletions need confirmation when destructive', () => {
  function entry(rel: string, size = 10): number {
    return Number(
      m.d.db
        .prepare(
          `INSERT INTO entries (pair_id, rel_path, kind, l_exists, l_size, r_exists, r_uid, r_rev_uid, r_size, b_size, state, updated_at)
           VALUES (1, ?, 'file', 1, ?, 1, ?, ?, ?, ?, 'conflict', ?)`,
        )
        .run(rel, size, `uid-${rel}`, `rev-${rel}`, size, size, Date.now()).lastInsertRowid,
    );
  }

  it('"Proton behalten" with a local file asks first; ignore does not', async () => {
    const e = entry('Konflikt/a.txt');
    const snap = JSON.stringify({ size: 10, mtime: new Date().toISOString(), sha1: null });
    const cid = Number(
      m.d.db
        .prepare(
          "INSERT INTO conflicts (entry_id, kind, detected_at, local_snapshot, remote_snapshot) VALUES (?, 'both_changed', ?, ?, ?)",
        )
        .run(e, Date.now(), snap, snap).lastInsertRowid,
    );
    const first = await m.req<ConfirmRequiredResponse>('POST', `/v1/conflicts/${cid}/resolve`, {
      resolution: 'keep_remote',
    });
    expect(first.status).toBe(409);
    expect(first.body.summary.title).toContain('Keep Proton version');
    expect((await m.req('POST', `/v1/conflicts/${cid}/resolve`, { resolution: 'bogus' })).status).toBe(400);
    expect((await m.req('POST', `/v1/conflicts/${cid}/resolve`, { resolution: 'ignore' })).status).toBe(200);
    expect((await m.req('POST', `/v1/conflicts/${cid}/resolve`, { resolution: 'ignore' })).status).toBe(404);
  });

  it('deleting more than 100 files in Proton asks first, small decisions do not', async () => {
    const ids: number[] = [];
    const ins = m.d.db.prepare(
      'INSERT INTO pending_deletions (entry_id, detected_at, size, remote_rev_uid_at_detect) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < 102; i++) {
      const e = entry(`Weg/${i}.txt`, 5);
      ids.push(Number(ins.run(e, Date.now(), 5, `rev-Weg/${i}.txt`).lastInsertRowid));
    }
    const big = await m.req<ConfirmRequiredResponse>('POST', '/v1/deletions/decide', {
      ids: ids.slice(0, 101),
      decision: 'trash_remote',
    });
    expect(big.status).toBe(409);
    expect(big.body.summary.items).toBe(101);
    const keep = await m.req('POST', '/v1/deletions/decide', { ids: ids.slice(0, 101), decision: 'keep_remote_only' });
    expect(keep.status).toBe(200);
    expect((await m.req('POST', '/v1/deletions/decide', { ids: [ids[101]], decision: 'restore_local' })).status).toBe(
      200,
    );
    expect((await m.req('POST', '/v1/deletions/decide', { ids: [], decision: 'trash_remote' })).status).toBe(400);
  });
});

function mkdirTemp(name: string): string {
  const p = path.join(m.home, 'extra', name);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}
