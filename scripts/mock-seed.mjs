// SPDX-License-Identifier: GPL-3.0-or-later
// Seeds a complete mock environment below <home>/mock: two accounts (alex, sam), local test trees,
// fake remotes (incl. files "uploaded by the old Windows client" without sha1) and logged-in sessions
// in the secret-shim file backend. Idempotent: does nothing if <home>/mock exists.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedBin = path.join(root, 'mock-cli/bin/mock-proton-drive-seed');

function write(p, content, mtime) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mtime) utimesSync(p, mtime, mtime);
}

export function seedMock(home) {
  const mock = path.join(home, 'mock');
  if (existsSync(mock)) return mock;
  const data = path.join(mock, 'data');
  const t = new Date('2025-03-01T10:00:00Z');
  // Alex's local master tree
  const dok = path.join(data, 'Dokumente');
  write(path.join(dok, '01_Haushalt/01_Rechnungen/Kündigung Müller.docx'), 'mueller v1', t);
  write(path.join(dok, '01_Haushalt/02_Finanzen/Taxes 2025.pdf'), 'steuer 2025', t);
  write(path.join(dok, '02_Büro/Projekt A/Angebot.xlsx'), 'angebot', t);
  write(path.join(dok, '03_Projects/nucleon-sync/notes.md'), '# notes', t);
  write(path.join(dok, '03_Projects/nucleon-sync/node_modules/x/index.js'), 'cache', t);
  // Remote copy as the old Windows client left it: no sha1 digests (the 31 GB lesson)
  const winTree = path.join(mock, 'windows-upload');
  write(path.join(winTree, '01_Haushalt/01_Rechnungen/Kündigung Müller.docx'), 'mueller v1', t);
  write(path.join(winTree, '02_Büro/Projekt A/Angebot.xlsx'), 'angebot', t);
  write(path.join(winTree, '04_Studies/Nur-in-Proton.pdf'), 'remote only file', t);
  const rf = path.join(mock, 'remote-alex');
  execFileSync(seedBin, [
    '--remote',
    rf,
    '--email',
    'alex@mock.test',
    '--device',
    'Workstation',
    '--device',
    'Laptop',
    '--from',
    winTree,
    '--to',
    '/devices/Workstation/Documents',
    '--no-digest',
  ]);
  // Sam's laptop backup lives in her own account (remote master, mirrored down to /srv/sync/Sam)
  const samTree = path.join(mock, 'sam-laptop');
  write(path.join(samTree, 'Bilder/Urlaub/IMG_0001.jpg'), 'jpeg-1', t);
  write(path.join(samTree, 'Dokumente/Resume.pdf'), 'cv', t);
  const ra = path.join(mock, 'remote-sam');
  execFileSync(seedBin, [
    '--remote',
    ra,
    '--email',
    'sam@mock.test',
    '--from',
    samTree,
    '--to',
    '/my-files/Laptop-Backup',
  ]);
  mkdirSync(path.join(data, 'Sam/Laptop-Backup'), { recursive: true });
  // Logged-in sessions in the secret-shim file backend (what `auth login` would store)
  const secrets = path.join(mock, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  for (const [id, remote] of [
    ['alex', rf],
    ['sam', ra],
  ]) {
    const s = execFileSync(seedBin, ['--remote', remote, '--print-session'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(secrets, `${id}.json`), s, { mode: 0o600 });
  }
  return mock;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const home = process.argv[2];
  if (!home) throw new Error('usage: node scripts/mock-seed.mjs <NUCLEON_SYNC_HOME>');
  console.log(seedMock(path.resolve(home)));
}
