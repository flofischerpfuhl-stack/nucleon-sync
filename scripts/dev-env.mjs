// SPDX-License-Identifier: GPL-3.0-or-later
// Dev launcher: mock environment in ./.dev (never touches Proton or the real state dir).
//   node scripts/dev-env.mjs daemon|ui|all
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedMock } from './mock-seed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.NUCLEON_SYNC_HOME ?? path.join(root, '.dev');
const env = { ...process.env, NUCLEON_SYNC_HOME: home, NUCLEON_SYNC_MOCK: '1' };
seedMock(home);
const what = process.argv[2] ?? 'all';
const procs = [];
if (what === 'daemon' || what === 'all')
  procs.push(spawn(process.execPath, [path.join(root, 'daemon/src/main.ts')], { env, stdio: 'inherit' }));
if (what === 'ui' || what === 'all') {
  const ui = path.join(root, 'ui');
  procs.push(spawn('pnpm', ['run', 'start'], { cwd: ui, env, stdio: 'inherit' }));
}
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(
  `[dev] NUCLEON_SYNC_HOME=${home} (mock). CLI client: NUCLEON_SYNC_HOME=${home} daemon/bin/nucleon-sync status`,
);
