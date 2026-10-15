// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * secret-shim hardening: presence check without reading secrets, robust errors, and the libsecret backend
 * against a THROWAWAY item (ARCHITECTURE §5.4 step 1). The libsecret test is opt-in (NUCLEON_SYNC_TEST_LIBSECRET=1)
 * because it writes a temporary item into the user's real KDE wallet; it never touches the Proton CLI item.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSearchItems } from '../../secret-shim/src/pass.ts';
import { sessionState } from '../src/accounts/keyring.ts';
import { foreignCliProcesses } from '../src/accounts/keyring.ts';
import { SHIM_DIR, tmp } from './helpers.ts';

const PASS = path.join(SHIM_DIR, 'pass');
const ENTRY = 'ch.proton.drive/drive-sdk-cli/auth-session';

function shim(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(PASS, args, { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('secret-shim presence check', () => {
  it('parses D-Bus SearchItems replies', () => {
    expect(parseSearchItems('{"type":"aoao","data":[["/a"],[]]}')).toEqual({ unlocked: 1, locked: 0 });
    expect(parseSearchItems('{"type":"aoao","data":[[],["/b","/c"]]}')).toEqual({ unlocked: 0, locked: 2 });
    expect(() => parseSearchItems('{"type":"s","data":"x"}')).toThrow();
  });

  it('has: 0 present / 1 missing on the file backend, never prints the secret', () => {
    const dir = tmp();
    const env = { NUCLEON_SYNC_ACCOUNT: 'sam', NUCLEON_SYNC_SECRET_BACKEND: 'file', NUCLEON_SYNC_SECRET_FILE_DIR: dir };
    expect(shim(['has', ENTRY], env).status).toBe(1);
    shim(['insert', '-f', '-m', ENTRY], env, '{"refreshToken":"SECRET"}');
    const r = shim(['has', ENTRY], env);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(
      sessionState({ id: 'sam', credential_backend: 'mock', secret_service: null, secret_key: null }, process.env, dir),
    ).toBe('present');
    expect(
      sessionState({ id: 'bob', credential_backend: 'mock', secret_service: null, secret_key: null }, process.env, dir),
    ).toBe('missing');
  });

  it('libsecret backend without busctl/secret-tool reports clean errors (exit 3 / message)', () => {
    const env = {
      NUCLEON_SYNC_ACCOUNT: 'selftest',
      NUCLEON_SYNC_SECRET_SERVICE: 'nucleon-sync-selftest',
      PATH: '/nonexistent',
    };
    // node itself must still be found: call the shim through the absolute node path
    const r = spawnSync(process.execPath, [path.join(SHIM_DIR, 'pass'), 'has', ENTRY], {
      encoding: 'utf8',
      env: { ...env },
    });
    expect(r.status).toBe(3);
    const s = spawnSync(process.execPath, [path.join(SHIM_DIR, 'pass'), 'show', ENTRY], {
      encoding: 'utf8',
      env: { ...env },
    });
    expect(s.status).toBe(1);
    expect(s.stderr).toContain('secret-tool not found');
  });

  it('rejects invalid account ids', () => {
    expect(shim(['show', ENTRY], { NUCLEON_SYNC_ACCOUNT: '../etc' }).status).toBe(2);
  });
});

describe('foreign proton-drive process detection (/proc)', () => {
  it('reports CLI processes not started by this daemon, with the session they use', () => {
    const proc = tmp('proc-');
    const mk = (pid: number, argv: string[], environ: string[]) => {
      mkdirSync(path.join(proc, String(pid)), { recursive: true });
      writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
      writeFileSync(path.join(proc, String(pid), 'environ'), environ.join('\0') + '\0');
    };
    const OWN = 4242;
    mk(101, ['/home/x/.local/bin/proton-drive', 'filesystem', 'move', '/my-files/a'], ['HOME=/home/x']);
    // our own worker
    mk(102, ['/home/x/.local/bin/proton-drive'], ['NUCLEON_SYNC_ACCOUNT=alex', `NUCLEON_SYNC_DAEMON_PID=${OWN}`]);
    mk(103, ['/usr/bin/python3', 'phase2.py'], ['HOME=/home/x']);
    // a worker of another nucleon-sync instance (or left over from a crashed daemon): foreign, Sam's item
    mk(
      104,
      ['/home/x/.local/bin/proton-drive'],
      [
        'NUCLEON_SYNC_ACCOUNT=sam',
        'PROTON_DRIVE_CREDENTIALS_STORE=pass',
        'NUCLEON_SYNC_SECRET_SERVICE=nucleon-sync',
        'NUCLEON_SYNC_SECRET_KEY=sam',
        'NUCLEON_SYNC_DAEMON_PID=1',
      ],
    );
    // node-based CLI (mock): recognised by argv[1]
    mk(
      105,
      ['/usr/bin/node', '/home/x/.local/bin/proton-drive', 'filesystem', 'list'],
      [
        'PROTON_DRIVE_CREDENTIALS_STORE=pass',
        'NUCLEON_SYNC_ACCOUNT=alex',
        'NUCLEON_SYNC_SECRET_SERVICE=ch.proton.drive/drive-sdk-cli',
        'NUCLEON_SYNC_SECRET_KEY=auth-session',
      ],
    );
    const found = foreignCliProcesses('/home/x/.local/bin/proton-drive', proc, OWN);
    expect(found).toEqual([
      { pid: 101, command: 'proton-drive filesystem move', session: 'keychain' },
      { pid: 104, command: 'proton-drive', session: 'libsecret:nucleon-sync/sam' },
      { pid: 105, command: 'proton-drive filesystem list', session: 'keychain' },
    ]);
  });
});

const LIBSECRET = process.env.NUCLEON_SYNC_TEST_LIBSECRET === '1';

describe.skipIf(!LIBSECRET)('libsecret backend against a throwaway item (opt-in)', () => {
  const service = `nucleon-sync-selftest-${process.pid}`;
  const env = {
    NUCLEON_SYNC_ACCOUNT: 'selftest',
    NUCLEON_SYNC_SECRET_BACKEND: 'libsecret',
    NUCLEON_SYNC_SECRET_SERVICE: service,
    NUCLEON_SYNC_SECRET_KEY: 'auth-session',
    NUCLEON_SYNC_SECRET_SCHEMA: 'com.oven-sh.bun.Secret',
  };
  const count = () => {
    const r = spawnSync('secret-tool', ['search', '--all', 'service', service], { encoding: 'utf8' });
    // never keep secret lines: only count item headers
    return (r.stdout + r.stderr).split('\n').filter((l) => l.startsWith('[/')).length;
  };

  it('replaces a Bun-style item instead of creating a duplicate; has/rm work', () => {
    try {
      // 1. an item like Bun.secrets creates it (schema attribute set)
      const bun = spawnSync(
        'secret-tool',
        [
          'store',
          '--label=bun-like',
          'service',
          service,
          'account',
          'auth-session',
          'xdg:schema',
          'com.oven-sh.bun.Secret',
        ],
        { input: 'value-from-bun', encoding: 'utf8' },
      );
      expect(bun.status).toBe(0);
      expect(count()).toBe(1);
      expect(shim(['has', ENTRY], env).status).toBe(0);
      // 2. the shim writes it again (as the CLI does after a token refresh)
      expect(shim(['insert', '-f', '-m', ENTRY], env, 'value-from-shim').status).toBe(0);
      expect(count()).toBe(1);
      expect(shim(['show', ENTRY], env).stdout).toBe('value-from-shim');
      // 3. rm is suppressed without the logout permission, removes with it
      shim(['rm', '-f', ENTRY], env);
      expect(shim(['has', ENTRY], env).status).toBe(0);
      shim(['rm', '-f', ENTRY], { ...env, NUCLEON_SYNC_ALLOW_LOGOUT: '1' });
      expect(shim(['has', ENTRY], env).status).toBe(1);
    } finally {
      spawnSync('secret-tool', ['clear', 'service', service, 'account', 'auth-session']);
    }
  });
});
