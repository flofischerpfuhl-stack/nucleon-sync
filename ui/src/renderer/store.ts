// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Renderer state: one small external store fed by GET /v1/status + the SSE event stream (relayed by main).
 * Reconnect handling: main re-subscribes every 3 s; on `hello` the store replaces the status, re-fetches recent
 * activity and bumps `epoch` so screens re-fetch their data.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type {
  ApprovalDto,
  ActivityItemWithRun,
  ConfirmRequiredResponse,
  DaemonEvent,
  DaemonEventType,
  MsgRef,
  StatusDto,
} from '@nucleon-sync/shared';

import type { PauseDuration } from '../bridge.ts';
import type { ConnectionState, UiState } from '../common/ipc.ts';
import { api, fixtureMode, setFixtureMode } from './api.ts';
import { fixtures } from './dev/fixtures.ts';
import { ApiError, toApiError } from './errors.ts';
import { isLocale, setLocale, t, type Locale } from './i18n/index.ts';
import { daemonText } from './logic/daemonText.ts';
import { memoSelector } from './logic/memo.ts';
import { normalizeStatus } from './logic/normalize.ts';
import { applyTheme } from './logic/theme.ts';

export interface LoginState {
  phase: 'starting' | 'url' | 'done' | 'failed';
  signInUrl?: string;
  /** English text of the service (or a local error) */
  message?: string;
  /** key + params of message (shown in the UI language via daemonText) */
  msg?: MsgRef | null;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'info';
  text: string;
}

export interface ConfirmRequest {
  summary: ConfirmRequiredResponse['summary'];
  expiresAt: string | null;
  resolve: (ok: boolean) => void;
}

export interface ChoiceOption {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface ChoiceRequest {
  title: string;
  body: string;
  options: ChoiceOption[];
  resolve: (id: string | null) => void;
}

export interface StorageEventState {
  accountId: string;
  phase: 'start' | 'done' | 'failed';
  message?: string;
  n: number;
}

export interface State {
  connection: ConnectionState;
  status: StatusDto | null;
  recent: ActivityItemWithRun[];
  ui: UiState;
  /** bumped on (re)connect: screens re-fetch everything */
  epoch: number;
  /** per event type counter, screens re-fetch on the types they care about */
  seq: Partial<Record<DaemonEventType, number>>;
  login: Record<string, LoginState>;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  /** non-destructive multiple-choice dialog (unsaved changes) */
  choice: ChoiceRequest | null;
  navigate: { screen: string; n: number } | null;
  /** last SSE `storage` event (measurement progress) */
  storageEvent: StorageEventState | null;
  /** active UI language (the app re-renders when it changes) */
  locale: Locale;
  /** keyboard shortcut help overlay */
  helpOpen: boolean;
  /** agent approvals waiting for the user (SSE `approval`, GET /v1/approvals) */
  approvals: ApprovalDto[];
}

let state: State = {
  connection: 'connecting',
  status: null,
  recent: [],
  ui: { pauseUntil: null, fixtures: 'off' },
  epoch: 0,
  seq: {},
  login: {},
  toasts: [],
  confirm: null,
  choice: null,
  navigate: null,
  storageEvent: null,
  locale: 'en',
  helpOpen: false,
  approvals: [],
};
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Selected slice of the store; the snapshot is memoised (see logic/memo.ts), so selectors may build new objects. */
export function useStore<T>(selector: (s: State) => T): T {
  const memo = useRef<ReturnType<typeof memoSelector<State, T>> | null>(null);
  memo.current ??= memoSelector<State, T>();
  const m = memo.current;
  return useSyncExternalStore(subscribe, () => m(state, selector));
}

// ------------------------------------------------------------------ actions

let toastId = 0;
export function toast(kind: Toast['kind'], text: string): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'err' ? 8000 : 4500);
}

export function errorText(e: unknown): string {
  const err = toApiError(e);
  if (err.notImplemented) return t.errors.notImplemented;
  if (err.status === 503 || err.status === 0) return `${t.errors.unreachable}: ${err.message}`;
  return err.message || t.errors.generic;
}

export function toastError(e: unknown): void {
  toast('err', errorText(e));
}

