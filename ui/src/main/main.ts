// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Electron main process. Owns the only connection to the daemon (Unix socket + token) and relays it to the
 * sandboxed renderers (main window + tray flyout) via an allow-listed IPC surface. Tray icon with state
 * colours, flyout, context menu with timed pauses, desktop notifications from `notice` events.
 *
 * Flags / env:
 *   --hidden                     start in the tray (autostart)
 *   NUCLEON_SYNC_UI_SMOKE=1       hidden window, no tray; exits 0 after the renderer reported a status
 *   NUCLEON_SYNC_UI_FIXTURES=1    renderer answers endpoints that still return 501 from fixtures
 *   NUCLEON_SYNC_UI_FIXTURES=demo renderer runs fully on demo fixtures (no daemon needed)
 *   NUCLEON_SYNC_UI_OFFSCREEN=1   tests: windows render offscreen (never visible), no real tray icon
 *   NUCLEON_SYNC_UI_USER_DATA     tests/dev: separate Electron profile directory
 *   --open[=SCREEN]              show the window (on a screen); also for a second start (`nucleon-sync open`)
 *   NUCLEON_SYNC_UI_THEME=light|dark  override the theme (default: Omarchy theme › KDE kdeglobals › system)
 *   NUCLEON_SYNC_UI_LANG=en|de    override the language (default: Settings → Language, else the system locale)
 *   NUCLEON_SYNC_UI_SETUP=1       show the first-run wizard even when not running from the packaged app
 */
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';

import {
  ApiRequestError,
  NucleonSyncClient,
  type DaemonEvent,
  type Notice,
  type SettingsDto,
  type StatusDto,
} from '@nucleon-sync/shared';

import {
  IPC,
  isSetupOp,
  encodeApiError,
  isAllowedApiRequest,
  isAllowedExternalUrl,
  type ConnectionState,
  type ThemeState,
  type UiPrefs,
  type UiState,
} from '../common/ipc.ts';
import { deriveTrayState, type TrayState } from '../common/trayState.ts';
import {
  isLanguagePreference,
  resolveLocale,
  section,
  setLocale,
  systemLocale,
  t,
  type Locale,
} from '../renderer/i18n/index.ts';
import { daemonText } from '../renderer/logic/daemonText.ts';
import { OMARCHY_THEME_DIRS, OMARCHY_WATCH_DIRS, parseColorsToml } from '../common/omarchyTheme.ts';
import { renderIcon, SYNC_FRAMES } from './icons.ts';
import { resolveTheme } from './theme.ts';
import {
  checkSystem,
  installCli,
  installKind,
  installService,
  suggestPairs,
  writeDaemonConfig,
  type SetupContext,
} from './setup.ts';

// Wayland compositors (Hyprland, KDE, GNOME): native Wayland when available (the launchers pass the same flag;
// this covers starts without them). Must be set before the app is ready.
if (!app.commandLine.hasSwitch('ozone-platform-hint')) app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

const SMOKE = process.env.NUCLEON_SYNC_UI_SMOKE === '1';
const OFFSCREEN = process.env.NUCLEON_SYNC_UI_OFFSCREEN === '1';
const HIDDEN = process.argv.includes('--hidden');
const FIXTURES: UiState['fixtures'] =
  process.env.NUCLEON_SYNC_UI_FIXTURES === 'demo'
    ? 'demo'
    : process.env.NUCLEON_SYNC_UI_FIXTURES === '1'
      ? 'fallback'
      : 'off';
const T = section('tray');

let win: BrowserWindow | null = null;
let flyout: BrowserWindow | null = null;
let flyoutHiddenAt = 0;
let tray: Tray | null = null;
let client: NucleonSyncClient | null = null;
let quitting = false;
let connection: ConnectionState = 'connecting';
let lastStatus: StatusDto | null = null;
let trayState: TrayState = 'error';
let syncFrame = 0;
let syncTimer: NodeJS.Timeout | null = null;
let pauseUntil: string | null = null;
let pauseTimer: NodeJS.Timeout | null = null;
const recentNotices = new Map<string, number>();

