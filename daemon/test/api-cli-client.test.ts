// SPDX-License-Identifier: GPL-3.0-or-later
/** `nucleon-sync` CLI client against a mock daemon: --json output, exit codes, token scopes, confirmations. */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccountDto, ActivityItem, DoctorCheck, StatusDto } from '@nucleon-sync/shared';

import { runDoctor } from '../src/accounts/doctor.ts';
import { startMockDaemon, type MockDaemon } from './c-helpers.ts';
import { ROOT, tmp } from './helpers.ts';

const BIN = path.join(ROOT, 'daemon/bin/nucleon-sync');
let m: MockDaemon;

function cli(
  args: string[],
  env: NodeJS.ProcessEnv = m.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

beforeAll(async () => {
  m = await startMockDaemon();
});
afterAll(async () => {
  await m.close();
});

describe('nucleon-sync CLI', () => {
  it('status --json prints the StatusDto (agent token by default)', async () => {
    const r = await cli(['status', '--json']);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout) as StatusDto;
    expect(s.apiVersion).toBe('v1');
    expect(s.accounts.map((a) => a.id)).toEqual(['alex', 'sam']);
    expect((await cli(['status'])).stdout).toContain('accounts:');
  });

  it('exit code 3 when the daemon is down or not configured', async () => {
    const empty = tmp('cli-empty-');
    expect((await cli(['status'], { ...process.env, NUCLEON_SYNC_HOME: empty })).code).toBe(3);
    // token present but no socket
    mkdirSync(path.join(empty, 'config'), { recursive: true });
    writeFileSync(path.join(empty, 'config', 'agent-token'), 'x\n');
    const r = await cli(['status', '--json'], { ...process.env, NUCLEON_SYNC_HOME: empty });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('daemon not running');
  });

  it('sync --wait, activity filters, runs', async () => {
    const s = await cli(['sync', '--wait', '--json']);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout).status).toBe('ok');
    const a = await cli(['activity', '--json', '--account', 'sam', '--action', 'downloaded', '--limit', '5']);
    const items = JSON.parse(a.stdout) as ActivityItem[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.accountId === 'sam' && i.action === 'downloaded')).toBe(true);
    expect((await cli(['runs', '--json'])).code).toBe(0);
    expect((await cli(['conflicts', '--json'])).code).toBe(0);
    expect((await cli(['deletions', '--json'])).code).toBe(0);
  });

  it('pause --for sets a daemon-side timer, resume clears it', async () => {
    const p = await cli(['pause', '--for', '1h', '--json']);
    expect(p.code).toBe(0);
    expect(JSON.parse(p.stdout).until).toBeTruthy();
    const st = JSON.parse((await cli(['status', '--json'])).stdout) as StatusDto;
    expect(st.paused).toBe(true);
    expect(st.pausedUntil).toBeTruthy();
    expect((await cli(['resume'])).code).toBe(0);
    expect((JSON.parse((await cli(['status', '--json'])).stdout) as StatusDto).paused).toBe(false);
    expect((await cli(['pause', '--account', 'sam'])).code).toBe(0);
    expect((await cli(['resume', '--account', 'sam'])).code).toBe(0);
    expect((await cli(['pause', '--for', 'soon'])).code).toBe(2);
  });

  it('management commands need a scope (exit 6); destructive ones need confirmation (exit 5)', async () => {
    const no = await cli(['accounts', 'add', 'bob', 'Bob']);
    expect(no.code).toBe(6);
    expect(no.stderr).toContain('lacks the scope "manage"');
    expect(no.stderr).toContain('--ui-token');
    const yes = await cli(['accounts', 'add', 'bob', 'Bob', '--ui-token', '--json']);
    expect(yes.code).toBe(0);
    expect((JSON.parse(yes.stdout) as AccountDto).status).toBe('needs_login');
    // non-interactive without --yes: refused
    const rm = await cli(['accounts', 'remove', 'bob', '--ui-token']);
    expect(rm.code).toBe(5);
    expect(rm.stderr).toContain('confirmation required');
    const rm2 = await cli(['accounts', 'remove', 'bob', '--ui-token', '--yes']);
    expect(rm2.code).toBe(0);
    expect(rm2.stderr).toContain('Remove account "Bob"');
  });

  it('cli passthrough: read-only allowlist works, writes are refused', async () => {
    const r = await cli(['cli', '--account', 'alex', '--', 'filesystem', 'list', '-j', '/devices']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].name.value).toBe('Workstation');
    const w = await cli(['cli', '--account', 'alex', '--', 'filesystem', 'create-folder', '/my-files', 'x']);
    expect(w.code).toBe(6);
    expect(w.stderr).toContain('without --allow-write');
    const w2 = await cli([
      'cli',
      '--account',
      'alex',
      '--allow-write',
      '--',
      'filesystem',
      'create-folder',
      '/my-files',
      'x',
    ]);
    expect(w2.code).toBe(6);
    expect(w2.stderr).toContain('--ui-token');
  });

  it('notifications: config, telegram token from stdin (UI token only), test', async () => {
    const before = await cli(['notifications', 'config', '--json']);
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({ telegram: { tokenSet: false }, command: { configured: false } });
    const token = '123456:FAKE-cli-token_abcdefghijklmnopqrstuvwxyz';
    const store = (args: string[]) =>
      new Promise<number>((resolve) => {
        const p = execFile(BIN, args, { env: m.env }, (err) =>
          resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
        );
        p.stdin!.end(`${token}\n`);
      });
    expect(await store(['notifications', 'telegram-token', '--json'])).toBe(6); // agent token: forbidden
    expect(await store(['notifications', 'telegram-token', '--ui-token', '--json'])).toBe(0);
    const after = await cli(['notifications', 'config', '--json']);
    expect(JSON.parse(after.stdout).telegram.tokenSet).toBe(true);
    expect(after.stdout).not.toContain(token);
    const test = await cli(['notifications', 'test', '--ui-token', '--json']);
    expect(test.code).toBe(0); // no channel switched on: nothing to send
    expect(JSON.parse(test.stdout)).toEqual([]);
    expect((await cli(['notifications', 'telegram-token', '--remove', '--ui-token', '--json'])).code).toBe(0);
  });

  it('doctor --json via the daemon', async () => {
    const r = await cli(['doctor', '--json']);
    expect(r.code).toBe(0);
    const checks = JSON.parse(r.stdout) as DoctorCheck[];
    expect(checks.find((c) => c.id === 'api')!.ok).toBe(true);
  });

  it('doctor without a daemon runs locally (read-only, mock home)', async () => {
    const r = await cli(['doctor', '--json'], { ...m.env, NUCLEON_SYNC_API_PORT: '1' });
    // NUCLEON_SYNC_API_PORT=1 points the client at a closed port -> local doctor
    const checks = JSON.parse(r.stdout) as DoctorCheck[];
    expect(checks.find((c) => c.id === 'api')!.ok).toBe(false);
    expect(checks.find((c) => c.id === 'keyring:alex')!.ok).toBe(true);
    expect(r.code).toBe(0);
  });
});

