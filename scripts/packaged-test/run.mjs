#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * End-to-end test of the PACKAGED app in a fully isolated environment (never the real desktop, account or service):
 *  - separate HOME, XDG_RUNTIME_DIR and a private D-Bus session (no Secret Service, no tray watcher)
 *  - its own X server (Xvfb :99 by default) — nothing is shown on the real display
 *  - `systemctl --user` replaced by scripts/packaged-test/fake-systemctl.mjs (starts the unit's ExecStart itself)
 *  - the "official CLI" download is served locally: a version.json + a wrapper around mock-cli (SHA-512 is real)
 *
 * It walks through the wizard (system check -> CLI install -> encrypted-file store -> service -> login via mock ->
 * folder pairs with createRemote -> schedule/notifications -> first sync), takes a screenshot of every step and checks
 * the result. Screenshots and logs land in build/packaged-test/<kind>/ unless --out is given.
 *
 * Usage: node scripts/packaged-test/run.mjs <app binary> [--appimage] [--out DIR] [--display :99]
 *   app binary: dist/linux-unpacked/nucleon-sync  or  dist/Nucleon-Sync-0.3.0-x86_64.AppImage (with --appimage)
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron } from '../../ui/node_modules/@playwright/test/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const appBin = path.resolve(argv[0] ?? path.join(ROOT, 'dist/linux-unpacked/nucleon-sync'));
const appimage = argv.includes('--appimage');
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const OUT = path.resolve(opt('--out', path.join(ROOT, 'build/packaged-test')));
const DISPLAY = opt('--display', ':99');
if (DISPLAY === ':0' || DISPLAY === ':1') throw new Error('refusing to use the real display');

const T = path.join(OUT, appimage ? 'appimage' : 'unpacked');
rmSync(T, { recursive: true, force: true });
const HOME = path.join(T, 'home');
const RUN = path.join(T, 'run');
const SHOTS = path.join(T, 'screens');
for (const d of [HOME, RUN, SHOTS]) mkdirSync(d, { recursive: true, mode: 0o700 });
const log = (...a) => console.log('[pkgtest]', ...a);
// never the real CLI: PATH without directories that hold a proton-drive binary (the wizard also searches PATH)
const SAFE_PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((d) => d && !existsSync(path.join(d, 'proton-drive')))
  .join(':');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixtures: local folders, mock remote, "official" CLI
mkdirSync(path.join(HOME, 'Dokumente/Rechnungen'), { recursive: true });
mkdirSync(path.join(HOME, 'Bilder'), { recursive: true });
writeFileSync(path.join(HOME, 'Dokumente/Rechnungen/Stromrechnung 2026.pdf'), 'strom 2026');
writeFileSync(path.join(HOME, 'Dokumente/Notizen [alt].txt'), 'glob chars in the name');
writeFileSync(path.join(HOME, 'Bilder/Urlaub.jpg'), 'jpeg');
const old = new Date('2026-09-01T10:00:00Z');
for (const f of ['Dokumente/Rechnungen/Stromrechnung 2026.pdf', 'Dokumente/Notizen [alt].txt', 'Bilder/Urlaub.jpg'])
  utimesSync(path.join(HOME, f), old, old);
const REMOTE = path.join(T, 'remote');
execFileSync(path.join(ROOT, 'mock-cli/bin/mock-proton-drive-seed'), ['--remote', REMOTE, '--email', 'alex@mock.test']);
const cliWrapper = Buffer.from(`#!/bin/sh
# test stand-in for the official proton-drive CLI (mock with auto-approved login)
export MOCK_PROTON_REMOTE=${JSON.stringify(REMOTE)}
export MOCK_LOGIN_AUTO_APPROVE_MS=2500
export MOCK_LATENCY_MS=20
export MOCK_COMMAND_LOG=${JSON.stringify(path.join(T, 'cli-commands.jsonl'))}
exec ${JSON.stringify(path.join(ROOT, 'mock-cli/bin/mock-proton-drive'))} "$@"
`);
const server = http.createServer((req, res) => {
  if (req.url === '/version.json') {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        Releases: [
          {
            CategoryName: 'Stable',
            // a tested minor (0.9) that is not pinned: the mock's hash cannot match a pinned official build
            Version: '0.9.99',
            ReleaseDate: '2026-10-05',
            Files: [
              {
                Url: `http://127.0.0.1:${server.address().port}/proton-drive`,
                Sha512CheckSum: createHash('sha512').update(cliWrapper).digest('hex'),
                Platform: 'linux/x64',
              },
            ],
          },
        ],
      }),
    );
  } else if (req.url === '/proton-drive') res.end(cliWrapper);
  else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// ------------------------------------------------------------------ X server + private session bus
