// SPDX-License-Identifier: GPL-3.0-or-later
/** Shared e2e helpers: launch the Electron UI offscreen, start/stop the mock daemon (scripts/dev-env.mjs). */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, type ElectronApplication, type Page } from '@playwright/test';

import { resolvePaths } from '../../../shared/src/paths.ts';

export const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ROOT = path.resolve(UI_DIR, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DISPLAY/XAUTHORITY from the environment or the systemd user session (agent shells); null = no display. */
export function displayEnv(): Record<string, string> | null {
  if (process.env.DISPLAY)
    return { DISPLAY: process.env.DISPLAY, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) };
  try {
    const out = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    const env: Record<string, string> = {};
    for (const l of out.split('\n')) {
      const m = /^(DISPLAY|XAUTHORITY)=(.*)$/.exec(l);
      if (m) env[m[1]!] = m[2]!;
    }
    return env.DISPLAY ? env : null;
  } catch {
    return null;
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(process.env.NUCLEON_SYNC_TEST_TMP ?? tmpdir(), `ps-${prefix}-`));
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  close: () => Promise<void>;
}

export async function launchUi(opts: {
  home: string;
  fixtures?: 'demo' | '1';
  colorScheme?: 'dark' | 'light';
  /** UI language (default German: the older specs assert German strings) */
  lang?: 'en' | 'de';
  /** extra environment (e.g. a fake HOME with an Omarchy theme) */
  env?: Record<string, string>;
}): Promise<Launched> {
  const userData = tempDir('profile');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...displayEnv(),
    // never the real CLI: drop PATH entries that hold a proton-drive binary
    PATH: (process.env.PATH ?? '')
      .split(':')
      .filter((d) => d && !existsSync(path.join(d, 'proton-drive')))
      .join(':'),
    NUCLEON_SYNC_HOME: opts.home,
    NUCLEON_SYNC_UI_OFFSCREEN: '1',
    NUCLEON_SYNC_UI_USER_DATA: userData,
    NUCLEON_SYNC_UI_THEME: opts.colorScheme ?? 'dark',
    NUCLEON_SYNC_UI_LANG: opts.lang ?? 'de',
    ...(opts.env ?? {}),
  };
  // an empty value in opts.env removes the variable (e.g. no theme/language override)
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === '') delete env[k];
  if (opts.fixtures) env.NUCLEON_SYNC_UI_FIXTURES = opts.fixtures;
  else delete env.NUCLEON_SYNC_UI_FIXTURES;
  const app = await _electron.launch({ args: [UI_DIR], env, colorScheme: opts.colorScheme ?? 'dark' });
  let page: Page | undefined;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((w) => !w.url().endsWith('#flyout') && w.url().startsWith('file:'));
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('main window not found');
  await page.waitForSelector('.app');
  return {
    app,
    page,
    close: async () => {
      await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
      await app.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

export async function flyoutPage(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => w.url().endsWith('#flyout'));
    if (p) return p;
    await sleep(100);
  }
  throw new Error('flyout window not found');
}

export interface MockDaemon {
  home: string;
  stop: () => Promise<void>;
}

/** Starts the mock daemon via scripts/dev-env.mjs (seeds accounts alex + sam below `home`). */
export async function startDaemon(home: string): Promise<MockDaemon> {
  const env = { ...process.env, NUCLEON_SYNC_HOME: home, MOCK_LATENCY_MS: '0' };
  const sock = resolvePaths(env).socketFile;
  const proc: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-env.mjs'), 'daemon'], {
    env,
    stdio: 'ignore',
  });
  for (let i = 0; i < 150 && !existsSync(sock); i++) await sleep(100);
  if (!existsSync(sock)) throw new Error('mock daemon did not start');
  return {
    home,
    stop: async () => {
      proc.kill('SIGTERM');
      for (let i = 0; i < 50 && existsSync(sock); i++) await sleep(100);
    },
  };
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  try {
    rmSync(path.dirname(resolvePaths({ NUCLEON_SYNC_HOME: dir }).socketFile), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export type Recorded = { method: string; path: string; body: unknown };
export function fixtureCalls(page: Page, method: string, pathPrefix: string): Promise<Recorded[]> {
  return page.evaluate(
    ([m, p]) =>
      (window as unknown as { __psFixtures: { calls: Recorded[] } }).__psFixtures.calls.filter(
        (c) => c.method === m && c.path.startsWith(p!),
      ),
    [method, pathPrefix],
  );
}

export function trayState(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => (globalThis as unknown as { __psTest: { trayState: () => string } }).__psTest.trayState());
}