/** Lets Playwright inspect tray/menu/notification state (see below). */
const testHook = {
  trayState: () => trayState,
  menuLabels: () => menuTemplate().map((i) => i.label ?? (i.submenu ? 'submenu' : '-')),
  notifications: [] as { title: string; body: string }[],
  handleEvent: (ev: DaemonEvent) => onDaemonEvent(ev),
  pauseUntil: () => pauseUntil,
  toggleFlyout: () => toggleFlyout(),
};
/** Test/dev hook, reachable only from the main process (Playwright `electronApp.evaluate`). */
(globalThis as unknown as { __psTest: typeof testHook }).__psTest = testHook;

function getClient(): NucleonSyncClient {
  client ??= NucleonSyncClient.fromEnv();
  return client;
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of [win, flyout]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function setupContext(): SetupContext {
  return {
    home: os.homedir(),
    env: process.env,
    execPath: process.execPath,
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    appVersion: app.getVersion(),
  };
}

function uiState(): UiState {
  const kind = installKind(setupContext()).kind;
  return {
    pauseUntil,
    fixtures: FIXTURES,
    setup: { packaged: kind !== 'dev', force: process.env.NUCLEON_SYNC_UI_SETUP === '1', appVersion: app.getVersion() },
    language: { preference: prefs.language, locale: activeLocale, system: systemLocale(systemLanguages()) },
    theme: themeState,
    prefs,
  };
}

// ------------------------------------------------------------------ preferences: language, theme

const DEFAULT_PREFS: UiPrefs = { language: 'system', followTheme: true };
let prefs: UiPrefs = DEFAULT_PREFS;
let activeLocale: Locale = 'en';
let themeState: ThemeState = { source: 'system', name: null, mode: 'system', vars: null };

const prefsFile = () => path.join(app.getPath('userData'), 'ui-prefs.json');

function loadPrefs(): void {
  try {
    const p = JSON.parse(readFileSync(prefsFile(), 'utf8')) as Partial<UiPrefs>;
    prefs = {
      language: isLanguagePreference(p.language) ? p.language : 'system',
      followTheme: p.followTheme !== false,
    };
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
}

function savePrefs(): void {
  try {
    mkdirSync(path.dirname(prefsFile()), { recursive: true });
    writeFileSync(`${prefsFile()}.tmp`, JSON.stringify(prefs, null, 2) + '\n');
    renameSync(`${prefsFile()}.tmp`, prefsFile());
  } catch {
    /* preferences are best effort */
  }
}

/** OS language preference list (LANGUAGE/LC_ALL/LANG on Linux) */
function systemLanguages(): string[] {
  const env = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].filter((x): x is string => !!x);
  let electron: string[];
  try {
    electron = app.getPreferredSystemLanguages();
  } catch {
    electron = [app.getLocale()];
  }
  return [...(process.env.LANGUAGE?.split(':') ?? []), ...env, ...electron].filter(Boolean);
}

function applyLanguage(): void {
  const forced = process.env.NUCLEON_SYNC_UI_LANG;
  activeLocale = resolveLocale(
    forced && isLanguagePreference(forced) ? forced : (prefs.language as Locale | 'system'),
    systemLanguages(),
  );
  setLocale(activeLocale);
  updateTray();
}

// ------------------------------------------------------------------ windows

function webPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    spellcheck: false,
    offscreen: OFFSCREEN,
    backgroundThrottling: !OFFSCREEN,
  };
}

function appIcon(): Electron.NativeImage {
  const b = renderIcon('idle', 128);
  return nativeImage.createFromBitmap(b.data, { width: b.width, height: b.height });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Nucleon Sync',
    icon: appIcon(),
    backgroundColor: '#1d1a23',
    webPreferences: webPreferences(),
  });
  w.removeMenu();
  void w.loadFile(path.join(__dirname, 'index.html'));
  if (!SMOKE && !OFFSCREEN && !HIDDEN) w.once('ready-to-show', () => w.show());
  w.on('close', (e) => {
    if (!quitting && !SMOKE) {
      e.preventDefault();
      w.hide();
    }
  });
  return w;
}