let xvfb = null;
if (!existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`)) {
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`); i++) await sleep(100);
}
// private session bus WITHOUT service activation: no Secret Service, no portals, no tray watcher
const busConf = path.join(T, 'session-bus.conf');
writeFileSync(
  busConf,
  `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${RUN}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
`,
);
const dbusOut = execFileSync(
  'dbus-daemon',
  [`--config-file=${busConf}`, '--fork', '--print-address=1', '--print-pid=1'],
  { encoding: 'utf8', env: { PATH: SAFE_PATH, HOME } },
)
  .trim()
  .split('\n');
const DBUS = dbusOut[0];
const dbusPid = Number(dbusOut[1]);

const fakeSystemctl = path.join(ROOT, 'scripts/packaged-test/fake-systemctl.mjs');
const env = {
  PATH: SAFE_PATH,
  HOME,
  USER: 'alex',
  LANG: 'de_DE.UTF-8',
  DISPLAY,
  XDG_RUNTIME_DIR: RUN,
  XDG_SESSION_TYPE: 'x11',
  XDG_CURRENT_DESKTOP: 'Hyprland',
  DBUS_SESSION_BUS_ADDRESS: DBUS,
  NUCLEON_SYNC_SYSTEMCTL: fakeSystemctl,
  FAKE_SYSTEMCTL_LOG: path.join(T, 'systemctl.log'),
  NUCLEON_SYNC_CLI_RELEASES_URL: `http://127.0.0.1:${server.address().port}/version.json`,
  NUCLEON_SYNC_UI_THEME: 'dark',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  ...(appimage ? { APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? '' } : {}),
};
for (const k of Object.keys(env)) if (env[k] === '') delete env[k];

