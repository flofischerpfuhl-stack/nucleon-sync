#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Builds the distributable app (version from package.json):
 *   1. bundles the daemon, the `nucleon-sync` CLI client and the pass shim with esbuild (plain ESM for Electron's
 *      Node 24, which runs them with ELECTRON_RUN_AS_NODE=1)
 *   2. builds the Electron UI into build/app
 *   3. electron-builder: dist/Nucleon-Sync-<v>-x86_64.AppImage + dist/linux-unpacked
 *   4. release tarball dist/nucleon-sync-<v>-linux-x64.tar.gz (what the AUR package nucleon-sync-bin downloads)
 *   5. makepkg of packaging/aur/nucleon-sync-bin/PKGBUILD against the local files: dist/nucleon-sync-bin-<v>-1-x86_64.pkg.tar.zst
 *
 * Usage: node scripts/package.mjs [--bundle-only] [--no-appimage] [--no-pacman] [--skip-ui-build]
 *   --bundle-only  steps 1 + 2 only (build/app, build/daemon): used by the source PKGBUILD (system Electron)
 * Nothing is installed or started here.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as esbuild } from '../ui/node_modules/esbuild/lib/main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const BUILD = path.join(ROOT, 'build');
const APP = path.join(BUILD, 'app');
const DAEMON = path.join(BUILD, 'daemon');
const DIST = path.join(ROOT, 'dist');
const args = new Set(process.argv.slice(2));
const REPO_URL = 'https://github.com/flofischerpfuhl-stack/nucleon-sync';
const APP_ID = 'io.github.nucleon_sync.NucleonSync';

const log = (...a) => console.log('[package]', ...a);

// ------------------------------------------------------------------ 1. daemon bundle

async function bundleDaemon() {
  rmSync(DAEMON, { recursive: true, force: true });
  mkdirSync(path.join(DAEMON, 'shim'), { recursive: true });
  const common = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'warning',
    sourcemap: false,
    legalComments: 'none',
    // CJS deps inside an ESM bundle need require()
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  };
  await esbuild({
    ...common,
    entryPoints: [path.join(ROOT, 'daemon/src/main.ts')],
    outfile: path.join(DAEMON, 'nucleon-syncd.mjs'),
  });
  await esbuild({
    ...common,
    entryPoints: [path.join(ROOT, 'daemon/src/bin/nucleon-sync.ts')],
    outfile: path.join(DAEMON, 'nucleon-sync.mjs'),
  });
  await esbuild({
    ...common,
    entryPoints: [path.join(ROOT, 'secret-shim/src/pass.ts')],
    outfile: path.join(DAEMON, 'shim/pass.mjs'),
  });
  // schema + migrations are read relative to the bundle (import.meta.url)
  copyFileSync(path.join(ROOT, 'daemon/src/db/schema.sql'), path.join(DAEMON, 'schema.sql'));
  cpSync(path.join(ROOT, 'daemon/src/db/migrations'), path.join(DAEMON, 'migrations'), { recursive: true });
  // the CLI starts `pass` from PATH: a tiny wrapper that runs the shim on the app's own Node (Electron in node mode)
  const wrapper = `#!/bin/sh
# nucleon-sync pass shim (packaged): runs on the bundled Node runtime of the app
dir=$(dirname "$(readlink -f "$0")")
ELECTRON_RUN_AS_NODE=1 exec "\${NUCLEON_SYNC_NODE:-node}" "$dir/pass.mjs" "$@"
`;
  writeFileSync(path.join(DAEMON, 'shim/pass'), wrapper, { mode: 0o755 });
  writeFileSync(path.join(DAEMON, 'VERSION'), `${VERSION}\n`);
  log('daemon bundle', fmtSize(dirSize(DAEMON)));
}

// ------------------------------------------------------------------ 2. UI + app dir

function buildApp() {
  if (!args.has('--skip-ui-build'))
    execFileSync('node', ['build.mjs'], { cwd: path.join(ROOT, 'ui'), stdio: 'inherit' });
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(path.join(APP, 'ui'), { recursive: true });
  for (const f of ['main.cjs', 'preload.cjs', 'renderer.js', 'index.html', 'styles.css'])
    copyFileSync(path.join(ROOT, 'ui/out', f), path.join(APP, 'ui', f));
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(APP, 'LICENSE'));
  writeFileSync(
    path.join(APP, 'package.json'),
    JSON.stringify(
      {
        name: 'nucleon-sync',
        productName: 'Nucleon Sync',
        version: VERSION,
        description: 'Sync folders with Proton Drive (third-party app on the official proton-drive CLI)',
        main: 'ui/main.cjs',
        author: { name: 'Nucleon Sync contributors' },
        license: 'GPL-3.0-or-later',
        homepage: REPO_URL,
      },
      null,
      2,
    ),
  );
}

// ------------------------------------------------------------------ icons (packaging/icons, rendered from the SVG)

function icons() {
  const dir = path.join(BUILD, 'icons');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = path.join(ROOT, 'packaging/icons/hicolor');
  for (const s of readdirSync(src).filter((d) => /^\d+x\d+$/.test(d)))
    copyFileSync(path.join(src, s, 'apps/nucleon-sync.png'), path.join(dir, `${s}.png`));
  return dir;
}

// ------------------------------------------------------------------ 3. electron-builder

