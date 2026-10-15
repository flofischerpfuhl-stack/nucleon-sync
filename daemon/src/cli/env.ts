// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AccountCliConfig {
  accountId: string;
  /**
   * keyring-shim (default, per-account libsecret item via the pass shim), keychain-direct (plain CLI store), mock,
   * encfile (no Secret Service: AES-GCM file via the shim)
   */
  credentialBackend: 'keyring-shim' | 'keychain-direct' | 'mock' | 'encfile';
  secretService?: string | null;
  secretKey?: string | null;
  secretSchema?: string | null;
  /** extra env, e.g. MOCK_PROTON_REMOTE for the mock backend */
  extraEnv?: Record<string, string>;
}

const REPO_SHIM_BIN_DIR = fileURLToPath(new URL('../../../secret-shim/bin/', import.meta.url));

/**
 * Directory holding the `pass` shim executable. The packaged app (bundled daemon) sets NUCLEON_SYNC_SHIM_DIR to its
 * own shim wrapper; from the repository it is secret-shim/bin.
 */
export function shimBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NUCLEON_SYNC_SHIM_DIR || REPO_SHIM_BIN_DIR;
}

/** @deprecated use shimBinDir() (kept for tests importing the constant) */
export const SHIM_BIN_DIR = REPO_SHIM_BIN_DIR;

/**
 * Environment for one CLI worker process. Isolation per account AND per worker:
 *  - PROTON_DRIVE_CACHE_DIR=<state>/accounts/<id>/cli/w<N>  (cache sqlite, events DB, clientUid.json, logs)
 *    -> no sqlite lock contention between workers (observed 40 s/call with a shared cache), no cross-account leaks.
 *  - PROTON_DRIVE_CREDENTIALS_STORE=pass + PATH=<secret-shim>:... + NUCLEON_SYNC_ACCOUNT=<id>
 *    -> per-account keyring item, `pass rm` (signOut after a lost refresh race) suppressed.
 *  - PROTON_DRIVE_LOG_LEVEL=INFO (default DEBUG writes ~5 MB per few minutes)
 */
export function buildCliEnv(
  base: NodeJS.ProcessEnv,
  acc: AccountCliConfig,
  workerDir: string,
  opts: { shimEventsFile?: string; secretFileDir?: string; encFile?: { dir: string; keyFile: string } } = {},
): NodeJS.ProcessEnv {
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  // All workers of one account share one client UID (seeded from the account dir) so upload drafts are attributable.
  const accountClientUid = path.join(path.dirname(path.dirname(workerDir)), 'clientUid.json');
  const workerClientUid = path.join(workerDir, 'clientUid.json');
  if (existsSync(accountClientUid) && !existsSync(workerClientUid)) copyFileSync(accountClientUid, workerClientUid);

  const env: NodeJS.ProcessEnv = {
    HOME: base.HOME,
    USER: base.USER,
    LANG: base.LANG ?? 'C.UTF-8',
    PATH: base.PATH,
    DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS,
    XDG_RUNTIME_DIR: base.XDG_RUNTIME_DIR,
    PROTON_DRIVE_CACHE_DIR: workerDir,
    PROTON_DRIVE_LOG_LEVEL: base.NUCLEON_SYNC_CLI_LOG_LEVEL ?? 'INFO',
    // never let the CLI open a browser from the daemon (login URL is shown in the UI instead)
    BROWSER: 'true',
    // marks the process as a worker of THIS daemon (foreign-process gate, accounts/keyring.ts)
    NUCLEON_SYNC_DAEMON_PID: String(process.pid),
    ...(acc.extraEnv ?? {}),
  };
  if (acc.credentialBackend !== 'keychain-direct') {
    env.PROTON_DRIVE_CREDENTIALS_STORE = 'pass';
    env.PATH = `${shimBinDir(base)}${path.delimiter}${base.PATH ?? '/usr/bin:/bin'}`;
    env.NUCLEON_SYNC_ACCOUNT = acc.accountId;
    // the packaged shim wrapper runs on the app's bundled Node (Electron in node mode)
    if (base.NUCLEON_SYNC_NODE) env.NUCLEON_SYNC_NODE = base.NUCLEON_SYNC_NODE;
    if (acc.credentialBackend === 'mock') {
      env.NUCLEON_SYNC_SECRET_BACKEND = 'file';
      if (opts.secretFileDir) env.NUCLEON_SYNC_SECRET_FILE_DIR = opts.secretFileDir;
    } else if (acc.credentialBackend === 'encfile') {
      env.NUCLEON_SYNC_SECRET_BACKEND = 'encfile';
      if (opts.encFile) {
        env.NUCLEON_SYNC_SECRET_FILE_DIR = opts.encFile.dir;
        env.NUCLEON_SYNC_SECRET_KEYFILE = opts.encFile.keyFile;
      }
    } else {
      env.NUCLEON_SYNC_SECRET_BACKEND = 'libsecret';
      if (acc.secretService) env.NUCLEON_SYNC_SECRET_SERVICE = acc.secretService;
      if (acc.secretKey) env.NUCLEON_SYNC_SECRET_KEY = acc.secretKey;
      if (acc.secretSchema) env.NUCLEON_SYNC_SECRET_SCHEMA = acc.secretSchema;
    }
    if (opts.shimEventsFile) env.NUCLEON_SYNC_SHIM_EVENTS = opts.shimEventsFile;
  } else {
    env.PROTON_DRIVE_CREDENTIALS_STORE = 'keychain';
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}
