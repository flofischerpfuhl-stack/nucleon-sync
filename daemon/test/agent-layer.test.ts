// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Agent layer (ARCHITECTURE §7): named agent tokens with scopes, user approval of destructive agent requests,
 * `whoami`, the CLI's JSON/exit-code contract (docs/CLI-JSON.md) and the status-bar files.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentTokenInfoDto,
  ApprovalDto,
  ApprovalRequiredResponse,
  BarOutput,
  CreateAgentTokenResponse,
  PairDto,
  StatusDto,
  WhoAmIDto,
} from '@nucleon-sync/shared';

import { startMockDaemon, waitFor, type MockDaemon } from './c-helpers.ts';
import { ROOT } from './helpers.ts';

const BIN = path.join(ROOT, 'daemon/bin/nucleon-sync');
let m: MockDaemon;

function cli(
  args: string[],
  env: NodeJS.ProcessEnv = m.env,
): Promise<{ code: number; stdout: string; stderr: string; json: () => Record<string, unknown> }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        json: () => JSON.parse(stdout) as Record<string, unknown>,
      }),
    );
  });
}

async function token(name: string, scopes: string[]): Promise<CreateAgentTokenResponse> {
  const r = await m.req<CreateAgentTokenResponse>('POST', '/v1/tokens', { name, scopes });
  expect(r.status).toBe(200);
  return r.body;
}

/** an upload-only pair on a fresh local folder (created in Proton by the mock) */
async function newPair(name: string): Promise<PairDto> {
  mkdirSync(path.join(m.data, name), { recursive: true });
  const r = await m.req<PairDto>('POST', '/v1/pairs', {
    accountId: 'alex',
    name,
    localRoot: path.join(m.data, name),
    remoteRoot: `/my-files/${name}`,
    direction: 'upload-only',
    createRemote: true,
  });
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  m = await startMockDaemon();
});
afterAll(async () => {
  await m.close();
});

