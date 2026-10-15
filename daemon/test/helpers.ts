// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MOCK_BIN = path.join(ROOT, 'mock-cli/bin/mock-proton-drive');
export const SEED_BIN = path.join(ROOT, 'mock-cli/bin/mock-proton-drive-seed');
export const SHIM_DIR = path.join(ROOT, 'secret-shim/bin');

export function tmp(prefix = 'ps-test-'): string {
  return mkdtempSync(path.join(process.env.NUCLEON_SYNC_TEST_TMP ?? tmpdir(), prefix));
}

/** Creates a mock remote with a small tree and a logged-in session in the shim's file backend. */
export function mockAccount(dir: string, account = 'alex', opts: { noDigest?: boolean } = {}) {
  const local = path.join(dir, 'local');
  mkdirSync(path.join(local, 'Ordner mit Leerzeichen'), { recursive: true });
  writeFileSync(path.join(local, 'a.txt'), 'hello');
  writeFileSync(path.join(local, 'Ordner mit Leerzeichen', 'Kündigung "Müller".docx'), 'umlaut+quotes');
  const remote = path.join(dir, `remote-${account}`);
  execFileSync(SEED_BIN, [
    '--remote',
    remote,
    '--email',
    `${account}@mock.test`,
    '--from',
    local,
    '--to',
    '/devices/Workstation/Documents',
    ...(opts.noDigest ? ['--no-digest'] : []),
  ]);
  const secrets = path.join(dir, 'secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(
    path.join(secrets, `${account}.json`),
    execFileSync(SEED_BIN, ['--remote', remote, '--print-session'], { encoding: 'utf8' }).trim(),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOCK_PROTON_REMOTE: remote,
    PROTON_DRIVE_CACHE_DIR: path.join(dir, `cache-${account}`),
    PROTON_DRIVE_CREDENTIALS_STORE: 'pass',
    PATH: `${SHIM_DIR}${path.delimiter}${process.env.PATH}`,
    NUCLEON_SYNC_ACCOUNT: account,
    NUCLEON_SYNC_SECRET_BACKEND: 'file',
    NUCLEON_SYNC_SECRET_FILE_DIR: secrets,
    NUCLEON_SYNC_SHIM_EVENTS: path.join(dir, 'shim-events.jsonl'),
  };
  return { local, remote, secrets, env };
}

export function seed(remote: string, ...args: string[]): string {
  return execFileSync(SEED_BIN, ['--remote', remote, ...args], { encoding: 'utf8' });
}