let app;
const results = { steps: [], ok: false };
const shot = async (page, name) => {
  const f = path.join(SHOTS, `${String(results.steps.length).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  results.steps.push(name);
  log('screenshot', f);
};

try {
  // an AppImage copies itself for the service: run it from a "Downloads" folder like a user would
  let exe = appBin;
  if (appimage) {
    const dl = path.join(HOME, 'Downloads');
    mkdirSync(dl, { recursive: true });
    exe = path.join(dl, path.basename(appBin));
    execFileSync('cp', [appBin, exe]);
    chmodSync(exe, 0o755);
  }
  app = await _electron.launch({
    executablePath: exe,
    args: ['--ozone-platform-hint=auto'],
    env,
    timeout: 60_000,
    colorScheme: 'dark',
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="setup"]', { timeout: 30_000 });
  await page.waitForSelector('.setup-table', { timeout: 30_000 });
  await shot(page, 'system-check');

  const next = async () => page.click('[data-testid="setup-next"]');
  await next();
  await page.waitForSelector('[data-testid="setup-step-cli"]');
  await shot(page, 'cli-missing');
  await page.click('[data-testid="install-cli"]');
  await page.waitForSelector('[data-testid="setup-step-cli"] .setup-ok', { timeout: 30_000 });
  await shot(page, 'cli-installed');
  await next();

  await page.waitForSelector('[data-testid="setup-step-keyring"]');
  await shot(page, 'keyring-none');
  await page.click('.setup-consent [role="checkbox"]');
  await next();

  await page.waitForSelector('[data-testid="setup-step-service"]');
  await shot(page, 'service-consent');
  await page.click('[data-testid="install-service"]');
  await page.waitForSelector(
    '[data-testid="setup-step-service"] .pill-ok, [data-testid="setup-step-service"] .pill.tone-ok, [data-testid="setup-next"]:not([disabled])',
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    // eslint-disable-next-line no-undef -- runs in the page
    () => !document.querySelector('[data-testid="setup-next"]')?.hasAttribute('disabled'),
    null,
    { timeout: 60_000 },
  );
  await shot(page, 'service-running');
  await next();

  await page.waitForSelector('[data-testid="setup-step-login"]');
  await page.fill('[data-testid="display-name"]', 'Alex');
  await shot(page, 'login-start');
  await page.click('[data-testid="start-login"]');
  await page.waitForSelector('[data-testid="login-url"]', { timeout: 30_000 });
  await shot(page, 'login-qr');
  await page.waitForSelector('[data-testid="login-ok"]', { timeout: 60_000 });
  await shot(page, 'login-ok');
  await next();

  await page.waitForSelector('[data-testid="setup-pair"]', { timeout: 30_000 });
  // nothing is preselected: tick every suggested folder
  for (const box of await page.locator('[data-testid="setup-pair"] [role="checkbox"]').all()) await box.click();
  await shot(page, 'folders');
  await page.click('[data-testid="create-pairs"]');
  await page.waitForSelector('[data-testid="setup-step-prefs"]', { timeout: 60_000 });
  await shot(page, 'prefs');
  await page.click('[data-testid="save-prefs"]');
  await page.waitForSelector('[data-testid="setup-step-done"]', { timeout: 60_000 });
  await shot(page, 'done');
  await page.click('[data-testid="finish"]');
  await page.waitForSelector('[data-testid="hero"]', { timeout: 30_000 });
  // wait for the first sync to upload the files
  const deadline = Date.now() + 90_000;
  let uploaded = false;
  while (Date.now() < deadline && !uploaded) {
    const st = JSON.parse(readFileSync(path.join(REMOTE, 'state.json'), 'utf8'));
    const names = Object.values(st.nodes).map((n) => n.name);
    uploaded = ['Stromrechnung 2026.pdf', 'Notizen [alt].txt', 'Urlaub.jpg'].every((n) => names.includes(n));
    if (!uploaded) await sleep(1000);
  }
  await sleep(1500);
  await shot(page, 'overview-after-sync');
  results.uploaded = uploaded;

  // checks on the isolated system
  const unit = readFileSync(path.join(HOME, '.config/systemd/user/nucleon-sync.service'), 'utf8');
  results.unitManaged = unit.includes('# managed-by: nucleon-sync-app');
  results.autostart = existsSync(path.join(HOME, '.config/autostart/nucleon-sync.desktop'));
  results.encfile = existsSync(path.join(HOME, '.local/state/nucleon-sync/secrets'))
    ? readdirSync(path.join(HOME, '.local/state/nucleon-sync/secrets'))
    : [];
  results.daemonJson = JSON.parse(readFileSync(path.join(HOME, '.config/nucleon-sync/daemon.json'), 'utf8'));
  results.systemctl = readFileSync(path.join(T, 'systemctl.log'), 'utf8').trim().split('\n');
  if (appimage) results.stableAppImage = existsSync(path.join(HOME, '.local/share/nucleon-sync/NucleonSync.AppImage'));
  // the CLI client of the package works against the running daemon
  const daemonDir = appimage
    ? path.join(HOME, '.local/share/nucleon-sync/daemon')
    : path.join(path.dirname(appBin), 'resources/daemon');
  const nodeBin = appimage ? path.join(HOME, '.local/share/nucleon-sync/NucleonSync.AppImage') : appBin;
  results.cliStatus = execFileSync(nodeBin, [path.join(daemonDir, 'nucleon-sync.mjs'), 'status'], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  results.ok =
    uploaded &&
    results.unitManaged &&
    results.autostart &&
    results.encfile.length > 0 &&
    results.daemonJson.secretBackend === 'encfile' &&
    !('profile' in results.daemonJson);
} catch (e) {
  results.error = String(e?.stack ?? e);
  try {
    const page = app && (await app.firstWindow());
    if (page) await shot(page, 'failure');
  } catch {
    /* ignore */
  }
} finally {
  writeFileSync(path.join(T, 'result.json'), JSON.stringify(results, null, 2));
  const within = (p, ms) => Promise.race([p.catch(() => undefined), sleep(ms)]);
  await within(app?.evaluate(({ app: a }) => a.exit(0)) ?? Promise.resolve(), 5000);
  await within(app?.close() ?? Promise.resolve(), 5000);
  try {
    app?.process().kill('SIGKILL');
  } catch {
    /* gone */
  }
  try {
    execFileSync(fakeSystemctl, ['--user', 'stop', 'nucleon-sync.service'], { env });
  } catch {
    /* ignore */
  }
  try {
    process.kill(dbusPid);
  } catch {
    /* ignore */
  }
  xvfb?.kill();
  server.close();
  // anything still running from this isolated environment (daemon, CLI workers) is stopped
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid)) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`XDG_RUNTIME_DIR=${RUN}`))
        process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* gone / not ours */
    }
  }
  writeFileSync(path.join(T, 'result.json'), JSON.stringify(results, null, 2));
  log(JSON.stringify({ ok: results.ok, uploaded: results.uploaded, error: results.error?.split('\n')[0] }));
  process.exitCode = results.ok ? 0 : 1;
}
