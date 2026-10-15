// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * All filesystem locations used by daemon, UI and CLI client.
 *
 * Production (XDG):
 *   config  ~/.config/nucleon-sync/            daemon.json (optional overrides), api-token + agent-token (0600)
 *   state   ~/.local/state/nucleon-sync/       state.sqlite, logs/, accounts/<id>/cli/w<N>/
 *   runtime $XDG_RUNTIME_DIR/nucleon-sync/     api.sock (0600), daemon.pid
 *
 * Dev/test: NUCLEON_SYNC_HOME=<dir> puts everything below <dir>/{config,state,run}.
 */
export interface NucleonSyncPaths {
  configDir: string;
  stateDir: string;
  runtimeDir: string;
  dbFile: string;
  tokenFile: string;
  /** limited-scope token for agents (read + sync/pause/resume), see docs/SYNC-RULES.md */
  agentTokenFile: string;
  /** registry of named agent tokens (hashes + scopes, 0600), agent layer */
  agentTokensFile: string;
  /** secrets of named agent tokens for local agents: <id>.token (0600) */
  agentTokensDir: string;
  daemonConfigFile: string;
  socketFile: string;
  logDir: string;
  accountsDir: string;
  /** encrypted-file session store (no Secret Service available), one <account>.enc per account */
  secretsDir: string;
  /** key of the encrypted-file session store (0600) */
  secretKeyFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): NucleonSyncPaths {
  const home = homedir();
  let configDir: string;
  let stateDir: string;
  let runtimeDir: string;
  if (env.NUCLEON_SYNC_HOME) {
    const base = path.resolve(env.NUCLEON_SYNC_HOME);
    configDir = path.join(base, 'config');
    stateDir = path.join(base, 'state');
    runtimeDir = path.join(base, 'run');
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'nucleon-sync');
    stateDir = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'nucleon-sync');
    runtimeDir = path.join(env.XDG_RUNTIME_DIR || path.join(stateDir, 'run'), 'nucleon-sync');
  }
  let socketFile = path.join(runtimeDir, 'api.sock');
  if (socketFile.length > 100) {
    // sun_path is limited to 108 bytes; deep NUCLEON_SYNC_HOME dirs (tests) get a short, stable socket path
    const h = createHash('sha1').update(runtimeDir).digest('hex').slice(0, 12);
    socketFile = path.join(env.XDG_RUNTIME_DIR || tmpdir(), `nucleon-sync-${h}`, 'api.sock');
  }
  return {
    configDir,
    stateDir,
    runtimeDir,
    dbFile: path.join(stateDir, 'state.sqlite'),
    tokenFile: path.join(configDir, 'api-token'),
    agentTokenFile: path.join(configDir, 'agent-token'),
    agentTokensFile: path.join(configDir, 'agent-tokens.json'),
    agentTokensDir: path.join(configDir, 'agent-tokens'),
    daemonConfigFile: path.join(configDir, 'daemon.json'),
    socketFile,
    logDir: path.join(stateDir, 'logs'),
    accountsDir: path.join(stateDir, 'accounts'),
    secretsDir: path.join(stateDir, 'secrets'),
    secretKeyFile: path.join(configDir, 'secret.key'),
  };
}

/** Per-account, per-worker CLI data dir (PROTON_DRIVE_CACHE_DIR). Holds cache, events DB, clientUid.json, CLI logs. */
export function cliWorkerDir(paths: NucleonSyncPaths, accountId: string, worker: number): string {
  return path.join(paths.accountsDir, accountId, 'cli', `w${worker}`);
}

/**
 * Default location of the official `proton-drive` CLI when daemon.json has no `cliPath`: the app-managed copy
 * (~/.local/bin/proton-drive, installed by the setup wizard after a SHA-512 check) if present, else the first
 * `proton-drive` on PATH (e.g. /usr/bin/proton-drive from a distribution package), else the app-managed location.
 */
export function defaultCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const managed = path.join(env.HOME || homedir(), '.local/bin/proton-drive');
  const executable = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (executable(managed)) return managed;
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, 'proton-drive');
    if (executable(p)) return p;
  }
  return managed;
}