describe('agent tokens and scopes', () => {
  it('lists the built-in token; creating a token returns the secret once and stores only a hash', async () => {
    const list0 = await m.req<AgentTokenInfoDto[]>('GET', '/v1/tokens');
    expect(list0.body[0]).toMatchObject({ id: 'default', builtin: true, scopes: ['read', 'sync'] });
    const t = await token('reader', []);
    expect(t.token).toMatch(/^nst_/);
    expect(t.scopes).toEqual(['read']);
    expect(statSync(t.file!).mode & 0o777).toBe(0o600);
    const reg = readFileSync(m.d.services.ctx.paths.agentTokensFile, 'utf8');
    expect(reg).not.toContain(t.token);
    expect(statSync(m.d.services.ctx.paths.agentTokensFile).mode & 0o777).toBe(0o600);
    // the agent token cannot manage tokens
    expect((await m.req('GET', '/v1/tokens', undefined, t.token)).status).toBe(403);
    expect((await m.req('POST', '/v1/tokens', { name: 'x', scopes: [] }, 'agent')).status).toBe(403);
    // duplicate names, bad scopes
    expect((await m.req('POST', '/v1/tokens', { name: 'reader', scopes: [] })).status).toBe(409);
    expect((await m.req('POST', '/v1/tokens', { name: 'y', scopes: ['root'] })).status).toBe(400);
  });

  it('read is free, sync/manage/destructive need their scope', async () => {
    const r = await token('r-only', ['read']);
    const s = await token('syncer', ['sync']);
    const g = await token('manager', ['sync', 'manage']);
    expect((await m.req('GET', '/v1/status', undefined, r.token)).status).toBe(200);
    expect((await m.req('GET', '/v1/conflicts', undefined, r.token)).status).toBe(200);
    const denied = await m.req<{ error: string; needs: string }>('POST', '/v1/pause', { scope: 'all' }, r.token);
    expect(denied.status).toBe(403);
    expect(denied.body.needs).toBe('sync');
    expect((await m.req('POST', '/v1/pause', { scope: 'all' }, s.token)).status).toBe(200);
    expect((await m.req('POST', '/v1/resume', { scope: 'all' }, s.token)).status).toBe(200);
    const pairs = (await m.req<PairDto[]>('GET', '/v1/pairs')).body;
    expect((await m.req('PATCH', `/v1/pairs/${pairs[0]!.id}`, { name: 'X' }, s.token)).status).toBe(403);
    const ok = await m.req<PairDto>('PATCH', `/v1/pairs/${pairs[0]!.id}`, { name: 'Renamed' }, g.token);
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Renamed');
    // manage without destructive: removing a pair is refused before any approval is created
    expect((await m.req('DELETE', `/v1/pairs/${pairs[0]!.id}`, {}, g.token)).status).toBe(403);
    const who = await m.req<WhoAmIDto>('GET', '/v1/whoami', undefined, g.token);
    expect(who.body).toEqual({
      scope: 'agent',
      tokenId: g.id,
      name: 'manager',
      permissions: ['read', 'sync', 'manage'],
      approvalRequired: ['destructive'],
    });
    expect((await m.req<WhoAmIDto>('GET', '/v1/whoami')).body.scope).toBe('ui');
  });

  it('destructive agent requests wait for the user: pending → approved → executed once', async () => {
    const d = await token('cleaner', ['manage', 'destructive']);
    const other = await token('other', ['destructive']);
    const pair = await newPair('Temp');
    expect(pair.id).toBeGreaterThan(0);
    const events: ApprovalDto[] = [];
    const off = (ev: { type: string; approval?: ApprovalDto }) => ev.type === 'approval' && events.push(ev.approval!);
    m.d.api.confirm.onApproval = ((orig) => (a: ApprovalDto) => {
      orig?.(a);
      off({ type: 'approval', approval: { ...a } });
    })(m.d.api.confirm.onApproval);

    const first = await m.req<ApprovalRequiredResponse>('DELETE', `/v1/pairs/${pair.id}`, {}, d.token);
    expect(first.status).toBe(409);
    expect(first.body.error).toBe('approval required');
    expect(first.body.approval).toMatchObject({ state: 'requested', tokenName: 'cleaner', method: 'DELETE' });
    // not visible to the user before the agent confirmed
    expect((await m.req<ApprovalDto[]>('GET', '/v1/approvals')).body.some((a) => a.id === first.body.approval.id)).toBe(
      false,
    );
    expect(first.body.summary).toMatchObject({ kind: 'pair.remove', title: 'Remove pair "Temp"' });
    const id = first.body.approval.id;
    // the agent cannot approve itself, another agent cannot use the confirm token
    expect((await m.req('POST', `/v1/approvals/${id}/approve`, {}, d.token)).status).toBe(403);
    const foreign = await m.req<ApprovalRequiredResponse>(
      'DELETE',
      `/v1/pairs/${pair.id}`,
      { confirmToken: first.body.confirmToken },
      other.token,
    );
    expect(foreign.status).toBe(409);
    expect(foreign.body.confirmToken).not.toBe(first.body.confirmToken);
    // the agent confirms → pending (now the user sees it)
    const again = await m.req<ApprovalRequiredResponse>(
      'DELETE',
      `/v1/pairs/${pair.id}`,
      { confirmToken: first.body.confirmToken },
      d.token,
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('approval pending');
    expect((await m.req<ApprovalDto>('GET', `/v1/approvals/${id}`, undefined, d.token)).body.state).toBe('pending');
    expect((await m.req('GET', `/v1/approvals/${id}`, undefined, other.token)).status).toBe(404);
    const list = await m.req<ApprovalDto[]>('GET', '/v1/approvals');
    expect(list.body.some((a) => a.id === id && a.state === 'pending')).toBe(true);
    // the user approves
    expect((await m.req<ApprovalDto>('POST', `/v1/approvals/${id}/approve`, {})).body.state).toBe('approved');
    const done = await m.req('DELETE', `/v1/pairs/${pair.id}`, { confirmToken: first.body.confirmToken }, d.token);
    expect(done.status).toBe(200);
    expect((await m.req('GET', `/v1/pairs/${pair.id}`)).status).toBe(404);
    // single use
    const reuse = await m.req('DELETE', `/v1/pairs/${pair.id}`, { confirmToken: first.body.confirmToken }, d.token);
    expect(reuse.status).toBe(404);
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(['pending', 'approved', 'used']));
  });

  it('a denied approval answers 403; agents need approval even for small trash_remote decisions', async () => {
    const d = await token('denied', ['manage', 'destructive']);
    const r1 = await m.req<ApprovalRequiredResponse>(
      'POST',
      '/v1/deletions/decide',
      { ids: [999_999], decision: 'trash_remote' },
      d.token,
    );
    expect(r1.status).toBe(409);
    expect(r1.body.summary.kind).toBe('deletions.trashRemote');
    // not confirmed by the agent yet: the user cannot decide it
    expect((await m.req('POST', `/v1/approvals/${r1.body.approval.id}/deny`, {})).status).toBe(409);
    const conf = await m.req<ApprovalRequiredResponse>(
      'POST',
      '/v1/deletions/decide',
      { ids: [999_999], decision: 'trash_remote', confirmToken: r1.body.confirmToken },
      d.token,
    );
    expect(conf.body.error).toBe('approval pending');
    expect((await m.req('POST', `/v1/approvals/${r1.body.approval.id}/deny`, {})).status).toBe(200);
    const r2 = await m.req<{ error: string }>(
      'POST',
      '/v1/deletions/decide',
      { ids: [999_999], decision: 'trash_remote', confirmToken: r1.body.confirmToken },
      d.token,
    );
    expect(r2.status).toBe(403);
    expect(r2.body.error).toContain('denied');
    // non-destructive decisions do not ask
    const r3 = await m.req('POST', '/v1/deletions/decide', { ids: [999_999], decision: 'keep_remote_only' }, d.token);
    expect(r3.status).not.toBe(409);
  });

  it('revoking or disabling a token locks it out at once; rotation keeps the built-in token working', async () => {
    const t = await token('temp', ['sync']);
    expect((await m.req('GET', '/v1/status', undefined, t.token)).status).toBe(200);
    expect((await m.req('PATCH', `/v1/tokens/${t.id}`, { disabled: true })).status).toBe(200);
    expect((await m.req('GET', '/v1/status', undefined, t.token)).status).toBe(401);
    await m.req('PATCH', `/v1/tokens/${t.id}`, { disabled: false });
    expect((await m.req('GET', '/v1/status', undefined, t.token)).status).toBe(200);
    const first = await m.req<{ confirmToken: string }>('DELETE', `/v1/tokens/${t.id}`, {});
    expect(first.status).toBe(409);
    expect((await m.req('DELETE', `/v1/tokens/${t.id}`, { confirmToken: first.body.confirmToken })).status).toBe(200);
    expect((await m.req('GET', '/v1/status', undefined, t.token)).status).toBe(401);
    expect(existsSync(t.file!)).toBe(false);
    // built-in token: disable + enable, cannot be deleted
    expect((await m.req('PATCH', '/v1/tokens/default', { disabled: true })).status).toBe(200);
    expect((await m.req('GET', '/v1/status', undefined, 'agent')).status).toBe(401);
    expect((await m.req('PATCH', '/v1/tokens/default', { disabled: false })).status).toBe(200);
    expect((await m.req('GET', '/v1/status', undefined, 'agent')).status).toBe(200);
    expect((await m.req('DELETE', '/v1/tokens/default', {})).status).toBe(400);
  });
});

