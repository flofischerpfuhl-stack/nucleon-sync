// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Daemon assembly (used by main.ts and the API/e2e tests): state DB, tokens, engine, services, API server.
 * A fresh production install starts with no accounts and no pairs: the first-run wizard (or the CLI) creates them.
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { NucleonSyncPaths } from '@nucleon-sync/shared';

import type { DaemonFileConfig, MutableAccountEnv } from '../accounts/context.ts';
import type { AccountsService } from '../accounts/accounts.ts';
import { openDb } from '../db/db.ts';
import { Engine, type EngineOptions } from '../engine/engine.ts';
import { ensureToken } from '../util/token.ts';
import { ApiServer } from './server.ts';
import { createServices, type Services } from './services.ts';

export interface DaemonOptions {
  env: NodeJS.ProcessEnv;
  paths: NucleonSyncPaths;
  mode: 'production' | 'mock';
  cliPath: string;
  config?: DaemonFileConfig;
  version?: string;
  tcpPort?: number | null;
  /** listen on the Unix socket (default true) */
  socket?: boolean;
  accountEnv?: MutableAccountEnv;
  secretFileDir?: string;
  mockDir?: string;
  /** seed the mock demo accounts alex + sam on first start (default: when mockDir is given) */
  seedMock?: boolean;
  /** engine tuning (tests) */
  engine?: Partial<EngineOptions>;
  /** start timers (keyring check, pause timers, storage, notifier); default true */
  startServices?: boolean;
}

export interface Daemon {
  db: DatabaseSync;
  engine: Engine;
  services: Services;
  api: ApiServer;
  tokens: { ui: string; agent: string | null };
  close(): Promise<void>;
}

export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const db = openDb(o.paths.dbFile);
  const tokens = { ui: ensureToken(o.paths.tokenFile), agent: ensureToken(o.paths.agentTokenFile) as string | null };
  const config = o.config ?? {};
  if (o.mode === 'mock' && o.mockDir && o.seedMock !== false) seedMockConfig(db, o.mockDir);
  const accountEnv = o.accountEnv ?? {};
  const late: { accounts?: AccountsService } = {};
  const engine = new Engine({
    db,
    paths: o.paths,
    cliPath: o.cliPath,
    mode: o.mode,
    version: o.version ?? '0.1.0',
    accountEnv,
    secretFileDir: o.secretFileDir,
    env: o.env,
    stagingDir: config.stagingDir ?? path.join(o.paths.stateDir, 'staging'),
    ...(config.protectedPaths ? { protectedPaths: config.protectedPaths } : {}),
    ...(config.cliTimeouts ? { cliTimeouts: config.cliTimeouts } : {}),
    accountGate: (id) => late.accounts?.gateMsg(id) ?? null,
    ...(o.engine ?? {}),
  });
  const services = createServices({
    db,
    paths: o.paths,
    engine,
    mode: o.mode,
    cliPath: o.cliPath,
    env: o.env,
    accountEnv,
    secretFileDir: o.secretFileDir,
    mockDir: o.mockDir,
    config,
  });
  late.accounts = services.accounts;
  const api = new ApiServer({
    engine,
    tokens,
    services,
    socketPath: o.socket === false ? undefined : o.paths.socketFile,
    tcpPort: o.tcpPort ?? null,
  });
  await api.listen();
  if (o.startServices !== false) services.start();
  let closed = false;
  return {
    db,
    engine,
    services,
    api,
    tokens,
    close: async () => {
      if (closed) return;
      closed = true;
      services.stop();
      await api.close();
      await engine.shutdown();
      db.close();
    },
  };
}

/** Mock mode: accounts alex + sam with one pair each (scripts/mock-seed.mjs creates the remotes). */
export function seedMockConfig(db: DatabaseSync, mockDir: string): void {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  if (n > 0) return;
  const now = Date.now();
  const acc = db.prepare(
    'INSERT INTO accounts (id, display_name, email, credential_backend, workers, created_at) VALUES (?,?,?,?,?,?)',
  );
  acc.run('alex', 'Alex', 'alex@mock.test', 'mock', 2, now);
  acc.run('sam', 'Sam', 'sam@mock.test', 'mock', 1, now);
  const pair = db.prepare(
    'INSERT INTO pairs (account_id, name, local_root, remote_root, remote_section, direction, created_at) VALUES (?,?,?,?,?,?,?)',
  );
  pair.run(
    'alex',
    'Dokumente',
    path.join(mockDir, 'data/Dokumente'),
    '/devices/Workstation/Documents',
    '/devices/Workstation',
    'backup',
    now,
  );
  pair.run(
    'sam',
    'Sam Laptop-Backup',
    path.join(mockDir, 'data/Sam/Laptop-Backup'),
    '/my-files/Laptop-Backup',
    '/my-files',
    'mirror-down',
    now,
  );
}
