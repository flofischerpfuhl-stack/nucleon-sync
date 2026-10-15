// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Presence checks for account sessions and foreign CLI processes. Nothing here reads a secret value or starts a
 * proton-drive process: the keyring check runs the shim's `has` (D-Bus SearchItems, file existence for the mock),
 * the process check reads /proc.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { NucleonSyncPaths } from '@nucleon-sync/shared';

import type { AccountRow } from '../db/repo.ts';
import { shimBinDir } from '../cli/env.ts';
import { PASS_ENTRY } from './context.ts';

export type KeyringState = 'present' | 'missing' | 'locked' | 'unavailable';

/** Session presence for one account via `pass has` of the secret-shim (exit 0/1/3/4). */
export function sessionState(
  acc: Pick<AccountRow, 'id' | 'credential_backend' | 'secret_service' | 'secret_key'>,
  baseEnv: NodeJS.ProcessEnv,
  secretFileDir?: string,
  paths?: Pick<NucleonSyncPaths, 'secretsDir' | 'secretKeyFile'>,
): KeyringState {
  if (acc.credential_backend === 'keychain-direct') return 'unavailable'; // plain CLI store: cannot check safely
  const env: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH,
    HOME: baseEnv.HOME,
    DBUS_SESSION_BUS_ADDRESS: baseEnv.DBUS_SESSION_BUS_ADDRESS,
    XDG_RUNTIME_DIR: baseEnv.XDG_RUNTIME_DIR,
    NUCLEON_SYNC_ACCOUNT: acc.id,
    NUCLEON_SYNC_NODE: baseEnv.NUCLEON_SYNC_NODE,
  };
  if (acc.credential_backend === 'mock') {
    env.NUCLEON_SYNC_SECRET_BACKEND = 'file';
    if (secretFileDir) env.NUCLEON_SYNC_SECRET_FILE_DIR = secretFileDir;
  } else if (acc.credential_backend === 'encfile') {
    env.NUCLEON_SYNC_SECRET_BACKEND = 'encfile';
    if (paths) {
      env.NUCLEON_SYNC_SECRET_FILE_DIR = paths.secretsDir;
      env.NUCLEON_SYNC_SECRET_KEYFILE = paths.secretKeyFile;
    }
  } else {
    env.NUCLEON_SYNC_SECRET_BACKEND = 'libsecret';
    if (acc.secret_service) env.NUCLEON_SYNC_SECRET_SERVICE = acc.secret_service;
    if (acc.secret_key) env.NUCLEON_SYNC_SECRET_KEY = acc.secret_key;
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(path.join(shimBinDir(baseEnv), 'pass'), ['has', PASS_ENTRY], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  switch (r.status) {
    case 0:
      return 'present';
    case 1:
      return 'missing';
    case 4:
      return 'locked';
    default:
      return 'unavailable';
  }
}

export interface ForeignProcess {
  pid: number;
  command: string;
  /** which stored session the process uses (from its environment), see sessionIdOf() */
  session: string | null;
}

/**
 * Identity of the stored session a proton-drive process uses, derived from its environment exactly like the CLI and
 * the secret-shim resolve it:
 *  - keychain store (default)          -> "keychain"   (the ONE plain-CLI item, shared with adopted accounts)
 *  - pass store through the shim       -> "<backend>:<service>/<key>[@<file dir>]"
 *  - unsafe_file store                 -> "file:<cache dir>"
 * null = unknown (environment not readable).
 */
export function sessionIdOf(env: Record<string, string | undefined>): string {
  const store = env.PROTON_DRIVE_CREDENTIALS_STORE || 'keychain';
  if (store === 'keychain') return 'keychain';
  if (store === 'unsafe_file') return `file:${env.PROTON_DRIVE_CACHE_DIR ?? env.XDG_DATA_HOME ?? env.HOME ?? ''}`;
  const backend = env.NUCLEON_SYNC_SECRET_BACKEND || 'libsecret';
  const account = env.NUCLEON_SYNC_ACCOUNT ?? '';
  const service = env.NUCLEON_SYNC_SECRET_SERVICE || 'nucleon-sync';
  const key = env.NUCLEON_SYNC_SECRET_KEY || account;
  if (backend === 'file') return `file:${env.NUCLEON_SYNC_SECRET_FILE_DIR ?? ''}/${account}`;
  if (backend === 'encfile') return `encfile:${env.NUCLEON_SYNC_SECRET_FILE_DIR ?? ''}/${account}`;
  // the plain CLI's keychain item addressed through the shim is the same session as the keychain store
  if (service === 'ch.proton.drive/drive-sdk-cli' && key === 'auth-session') return 'keychain';
  return `${backend}:${service}/${key}`;
}

function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/**
 * proton-drive processes that were NOT started by this daemon, e.g. a manual CLI call or a script, another
 * nucleon-sync instance or a worker left over from a crashed daemon. A process is "ours" only if its environment carries
 * NUCLEON_SYNC_DAEMON_PID=<our pid>. Each process reports the session it uses (sessionIdOf); the account gate compares
 * it with the account's own session — two processes refreshing one session can make one of them delete it.
 * The CLI is recognised by its executable, argv[0] or (node-based mock) argv[1].
 */
export function foreignCliProcesses(cliPath: string, procDir = '/proc', ownPid = process.pid): ForeignProcess[] {
  let target: string;
  try {
    target = realpathSync(cliPath);
  } catch {
    target = cliPath;
  }
  const base = path.basename(cliPath);
  const out: ForeignProcess[] = [];
  let pids: string[];
  try {
    pids = readdirSync(procDir).filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  for (const pid of pids) {
    if (Number(pid) === ownPid) continue;
    try {
      const argv = readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8')
        .split('\0')
        .filter(Boolean);
      if (!argv.length) continue;
      let exe = '';
      try {
        exe = readlinkSync(path.join(procDir, pid, 'exe'));
      } catch {
        /* other user / gone */
      }
      const isCli =
        exe === target ||
        path.basename(argv[0]!) === base ||
        (argv[1] !== undefined && (argv[1] === cliPath || path.basename(argv[1]) === base) && real(argv[1]) === target);
      if (!isCli) continue;
      let env: Record<string, string> = {};
      let readable = true;
      try {
        env = parseEnviron(readFileSync(path.join(procDir, pid, 'environ'), 'utf8'));
      } catch {
        readable = false;
      }
      if (readable && env.NUCLEON_SYNC_DAEMON_PID === String(ownPid)) continue; // one of ours
      // only the subcommand is reported (no paths/arguments that could be private)
      const shown = path.basename(argv[0]!) === base || exe === target ? argv.slice(0, 3) : argv.slice(1, 4);
      out.push({
        pid: Number(pid),
        command: [path.basename(shown[0] ?? base), ...shown.slice(1)].join(' '),
        session: readable ? sessionIdOf(env) : null,
      });
    } catch {
      /* process vanished or not readable */
    }
  }
  return out;
}
