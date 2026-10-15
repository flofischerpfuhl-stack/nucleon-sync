// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Mock multi-account e2e (acceptance): create account `sam` via the API while `alex` syncs, log in through
 * the mock (`MOCK_LOGIN_AUTO_APPROVE_MS`) => SSE `login` url then done, status ok, probe works; sam syncs; worker
 * dirs and secret entries stay separate; only the explicit logout removes the secret.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NucleonSyncClient,
  type AccountDto,
  type DaemonEvent,
  type PairDto,
  type StatusDto,
} from '@nucleon-sync/shared';

import { PASS_ENTRY } from '../src/accounts/context.ts';
import { confirmed, seedRemote, startMockDaemon, waitFor, type MockDaemon } from './c-helpers.ts';
import { SEED_BIN, SHIM_DIR } from './helpers.ts';

let m: MockDaemon;
const events: DaemonEvent[] = [];
let unsub: () => void = () => undefined;

beforeAll(async () => {
  m = await startMockDaemon({ accounts: 'alex', latencyMs: 25, env: { MOCK_LOGIN_AUTO_APPROVE_MS: '700' } });
  const c = new NucleonSyncClient({ host: '127.0.0.1', port: m.port, token: m.d.tokens.ui });
  unsub = c.subscribe((e) => events.push(e));
  await waitFor(() => events.some((e) => e.type === 'hello'));
});
afterAll(async () => {
  unsub();
  await m.close();
});

