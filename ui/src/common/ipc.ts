// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * IPC contract between Electron main and the sandboxed renderer (pure, no Electron imports; unit-tested).
 * The renderer never sees the API token; it can only ask main to call allow-listed `/v1/` endpoints.
 */

export const IPC = {
  request: 'ps:request',
  event: 'ps:event',
  connection: 'ps:connection',
  connectionState: 'ps:connection-state',
  uiState: 'ps:ui-state',
  navigate: 'ps:navigate',
  getUiState: 'ps:get-ui-state',
  pauseFor: 'ps:pause-for',
  showInFolder: 'ps:show-in-folder',
  openPath: 'ps:open-path',
  openExternal: 'ps:open-external',
  copyText: 'ps:copy-text',
  pickFolder: 'ps:pick-folder',
  openMain: 'ps:open-main',
  closeFlyout: 'ps:close-flyout',
  smoke: 'ps:smoke',
  setup: 'ps:setup',
  setupProgress: 'ps:setup-progress',
  setPrefs: 'ps:set-prefs',
} as const;

/** UI preferences stored by the main process (userData/ui-prefs.json) */
export interface UiPrefs {
  /** 'system' = OS language list, else a locale id of i18n/index.ts */
  language: string;
  /** follow the desktop theme (Omarchy colours, KDE, system light/dark) or keep the built-in palette */
  followTheme: boolean;
}

/** what the renderer applies: CSS variables (Omarchy) or nothing (built-in palette + light/dark) */
export interface ThemeState {
  source: 'omarchy' | 'kde' | 'system' | 'env';
  /** Omarchy theme name */
  name: string | null;
  mode: 'dark' | 'light' | 'system';
  vars: Record<string, string> | null;
}

/** first-run setup operations main performs for the wizard (allow-list) */
export const SETUP_OPS = ['check', 'installCli', 'configure', 'installService', 'suggest'] as const;
export type SetupOp = (typeof SETUP_OPS)[number];
export const isSetupOp = (v: unknown): v is SetupOp =>
  typeof v === 'string' && (SETUP_OPS as readonly string[]).includes(v);

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** State owned by the main process that the renderer displays (timed pause lives in main, see CHANGELOG-). */
export interface UiState {
  /** ISO time until which a timed pause lasts (main resumes automatically), null = no timed pause */
  pauseUntil: string | null;
  fixtures: 'off' | 'fallback' | 'demo';
  /** first-run wizard: offered by the packaged app (or forced with NUCLEON_SYNC_UI_SETUP=1) */
  setup?: { packaged: boolean; force: boolean; appVersion: string };
  /** active language (`locale`), the stored preference and the OS languages (agent-omarchy; additive) */
  language?: { preference: string; locale: string; system: string };
  theme?: ThemeState;
  prefs?: UiPrefs;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** `/v1/` + path segments of safe characters + optional query string. No `..`, no encoded slashes, no host. */
const PATH_RE = /^\/v1\/[A-Za-z0-9_\-/.]*(\?[A-Za-z0-9_\-.~%=&+,:/]*)?$/;

export function isAllowedApiRequest(method: unknown, path: unknown): boolean {
  if (typeof method !== 'string' || typeof path !== 'string') return false;
  if (!METHODS.has(method)) return false;
  if (path.length > 2048 || !PATH_RE.test(path)) return false;
  const pathname = path.split('?')[0]!;
  if (pathname.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  if (/%2f|%5c|%2e/i.test(pathname)) return false; // encoded separators/dots only matter in the path part
  return true;
}

/** Allowed targets for shell.openExternal (login links, Proton web app). */
export function isAllowedExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'proton.me' || u.hostname.endsWith('.proton.me'));
  } catch {
    return false;
  }
}

/** API errors cross the IPC boundary as an Error message `PSAPI <status> <body>` (Electron only keeps messages). */
export function encodeApiError(status: number, body: string): string {
  return `PSAPI ${status} ${body}`;
}

export function decodeApiError(message: string): { status: number; body: string } | null {
  const m = /PSAPI (\d{3}) ([\s\S]*)$/.exec(message);
  return m ? { status: Number(m[1]), body: m[2]! } : null;
}
