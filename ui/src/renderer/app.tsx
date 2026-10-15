// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Renderer entry (React 19). Main window: sidebar navigation + header status line + screens (docs/SYNC-RULES.md–4.8).
 * `#flyout`: the tray flyout. State: store.ts (status + SSE). UI language: i18n/index.ts (English default, German;
 * follows the system or Settings → Language; the tree re-mounts on a switch). Keyboard: global shortcuts below,
 * `?` shows them (HelpHost in components/Overlays.tsx).
 */
import { Component, StrictMode, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import '../bridge.ts';
import { Icon, type IconName } from './components/Icon.tsx';
import { isTyping, KEY_EVENTS } from './components/a11y.ts';
import { ApprovalHost, ChoiceHost, ConfirmHost, HelpHost, ToastHost } from './components/Overlays.tsx';
import { Button, Dot, PauseControl, Spinner } from './components/ui.tsx';
import { t } from './i18n/index.ts';
import { isScreen, screenOr, type Screen } from './logic/screens.ts';
import { globalStatus } from './logic/status.ts';
import { Accounts } from './screens/Accounts.tsx';
import { Activity } from './screens/Activity.tsx';
import { Flyout } from './screens/Flyout.tsx';
import { Folders } from './screens/Folders.tsx';
import { Issues } from './screens/Issues.tsx';
import { Maintenance } from './screens/Maintenance.tsx';
import { Overview } from './screens/Overview.tsx';
import { Setup, setupDone } from './screens/Setup.tsx';
import { Settings } from './screens/Settings.tsx';
import { Storage } from './screens/Storage.tsx';
import { api } from './api.ts';
import { canLeave, getState, initStore, pauseFor, refresh, setState, toastError, useStore } from './store.ts';

export type { Screen };
const NAV: { id: Screen; icon: IconName }[] = [
  { id: 'overview', icon: 'overview' },
  { id: 'activity', icon: 'activity' },
  { id: 'folders', icon: 'folder' },
  { id: 'issues', icon: 'issues' },
  { id: 'storage', icon: 'storage' },
  { id: 'accounts', icon: 'accounts' },
  { id: 'settings', icon: 'settings' },
  { id: 'maintenance', icon: 'maintenance' },
];
const SCREENS: Record<Screen, () => React.JSX.Element> = {
  overview: Overview,
  activity: Activity,
  folders: Folders,
  issues: Issues,
  storage: Storage,
  accounts: Accounts,
  settings: Settings,
  maintenance: Maintenance,
};

function initialScreen(): Screen {
  try {
    return screenOr(localStorage.getItem('ps.screen'));
  } catch {
    return 'overview'; // storage unavailable
  }
}

function persistScreen(screen: Screen): void {
  try {
    localStorage.setItem('ps.screen', screen);
  } catch {
    /* ignore */
  }
}

/**
 * Catches render errors of one screen: the app falls back to the overview with a small notice instead of a blank
 * window, and the persisted screen is reset so the next start does not crash again.
 */
class ScreenBoundary extends Component<
  { screen: Screen; onCrash: (screen: Screen, error: Error) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`screen "${this.props.screen}" crashed`, error, info.componentStack);
    this.props.onCrash(this.props.screen, error);
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** test hook (fixture mode only): makes one screen throw while rendering, see dev/fixtures.ts `crashScreen` */
function CrashProbe({ screen }: { screen: Screen }) {
  const crash = (window as unknown as { __psCrashScreen?: string }).__psCrashScreen;
  if (crash === screen) throw new Error(`test crash of ${screen}`);
  return null;
}

function App() {
  const [screen, setScreenRaw] = useState<Screen>(initialScreen);
  const [crashed, setCrashed] = useState<Screen | null>(null);
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.connection);
  const ui = useStore((s) => s.ui);
  const navigate = useStore((s) => s.navigate);
  /** every screen change goes through the leave guard (unsaved selection changes are never dropped silently) */
  const setScreen = useCallback(
    async (next: Screen) => {
      if (next === screen) return;
      if (!(await canLeave())) return;
      setCrashed(null);
      setScreenRaw(next);
    },
    [screen],
  );
  useEffect(() => {
    if (navigate && isScreen(navigate.screen)) void setScreen(navigate.screen);
    // only react to new navigation requests (setScreen changes with every screen)
  }, [navigate]);
  useEffect(() => persistScreen(screen), [screen]);
  // global keyboard shortcuts (not while typing, not under a dialog); `?` toggles the help
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = getState();
      if (e.defaultPrevented || st.confirm || st.choice) return;
      if (e.key === '?' && !isTyping(e.target)) {
        e.preventDefault();
        setState({ helpOpen: !st.helpOpen });
        return;
      }
      if (st.helpOpen || st.approvals.length) return;
      const ctrlF = e.ctrlKey && !e.altKey && (e.key === 'f' || e.key === 'F');
      if (ctrlF || (e.key === '/' && !isTyping(e.target) && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        if (screenRef.current !== 'activity') void setScreen('activity');
        // the activity screen focuses its search box (also right after mounting)
        setTimeout(() => window.dispatchEvent(new Event(KEY_EVENTS.search)), 0);
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        void refresh();
        setState((x) => ({ epoch: x.epoch + 1 }));
        return;
      }
      if (e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (digit && !e.shiftKey) {
        const target = NAV[Number(digit) - 1];
        if (target) {
          e.preventDefault();
          void setScreen(target.id);
        }
        return;
      }
      if (e.altKey || e.shiftKey) return;
      const online = st.connection === 'connected';
      switch (e.key.toLowerCase()) {
        case 's':
          if (!online || st.status?.paused) return;
          e.preventDefault();
          void api.sync({}).catch(toastError);
          return;
        case 'p':
          if (!online) return;
          e.preventDefault();
          void pauseFor(st.status?.paused ? 'resume' : null);
          return;
        case 'n':
          e.preventDefault();
          if (screenRef.current !== 'folders') void setScreen('folders');
          setTimeout(() => window.dispatchEvent(new Event(KEY_EVENTS.newPair)), 0);
          return;
        case 'r':
          e.preventDefault();
          void refresh();
          setState((x) => ({ epoch: x.epoch + 1 }));
          return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setScreen]);
  const onCrash = useCallback((s: Screen) => {
    persistScreen('overview');
    setCrashed(s);
    setScreenRaw('overview');
  }, []);
  const g = globalStatus(status, connection, ui.pauseUntil);
  const issues = (status?.openConflicts ?? 0) + (status?.pendingDeletions ?? 0);
  const loginNeeded =
    status?.accounts.filter((a) => a.status === 'needs_login' || a.status === 'needs_keyring').length ?? 0;
  const Current = SCREENS[screen];
  // first-run wizard (packaged app): latched once shown, until the user finished it
  const [wizard, setWizard] = useState(false);
  const offer =
    !!(ui.setup?.packaged || ui.setup?.force) &&
    ui.fixtures === 'off' &&
    !setupDone() &&
    connection !== 'connecting' &&
    !(connection === 'connected' && (status?.accounts.length ?? 0) > 0);
  useEffect(() => {
    if (offer) setWizard(true);
  }, [offer]);
  if (wizard)
    return (
      <div className="app app-setup">
        <Setup onFinish={() => setWizard(false)} />
        <ToastHost />
      </div>
    );
  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        {t.keys.skipToContent}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="logo" size={22} />
          </span>
          <span className="brand-name">{t.appName}</span>
        </div>
        {ui.fixtures !== 'off' || status?.mode === 'mock' ? (
          <div className="mode-chip">
            {ui.fixtures === 'demo' ? t.shell.demo : status?.mode === 'mock' ? t.shell.mock : t.shell.fixtures}
          </div>
        ) : null}
        <nav className="nav" aria-label="Navigation">
          {NAV.map((n, i) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item${screen === n.id ? ' active' : ''}`}
              aria-current={screen === n.id ? 'page' : undefined}
              aria-keyshortcuts={String(i + 1)}
              title={`${t.nav[n.id]} (${i + 1})`}
              onClick={() => void setScreen(n.id)}
              data-nav={n.id}
            >
              <Icon name={n.icon} size={20} />
              <span className="nav-label">{t.nav[n.id]}</span>
              {n.id === 'issues' && issues > 0 ? (
                <span className="badge" data-testid="issues-badge">
                  {issues}
                </span>
              ) : null}
              {n.id === 'accounts' && loginNeeded > 0 ? <span className="badge warn">{loginNeeded}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <PauseControl paused={!!status?.paused} disabled={connection !== 'connected'} />
          <div className="muted small">{status ? t.shell.version(status.daemonVersion) : ''}</div>
          <button
            type="button"
            className="link-btn small help-link"
            aria-keyshortcuts="?"
            aria-label={t.keys.title}
            title={`${t.keys.title} (?)`}
            onClick={() => setState({ helpOpen: true })}
            data-testid="open-help"
          >
            <span className="help-label">{t.keys.title} </span>
            <span className="help-key">(?)</span>
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <h1>{t.nav[screen]}</h1>
          <div className={`statusline tone-${g.tone}`} data-testid="statusline" data-state={g.state}>
            <Dot tone={g.tone} pulse={g.state === 'syncing'} />
            <span className="statusline-title">{g.title}</span>
            {g.detail && connection === 'connected' ? <span className="statusline-detail">· {g.detail}</span> : null}
          </div>
        </header>
        {connection === 'disconnected' ? (
          <div className="banner" role="alert" data-testid="disconnect-banner">
            <Spinner />
            <div>
              <b>{t.shell.disconnected}</b>
              <div className="small">{t.shell.disconnectedHint}</div>
            </div>
          </div>
        ) : null}
        {crashed ? (
          <div className="banner banner-warn" role="status" data-testid="screen-crashed">
            <Icon name="warn" size={18} />
            <span className="grow">{t.shell.screenCrashed(t.nav[crashed])}</span>
            <Button small variant="ghost" onClick={() => void setScreen(crashed)}>
              {t.shell.screenCrashedRetry}
            </Button>
            <button type="button" className="icon-btn" aria-label={t.actions.close} onClick={() => setCrashed(null)}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : null}
        <main id="main" tabIndex={-1} className={`screen screen-${screen}`}>
          <ScreenBoundary key={screen} screen={screen} onCrash={onCrash}>
            {ui.fixtures !== 'off' ? <CrashProbe screen={screen} /> : null}
            <Current />
          </ScreenBoundary>
        </main>
      </div>
      <ConfirmHost />
      <ChoiceHost />
      <ApprovalHost />
      <HelpHost screens={NAV.map((n) => n.id)} />
      <ToastHost />
    </div>
  );
}

/** re-mounts the UI when the language changes (strings are read at render time from the live `t`) */
function Root({ children }: { children: ReactNode }) {
  const locale = useStore((s) => s.locale);
  return (
    <div key={locale} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

function FlyoutRoot() {
  return (
    <>
      <Flyout />
      <ToastHost />
    </>
  );
}

void initStore().then(() => {
  const s = getState().status;
  if (s) window.nucleonSync.smokeReport({ mode: s.mode, accounts: s.accounts.map((x) => x.id), pairs: s.pairs.length });
});

const isFlyout = location.hash === '#flyout';
document.documentElement.dataset.view = isFlyout ? 'flyout' : 'main';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root>{isFlyout ? <FlyoutRoot /> : <App />}</Root>
  </StrictMode>,
);