describe('doctor safety', () => {
  it('never executes the CLI binary and flags production problems', () => {
    const dir = tmp('doctor-');
    const marker = path.join(dir, 'EXECUTED');
    const fakeCli = path.join(dir, 'proton-drive');
    writeFileSync(fakeCli, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(fakeCli, 0o755);
    const proc = path.join(dir, 'proc');
    mkdirSync(path.join(proc, '4242'), { recursive: true });
    writeFileSync(path.join(proc, '4242', 'cmdline'), `${fakeCli}\0filesystem\0list\0`);
    writeFileSync(path.join(proc, '4242', 'environ'), 'HOME=/x\0');
    const checks = runDoctor({
      env: process.env,
      paths: { ...m.d.services.ctx.paths },
      cliPath: fakeCli,
      mode: 'production',
      accounts: [
        {
          id: 'selftest',
          display_name: 'Selftest',
          credential_backend: 'keyring-shim',
          secret_service: `nucleon-sync-doctor-test-${process.pid}`,
          secret_key: 'x',
        },
      ],
      pairs: [{ name: 'Missing', local_root: path.join(dir, 'missing'), enabled: 1 }],
      stagingDir: path.join(dir, 'staging'),
      api: null,
      requiredMounts: [dir],
      procDir: proc,
    });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(existsSync(marker)).toBe(false);
    expect(byId['cli_version']!.ok).toBe(true);
    expect(byId['cli_version']!.message).toContain('checked on the first run');
    expect(byId['cli_version']!.msg?.key).toBe('doctor.cliPresent');
    expect(byId[`mount:${dir}`]!.ok).toBe(false);
    expect(byId['foreign_cli']!.ok).toBe(false);
    expect(byId['foreign_cli']!.message).toContain('4242');
    expect(byId['pair_root:Missing']!.ok).toBe(false);
    expect(byId['keyring:selftest']!.ok).toBe(false); // nonexistent throwaway service: missing (or no Secret Service)
    expect(byId['staging_dir']!.ok).toBe(true);
  });
});