async function electronBuilder(iconDir) {
  const { build, Platform } = await import('electron-builder');
  const electronPkg = realpathSync(path.join(ROOT, 'ui/node_modules/electron'));
  // pnpm may skip electron's postinstall (binary already in its cache): fetch/unpack the binary now
  if (!existsSync(path.join(electronPkg, 'dist')))
    execFileSync('node', ['install.js'], { cwd: electronPkg, stdio: 'inherit' });
  const electronDist = realpathSync(path.join(electronPkg, 'dist'));
  const electronVersion = JSON.parse(
    readFileSync(path.join(ROOT, 'ui/node_modules/electron/package.json'), 'utf8'),
  ).version;
  const targets = ['dir', ...(args.has('--no-appimage') ? [] : ['AppImage'])];
  rmSync(path.join(DIST, 'linux-unpacked'), { recursive: true, force: true });
  await build({
    targets: Platform.LINUX.createTarget(targets),
    projectDir: ROOT,
    config: {
      appId: APP_ID,
      productName: 'Nucleon Sync',
      copyright: 'Nucleon Sync contributors, GPL-3.0-or-later',
      artifactName: 'Nucleon-Sync-${version}-${arch}.${ext}',
      electronVersion,
      electronDist,
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      directories: { app: APP, output: DIST, buildResources: path.join(BUILD, 'resources') },
      files: ['**/*'],
      asar: true,
      extraResources: [
        { from: DAEMON, to: 'daemon' },
        { from: path.join(ROOT, 'LICENSE'), to: 'LICENSE' },
      ],
      linux: {
        target: targets,
        category: 'Utility',
        executableName: 'nucleon-sync',
        icon: iconDir,
        synopsis: 'Proton Drive sync (third-party)',
        description:
          'Sync folders with Proton Drive: background service, tray dashboard and agent CLI on top of the official proton-drive CLI',
        executableArgs: ['--ozone-platform-hint=auto', '--enable-features=WaylandWindowDecorations'],
        desktop: { entry: { StartupWMClass: 'Nucleon Sync', Keywords: 'Proton;Drive;Sync;Backup;Cloud;' } },
      },
      appImage: { license: path.join(ROOT, 'LICENSE') },
      publish: null,
    },
  });
}

// ------------------------------------------------------------------ 4. release tarball

function releaseTarball() {
  const unpacked = path.join(DIST, 'linux-unpacked');
  if (!existsSync(path.join(unpacked, 'nucleon-sync')))
    throw new Error('dist/linux-unpacked missing (electron-builder dir target)');
  const top = `nucleon-sync-${VERSION}-linux-x64`;
  const file = path.join(DIST, `${top}.tar.gz`);
  execFileSync('bsdtar', ['-czf', file, '-s', `|^linux-unpacked|${top}|`, '-C', DIST, 'linux-unpacked']);
  return file;
}

/** The files of the tagged source archive that nucleon-sync-bin needs (stand-in for GitHub's tag tarball). */
function sourceTarball(dir) {
  const top = `nucleon-sync-${VERSION}`;
  const file = path.join(dir, `${top}-src.tar.gz`);
  execFileSync('bsdtar', [
    '-czf',
    file,
    '-s',
    `|^|${top}/|`,
    '-C',
    ROOT,
    'LICENSE',
    'README.md',
    'agent-skill',
    'packaging',
  ]);
  return file;
}

// ------------------------------------------------------------------ 5. Arch package (local build of the AUR -bin PKGBUILD)

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pacman(tarball) {
  const work = path.join(BUILD, 'arch');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const bin = path.join(work, path.basename(tarball));
  copyFileSync(tarball, bin);
  const src = sourceTarball(work);
  let pb = readFileSync(path.join(ROOT, 'packaging/aur/nucleon-sync-bin/PKGBUILD'), 'utf8');
  pb = pb.replace(/^pkgver=.*$/m, `pkgver=${VERSION}`);
  // local sources instead of the GitHub release/tag URLs, real checksums instead of SKIP
  pb = pb.replace(/^source=\([\s\S]*?\)$/m, `source=('${path.basename(bin)}'\n        '${path.basename(src)}')`);
  pb = pb.replace(/^sha256sums=\([\s\S]*?\)$/m, `sha256sums=('${sha256(bin)}'\n            '${sha256(src)}')`);
  writeFileSync(path.join(work, 'PKGBUILD'), pb);
  execFileSync('makepkg', ['-f', '--nodeps', '--noconfirm'], {
    cwd: work,
    stdio: 'inherit',
    env: {
      ...process.env,
      PKGDEST: DIST,
      SRCDEST: work,
      BUILDDIR: path.join(work, 'build'),
      PACKAGER: 'Nucleon Sync local build <build@localhost>',
    },
  });
  // keep the filled-in PKGBUILD next to the package (what was built, with local checksums)
  copyFileSync(path.join(work, 'PKGBUILD'), path.join(DIST, 'PKGBUILD.local'));
}

// ------------------------------------------------------------------ helpers

function dirSize(p) {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  return readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
}
function fmtSize(n) {
  return `${(n / 1e6).toFixed(1)} MB`;
}

await bundleDaemon();
if (args.has('--daemon-only')) process.exit(0);
buildApp();
if (args.has('--bundle-only')) {
  log('build/app and build/daemon ready');
  process.exit(0);
}
const iconDir = icons();
await electronBuilder(iconDir);
const tarball = releaseTarball();
if (!args.has('--no-pacman')) pacman(tarball);
const sums = [];
for (const f of readdirSync(DIST).filter((f) => /\.(AppImage|pkg\.tar\.zst|tar\.gz)$/.test(f))) {
  const p = path.join(DIST, f);
  chmodSync(p, f.endsWith('.AppImage') ? 0o755 : 0o644);
  sums.push(`${sha256(p)}  ${f}`);
  log(`${f}  ${fmtSize(statSync(p).size)}  sha256 ${sha256(p)}`);
}
writeFileSync(path.join(DIST, 'SHA256SUMS'), sums.join('\n') + '\n');
