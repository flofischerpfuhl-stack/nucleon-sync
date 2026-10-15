// SPDX-License-Identifier: GPL-3.0-or-later
/** Encrypted-file session store (no Secret Service on the desktop): pass shim round trip. */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCliEnv } from '../../src/cli/env.ts';
import { sessionIdOf } from '../../src/accounts/keyring.ts';
import { SHIM_DIR, tmp } from '../helpers.ts';

const ENTRY = 'ch.proton.drive/drive-sdk-cli/auth-session';

describe('encfile backend', () => {
  it('stores the session AES-GCM encrypted, key in a separate 0600 file; has/show/rm work', () => {
    const dir = tmp('encfile-');
    const env = {
      ...process.env,
      NUCLEON_SYNC_ACCOUNT: 'laptop',
      NUCLEON_SYNC_SECRET_BACKEND: 'encfile',
      NUCLEON_SYNC_SECRET_FILE_DIR: path.join(dir, 'secrets'),
      NUCLEON_SYNC_SECRET_KEYFILE: path.join(dir, 'config', 'secret.key'),
    };
    const pass = (args: string[], input?: string, extra: Record<string, string> = {}) =>
      spawnSync(path.join(SHIM_DIR, 'pass'), args, { env: { ...env, ...extra }, input, encoding: 'utf8' });
    expect(pass(['has', ENTRY]).status).toBe(1);
    const secret = '{"refreshToken":"very-secret-token-123"}';
    expect(pass(['insert', '-f', '-m', ENTRY], secret).status).toBe(0);
    expect(pass(['has', ENTRY]).status).toBe(0);
    expect(pass(['show', ENTRY]).stdout).toBe(secret);
    const stored = readFileSync(path.join(dir, 'secrets', 'laptop.enc'), 'utf8');
    expect(stored).not.toContain('very-secret');
    expect(statSync(path.join(dir, 'config', 'secret.key')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, 'secrets', 'laptop.enc')).mode & 0o777).toBe(0o600);
    // a different key cannot decrypt (tamper/copy protection)
    writeFileSync(path.join(dir, 'other.key'), Buffer.alloc(32, 7).toString('base64'));
    const bad = pass(['show', ENTRY], undefined, { NUCLEON_SYNC_SECRET_KEYFILE: path.join(dir, 'other.key') });
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
    // rm only with the explicit logout permission
    expect(pass(['rm', '-f', ENTRY]).status).toBe(0);
    expect(pass(['has', ENTRY]).status).toBe(0);
    expect(pass(['rm', '-f', ENTRY], undefined, { NUCLEON_SYNC_ALLOW_LOGOUT: '1' }).status).toBe(0);
    expect(pass(['has', ENTRY]).status).toBe(1);
  });

  it('worker env selects the encfile store; the foreign-process gate knows its session id', () => {
    const dir = tmp('encenv-');
    const env = buildCliEnv(
      { HOME: '/home/x', PATH: '/usr/bin' },
      { accountId: 'laptop', credentialBackend: 'encfile' },
      path.join(dir, 'w0'),
      { encFile: { dir: '/s/secrets', keyFile: '/c/secret.key' } },
    );
    expect(env).toMatchObject({
      PROTON_DRIVE_CREDENTIALS_STORE: 'pass',
      NUCLEON_SYNC_SECRET_BACKEND: 'encfile',
      NUCLEON_SYNC_SECRET_FILE_DIR: '/s/secrets',
      NUCLEON_SYNC_SECRET_KEYFILE: '/c/secret.key',
      NUCLEON_SYNC_DAEMON_PID: String(process.pid),
    });
    expect(sessionIdOf(env as Record<string, string>)).toBe('encfile:/s/secrets/laptop');
  });
});

describe('setup wizard API: pair with createRemote', () => {
  it('creates missing Proton folders below /my-files, then the pair', async () => {
    const { startMockDaemon } = await import('../c-helpers.ts');
    const { mkdirSync } = await import('node:fs');
    const md = await startMockDaemon({ accounts: 'alex' });
    try {
      const local = path.join(md.data, 'Laptop-Dokumente');
      mkdirSync(local, { recursive: true });
      const body = {
        accountId: 'alex',
        name: 'Dokumente',
        localRoot: local,
        remoteRoot: '/my-files/omarchy/Dokumente',
        direction: 'backup',
        enabled: true,
      };
      const without = await md.req<{ error: string }>('POST', '/v1/pairs', body);
      expect(without.status).toBe(400);
      expect(without.body.error).toMatch(/not found/);
      const r = await md.req<{ id: number; remoteRoot: string }>('POST', '/v1/pairs', { ...body, createRemote: true });
      expect(r.status).toBe(200);
      expect(r.body.remoteRoot).toBe('/my-files/omarchy/Dokumente');
      const again = await md.req('POST', '/v1/pairs', {
        ...body,
        localRoot: path.join(md.data, 'x'),
        remoteRoot: '/my-files/omarchy/Bilder',
        createRemote: true,
      });
      expect(again.status).toBe(400); // local folder missing -> validated before anything is created
    } finally {
      await md.close();
    }
  });
});
