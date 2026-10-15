// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end plumbing check (no Proton access): mock env in a temp dir -> daemon -> CLI client -> sync probe
// through REPL workers + secret-shim -> activity -> Electron renderer (headless). Exit 0 = all good.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedMock } from './mock-seed.mjs';
import { resolvePaths } from '../shared/src/paths.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(path.join(process.env.NUCLEON_SYNC_SMOKE_TMP ?? tmpdir(), 'nucleon-sync-smoke-'));
const env = { ...process.env, NUCLEON_SYNC_HOME: home, NUCLEON_SYNC_MOCK: '1', MOCK_LATENCY_MS: '0' };
const cli = (...a) => execFileSync(path.join(root, 'daemon/bin/nucleon-sync'), a, { env, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let daemon;
let ok = false;
try {
  seedMock(home);
  daemon = spawn(process.execPath, [path.join(root, 'daemon/src/main.ts')], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  daemon.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
  const sock = resolvePaths(env).socketFile;
  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  const st = JSON.parse(cli('status', '--json'));
  console.log(`daemon up: mode=${st.mode} accounts=${st.accounts.map((a) => a.id)} pairs=${st.pairs.length}`);
  cli('sync');
  let last;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    last = JSON.parse(cli('status', '--json'));
    if (!last.currentRun && last.lastRun) break;
  }
  const act = JSON.parse(cli('activity', '--json'));
  // engine: a real sync of both mock pairs (adopt/upload/download) instead of the skeleton's probe
  const pairsRan = last.pairs.filter((p) => p.lastRunAt);
  console.log(
    `run: ${last.lastRun?.status}; pairs synced: ${pairsRan.map((p) => `${p.accountId}/${p.name}`).join(', ')}; activity rows: ${act.length}`,
  );
  if (
    last.lastRun?.status !== 'ok' ||
    pairsRan.length !== 2 ||
    !act.some((a) => a.accountId === 'alex' && a.action === 'uploaded') ||
    !act.some((a) => a.accountId === 'sam' && a.action === 'downloaded')
  )
    throw new Error('sync failed: ' + JSON.stringify(act.slice(0, 4)));
  // agent token "default" is limited (management needs a scope or --ui-token), doctor/storage/settings answer through the CLI
  const denied = spawnSync(path.join(root, 'daemon/bin/nucleon-sync'), ['accounts', 'add', 'x', 'X'], {
    env,
    encoding: 'utf8',
  });
  if (denied.status === 0) throw new Error('agent token was allowed to add an account');
  const doc = JSON.parse(cli('doctor', '--json'));
  const bad = doc.filter((c) => !c.ok && c.severity === 'error');
  if (bad.length) throw new Error('doctor errors: ' + JSON.stringify(bad));
  const storage = JSON.parse(cli('storage', '--json'));
  const settings = JSON.parse(cli('settings', '--json'));
  if (storage.accounts.length !== 2 || !settings.schedule) throw new Error('storage/settings via CLI failed');
  console.log(`api: agent scope enforced; doctor ${doc.length} checks ok; storage + settings readable`);
  if (!process.argv.includes('--no-ui')) {
    execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(root, 'ui'), stdio: 'ignore' });
    const r = spawnSync(process.execPath, [path.join(root, 'ui/smoke.mjs')], {
      cwd: path.join(root, 'ui'),
      env,
      encoding: 'utf8',
    });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SMOKE_OK'));
    if (r.status === 77) console.log('ui: skipped (no display)');
    else if (!line) throw new Error('UI smoke failed: ' + (r.stdout ?? '').slice(-300) + (r.stderr ?? '').slice(-300));
    else console.log(`ui: ${line}`);
  }
  ok = true;
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
} finally {
  daemon?.kill('SIGTERM');
  await sleep(500);
  if (!process.env.SMOKE_KEEP) {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(resolvePaths(env).socketFile), { recursive: true, force: true });
  }
}
console.log(ok ? 'SMOKE PASSED' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