describe('CLI agent contract (--json, exit codes)', () => {
  it('status/whoami/pairs --json print the documented DTOs', async () => {
    const s = await cli(['status', '--json']);
    expect(s.code).toBe(0);
    expect(s.json()).toMatchObject({ apiVersion: 'v1', mode: 'mock' });
    const w = await cli(['whoami', '--json']);
    expect(w.json()).toMatchObject({ scope: 'agent', tokenId: 'default', permissions: ['read', 'sync'] });
    const p = await cli(['pairs', '--json']);
    expect(Array.isArray(JSON.parse(p.stdout))).toBe(true);
    const paused = await cli(['paused', '--json']);
    expect(paused.code).toBe(1);
    expect(paused.json()).toEqual({ paused: false, pausedUntil: null });
  });

  it('errors are one JSON document with ok:false, exitCode and code', async () => {
    const u = await cli(['pairs', 'show', 'x', '--json']);
    expect(u.code).toBe(2);
    expect(u.json()).toMatchObject({ ok: false, exitCode: 2, code: 'usage' });
    const f = await cli(['pairs', 'set', '1', 'name=Y', '--json']);
    expect(f.code).toBe(6);
    expect(f.json()).toMatchObject({ ok: false, exitCode: 6, code: 'forbidden', status: 403 });
    const down = await cli(['status', '--json'], { ...m.env, NUCLEON_SYNC_API_PORT: '1' });
    expect(down.code).toBe(3);
    expect(down.json()).toMatchObject({ ok: false, code: 'daemon_down' });
    const unknown = await cli(['frobnicate', '--json']);
    expect(unknown.code).toBe(2);
  });

  it('--json never prompts: destructive commands need --yes (exit 5 with the summary)', async () => {
    const r = await cli(['accounts', 'logout', 'sam', '--ui-token', '--json']);
    expect(r.code).toBe(5);
    expect(r.json()).toMatchObject({
      ok: false,
      code: 'confirmation_required',
      confirm: { summary: { kind: 'account.logout' } },
    });
  });

  it('pause --toggle flips the global pause', async () => {
    const a = await cli(['pause', '--toggle', '--json']);
    expect(a.json()).toMatchObject({ ok: true, action: 'pause' });
    expect((await cli(['paused'])).code).toBe(0);
    const b = await cli(['pause', '--toggle', '--json']);
    expect(b.json()).toMatchObject({ ok: true, action: 'resume' });
  });

  it('a named agent token: --agent NAME; destructive → exit 7 pending, approve, --confirm-token runs it', async () => {
    const created = await cli([
      'tokens',
      'create',
      'cli-agent',
      '--scopes',
      'sync,manage,destructive',
      '--ui-token',
      '--json',
    ]);
    expect(created.code).toBe(0);
    const t = created.json() as unknown as CreateAgentTokenResponse;
    const who = await cli(['whoami', '--agent', 'cli-agent', '--json']);
    expect(who.json()).toMatchObject({ name: 'cli-agent', permissions: ['read', 'sync', 'manage', 'destructive'] });
    const list = await cli(['tokens', '--ui-token', '--json']);
    expect((JSON.parse(list.stdout) as AgentTokenInfoDto[]).some((x) => x.id === t.id)).toBe(true);
    // token from the environment works too
    expect((await cli(['whoami', '--json'], { ...m.env, NUCLEON_SYNC_TOKEN: t.token })).json().tokenId).toBe(t.id);

    const pair = await newPair('Temp2');
    // without --yes: confirmation required (exit 5), no approval is created
    const noYes = await cli(['pairs', 'remove', String(pair.id), '--agent', 'cli-agent', '--json']);
    expect(noYes.code).toBe(5);
    // … and nothing was shown to the user
    expect(
      (JSON.parse((await cli(['approvals', '--ui-token', '--json'])).stdout) as ApprovalDto[]).filter(
        (a) => a.state === 'pending',
      ),
    ).toEqual([]);
    const pend = await cli([
      'pairs',
      'remove',
      String(pair.id),
      '--agent',
      'cli-agent',
      '--yes',
      '--no-wait',
      '--json',
    ]);
    expect(pend.code).toBe(7);
    const body = pend.json() as { code: string; approval: ApprovalDto; confirmToken: string };
    expect(body.code).toBe('approval_pending');
    expect(body.approval.state).toBe('pending');
    const appr = await cli(['approvals', '--ui-token', '--json']);
    expect((JSON.parse(appr.stdout) as ApprovalDto[]).some((a) => a.id === body.approval.id)).toBe(true);
    expect((await cli(['approvals', 'approve', body.approval.id, '--ui-token', '--json'])).code).toBe(0);
    const run = await cli([
      'pairs',
      'remove',
      String(pair.id),
      '--agent',
      'cli-agent',
      '--confirm-token',
      body.confirmToken,
      '--json',
    ]);
    expect(run.code).toBe(0);
    expect(run.json()).toEqual({ ok: true });
  });

  it('waits for the approval when allowed (approve while the CLI waits)', async () => {
    const pair = await newPair('Temp3');
    const running = cli(['pairs', 'remove', String(pair.id), '--agent', 'cli-agent', '--yes', '--json']);
    let id = '';
    await waitFor(async () => {
      const l = (await m.req<ApprovalDto[]>('GET', '/v1/approvals')).body;
      id = l.find((a) => a.state === 'pending' && a.tokenName === 'cli-agent')?.id ?? '';
      return !!id;
    });
    await m.req('POST', `/v1/approvals/${id}/approve`, {});
    const r = await running;
    expect(r.code).toBe(0);
    expect((await m.req('GET', `/v1/pairs/${pair.id}`)).status).toBe(404);
  });
});

