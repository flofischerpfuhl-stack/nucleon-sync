// SPDX-License-Identifier: GPL-3.0-or-later
/** test helpers: a complete mock daemon (engine + services + API) in a temp NUCLEON_SYNC_HOME. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { resolvePaths } from '@nucleon-sync/shared';

import type { DaemonFileConfig } from '../src/accounts/context.ts';
import { startDaemon, type Daemon } from '../src/api/daemon.ts';
import type { EngineOptions } from '../src/engine/engine.ts';
import { MOCK_BIN, SEED_BIN, tmp } from './helpers.ts';

export interface MockDaemon {
  home: string;
  mockDir: string;
  data: string;
  port: number;
  env: NodeJS.ProcessEnv;
  d: Daemon;
  req<T = unknown>(
    method: string,
    p: string,
    body?: unknown,
    token?: 'ui' | 'agent' | string,
  ): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

const T0 = new Date('2025-03-01T10:00:00Z');

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    utimesSync(p, T0, T0);
  }
}

/** Seeds a mock remote (+ logged-in session in the shim file backend unless `session: false`). */
export function seedRemote(
  mockDir: string,
  id: string,
  o: { device?: string; files?: Record<string, string>; to?: string; session?: boolean } = {},
): string {
  const remote = path.join(mockDir, `remote-${id}`);
  const args = ['--remote', remote, '--email', `${id}@mock.test`, ...(o.device ? ['--device', o.device] : [])];
  execFileSync(SEED_BIN, args);
  if (o.files && o.to) {
    const src = path.join(mockDir, `seed-${id}-${Math.random().toString(36).slice(2)}`);
    writeTree(src, o.files);
    execFileSync(SEED_BIN, ['--remote', remote, '--from', src, '--to', o.to]);
  }
  if (o.session !== false) {
    const secrets = path.join(mockDir, 'secrets');
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(secrets, `${id}.json`),
      execFileSync(SEED_BIN, ['--remote', remote, '--print-session'], { encoding: 'utf8' }).trim(),
      { mode: 0o600 },
    );
  }
  return remote;
}

export async function startMockDaemon(
  o: {
    /** 'both' = alex + sam with one pair each (like scripts/mock-seed.mjs), 'alex' = only alex */
    accounts?: 'both' | 'alex';
    env?: Record<string, string>;
    config?: DaemonFileConfig;
    engine?: Partial<EngineOptions>;
    startServices?: boolean;
    latencyMs?: number;
    /** extra CLI env per account (e.g. MOCK_TRANSFER_BPS for one account only) */
    accountEnv?: Record<string, Record<string, string>>;
  } = {},
): Promise<MockDaemon> {
  const home = tmp('wpc-');
  const mockDir = path.join(home, 'mock');
  const data = path.join(mockDir, 'data');
  mkdirSync(path.join(mockDir, 'secrets'), { recursive: true, mode: 0o700 });
  writeTree(path.join(data, 'Dokumente'), {
    '01_Haushalt/Taxes 2025.pdf': 'steuer 2025',
    '02_Büro/Angebot.xlsx': 'angebot',
  });
  seedRemote(mockDir, 'alex', {
    device: 'Workstation',
    files: { '02_Büro/Angebot.xlsx': 'angebot', '04_Studies/Nur-in-Proton.pdf': 'remote only' },
    to: '/devices/Workstation/Documents',
  });
  const both = (o.accounts ?? 'both') === 'both';
  if (both) {
    seedRemote(mockDir, 'sam', {
      files: { 'Bilder/IMG_0001.jpg': 'jpeg-1', 'Dokumente/Resume.pdf': 'cv' },
      to: '/my-files/Laptop-Backup',
    });
    mkdirSync(path.join(data, 'Sam/Laptop-Backup'), { recursive: true });
  }
  const latency = String(o.latencyMs ?? 0);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NUCLEON_SYNC_HOME: home,
    NUCLEON_SYNC_MOCK: '1',
    MOCK_LATENCY_MS: latency,
    ...(o.env ?? {}),
  };
  const accountEnv: Record<string, Record<string, string>> = {};
  for (const id of both ? ['alex', 'sam'] : ['alex'])
    accountEnv[id] = {
      MOCK_PROTON_REMOTE: path.join(mockDir, `remote-${id}`),
      MOCK_LATENCY_MS: latency,
      ...(o.env?.MOCK_LOGIN_AUTO_APPROVE_MS ? { MOCK_LOGIN_AUTO_APPROVE_MS: o.env.MOCK_LOGIN_AUTO_APPROVE_MS } : {}),
      ...(o.accountEnv?.[id] ?? {}),
    };
  const paths = resolvePaths(env);
  const port = 40000 + Math.floor(Math.random() * 7000);
  const d = await startDaemon({
    env,
    paths,
    mode: 'mock',
    cliPath: MOCK_BIN,
    config: o.config ?? {},
    version: 'test',
    tcpPort: port,
    accountEnv,
    secretFileDir: path.join(mockDir, 'secrets'),
    mockDir,
    seedMock: both,
    startServices: o.startServices ?? false,
    engine: {
      scheduler: false,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      probeIntervalMs: 200,
      freshMs: 0,
      shimPollMs: 100,
      restartBackoffMs: [50, 100, 200],
      stagingDir: path.join(data, '.nucleon-sync-staging'),
      trashDir: path.join(mockDir, 'trash'),
      ...(o.engine ?? {}),
    },
  });
  if (!both) {
    d.db
      .prepare(
        "INSERT INTO accounts (id, display_name, email, credential_backend, workers, created_at) VALUES ('alex', 'Alex', 'alex@mock.test', 'mock', 2, ?)",
      )
      .run(Date.now());
    d.db
      .prepare(
        "INSERT INTO pairs (account_id, name, local_root, remote_root, remote_section, direction, created_at) VALUES ('alex', 'Dokumente', ?, '/devices/Workstation/Documents', '/devices/Workstation', 'backup', ?)",
      )
      .run(path.join(data, 'Dokumente'), Date.now());
  }
  const req = <T>(method: string, p: string, body?: unknown, token: string = 'ui') =>
    new Promise<{ status: number; body: T }>((resolve, reject) => {
      const tok = token === 'ui' ? d.tokens.ui : token === 'agent' ? d.tokens.agent! : token;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: p,
          headers: {
            authorization: `Bearer ${tok}`,
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              /* raw */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          });
        },
      );
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  return { home, mockDir, data, port, env, d, req, close: () => d.close() };
}

/** Calls a destructive route twice: expects 409 + confirmToken first, then sends the token. */
export async function confirmed<T = unknown>(
  m: MockDaemon,
  method: string,
  p: string,
  body: Record<string, unknown> = {},
): Promise<{
  first: { status: number; body: { confirmToken?: string; summary?: { title: string } } };
  second: { status: number; body: T };
}> {
  const first = await m.req<{ confirmToken?: string; summary?: { title: string } }>(method, p, body);
  const second = await m.req<T>(method, p, { ...body, confirmToken: first.body?.confirmToken });
  return { first, second };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000, stepMs = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor: timeout');
}
