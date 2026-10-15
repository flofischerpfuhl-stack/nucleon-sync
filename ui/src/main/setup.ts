// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * First-run setup (packaged app): system checks, installation of the official Proton Drive CLI (SHA-512 verified
 * against Proton's release manifest and, for tested versions, against hashes pinned in this release), daemon
 * configuration, systemd user service and tray autostart. Pure Node (no Electron imports) so it is unit-testable; main.ts exposes it via the `ps:setup` IPC.
 *
 * Nothing here runs without an explicit wizard step (the user's consent). Tests point every external effect elsewhere:
 *   NUCLEON_SYNC_CLI_RELEASES_URL  release manifest (default https://proton.me/download/drive/cli/version.json)
 *   NUCLEON_SYNC_SYSTEMCTL         systemctl binary (tests: a recorder script; never the real user manager)
 *   NUCLEON_SYNC_BUSCTL            busctl binary (Secret Service / tray detection)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PINNED_CLI_SHA512, TESTED_CLI_MINORS } from '../../../shared/src/defaults.ts';
import { defaultCliPath } from '../../../shared/src/paths.ts';

export const RELEASES_URL = 'https://proton.me/download/drive/cli/version.json';
/** marker line in files written by the wizard; files without it (e.g. a hand-written unit) are never overwritten */
export const MANAGED = '# managed-by: nucleon-sync-app';
export const UNIT_NAME = 'nucleon-sync.service';

export interface SetupContext {
  home: string;
  env: NodeJS.ProcessEnv;
  /** absolute path of the running app binary (Electron) */
  execPath: string;
  /** Electron resources dir (packaged) or null (dev) */
  resourcesPath: string | null;
  appVersion: string;
  arch?: string;
}

export interface SystemCheck {
  hostname: string;
  user: string;
  cli: { path: string; present: boolean; version: string | null };
  keyring: {
    secretService: 'running' | 'activatable' | 'none';
    secretTool: boolean;
    recommended: 'libsecret' | 'encfile';
  };
  systemd: boolean;
  session: { type: string; desktop: string; hyprland: boolean; uwsm: boolean };
  tray: { watcher: boolean };
  install: { kind: 'appimage' | 'package' | 'dev'; daemonScript: string | null };
  service: { unitFile: string; installed: boolean; managedByApp: boolean; active: boolean };
  daemon: { configured: boolean; tokenPresent: boolean };
  folders: { documents: string | null; pictures: string | null; desktop: string | null };
}

/** where the wizard installs the CLI (app-managed copy) */
const managedCliPath = (c: SetupContext) => c.env.NUCLEON_SYNC_CLI ?? path.join(c.home, '.local/bin/proton-drive');
/** the CLI the daemon will use: the managed copy, else proton-drive on PATH (e.g. the AUR package), else the managed path */
const cliPathOf = (c: SetupContext) =>
  c.env.NUCLEON_SYNC_CLI ?? defaultCliPath({ ...c.env, HOME: c.home, PATH: c.env.PATH ?? '' });
const configDir = (c: SetupContext) => path.join(c.env.XDG_CONFIG_HOME || path.join(c.home, '.config'), 'nucleon-sync');
const dataDir = (c: SetupContext) =>
  path.join(c.env.XDG_DATA_HOME || path.join(c.home, '.local/share'), 'nucleon-sync');
export const unitFile = (c: SetupContext) =>
  path.join(c.env.XDG_CONFIG_HOME || path.join(c.home, '.config'), 'systemd/user', UNIT_NAME);
export const autostartFile = (c: SetupContext) =>
  path.join(c.env.XDG_CONFIG_HOME || path.join(c.home, '.config'), 'autostart', 'nucleon-sync.desktop');

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 15_000) {
  return spawnSync(cmd, args, { env, encoding: 'utf8', timeout });
}

