// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * nucleon-syncd — headless sync daemon (systemd user service `nucleon-sync.service`).
 *
 * Env:
 *   NUCLEON_SYNC_HOME      dev/test root (see shared/src/paths.ts)
 *   NUCLEON_SYNC_MOCK=1    use mock-cli + mock accounts (alex, sam) under $NUCLEON_SYNC_HOME/mock
 *   NUCLEON_SYNC_CLI       path of the proton-drive binary (default: daemon.json cliPath, ~/.local/bin, PATH)
 *   NUCLEON_SYNC_API_PORT  also listen on TCP 127.0.0.1:<port> (default: Unix socket only)
 *   NUCLEON_SYNC_ALLOW_WRITES=1  allow Proton writes in production (default off = planning mode)
 * Optional ~/.config/nucleon-sync/daemon.json: see accounts/context.ts DaemonFileConfig.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultCliPath, resolvePaths } from '@nucleon-sync/shared';

import type { DaemonFileConfig, MutableAccountEnv } from './accounts/context.ts';
import { startDaemon } from './api/daemon.ts';
import { log } from './util/log.ts';

const VERSION = '0.3.1';

async function main(): Promise<void> {
  const env = process.env;
  const paths = resolvePaths(env);
  const fileCfg: DaemonFileConfig = existsSync(paths.daemonConfigFile)
    ? (JSON.parse(readFileSync(paths.daemonConfigFile, 'utf8')) as DaemonFileConfig)
    : {};
  const mock = env.NUCLEON_SYNC_MOCK === '1';
  const mockBin = fileURLToPath(new URL('../../mock-cli/bin/mock-proton-drive', import.meta.url));
  const cliPath = env.NUCLEON_SYNC_CLI ?? (mock ? mockBin : (fileCfg.cliPath ?? defaultCliPath(env)));
  const tcpPort = env.NUCLEON_SYNC_API_PORT ? Number(env.NUCLEON_SYNC_API_PORT) : (fileCfg.tcpPort ?? null);

  let accountEnv: MutableAccountEnv | undefined;
  let secretFileDir: string | undefined;
  let mockDir: string | undefined;
  if (mock) {
    if (!env.NUCLEON_SYNC_HOME)
      throw new Error('NUCLEON_SYNC_MOCK=1 requires NUCLEON_SYNC_HOME (never mix mock data with the real state dir)');
    mockDir = path.join(path.resolve(env.NUCLEON_SYNC_HOME), 'mock');
    secretFileDir = path.join(mockDir, 'secrets');
    accountEnv = {};
    // every mock remote below <home>/mock (remote-<id>) belongs to account <id>
    for (const d of existsSync(mockDir) ? readdirSync(mockDir) : []) {
      const m = /^remote-(.+)$/.exec(d);
      if (m)
        accountEnv[m[1]!] = {
          MOCK_PROTON_REMOTE: path.join(mockDir, d),
          MOCK_LATENCY_MS: env.MOCK_LATENCY_MS ?? '50',
          ...(env.MOCK_LOGIN_AUTO_APPROVE_MS ? { MOCK_LOGIN_AUTO_APPROVE_MS: env.MOCK_LOGIN_AUTO_APPROVE_MS } : {}),
        };
    }
  }

  const daemon = await startDaemon({
    env,
    paths,
    mode: mock ? 'mock' : 'production',
    cliPath,
    config: fileCfg,
    version: VERSION,
    tcpPort,
    accountEnv,
    secretFileDir,
    mockDir,
  });
  log('info', 'nucleon-syncd started', {
    version: VERSION,
    mode: mock ? 'mock' : 'production',
    cliPath,
    db: paths.dbFile,
    writes: daemon.engine.writeGuard() ? 'blocked (planning mode)' : 'allowed',
  });

  const stop = async (sig: string) => {
    log('info', 'shutting down', { sig });
    await daemon.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((e) => {
  log('error', 'fatal', { err: (e as Error).stack ?? String(e) });
  process.exit(1);
});
