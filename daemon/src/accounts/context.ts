// SPDX-License-Identifier: GPL-3.0-or-later
/** Shared context of the services (accounts, pairs, storage, settings, doctor, notifier). */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { NucleonSyncPaths } from '@nucleon-sync/shared';

import type { Engine } from '../engine/engine.ts';

/** ~/.config/nucleon-sync/daemon.json (all optional; read at daemon start). */
export interface DaemonFileConfig {
  /** proton-drive binary (default: ~/.local/bin/proton-drive if present, else proton-drive on PATH) */
  cliPath?: string;
  /** also listen on TCP 127.0.0.1:<port> */
  tcpPort?: number | null;
  /**
   * download staging dir (default <state>/staging). Downloads are renamed into place, so a staging dir on the same
   * filesystem as the pair roots avoids a copy (doctor warns otherwise).
   */
  stagingDir?: string;
  /** hour (0-23) of the daily storage measurement and the daily decision digest (default 9) */
  dailyHour?: number;
  /** session store for new accounts: Secret Service via the shim (default) or the encrypted file store */
  secretBackend?: 'libsecret' | 'encfile';
  /** per-command CLI timeouts (ms; transfers: base + bytes / minBytesPerSec) */
  cliTimeouts?: {
    listMs?: number;
    infoMs?: number;
    sizeMs?: number;
    probeMs?: number;
    mutateMs?: number;
    emptyTrashMs?: number;
    transferBaseMs?: number;
    minBytesPerSec?: number;
  };
  /** absolute paths that must be mount points (doctor error otherwise), e.g. the data disk holding the pair roots */
  requiredMounts?: string[];
  /** absolute local paths that may never be part of a pair (pair validation + rule matcher), e.g. a backup disk */
  protectedPaths?: string[];
  /** Telegram Bot API base (default https://api.telegram.org; tests point this at a fake endpoint) */
  telegramApiBase?: string;
  /**
   * Command run on every notification (problems right away, pending decisions in the daily digest): an argv array,
   * started without a shell, 30 s timeout. It gets NUCLEON_SYNC_EVENT (notice | digest | test), NUCLEON_SYNC_SEVERITY,
   * NUCLEON_SYNC_KEY, NUCLEON_SYNC_TITLE, NUCLEON_SYNC_BODY, NUCLEON_SYNC_TEXT (title + body), NUCLEON_SYNC_ACCOUNT_ID
   * and NUCLEON_SYNC_ACCOUNT_NAME in its environment. Only configurable in this file (not over the API).
   */
  notifyCommand?: string[];
}

export type MutableAccountEnv = Record<string, Record<string, string>>;

export interface ServiceContext {
  db: DatabaseSync;
  paths: NucleonSyncPaths;
  engine: Engine;
  mode: 'production' | 'mock';
  cliPath: string;
  /** daemon process env (write guard, CLI env base) */
  env: NodeJS.ProcessEnv;
  /** per-account extra CLI env (mock remotes); mutated when mock accounts are created */
  accountEnv: MutableAccountEnv;
  /** secret-shim file backend dir (mock only) */
  secretFileDir?: string;
  /** mock only: directory holding remote-<id>/ backends (new accounts get a fresh mock remote) */
  mockDir?: string;
  config: DaemonFileConfig;
}

/** The adopted plain-CLI keychain item (ARCHITECTURE §5.4): shared with manual `proton-drive` calls. */
export const PLAIN_CLI_SECRET = {
  service: 'ch.proton.drive/drive-sdk-cli',
  key: 'auth-session',
  schema: 'com.oven-sh.bun.Secret',
} as const;

/** Entry name the CLI's pass store uses (the shim ignores it and selects the item from env). */
export const PASS_ENTRY = 'ch.proton.drive/drive-sdk-cli/auth-session';

export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Download staging dir: daemon.json `stagingDir`, else <state>/staging. */
export function stagingDirOf(ctx: Pick<ServiceContext, 'config' | 'paths'>): string {
  return ctx.config.stagingDir ?? path.join(ctx.paths.stateDir, 'staging');
}
