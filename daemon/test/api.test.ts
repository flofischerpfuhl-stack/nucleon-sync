// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePaths, NucleonSyncClient } from '@nucleon-sync/shared';

import { startDaemon, type Daemon } from '../src/api/daemon.ts';
import { MOCK_BIN, tmp } from './helpers.ts';

const PORT = 47000 + Math.floor(Math.random() * 900);
let d: Daemon;

function raw(headers: Record<string, string>, p = '/v1/status'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const home = tmp();
  const paths = resolvePaths({ NUCLEON_SYNC_HOME: home });
  d = await startDaemon({
    env: { ...process.env, NUCLEON_SYNC_HOME: home },
    paths,
    mode: 'mock',
    cliPath: MOCK_BIN,
    tcpPort: PORT,
    socket: false,
    startServices: false,
    engine: { scheduler: false },
  });
});
afterAll(async () => {
  await d.close();
});

describe('local API security', () => {
  it('rejects missing/wrong tokens', async () => {
    expect(await raw({})).toBe(401);
    expect(await raw({ authorization: 'Bearer nope' })).toBe(401);
    expect(await raw({ authorization: `Bearer ${d.tokens.ui}` })).toBe(200);
    expect(await raw({ authorization: `Bearer ${d.tokens.agent}` })).toBe(200);
  });
  it('rejects foreign Host headers (DNS rebinding) and browser Origins', async () => {
    expect(await raw({ authorization: `Bearer ${d.tokens.ui}`, host: `evil.example:${PORT}` })).toBe(403);
    expect(await raw({ authorization: `Bearer ${d.tokens.ui}`, origin: 'http://localhost:3000' })).toBe(403);
  });
  it('serves status to the typed client over TCP', async () => {
    const c = new NucleonSyncClient({ host: '127.0.0.1', port: PORT, token: d.tokens.ui });
    const s = await c.status();
    expect(s.apiVersion).toBe('v1');
    expect(s.mode).toBe('mock');
  });
});