describe('status bar', () => {
  it('the daemon keeps bar.json + bar-omarchy.json in the runtime dir', async () => {
    const dir = m.d.services.ctx.paths.runtimeDir;
    await waitFor(() => existsSync(path.join(dir, 'bar.json')));
    const w = JSON.parse(readFileSync(path.join(dir, 'bar.json'), 'utf8')) as BarOutput;
    expect(['idle', 'conflicts', 'syncing', 'paused']).toContain(w.alt);
    expect(w.class).toBe(w.alt);
    const o = JSON.parse(readFileSync(path.join(dir, 'bar-omarchy.json'), 'utf8')) as BarOutput;
    expect(o.alt).toBe(w.alt);
    // pause → the file follows within ~1 s
    await m.req('POST', '/v1/pause', { scope: 'all' });
    await waitFor(() => (JSON.parse(readFileSync(path.join(dir, 'bar.json'), 'utf8')) as BarOutput).alt === 'paused');
    await m.req('POST', '/v1/resume', { scope: 'all' });
  });

  it('`nucleon-sync bar` prints one JSON line, also when the daemon is down', async () => {
    const r = await cli(['bar']);
    expect(r.code).toBe(0);
    const b = JSON.parse(r.stdout) as BarOutput;
    expect(b.tooltip).toContain('Nucleon Sync');
    const down = await cli(['bar', '--format', 'omarchy'], { ...m.env, NUCLEON_SYNC_API_PORT: '1' });
    expect(down.code).toBe(0);
    expect(JSON.parse(down.stdout)).toMatchObject({ alt: 'stopped', class: 'active' });
    const st = (await m.req<StatusDto>('GET', '/v1/status')).body;
    expect(st.apiVersion).toBe('v1');
  });
});
