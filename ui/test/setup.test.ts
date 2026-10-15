// SPDX-License-Identifier: GPL-3.0-or-later
/** First-run setup helpers (main process, no Electron): CLI install with SHA-512 check, service + autostart. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pathWithoutProtonDrive } from '../../vitest.global-setup.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  autostartFile,
  checkSystem,
  cliPlatform,
  installCli,
  installService,
  MANAGED,
  pickRelease,
  suggestPairs,
  unitFile,
  writeDaemonConfig,
  type SetupContext,
} from '../src/main/setup.ts';

const tmp = (p: string) => mkdtempSync(path.join(process.env.NUCLEON_SYNC_TEST_TMP ?? tmpdir(), p));
const BIN = Buffer.from('#!/bin/sh\necho "Proton Drive CLI cli-drive@0.9.7+abc"\n');
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex');

let server: http.Server;
let base = '';
let bad = false;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/version.json') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          Releases: [
            {
              CategoryName: 'Beta',
              Version: '0.10.0',
              Files: [{ Url: `${base}/beta`, Sha512CheckSum: 'a'.repeat(128), Platform: 'linux/x64' }],
            },
            {
              CategoryName: 'Stable',
              Version: '0.11.0',
              Files: [{ Url: `${base}/untested`, Sha512CheckSum: 'c'.repeat(128), Platform: 'linux/x64' }],
            },
            {
              CategoryName: 'Stable',
              Version: '0.9.7',
              Files: [
                { Url: `${base}/bin-x64`, Sha512CheckSum: sha512(BIN), Platform: 'linux/x64' },
                { Url: `${base}/bin-arm`, Sha512CheckSum: 'b'.repeat(128), Platform: 'linux/arm64' },
              ],
            },
          ],
        }),
      );
    } else if (req.url === '/bin-x64') res.end(bad ? Buffer.concat([BIN, Buffer.from('tampered')]) : BIN);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

function ctx(extra: Partial<SetupContext> = {}): SetupContext & { recorder: string } {
  const home = tmp('setup-home-');
  const recorder = path.join(home, 'systemctl.log');
  const fake = path.join(home, 'fake-systemctl');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${JSON.stringify(recorder)}\nexit 0\n`);
  chmodSync(fake, 0o755);
  const res = path.join(home, 'opt/resources');
  mkdirSync(path.join(res, 'daemon/shim'), { recursive: true });
  writeFileSync(path.join(res, 'daemon/nucleon-syncd.mjs'), '// daemon');
  return {
    home,
    env: {
      // never the real CLI: dirs holding a proton-drive binary are dropped (the setup code also searches PATH)
      PATH: pathWithoutProtonDrive(),
      HOME: home,
      USER: 'alex',
      NUCLEON_SYNC_CLI_RELEASES_URL: `${base}/version.json`,
      NUCLEON_SYNC_SYSTEMCTL: fake,
      NUCLEON_SYNC_BUSCTL: '/nonexistent/busctl',
    },
    execPath: path.join(home, 'opt/nucleon-sync'),
    resourcesPath: res,
    appVersion: '0.2.0',
    arch: 'x64',
    recorder,
    ...extra,
  };
}

describe('official CLI install', () => {
  it('picks the newest stable release for the platform', () => {
    expect(cliPlatform('x64', false)).toBe('linux/x64');
    expect(cliPlatform('arm64', true)).toBe('linux/arm64-musl');
    expect(() => pickRelease({ Releases: [] }, 'linux/x64')).toThrow(/no stable/);
  });

  it('prefers a tested version, falls back to the newest, and enforces pinned hashes', () => {
    const rel = (v: string, sum: string) => ({
      CategoryName: 'Stable',
      Version: v,
      Files: [
        {
          Url: `https://proton.me/download/drive/cli/${v}/linux-x64/proton-drive`,
          Sha512CheckSum: sum,
          Platform: 'linux/x64',
        },
      ],
    });
    const tested = pickRelease(
      { Releases: [rel('0.11.0', 'c'.repeat(128)), rel('0.9.7', 'd'.repeat(128))] },
      'linux/x64',
    );
    expect(tested).toMatchObject({ version: '0.9.7', tested: true, pinned: false });
    const untested = pickRelease({ Releases: [rel('0.11.0', 'c'.repeat(128))] }, 'linux/x64');
    expect(untested).toMatchObject({ version: '0.11.0', tested: false });
    // 0.9.0 is pinned in shared/src/defaults.ts: a manifest with another hash is refused
    expect(() => pickRelease({ Releases: [rel('0.9.0', 'e'.repeat(128))] }, 'linux/x64')).toThrow(/pinned/);
    const real =
      '3533025ba69ae112b64e3e01fbcc1ad0688136a4043f6cf6a72886967d85fdcd9ec235479c2e113171614be5225bfba93427509a05ca5aa6071d924fa7e91ca8';
    expect(pickRelease({ Releases: [rel('0.9.0', real)] }, 'linux/x64')).toMatchObject({ pinned: true, tested: true });
  });

  it('downloads, verifies SHA-512 and installs ~/.local/bin/proton-drive (0755)', async () => {
    const c = ctx();
    const phases: string[] = [];
    const r = await installCli(c, (p) => phases.push(p.phase));
    expect(r.version).toBe('0.9.7');
    const target = path.join(c.home, '.local/bin/proton-drive');
    expect(readFileSync(target)).toEqual(BIN);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(phases).toContain('verify');
    expect(checkSystem(c).cli).toMatchObject({ present: true, version: '0.9.7' });
  });

  it('a checksum mismatch installs nothing', async () => {
    const c = ctx();
    bad = true;
    try {
      await expect(installCli(c)).rejects.toThrow(/SHA-512 mismatch/);
    } finally {
      bad = false;
    }
    expect(existsSync(path.join(c.home, '.local/bin/proton-drive'))).toBe(false);
    expect(existsSync(path.join(c.home, '.local/bin'))).toBe(true);
  });
});

describe('daemon config, service and autostart', () => {
  it('writes daemon.json (0600) and keeps keys the user set', () => {
    const c = ctx();
    const f = writeDaemonConfig(c, { secretBackend: 'encfile' });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ secretBackend: 'encfile' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, JSON.stringify({ stagingDir: '/mnt/data/.staging' }));
    writeDaemonConfig(c, { secretBackend: 'libsecret' });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({
      stagingDir: '/mnt/data/.staging',
      secretBackend: 'libsecret',
    });
  });

  it('installs the user unit + autostart (packaged), enables it via systemctl --user', () => {
    const c = ctx();
    const r = installService(c, { autostart: true });
    expect(r.skipped).toBeUndefined();
    const unit = readFileSync(unitFile(c), 'utf8');
    expect(unit).toContain(MANAGED);
    expect(unit).toContain(`ExecStart=${c.execPath} ${path.join(c.resourcesPath!, 'daemon/nucleon-syncd.mjs')}`);
    expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1');
    expect(unit).not.toContain('PROFILE');
    const auto = readFileSync(autostartFile(c), 'utf8');
    expect(auto).toMatch(/Exec=.*--ozone-platform-hint=auto.*--hidden/);
    expect(readFileSync(c.recorder, 'utf8').trim().split('\n')).toEqual([
      '--user daemon-reload',
      '--user enable --now nucleon-sync.service',
      '--user restart nucleon-sync.service',
    ]);
  });

  it('AppImage: copies the AppImage and the daemon to stable paths', () => {
    const c = ctx();
    const img = path.join(c.home, 'Downloads/Nucleon-Sync-0.2.0-x86_64.AppImage');
    mkdirSync(path.dirname(img), { recursive: true });
    writeFileSync(img, 'appimage');
    c.env.APPIMAGE = img;
    installService(c, { autostart: false });
    const stable = path.join(c.home, '.local/share/nucleon-sync/NucleonSync.AppImage');
    expect(readFileSync(stable, 'utf8')).toBe('appimage');
    expect(existsSync(path.join(c.home, '.local/share/nucleon-sync/daemon/nucleon-syncd.mjs'))).toBe(true);
    expect(readFileSync(unitFile(c), 'utf8')).toContain(
      `ExecStart=${stable} ${path.join(c.home, '.local/share/nucleon-sync/daemon/nucleon-syncd.mjs')}`,
    );
    expect(existsSync(autostartFile(c))).toBe(false);
  });

  it('never touches a unit it did not write (e.g. the repository install on the PC)', () => {
    const c = ctx();
    mkdirSync(path.dirname(unitFile(c)), { recursive: true });
    writeFileSync(unitFile(c), '[Service]\nExecStart=/usr/bin/node /home/alex/src/nucleon-sync/daemon/src/main.ts\n');
    const r = installService(c, { autostart: true });
    expect(r.skipped).toBe('foreign-unit');
    expect(readFileSync(unitFile(c), 'utf8')).toContain('/home/alex/src/nucleon-sync');
    expect(existsSync(c.recorder)).toBe(false);
  });

  it('suggests Documents/Pictures pairs below /my-files/<hostname>', () => {
    const c = ctx();
    mkdirSync(path.join(c.home, 'Dokumente'));
    mkdirSync(path.join(c.home, 'Bilder'));
    const sys = checkSystem(c);
    expect(sys.keyring.secretService).toBe('none');
    expect(sys.keyring.recommended).toBe('encfile');
    expect(sys.install.kind).toBe('package');
    const s = suggestPairs(c, { hostname: 'omarchy', folders: sys.folders });
    expect(s.map((p) => [p.localRoot, p.remoteRoot])).toEqual([
      [path.join(c.home, 'Dokumente'), '/my-files/omarchy/Dokumente'],
      [path.join(c.home, 'Bilder'), '/my-files/omarchy/Bilder'],
    ]);
  });
});
