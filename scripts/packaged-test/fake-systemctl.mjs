#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test double for `systemctl --user` used by the packaged-app test (scripts/packaged-test/run.mjs). It never talks to
 * the real user manager: `enable --now`/`restart` start the ExecStart of the unit file in the isolated HOME as a
 * detached process (with the unit's Environment= lines), `is-active` checks that process, `stop`/`disable` kill it.
 * Every call is appended to $FAKE_SYSTEMCTL_LOG.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--user' && a !== '--quiet');
const home = process.env.HOME;
const state = process.env.FAKE_SYSTEMCTL_STATE ?? path.join(home, '.fake-systemd');
const pidFile = path.join(state + '.pid');
if (process.env.FAKE_SYSTEMCTL_LOG)
  appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, process.argv.slice(2).join(' ') + '\n');

const unitPath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
  'systemd/user/nucleon-sync.service',
);
const alive = () => {
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
};
const stop = () => {
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
  } catch {
    /* gone */
  }
  rmSync(pidFile, { force: true });
};
function splitArgs(s) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') cur += s[++i];
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ' ') {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
const start = () => {
  stop();
  const unit = readFileSync(unitPath, 'utf8');
  const env = {
    HOME: home,
    USER: process.env.USER,
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  for (const m of unit.matchAll(/^Environment=(.*)$/gm)) {
    const [kv] = splitArgs(m[1]);
    const i = kv.indexOf('=');
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const exec = splitArgs(/^ExecStart=(.*)$/m.exec(unit)[1]);
  const log = openSync(path.join(home, 'daemon.log'), 'a');
  const p = spawn(exec[0], exec.slice(1), { env, detached: true, stdio: ['ignore', log, log] });
  writeFileSync(pidFile, String(p.pid));
  p.unref();
};

const [cmd, ...rest] = args;
switch (cmd) {
  case 'show-environment':
  case 'daemon-reload':
    process.exit(0);
    break;
  case 'enable':
    if (rest.includes('--now')) start();
    process.exit(0);
    break;
  case 'restart':
  case 'start':
    start();
    process.exit(0);
    break;
  case 'stop':
  case 'disable':
    stop();
    process.exit(0);
    break;
  case 'is-active':
    process.exit(alive() ? 0 : 3);
    break;
  case 'is-enabled':
    console.log(existsSync(unitPath) ? 'enabled' : 'disabled');
    process.exit(0);
    break;
  default:
    process.exit(0);
}