function showMain(screenId?: string): void {
  if (!win || win.isDestroyed()) win = createWindow();
  if (screenId) win.webContents.send(IPC.navigate, screenId);
  if (!OFFSCREEN) {
    win.show();
    win.focus();
  }
  flyout?.hide();
}

function createFlyout(): BrowserWindow {
  const f = new BrowserWindow({
    width: 420,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: !OFFSCREEN,
    backgroundColor: OFFSCREEN ? '#1d1a23' : '#00000000',
    title: 'Nucleon Sync',
    webPreferences: webPreferences(),
  });
  void f.loadFile(path.join(__dirname, 'index.html'), { hash: 'flyout' });
  f.on('blur', () => {
    if (!OFFSCREEN) {
      f.hide();
      flyoutHiddenAt = Date.now();
    }
  });
  f.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      f.hide();
    }
  });
  return f;
}

function toggleFlyout(): void {
  flyout ??= createFlyout();
  if (flyout.isVisible()) return flyout.hide();
  // a click on the tray icon blurs (and hides) the flyout first; don't reopen it immediately
  if (Date.now() - flyoutHiddenAt < 300) return;
  const { width: w, height: h } = flyout.getBounds();
  const cur = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cur).workArea;
  const x = Math.round(Math.min(Math.max(cur.x - w / 2, wa.x + 8), wa.x + wa.width - w - 8));
  const lower = cur.y > wa.y + wa.height / 2;
  const y = Math.round(lower ? Math.min(cur.y - h - 16, wa.y + wa.height - h - 8) : Math.max(cur.y + 16, wa.y + 8));
  flyout.setPosition(x, Math.max(wa.y + 8, y));
  flyout.show();
  flyout.focus();
}

// ------------------------------------------------------------------ tray

