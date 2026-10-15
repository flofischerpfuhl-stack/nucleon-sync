// SPDX-License-Identifier: GPL-3.0-or-later
/** scripts/install-user.sh in a fake HOME with a fake systemctl (never touches the real user units). */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT, tmp } from './helpers.ts';

const SCRIPT = path.join(ROOT, 'scripts/install-user.sh');

function fakeEnv() {
  const home = tmp('install-');
  const bin = path.join(home, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(home, 'systemctl.log');
  writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  chmodSync(path.join(bin, 'systemctl'), 0o755);
  const cliPath = path.join(home, 'proton-drive');
  writeFileSync(cliPath, '#!/bin/sh\nexit 99\n');
  chmodSync(cliPath, 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    NUCLEON_SYNC_SYSTEMCTL: path.join(bin, 'systemctl'),
    NUCLEON_SYNC_CLI: cliPath,
  };
  return { home, env, log };
}

describe('install-user.sh', () => {
  it('is shellcheck clean', () => {
    const has = spawnSync('shellcheck', ['--version']).status === 0;
    if (!has) return;
    const r = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('--dry-run prints the exact actions and changes nothing', () => {
    const { home, env, log } = fakeEnv();
    const out = execFileSync(SCRIPT, ['--dry-run'], { env, encoding: 'utf8' });
    expect(out).toContain('ok: proton-drive CLI present');
    expect(out).toContain(`+ pnpm --dir ${ROOT} install --frozen-lockfile`);
    expect(out).toContain(
      `+ render ${ROOT}/packaging/systemd/nucleon-sync.service -> ${home}/.config/systemd/user/nucleon-sync.service`,
    );
    expect(out).toContain(`-> ${home}/.config/autostart/nucleon-sync.desktop`);
    expect(out).toContain('service installed, NOT enabled');
    expect(out).not.toMatch(/^\+ .*enable --now/m);
    expect(existsSync(path.join(home, '.config/systemd/user/nucleon-sync.service'))).toBe(false);
    // systemctl was not called at all
    expect(existsSync(log)).toBe(false);
  });

  it('installs unit/launcher/disabled autostart without enabling, and uninstalls', () => {
    const { home, env, log } = fakeEnv();
    execFileSync(SCRIPT, ['--no-build'], { env, encoding: 'utf8' });
    const unit = readFileSync(path.join(home, '.config/systemd/user/nucleon-sync.service'), 'utf8');
    expect(unit).toMatch(/^ExecStart=\/\S+\/node \S+\/daemon\/src\/main\.ts$/m);
    expect(unit).toContain(`${ROOT}/daemon/src/main.ts`);
    expect(unit).toContain('Environment=NUCLEON_SYNC_ALLOW_WRITES=0');
    expect(unit).not.toContain('@ROOT@');
    expect(unit).not.toContain('@NODE@');
    const auto = readFileSync(path.join(home, '.config/autostart/nucleon-sync.desktop'), 'utf8');
    expect(auto).toContain('Hidden=true');
    expect(auto).toContain('--hidden');
    expect(auto).not.toContain('@');
    const app = readFileSync(path.join(home, '.local/share/applications/nucleon-sync.desktop'), 'utf8');
    expect(app).toContain(`Exec=${ROOT}/ui/node_modules/.bin/electron ${ROOT}/ui`);
    expect(lstatSync(path.join(home, '.local/bin/nucleon-sync')).isSymbolicLink()).toBe(true);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('--user daemon-reload');
    expect(calls).not.toContain('enable --now');
    execFileSync(SCRIPT, ['--uninstall'], { env, encoding: 'utf8' });
    expect(existsSync(path.join(home, '.config/systemd/user/nucleon-sync.service'))).toBe(false);
    expect(existsSync(path.join(home, '.config/autostart/nucleon-sync.desktop'))).toBe(false);
    expect(existsSync(path.join(home, '.local/bin/nucleon-sync'))).toBe(false);
  });

  it('--enable-autostart writes an active autostart entry', () => {
    const { home, env } = fakeEnv();
    execFileSync(SCRIPT, ['--no-build', '--enable-autostart'], { env, encoding: 'utf8' });
    expect(readFileSync(path.join(home, '.config/autostart/nucleon-sync.desktop'), 'utf8')).toContain('Hidden=false');
  });
});