export function askConfirm(
  summary: ConfirmRequiredResponse['summary'],
  expiresAt: string | null = null,
): Promise<boolean> {
  return new Promise((resolve) => {
    setState({
      confirm: {
        summary,
        expiresAt,
        resolve: (ok) => {
          setState({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}

/** Multiple-choice dialog; resolves the chosen option id, or null (Esc/backdrop). */
export function askChoice(req: Omit<ChoiceRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    setState({
      choice: {
        ...req,
        resolve: (id) => {
          setState({ choice: null });
          resolve(id);
        },
      },
    });
  });
}

// ------------------------------------------------------------------ leave guard (unsaved changes)

let leaveGuard: (() => Promise<boolean>) | null = null;

/** A screen with unsaved changes registers a guard; it decides (asks) whether the user may leave. */
export function setLeaveGuard(guard: (() => Promise<boolean>) | null): void {
  leaveGuard = guard;
}

/** true when the current screen may be left (no unsaved changes, or they were applied/discarded) */
export async function canLeave(): Promise<boolean> {
  return leaveGuard ? leaveGuard() : true;
}

/**
 * Confirm round-trip (ARCHITECTURE §6): call without token; on 409 + confirmToken show the daemon's summary and
 * repeat the same call with the token. Resolves `null` when the user cancels.
 */
export async function withConfirm<T>(fn: (confirmToken?: string) => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const err = toApiError(e);
    const c = err.confirm;
    if (!c) throw err;
    if (!(await askConfirm(c.summary, c.expiresAt))) return null;
    return fn(c.confirmToken);
  }
}

export async function refresh(): Promise<StatusDto | null> {
  try {
    const [raw, recent] = await Promise.all([api.status(), api.activity('limit=50')]);
    const status = normalizeStatus(raw);
    setState({ status, recent: Array.isArray(recent) ? recent : [] });
    return status;
  } catch (e) {
    if (e instanceof ApiError && e.status !== 503) toastError(e);
    return null;
  }
}

function bump(s: State, t: DaemonEventType): Partial<State> {
  return { seq: { ...s.seq, [t]: (s.seq[t] ?? 0) + 1 } };
}

export function handleEvent(ev: DaemonEvent): void {
  switch (ev.type) {
    case 'hello':
      setState((s) => ({ status: normalizeStatus(ev.status), connection: 'connected', epoch: s.epoch + 1 }));
      void loadApprovals();
      void api
        .activity('limit=50')
        .then((recent) => setState({ recent: Array.isArray(recent) ? recent : [] }))
        .catch(() => undefined);
      return;
    case 'status':
      setState({ status: normalizeStatus(ev.status) });
      return;
    case 'activity':
      setState((s) => ({
        recent: s.recent.some((x) => x.id === ev.item.id) ? s.recent : [ev.item, ...s.recent].slice(0, 200),
        ...bump(s, 'activity'),
      }));
      return;
    case 'account':
      setState((s) => ({
        ...bump(s, 'account'),
        status: s.status && {
          ...s.status,
          accounts: s.status.accounts.map((a) =>
            a.id === ev.accountId
              ? {
                  ...a,
                  status: ev.status,
                  ...(ev.message ? { lastError: ev.message, lastErrorMsg: ev.msg ?? null } : {}),
                }
              : a,
          ),
        },
      }));
      return;
    case 'login':
      setState((s) => ({
        ...bump(s, 'login'),
        login: {
          ...s.login,
          [ev.accountId]: {
            phase: ev.phase,
            signInUrl: ev.signInUrl ?? s.login[ev.accountId]?.signInUrl,
            ...(ev.message ? { message: ev.message } : {}),
            ...(ev.msg ? { msg: ev.msg } : {}),
          },
        },
      }));
      return;
    case 'conflicts_changed':
      setState((s) => ({
        ...bump(s, 'conflicts_changed'),
        status: s.status && { ...s.status, openConflicts: ev.open },
      }));
      return;
    case 'deletions_changed':
      setState((s) => ({
        ...bump(s, 'deletions_changed'),
        status: s.status && { ...s.status, pendingDeletions: ev.pending },
      }));
      return;
    case 'notice':
      if (ev.notice.severity !== 'info')
        toast(ev.notice.severity === 'error' ? 'err' : 'info', daemonText(ev.notice.title, ev.notice.titleMsg));
      setState((s) => bump(s, 'notice'));
      return;
    case 'storage':
      setState((s) => ({
        ...bump(s, 'storage'),
        storageEvent: {
          accountId: ev.accountId,
          phase: ev.phase,
          ...(ev.message ? { message: ev.message } : {}),
          n: (s.storageEvent?.n ?? 0) + 1,
        },
      }));
      return;
    case 'run':
    case 'job':
      setState((s) => bump(s, ev.type));
      return;
    case 'approval':
      setState((s) => ({
        ...bump(s, 'approval'),
        approvals:
          ev.approval.state === 'pending'
            ? [ev.approval, ...s.approvals.filter((a) => a.id !== ev.approval.id)]
            : s.approvals.filter((a) => a.id !== ev.approval.id),
      }));
      return;
    default:
      return; // heartbeat and unknown future events
  }
}

/** language + theme from main; the locale switch happens before the state update so the re-render uses it */
export function applyUiState(u: UiState): void {
  const loc = isLocale(u.language?.locale) ? u.language.locale : 'en';
  setLocale(loc);
  document.documentElement.lang = loc;
  applyTheme(u.theme);
  setState({ ui: u, locale: loc });
}

/** open agent approvals (UI token only; older daemons answer 404) */
export async function loadApprovals(): Promise<void> {
  try {
    const l = await api.approvals();
    setState({ approvals: Array.isArray(l) ? l.filter((a) => a.state === 'pending') : [] });
  } catch {
    /* not available */
  }
}

let started = false;
export async function initStore(): Promise<void> {
  if (started) return;
  started = true;
  const b = window.nucleonSync;
  const ui = await b.uiState();
  setFixtureMode(ui.fixtures);
  applyUiState(ui);
  b.onUiState(applyUiState);
  b.onNavigate((screen) => setState((s) => ({ navigate: { screen, n: (s.navigate?.n ?? 0) + 1 } })));
  if (fixtureMode() !== 'off') fixtures.onEvent(handleEvent);
  if (fixtureMode() === 'demo') {
    setState({ connection: 'connected' });
  } else {
    b.onEvent(handleEvent);
    b.onConnection((c) => {
      setState((s) => ({ connection: c, ...(c === 'connected' ? { epoch: s.epoch + 1 } : {}) }));
      if (c === 'connected') void refresh();
    });
    const c = await b.connectionState();
    setState((s) => (s.connection === 'connecting' ? { connection: c } : {}));
  }
  await refresh();
}

// ------------------------------------------------------------------ data hook

export interface ApiData<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount, on (re)connect and whenever one of the given event types arrives. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[], refetchOn: DaemonEventType[] = []): ApiData<T> {
  const epoch = useStore((s) => s.epoch);
  const seqKey = useStore((s) => refetchOn.map((t) => s.seq[t] ?? 0).join(','));
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(toApiError(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [epoch, seqKey, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}

/** Global pause with duration ('resume' resumes). Demo fixtures are handled in the renderer, otherwise main. */
export async function pauseFor(d: PauseDuration): Promise<void> {
  try {
    if (fixtureMode() !== 'demo') return await window.nucleonSync.pauseFor(d);
    if (d === 'resume') {
      await api.resume({ scope: 'all' });
      setState((s) => ({ ui: { ...s.ui, pauseUntil: null } }));
      return;
    }
    let until: Date | null = null;
    if (typeof d === 'number') until = new Date(Date.now() + d * 60_000);
    if (d === 'tomorrow') {
      until = new Date();
      until.setDate(until.getDate() + 1);
      until.setHours(7, 0, 0, 0);
    }
    await api.pause({ scope: 'all', ...(until ? { until: until.toISOString() } : {}) });
    setState((s) => ({ ui: { ...s.ui, pauseUntil: until ? until.toISOString() : null } }));
  } catch (e) {
    toastError(e);
  }
}

export function goTo(screen: string): void {
  setState((s) => ({ navigate: { screen, n: (s.navigate?.n ?? 0) + 1 } }));
}
