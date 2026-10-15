// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Credential store emulation, honouring PROTON_DRIVE_CREDENTIALS_STORE exactly like the real CLI 0.9.0:
 *   keychain    (default) -> NEVER touches the real keyring in the mock; logged in iff MOCK_KEYCHAIN_SESSION is set
 *                            (value = session JSON or "1" for "valid current session").
 *   pass        -> spawns `pass show|insert -f -m|rm -f ch.proton.drive/drive-sdk-cli/auth-session` from PATH
 *                  (in nucleon-sync this resolves to the secret-shim).
 *   unsafe_file -> $PROTON_DRIVE_CACHE_DIR/auth-session.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { MockSession } from './store.ts';

export const PASS_PATH = 'ch.proton.drive/drive-sdk-cli/auth-session';

export type StoreKind = 'keychain' | 'pass' | 'unsafe_file';

export function storeKind(env: NodeJS.ProcessEnv): StoreKind {
  const v = (env.PROTON_DRIVE_CREDENTIALS_STORE ?? 'keychain').toLowerCase();
  if (v === 'keychain' || v === 'pass' || v === 'unsafe_file') return v;
  throw new Error(
    `Invalid PROTON_DRIVE_CREDENTIALS_STORE: ${env.PROTON_DRIVE_CREDENTIALS_STORE}. Expected one of: keychain, unsafe_file, pass.`,
  );
}

export function cacheDir(env: NodeJS.ProcessEnv): string {
  return env.PROTON_DRIVE_CACHE_DIR || path.join(env.HOME ?? '/tmp', '.cache', 'proton-drive-cli-mock');
}

export function loadSession(env: NodeJS.ProcessEnv): MockSession | null {
  const kind = storeKind(env);
  if (kind === 'keychain') {
    const v = env.MOCK_KEYCHAIN_SESSION;
    if (!v) return null;
    if (v === '1') return { mock: true, email: '*', refreshToken: '*', accessGeneration: -1 };
    return JSON.parse(v) as MockSession;
  }
  if (kind === 'unsafe_file') {
    const f = path.join(cacheDir(env), 'auth-session.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as MockSession) : null;
  }
  const r = spawnSync('pass', ['show', PASS_PATH], { env, encoding: 'utf8' });
  if (r.error) throw new Error(`Failed to load session from pass (ensure pass is installed): ${r.error.message}`);
  if (r.status !== 0) {
    if ((r.stderr ?? '').includes('is not in the password store')) return null;
    throw new Error(`Failed to load session in pass: ${(r.stderr ?? '').trim() || `exit code ${r.status}`}`);
  }
  return JSON.parse(r.stdout) as MockSession;
}

export function saveSession(env: NodeJS.ProcessEnv, s: MockSession): void {
  const kind = storeKind(env);
  if (kind === 'keychain') return; // mock never writes the real keyring
  if (kind === 'unsafe_file') {
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(path.join(cacheDir(env), 'auth-session.json'), JSON.stringify(s), { mode: 0o600 });
    return;
  }
  const r = spawnSync('pass', ['insert', '-f', '-m', PASS_PATH], { env, input: JSON.stringify(s), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Failed to save session in pass: ${(r.stderr ?? '').trim()}`);
}

export function removeSession(env: NodeJS.ProcessEnv): void {
  const kind = storeKind(env);
  if (kind === 'keychain') return;
  if (kind === 'unsafe_file') {
    rmSync(path.join(cacheDir(env), 'auth-session.json'), { force: true });
    return;
  }
  const r = spawnSync('pass', ['rm', '-f', PASS_PATH], { env, encoding: 'utf8' });
  if (r.status !== 0 && !(r.stderr ?? '').includes('is not in the password store')) {
    throw new Error(`Failed to remove session in pass: ${(r.stderr ?? '').trim()}`);
  }
}