function busNames(c: SetupContext, method: 'ListNames' | 'ListActivatableNames'): string[] {
  const busctl = c.env.NUCLEON_SYNC_BUSCTL ?? 'busctl';
  const r = run(
    busctl,
    ['--user', '--json=short', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', method],
    c.env,
  );
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const o = JSON.parse(r.stdout) as { data?: unknown[] };
    return Array.isArray(o.data?.[0]) ? (o.data[0] as string[]) : [];
  } catch {
    return [];
  }
}

function which(bin: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(':')) {
    try {
      if (dir && statSync(path.join(dir, bin)).isFile()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** XDG user dirs (~/.config/user-dirs.dirs), falling back to the usual German/English names. */
export function userDir(c: SetupContext, key: 'DOCUMENTS' | 'PICTURES' | 'DESKTOP'): string | null {
  try {
    const txt = readFileSync(
      path.join(c.env.XDG_CONFIG_HOME || path.join(c.home, '.config'), 'user-dirs.dirs'),
      'utf8',
    );
    const m = new RegExp(`^XDG_${key}_DIR="([^"]+)"`, 'm').exec(txt);
    if (m) {
      const p = m[1]!.replace(/^\$HOME/, c.home);
      if (p !== c.home && existsSync(p)) return p;
    }
  } catch {
    /* no user-dirs */
  }
  const names = {
    DOCUMENTS: ['Dokumente', 'Documents'],
    PICTURES: ['Bilder', 'Pictures'],
    DESKTOP: ['Schreibtisch', 'Desktop'],
  }[key];
  for (const n of names) if (existsSync(path.join(c.home, n))) return path.join(c.home, n);
  return null;
}

export function installKind(c: SetupContext): SystemCheck['install'] {
  // the source package runs on the system Electron: its launcher names the daemon dir
  const dir = c.env.NUCLEON_SYNC_DAEMON_DIR || (c.resourcesPath ? path.join(c.resourcesPath, 'daemon') : null);
  const script = dir ? path.join(dir, 'nucleon-syncd.mjs') : null;
  const packaged = !!script && existsSync(script);
  return {
    kind: c.env.APPIMAGE ? 'appimage' : packaged ? 'package' : 'dev',
    daemonScript: packaged ? script : null,
  };
}

export function cliVersion(cliPath: string, env: NodeJS.ProcessEnv): string | null {
  const r = run(cliPath, ['--version'], env, 30_000);
  const m = /Proton Drive CLI\s+(?:[\w.-]+@)?v?(\d+\.\d+\.\d+)/i.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return m?.[1] ?? null;
}

export function checkSystem(c: SetupContext): SystemCheck {
  const cliPath = cliPathOf(c);
  const present = existsSync(cliPath);
  const names = busNames(c, 'ListNames');
  const activatable = busNames(c, 'ListActivatableNames');
  const secretService = names.includes('org.freedesktop.secrets')
    ? 'running'
    : activatable.includes('org.freedesktop.secrets')
      ? 'activatable'
      : 'none';
  const secretTool = which('secret-tool', c.env);
  const systemctl = c.env.NUCLEON_SYNC_SYSTEMCTL ?? 'systemctl';
  const systemd = run(systemctl, ['--user', 'show-environment'], c.env).status === 0;
  const unit = unitFile(c);
  const unitText = existsSync(unit) ? readFileSync(unit, 'utf8') : '';
  const active = !!unitText && run(systemctl, ['--user', 'is-active', '--quiet', UNIT_NAME], c.env).status === 0;
  const cfg = path.join(configDir(c), 'daemon.json');
  return {
    hostname: os.hostname(),
    user: c.env.USER ?? os.userInfo().username,
    cli: { path: cliPath, present, version: present ? cliVersion(cliPath, c.env) : null },
    keyring: {
      secretService,
      secretTool,
      recommended: secretService !== 'none' && secretTool ? 'libsecret' : 'encfile',
    },
    systemd,
    session: {
      type: c.env.XDG_SESSION_TYPE ?? (c.env.WAYLAND_DISPLAY ? 'wayland' : c.env.DISPLAY ? 'x11' : 'unknown'),
      desktop: c.env.XDG_CURRENT_DESKTOP ?? '',
      hyprland: !!c.env.HYPRLAND_INSTANCE_SIGNATURE || /hyprland/i.test(c.env.XDG_CURRENT_DESKTOP ?? ''),
      uwsm: Object.keys(c.env).some((k) => k.startsWith('UWSM_')),
    },
    tray: { watcher: names.includes('org.kde.StatusNotifierWatcher') },
    install: installKind(c),
    service: { unitFile: unit, installed: !!unitText, managedByApp: unitText.includes(MANAGED), active },
    daemon: { configured: existsSync(cfg), tokenPresent: existsSync(path.join(configDir(c), 'api-token')) },
    folders: {
      documents: userDir(c, 'DOCUMENTS'),
      pictures: userDir(c, 'PICTURES'),
      desktop: userDir(c, 'DESKTOP'),
    },
  };
}

// ------------------------------------------------------------------ official CLI

export interface CliRelease {
  version: string;
  url: string;
  sha512: string;
  platform: string;
  /** the version's major.minor was tested with this release (otherwise the daemon starts read-only) */
  tested: boolean;
  /** the hash is also pinned in this release (not only taken from Proton's manifest) */
  pinned: boolean;
}

/** linux/x64, linux/arm64, ...-musl (Proton's manifest platform names) */
export function cliPlatform(arch: string = process.arch, musl = isMusl()): string {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return `linux/${a}${musl ? '-musl' : ''}`;
}

function isMusl(): boolean {
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

const minorOf = (v: string) => v.split('.').slice(0, 2).join('.');

/**
 * Picks the release to install from Proton's version.json: the newest Stable release of a tested major.minor for the
 * platform, else the newest Stable release (untested: the daemon stays read-only until it is tested). A release whose
 * hash is pinned in this app must have exactly that hash in the manifest.
 */
export function pickRelease(manifest: unknown, platform: string): CliRelease {
  const rel = (manifest as { Releases?: unknown[] })?.Releases;
  if (!Array.isArray(rel)) throw new Error('unexpected release manifest (no Releases)');
  const stable = rel.filter((r) => (r as { CategoryName?: string }).CategoryName === 'Stable') as {
    Version: string;
    Files: { Url: string; Sha512CheckSum: string; Platform: string }[];
  }[];
  stable.sort((a, b) => cmpVersion(b.Version, a.Version));
  const candidates = stable
    .map((r) => ({ r, f: r.Files?.find((x) => x.Platform === platform) }))
    .filter((x) => x.f && /^[0-9a-f]{128}$/i.test(x.f.Sha512CheckSum));
  const pick = candidates.find((x) => TESTED_CLI_MINORS.includes(minorOf(x.r.Version))) ?? candidates[0];
  if (!pick) throw new Error(`no stable proton-drive release for ${platform}`);
  const sha512 = pick.f!.Sha512CheckSum.toLowerCase();
  const pinned = PINNED_CLI_SHA512[pick.r.Version]?.[platform];
  if (pinned && pinned !== sha512)
    throw new Error(
      `the release manifest lists a different SHA-512 for proton-drive ${pick.r.Version} (${platform}) than the one ` +
        'pinned in this app – refusing to install',
    );
  return {
    version: pick.r.Version,
    url: pick.f!.Url,
    sha512,
    platform,
    tested: TESTED_CLI_MINORS.includes(minorOf(pick.r.Version)),
    pinned: !!pinned,
  };
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function allowedDownload(url: string, manifestUrl: string): boolean {
  try {
    const u = new URL(url);
    const m = new URL(manifestUrl);
    if (u.protocol === 'https:' && (u.hostname === 'proton.me' || u.hostname.endsWith('.proton.me'))) return true;
    // tests: a local manifest may point at its own (local) server
    return m.hostname === '127.0.0.1' && u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Downloads the official CLI for this platform, verifies its SHA-512 against the manifest (and the pinned hash, see
 * pickRelease) and installs it atomically to ~/.local/bin/proton-drive (0755). A mismatch leaves nothing behind.
 */
export async function installCli(
  c: SetupContext,
  onProgress: (p: {
    phase: 'manifest' | 'download' | 'verify' | 'done';
    bytes?: number;
    total?: number;
  }) => void = () => undefined,
): Promise<CliRelease & { path: string }> {
  const manifestUrl = c.env.NUCLEON_SYNC_CLI_RELEASES_URL ?? RELEASES_URL;
  onProgress({ phase: 'manifest' });
  const res = await fetch(manifestUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`release manifest: HTTP ${res.status}`);
  const rel = pickRelease(await res.json(), cliPlatform(c.arch));
  if (!allowedDownload(rel.url, manifestUrl)) throw new Error(`refusing download from ${rel.url}`);
  const target = managedCliPath(c);
  mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.download-${process.pid}`;
  try {
    const bin = await fetch(rel.url, { redirect: 'follow' });
    if (!bin.ok || !bin.body) throw new Error(`download: HTTP ${bin.status}`);
    const total = Number(bin.headers.get('content-length') ?? 0) || undefined;
    const hash = createHash('sha512');
    const out = createWriteStream(part, { mode: 0o700 });
    let bytes = 0;
    let last = 0;
    for await (const chunk of bin.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress({ phase: 'download', bytes, total });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    onProgress({ phase: 'verify', bytes, total });
    const got = hash.digest('hex');
    if (got !== rel.sha512) throw new Error(`SHA-512 mismatch for ${rel.url}: expected ${rel.sha512}, got ${got}`);
    chmodSync(part, 0o755);
    renameSync(part, target);
  } finally {
    rmSync(part, { force: true });
  }
  onProgress({ phase: 'done' });
  return { ...rel, path: target };
}

// ------------------------------------------------------------------ daemon config, service, autostart

export interface DaemonSetup {
  secretBackend: 'libsecret' | 'encfile';
}

/** ~/.config/nucleon-sync/daemon.json (merged, existing keys are kept). */
export function writeDaemonConfig(c: SetupContext, o: DaemonSetup): string {
  const file = path.join(configDir(c), 'daemon.json');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* new */
  }
  const next = { ...cur, secretBackend: o.secretBackend, cliPath: cliPathOf(c) };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return file;
}

export interface Launch {
  /** node runtime (Electron binary or AppImage) */
  node: string;
  /** directory with nucleon-syncd.mjs, nucleon-sync.mjs, shim/ */
  daemonDir: string;
  /** command that starts the GUI (autostart) */
  gui: string;
}

/**
 * Where the service runs from. AppImages are mounted at a new path on every start: the AppImage and the daemon files
 * are copied to ~/.local/share/nucleon-sync (stable paths, refreshed on every install/update).
 */
export function prepareLaunch(c: SetupContext): Launch {
  const k = installKind(c);
  if (!k.daemonScript) throw new Error('the daemon is only bundled in the packaged app (AppImage / pacman package)');
  const srcDir = path.dirname(k.daemonScript);
  if (k.kind !== 'appimage')
    return { node: c.execPath, daemonDir: srcDir, gui: c.env.NUCLEON_SYNC_LAUNCHER || c.execPath };
  const base = dataDir(c);
  const appimage = path.join(base, 'NucleonSync.AppImage');
  const daemonDir = path.join(base, 'daemon');
  mkdirSync(base, { recursive: true });
  const src = c.env.APPIMAGE!;
  if (path.resolve(src) !== appimage) {
    cpSync(src, `${appimage}.new`);
    chmodSync(`${appimage}.new`, 0o755);
    renameSync(`${appimage}.new`, appimage);
  }
  rmSync(`${daemonDir}.new`, { recursive: true, force: true });
  cpSync(srcDir, `${daemonDir}.new`, { recursive: true });
  rmSync(daemonDir, { recursive: true, force: true });
  renameSync(`${daemonDir}.new`, daemonDir);
  return { node: appimage, daemonDir, gui: appimage };
}

const q = (s: string) => (/^[A-Za-z0-9_\-./+=:@%]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

export function unitText(l: Launch, version: string): string {
  return `${MANAGED} ${version}
[Unit]
Description=Nucleon Sync daemon (nucleon-syncd)
Documentation=https://github.com/flofischerpfuhl-stack/nucleon-sync
After=network-online.target

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
Environment=NUCLEON_SYNC_ALLOW_WRITES=1
Environment=NUCLEON_SYNC_NODE=${q(l.node)}
Environment=NUCLEON_SYNC_SHIM_DIR=${q(path.join(l.daemonDir, 'shim'))}
ExecStart=${q(l.node)} ${q(path.join(l.daemonDir, 'nucleon-syncd.mjs'))}
Restart=on-failure
RestartSec=15
Nice=10
IOSchedulingClass=idle
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

/** Electron flags for Wayland compositors (Hyprland): native Wayland when available, X11 otherwise. */
export const WAYLAND_FLAGS = '--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations';

export function autostartText(l: Launch): string {
  return `[Desktop Entry]
${MANAGED}
Type=Application
Name=Nucleon Sync
Comment=Nucleon Sync tray icon
Exec=${q(l.gui)} ${WAYLAND_FLAGS} --hidden
Icon=nucleon-sync
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

export interface ServiceResult {
  unitFile: string;
  autostartFile: string | null;
  steps: { cmd: string; ok: boolean; output: string }[];
  skipped?: string;
}

/**
 * Installs and starts the systemd user service (after the user agreed in the wizard). A unit that the app did not
 * write (no MANAGED marker, e.g. Alex's PC with the repository install) is never touched.
 */
export function installService(c: SetupContext, o: { autostart: boolean; start?: boolean }): ServiceResult {
  const unit = unitFile(c);
  if (existsSync(unit) && !readFileSync(unit, 'utf8').includes(MANAGED)) {
    return {
      unitFile: unit,
      autostartFile: null,
      steps: [],
      skipped: 'foreign-unit', // shown as t.setup.serviceForeign
    };
  }
  const l = prepareLaunch(c);
  mkdirSync(path.dirname(unit), { recursive: true });
  writeFileSync(unit, unitText(l, c.appVersion));
  let auto: string | null = null;
  const af = autostartFile(c);
  if (o.autostart) {
    mkdirSync(path.dirname(af), { recursive: true });
    writeFileSync(af, autostartText(l));
    auto = af;
  } else if (existsSync(af) && readFileSync(af, 'utf8').includes(MANAGED)) rmSync(af);
  const systemctl = c.env.NUCLEON_SYNC_SYSTEMCTL ?? 'systemctl';
  const steps: ServiceResult['steps'] = [];
  const step = (args: string[]) => {
    const r = run(systemctl, ['--user', ...args], c.env, 60_000);
    steps.push({
      cmd: `systemctl --user ${args.join(' ')}`,
      ok: r.status === 0,
      output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    });
    return r.status === 0;
  };
  if (step(['daemon-reload']) && o.start !== false) {
    if (step(['enable', '--now', UNIT_NAME])) step(['restart', UNIT_NAME]); // restart picks up an updated binary
  }
  return { unitFile: unit, autostartFile: auto, steps };
}

/** Suggested folder pairs for this computer (wizard defaults; the user edits them). */
export function suggestPairs(c: SetupContext, sys: Pick<SystemCheck, 'hostname' | 'folders'>) {
  const device = sys.hostname.replace(/[^\p{L}\p{N} ._-]/gu, '_') || 'Laptop';
  const out: { name: string; localRoot: string; remoteRoot: string; direction: 'backup' }[] = [];
  if (sys.folders.documents)
    out.push({
      name: path.basename(sys.folders.documents),
      localRoot: sys.folders.documents,
      remoteRoot: `/my-files/${device}/${path.basename(sys.folders.documents)}`,
      direction: 'backup',
    });
  if (sys.folders.pictures)
    out.push({
      name: path.basename(sys.folders.pictures),
      localRoot: sys.folders.pictures,
      remoteRoot: `/my-files/${device}/${path.basename(sys.folders.pictures)}`,
      direction: 'backup',
    });
  return out;
}