describe('multi-account (mock)', () => {
  it('adds sam and logs her in while alex syncs', async () => {
    const run = await m.req<{ runId: number }>('POST', '/v1/sync', { accountId: 'alex' });
    expect(run.status).toBe(200);

    const created = await m.req<AccountDto>('POST', '/v1/accounts', { id: 'sam', displayName: 'Sam' });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe('needs_login');
    expect(created.body.credentialBackend).toBe('mock');
    expect((await m.req('POST', '/v1/accounts', { id: 'sam', displayName: 'Sam' })).status).toBe(409);
    expect((await m.req('POST', '/v1/accounts', { id: 'Bad Id', displayName: 'x' })).status).toBe(400);

    const login = await m.req<{ accountId: string; signInUrl: string }>('POST', '/v1/accounts/sam/login');
    expect(login.status).toBe(200);
    expect(login.body.signInUrl).toMatch(/^https:\/\/account\.proton\.me\//);
    expect((await m.req<AccountDto>('GET', '/v1/accounts/sam')).body.status).toBe('login_pending');

    await waitFor(() => events.some((e) => e.type === 'login' && e.accountId === 'sam' && e.phase === 'done'));
    const logins = events.filter((e) => e.type === 'login' && e.accountId === 'sam') as Extract<
      DaemonEvent,
      { type: 'login' }
    >[];
    expect(logins.map((e) => e.phase)).toEqual(['url', 'done']);
    expect(logins[0]!.signInUrl).toBe(login.body.signInUrl);
    // alex's run was still going while sam logged in (both accounts work in parallel)
    const runFinishedBeforeLogin = events.findIndex(
      (e) => e.type === 'run' && e.run.id === run.body.runId && e.run.finishedAt,
    );
    const loginDone = events.findIndex((e) => e.type === 'login' && e.phase === 'done');
    expect(runFinishedBeforeLogin === -1 || runFinishedBeforeLogin > loginDone).toBe(true);

    await waitFor(async () => (await m.req<AccountDto>('GET', '/v1/accounts/sam')).body.email === 'sam@mock.test');
    const sam = (await m.req<AccountDto>('GET', '/v1/accounts/sam')).body;
    expect(sam.status).toBe('ok');
    // probe through the pool works
    const probe = await m.req<{ exitCode: number; stdout: string }>('POST', '/v1/accounts/sam/cli', {
      args: ['filesystem', 'list', '-j', '/my-files'],
    });
    expect(probe.body.exitCode).toBe(0);
  });

  it('sam gets a mirror-down pair and syncs in parallel to alex', async () => {
    seedRemote(m.mockDir, 'sam', {
      files: { 'Fotos/a.jpg': 'A', 'Fotos/b.jpg': 'B' },
      to: '/my-files/Backup',
      session: false,
    });
    const local = path.join(m.data, 'Sam', 'Backup');
    mkdirSync(local, { recursive: true });
    const pair = await m.req<PairDto>('POST', '/v1/pairs', {
      accountId: 'sam',
      name: 'Sam Backup',
      localRoot: local,
      remoteRoot: '/my-files/Backup',
      direction: 'mirror-down',
      enabled: true,
    });
    expect(pair.status).toBe(200);
    await m.req('POST', '/v1/sync', {});
    await m.d.engine.waitIdle();
    expect(readFileSync(path.join(local, 'Fotos/a.jpg'), 'utf8')).toBe('A');
    const st = (await m.req<StatusDto>('GET', '/v1/status')).body;
    expect(st.pairs.every((p) => p.lastRunAt)).toBe(true);
    expect(st.accounts.map((a) => [a.id, a.status])).toEqual([
      ['alex', 'ok'],
      ['sam', 'ok'],
    ]);
  });

  it('keeps worker dirs and secret entries per account', () => {
    const acc = path.join(m.d.services.ctx.paths.accountsDir);
    expect(readdirSync(path.join(acc, 'alex', 'cli'))).toContain('w0');
    expect(readdirSync(path.join(acc, 'sam', 'cli')).sort()).toEqual(expect.arrayContaining(['login', 'w0']));
    expect(existsSync(path.join(acc, 'alex', 'cli', 'login'))).toBe(false);
    const secrets = path.join(m.mockDir, 'secrets');
    const f = JSON.parse(readFileSync(path.join(secrets, 'alex.json'), 'utf8')) as {
      email: string;
      refreshToken: string;
    };
    const a = JSON.parse(readFileSync(path.join(secrets, 'sam.json'), 'utf8')) as {
      email: string;
      refreshToken: string;
    };
    expect(f.email).toBe('alex@mock.test');
    expect(a.email).toBe('sam@mock.test');
    expect(a.refreshToken).not.toBe(f.refreshToken);
  });

  it('a lost refresh race never removes the secret; only the explicit logout does', async () => {
    const secret = path.join(m.mockDir, 'secrets', 'sam.json');
    // the CLI's signOut after a lost refresh race = `pass rm` without the logout permission
    const env = {
      ...process.env,
      NUCLEON_SYNC_ACCOUNT: 'sam',
      NUCLEON_SYNC_SECRET_BACKEND: 'file',
      NUCLEON_SYNC_SECRET_FILE_DIR: path.join(m.mockDir, 'secrets'),
      NUCLEON_SYNC_SHIM_EVENTS: path.join(m.d.services.ctx.paths.stateDir, 'shim-events.jsonl'),
    };
    expect(spawnSync(path.join(SHIM_DIR, 'pass'), ['rm', '-f', PASS_ENTRY], { env }).status).toBe(0);
    expect(existsSync(secret)).toBe(true);
    // a revoked session makes the (mock) CLI call signOut itself -> suppressed as well
    spawnSync(SEED_BIN, ['--remote', path.join(m.mockDir, 'remote-sam'), '--revoke']);
    await m.req('POST', '/v1/accounts/sam/cli', { args: ['filesystem', 'list', '-j', '/my-files'] });
    expect(existsSync(secret)).toBe(true);
    expect(readFileSync(env.NUCLEON_SYNC_SHIM_EVENTS, 'utf8')).toContain('"suppressed"');

    const r = await confirmed(m, 'DELETE', '/v1/accounts/sam/session');
    expect(r.first.status).toBe(409);
    expect(r.first.body.summary?.title).toContain('Log out');
    expect(r.second.status).toBe(200);
    expect(existsSync(secret)).toBe(false);
    expect(existsSync(path.join(m.mockDir, 'secrets', 'alex.json'))).toBe(true);
    const sam = (await m.req<AccountDto>('GET', '/v1/accounts/sam')).body;
    expect(sam.status).toBe('needs_login');
  });

  it('removes a profile only without pairs and with confirmation', async () => {
    expect((await m.req('DELETE', '/v1/accounts/sam', {})).status).toBe(409); // has a pair -> conflict (no token)
    const pid = (await m.req<PairDto[]>('GET', '/v1/pairs')).body.find((p) => p.accountId === 'sam')!.id;
    expect((await confirmed(m, 'DELETE', `/v1/pairs/${pid}`)).second.status).toBe(200);
    const r = await confirmed(m, 'DELETE', '/v1/accounts/sam');
    expect(r.second.status).toBe(200);
    expect((await m.req<AccountDto[]>('GET', '/v1/accounts')).body.map((a) => a.id)).toEqual(['alex']);
  });
});