function trayImage(state: TrayState, frame = 0): Electron.NativeImage {
  const b = renderIcon(state, 32, frame);
  return nativeImage.createFromBitmap(b.data, { width: b.width, height: b.height });
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function menuTemplate(): MenuItemConstructorOptions[] {
  const paused = !!lastStatus?.paused;
  const online = connection === 'connected';
  return [
    { label: T.open, click: () => showMain() },
    { label: T.syncNow, enabled: online && !paused, click: () => void apiCall('POST', '/v1/sync', {}) },
    {
      label: T.pause,
      enabled: online,
      submenu: [
        { label: T.pause1h, click: () => void pauseFor(60) },
        { label: T.pauseTomorrow, click: () => void pauseFor('tomorrow') },
        { label: T.pauseForever, click: () => void pauseFor(null) },
      ],
    },
    {
      label: pauseUntil ? `${T.resume} (${T.pausedUntil} ${fmtClock(pauseUntil)})` : T.resume,
      enabled: online && paused,
      click: () => void resumeAll(),
    },
    { type: 'separator' },
    { label: T.quit, click: () => ((quitting = true), app.quit()) },
  ];
}

function updateTray(): void {
  const next = deriveTrayState(lastStatus, connection);
  const changed = next !== trayState;
  trayState = next;
  if (next === 'syncing' && !syncTimer && tray) {
    syncTimer = setInterval(() => {
      syncFrame = (syncFrame + 1) % SYNC_FRAMES;
      tray?.setImage(trayImage('syncing', syncFrame));
    }, 140);
  } else if (next !== 'syncing' && syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (!tray) return;
  if (changed) tray.setImage(trayImage(next, syncFrame));
  tray.setToolTip(`${t.appName} – ${T.state[next]}`);
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray(): void {
  tray = new Tray(trayImage(trayState));
  tray.setToolTip('Nucleon Sync');
  tray.on('click', () => toggleFlyout());
  updateTray();
}

// ------------------------------------------------------------------ daemon

async function apiCall<T>(method: string, p: string, body?: unknown): Promise<T> {
  try {
    return await getClient().request<T>(method, p, body);
  } catch (e) {
    if (e instanceof ApiRequestError) throw new Error(encodeApiError(e.status, e.body), { cause: e });
    client = null;
    throw new Error(encodeApiError(503, JSON.stringify({ error: (e as Error).message, code: 'internal' })), {
      cause: e,
    });
  }
}

function tomorrowMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d;
}

async function pauseFor(minutes: number | 'tomorrow' | null): Promise<void> {
  const until =
    minutes === null ? null : minutes === 'tomorrow' ? tomorrowMorning() : new Date(Date.now() + minutes * 60_000);
  await apiCall('POST', '/v1/pause', { scope: 'all', ...(until ? { until: until.toISOString() } : {}) });
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  pauseUntil = until ? until.toISOString() : null;
  if (until) {
    // the daemon may ignore `until` (see CHANGELOG-): the UI resumes itself while it runs
    pauseTimer = setTimeout(() => void resumeAll(), Math.max(0, until.getTime() - Date.now()));
  }
  broadcast(IPC.uiState, uiState());
  updateTray();
}

async function resumeAll(): Promise<void> {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  pauseUntil = null;
  broadcast(IPC.uiState, uiState());
  await apiCall('POST', '/v1/resume', { scope: 'all' });
}

function setConnection(c: ConnectionState): void {
  if (c === connection) return;
  connection = c;
  broadcast(IPC.connection, c);
  updateTray();
}

async function notify(n: Notice): Promise<void> {
  const now = Date.now();
  if ((recentNotices.get(n.key) ?? 0) > now - 10 * 60_000) return; // SSE replays / reconnects
  recentNotices.set(n.key, now);
  let desktop = true;
  try {
    desktop = (await getClient().request<SettingsDto>('GET', '/v1/settings')).notifications.desktop;
  } catch {
    /* settings endpoint not available yet -> default on */
  }
  if (!desktop) return;
  // texts of the service in the UI language (key + params), English text as fallback
  const title = daemonText(n.title, n.titleMsg);
  const body = daemonText(n.body, n.bodyMsg);
  testHook.notifications.push({ title, body });
  if (OFFSCREEN || SMOKE || !Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: appIcon() });
  notification.on('click', () => showMain(n.severity === 'info' ? 'overview' : 'issues'));
  notification.show();
}

function onDaemonEvent(ev: DaemonEvent): void {
  broadcast(IPC.event, ev);
  if (ev.type === 'hello' || ev.type === 'status') {
    lastStatus = ev.status;
    if (!ev.status.paused && pauseUntil) {
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = null;
      pauseUntil = null;
      broadcast(IPC.uiState, uiState());
    }
    if (ev.type === 'hello') setConnection('connected');
    updateTray();
  } else if (ev.type === 'conflicts_changed' && lastStatus) {
    lastStatus = { ...lastStatus, openConflicts: ev.open };
    updateTray();
  } else if (ev.type === 'deletions_changed' && lastStatus) {
    lastStatus = { ...lastStatus, pendingDeletions: ev.pending };
    updateTray();
  } else if (ev.type === 'notice') {
    void notify(ev.notice);
  } else if (ev.type === 'approval' && ev.approval.state === 'pending') {
    // an agent waits for the user's decision: the dashboard shows the dialog; a notification points there
    void notify({
      key: `approval:${ev.approval.id}`,
      severity: 'warn',
      title: T.approval(ev.approval.tokenName),
      body: ev.approval.summary.title,
    });
    if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send(IPC.navigate, 'settings');
  }
}

function connectEvents(): void {
  let unsub: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const retry = () => {
    if (quitting) return;
    timer = setTimeout(connect, 3000);
  };
  const connect = () => {
    timer = null;
    try {
      unsub = getClient().subscribe(onDaemonEvent, () => {
        unsub = null;
        setConnection('disconnected');
        retry();
      });
    } catch {
      client = null; // token file not there yet -> retry
      setConnection('disconnected');
      retry();
    }
  };
  connect();
  app.on('before-quit', () => {
    if (timer) clearTimeout(timer);
    unsub?.();
  });
}

// ------------------------------------------------------------------ IPC

function fromOwnUi(e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return (e.senderFrame?.url ?? '').startsWith('file://');
}

function registerIpc(): void {
  ipcMain.handle(IPC.request, async (e, method: unknown, p: unknown, body?: unknown) => {
    if (!fromOwnUi(e) || !isAllowedApiRequest(method, p)) throw new Error('blocked request');
    return apiCall(method as string, p as string, body);
  });
  ipcMain.handle(IPC.connectionState, () => connection);
  ipcMain.handle(IPC.getUiState, () => uiState());
  ipcMain.handle(IPC.pauseFor, async (e, minutes: unknown) => {
    if (!fromOwnUi(e)) throw new Error('blocked');
    if (minutes === 'resume') return resumeAll();
    if (minutes !== null && minutes !== 'tomorrow' && !(typeof minutes === 'number' && minutes > 0))
      throw new Error('bad duration');
    return pauseFor(minutes as number | 'tomorrow' | null);
  });
  /** only absolute paths inside a configured pair root (never anything else on the system) */
  const insidePairRoot = (p: unknown): string | null => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return null;
    const roots = (lastStatus?.pairs ?? []).map((x) => x.localRoot);
    const norm = path.normalize(p);
    return roots.some((r) => norm === r || norm.startsWith(r.endsWith('/') ? r : r + '/')) ? norm : null;
  };
  ipcMain.handle(IPC.showInFolder, async (e, p: unknown) => {
    const norm = fromOwnUi(e) ? insidePairRoot(p) : null;
    if (!norm) return false;
    shell.showItemInFolder(norm);
    return true;
  });
  ipcMain.handle(IPC.openPath, async (e, p: unknown) => {
    const norm = fromOwnUi(e) ? insidePairRoot(p) : null;
    if (!norm || !existsSync(norm)) return false;
    return (await shell.openPath(norm)) === '';
  });
  ipcMain.handle(IPC.openExternal, async (e, url: unknown) => {
    if (!fromOwnUi(e) || !isAllowedExternalUrl(url)) return false;
    await shell.openExternal(url as string);
    return true;
  });
  ipcMain.handle(IPC.copyText, (e, text: unknown) => {
    if (!fromOwnUi(e) || typeof text !== 'string' || text.length > 10_000) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(IPC.pickFolder, async (e, defaultPath: unknown) => {
    if (!fromOwnUi(e) || !win) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : os.homedir(),
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.on(IPC.openMain, (e, screenId: unknown) => {
    if (fromOwnUi(e)) showMain(typeof screenId === 'string' ? screenId : undefined);
  });
  ipcMain.on(IPC.closeFlyout, (e) => {
    if (fromOwnUi(e)) flyout?.hide();
  });
  ipcMain.handle(IPC.setup, async (e, op: unknown, args: unknown) => {
    if (!fromOwnUi(e) || !isSetupOp(op)) throw new Error('blocked');
    const c = setupContext();
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    switch (op) {
      case 'check':
        return checkSystem(c);
      case 'installCli':
        return installCli(c, (p) => e.sender.send(IPC.setupProgress, p));
      case 'configure':
        return writeDaemonConfig(c, { secretBackend: a.secretBackend === 'encfile' ? 'encfile' : 'libsecret' });
      case 'installService': {
        const r = installService(c, { autostart: a.autostart !== false });
        client = null; // the service writes the token on its first start: reconnect with it
        return r;
      }
      case 'suggest':
        return suggestPairs(c, checkSystem(c));
    }
  });
  ipcMain.handle(IPC.setPrefs, (e, patch: unknown) => {
    if (!fromOwnUi(e) || !patch || typeof patch !== 'object') throw new Error('blocked');
    const p = patch as Partial<UiPrefs>;
    if (p.language !== undefined) {
      if (!isLanguagePreference(p.language)) throw new Error('bad language');
      prefs = { ...prefs, language: p.language };
    }
    if (p.followTheme !== undefined) prefs = { ...prefs, followTheme: !!p.followTheme };
    savePrefs();
    applyLanguage();
    applyTheme();
    broadcast(IPC.uiState, uiState());
    return uiState();
  });
  ipcMain.on(IPC.smoke, (_e, data: unknown) => {
    if (!SMOKE) return;
    console.log('SMOKE_OK ' + JSON.stringify(data));
    quitting = true;
    app.exit(0);
  });
}

let themeWatching = false;

/** current Omarchy theme (name + colors.toml), null when not on Omarchy */
function readOmarchy(): { name: string; colors: Record<string, string> } | null {
  const home = os.homedir();
  for (const dir of OMARCHY_THEME_DIRS) {
    try {
      const colors = parseColorsToml(readFileSync(path.join(home, dir, 'colors.toml'), 'utf8'));
      let name = '';
      try {
        name = readFileSync(path.join(home, dir, '..', 'theme.name'), 'utf8').trim();
      } catch {
        name = path.basename(path.resolve(home, dir));
      }
      return { name: name || 'omarchy', colors };
    } catch {
      /* next layout */
    }
  }
  return null;
}

function applyTheme(): void {
  const kdeFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kdeglobals');
  const read = () => {
    try {
      return readFileSync(kdeFile, 'utf8');
    } catch {
      return null;
    }
  };
  const update = () => {
    themeState = resolveTheme(process.env, {
      kdeglobals: read(),
      omarchy: readOmarchy(),
      follow: prefs.followTheme,
    });
    nativeTheme.themeSource = themeState.mode;
    broadcast(IPC.uiState, uiState());
  };
  update();
  if (process.env.NUCLEON_SYNC_UI_THEME || themeWatching) return;
  themeWatching = true;
  let timer: NodeJS.Timeout | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 400);
  };
  // KDE rewrites kdeglobals; omarchy-theme-set replaces current/theme (rm + mv) and rewrites theme.name
  const watches: [string, (name: string | null) => boolean][] = [
    [path.dirname(kdeFile), (name) => name === 'kdeglobals'],
    ...OMARCHY_WATCH_DIRS.map(
      (d) => [path.join(os.homedir(), d), () => true] as [string, (name: string | null) => boolean],
    ),
  ];
  for (const [dir, match] of watches) {
    try {
      watch(dir, (_ev, name) => {
        if (match(name ? String(name) : null)) later();
      }).unref();
    } catch {
      /* not there (not KDE / not Omarchy) */
    }
  }
  // the GTK/portal colour scheme (system mode) is followed by Chromium itself; re-send so the UI can re-render
  nativeTheme.on('updated', () => broadcast(IPC.uiState, uiState()));
}

/** `--open` / `--open=SCREEN` in a command line (first start or a second instance) */
function openArg(argv: string[]): { open: boolean; screen?: string } {
  for (const a of argv) {
    if (a === '--open') return { open: true };
    if (a.startsWith('--open=')) return { open: true, screen: a.slice('--open='.length) };
  }
  return { open: false };
}

function hardenSessions(): void {
  // no permissions (camera, notifications from web content, ...) for any renderer
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  app.on('web-contents-created', (_e, wc) => {
    // never navigate away from the bundled UI or open new windows (no remote content in the app)
    wc.on('will-navigate', (ev) => ev.preventDefault());
    wc.on('will-redirect', (ev) => ev.preventDefault());
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

// tests/dev: isolated profile (single-instance lock, localStorage) per run
if (process.env.NUCLEON_SYNC_UI_USER_DATA) app.setPath('userData', process.env.NUCLEON_SYNC_UI_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => showMain(openArg(argv).screen));
  void app.whenReady().then(() => {
    loadPrefs();
    applyLanguage();
    applyTheme();
    hardenSessions();
    registerIpc();
    win = createWindow();
    if (SMOKE) {
      setTimeout(() => {
        console.error('SMOKE_FAIL timeout');
        app.exit(1);
      }, 30_000);
    } else if (!OFFSCREEN) {
      createTray();
    }
    if (OFFSCREEN) flyout = createFlyout();
    const first = openArg(process.argv);
    if (first.screen) win.webContents.once('did-finish-load', () => win?.webContents.send(IPC.navigate, first.screen));
    connectEvents();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
}
