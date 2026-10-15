// SPDX-License-Identifier: GPL-3.0-or-later
// Starts Electron in smoke mode (hidden window, no tray, auto-exit). Needs an X display: if DISPLAY is not
// set (agent shells), it borrows DISPLAY/XAUTHORITY from the systemd user environment of the desktop
// session. The window is never shown. Ozone "headless" segfaults with Electron 44 + GTK, so it is not used.
import { execFileSync, spawnSync } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env, NUCLEON_SYNC_UI_SMOKE: '1' };
if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
  try {
    const out = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    for (const l of out.split('\n')) {
      const m = l.match(/^(DISPLAY|XAUTHORITY)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    /* no systemd user session */
  }
}
if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
  console.error('SMOKE_SKIP no display available');
  process.exit(77);
}
const r = spawnSync(electron, ['.'], { stdio: 'inherit', env, timeout: 60_000 });
process.exit(r.status ?? 1);
