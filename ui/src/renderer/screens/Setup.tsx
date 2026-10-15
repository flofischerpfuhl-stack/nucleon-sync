// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * First-run wizard of the packaged app: system check -> official Proton Drive CLI (found on PATH, or a SHA-512 verified
 * download from proton.me) -> session store (keyring or encrypted file) -> background service + tray autostart
 * (explicit consent) -> login via URL/QR (with Proton's third-party notice) -> folder pairs and directions (nothing is
 * pre-selected) -> schedule and notifications -> first sync. System steps run in the Electron main process
 * (`window.nucleonSync.setup`), everything else through the daemon API like the rest of the app.
 */
import { useEffect, useState } from 'react';

import type { AccountDto, PairDirection, RemoteBrowseEntry, SettingsDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { Button, Checkbox, Pill, Progress, Spinner } from '../components/ui.tsx';
import { section, t } from '../i18n/index.ts';
import { errorText, useStore } from '../store.ts';
import { LoginPanel } from './Accounts.tsx';

/** subset of SystemCheck (ui/src/main/setup.ts) the wizard shows */
interface SystemCheck {
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
  service: { installed: boolean; managedByApp: boolean; active: boolean };
  folders: { documents: string | null; pictures: string | null; desktop: string | null };
}

interface ServiceResult {
  steps: { cmd: string; ok: boolean; output: string }[];
  skipped?: string;
}

interface PairDraft {
  on: boolean;
  name: string;
  localRoot: string;
  remoteRoot: string;
  direction: PairDirection;
}

const S = section('setup');
const STEPS = ['check', 'cli', 'keyring', 'service', 'login', 'folders', 'prefs', 'done'] as const;
type Step = (typeof STEPS)[number];

export function markSetupDone(): void {
  try {
    localStorage.setItem('ps.setupDone', '1');
  } catch {
    /* ignore */
  }
}

export function setupDone(): boolean {
  try {
    return localStorage.getItem('ps.setupDone') === '1';
  } catch {
    return false;
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'account';

export function Setup({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState<Step>('check');
  const [sys, setSys] = useState<SystemCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cliProgress, setCliProgress] = useState<{ phase: string; bytes?: number; total?: number } | null>(null);
  const [secretBackend, setSecretBackend] = useState<'libsecret' | 'encfile'>('libsecret');
  const [encConsent, setEncConsent] = useState(false);
  const [serviceConsent, setServiceConsent] = useState(true);
  const [autostart, setAutostart] = useState(true);
  const [service, setService] = useState<ServiceResult | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PairDraft[]>([]);
  const [devices, setDevices] = useState<RemoteBrowseEntry[]>([]);
  const [created, setCreated] = useState<string[]>([]);
  const [cliRelease, setCliRelease] = useState<{ version: string; tested: boolean; pinned: boolean } | null>(null);
  const [prefs, setPrefs] = useState({
    incrementalHours: 6,
    fullEveryWeeks: 4,
    desktop: true,
    telegram: false,
    chatId: '',
    botToken: '',
  });
  const connection = useStore((s) => s.connection);
  const status = useStore((s) => s.status);
  const login = useStore((s) => (accountId ? s.login[accountId] : undefined));
  const account: AccountDto | undefined = status?.accounts.find((a) => a.id === accountId);
  const idx = STEPS.indexOf(step);

  const check = async () => {
    setErr(null);
    try {
      const s = await window.nucleonSync.setup<SystemCheck>('check');
      setSys(s);
      setSecretBackend(s.keyring.recommended);
      setDisplayName((d) => d || s.user.charAt(0).toUpperCase() + s.user.slice(1));
    } catch (e) {
      setErr(errorText(e));
    }
  };
  useEffect(() => {
    void check();
    return window.nucleonSync.onSetupProgress((p) => setCliProgress(p as typeof cliProgress));
  }, []);
  // an existing account (setup re-opened) is reused
  useEffect(() => {
    if (!accountId && status?.accounts.length) setAccountId(status.accounts[0]!.id);
  }, [status?.accounts.length]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const installCli = () =>
    run(async () => {
      setCliRelease(
        await window.nucleonSync.setup<{ version: string; tested: boolean; pinned: boolean }>('installCli'),
      );
      await check();
    });

  const installService = () =>
    run(async () => {
      await window.nucleonSync.setup('configure', { secretBackend });
      const r = await window.nucleonSync.setup<ServiceResult>('installService', { autostart });
      setService(r);
      if (r.steps.some((x) => !x.ok)) throw new Error(S.serviceFailed);
      await check();
    });

  const startLogin = () =>
    run(async () => {
      let id = accountId;
      if (!id) {
        id = slug(sys?.user ?? displayName);
        await api.createAccount(id, displayName.trim() || id);
        setAccountId(id);
      }
      await api.login(id);
    });

  const loadFolders = async () => {
    if (!accountId || !sys) return;
    let devs: RemoteBrowseEntry[] = [];
    try {
      devs = (await api.browse(accountId, '/devices')).filter((d) => d.type === 'folder');
    } catch {
      /* no devices */
    }
    setDevices(devs);
    const own = devs.find((d) => d.name.toLowerCase() === sys.hostname.toLowerCase());
    const sugg = await window.nucleonSync.setup<{ name: string; localRoot: string; remoteRoot: string }[]>('suggest');
    // suggestions only: nothing is selected until the user ticks a folder
    setDrafts(
      sugg.map((p) => ({
        on: false,
        name: p.name,
        localRoot: p.localRoot,
        // a Proton "device" with this computer's name exists (e.g. from the Windows app): use it
        remoteRoot: own
          ? `/devices/${own.name}/${p.name === 'Bilder' || p.name === 'Pictures' ? 'Pictures' : 'Documents'}`
          : p.remoteRoot,
        direction: 'backup',
      })),
    );
  };
  useEffect(() => {
    if (step === 'folders' && !drafts.length) void loadFolders();
  }, [step]);

  const createPairs = () =>
    run(async () => {
      const done: string[] = [];
      for (const d of drafts.filter((x) => x.on)) {
        await api.createPair({
          accountId: accountId!,
          name: d.name,
          localRoot: d.localRoot,
          remoteRoot: d.remoteRoot,
          direction: d.direction,
          enabled: true,
          createRemote: true,
        });
        done.push(`${d.localRoot} ⇄ ${d.remoteRoot}`);
      }
      setCreated(done);
      setStep('prefs');
    });

  const savePrefs = () =>
    run(async () => {
      const patch: Partial<SettingsDto> = {
        schedule: {
          incrementalEveryMinutes: prefs.incrementalHours * 60,
          fullEveryWeeks: prefs.fullEveryWeeks,
        } as SettingsDto['schedule'],
        notifications: {
          desktop: prefs.desktop,
          telegram: { enabled: prefs.telegram, chatId: prefs.chatId.trim() },
        } as SettingsDto['notifications'],
      };
      if (prefs.telegram && prefs.botToken.trim()) await api.setTelegramToken(prefs.botToken.trim());
      await api.putSettings(patch);
      setStep('done');
    });

  const finish = () =>
    run(async () => {
      await api.sync({});
      markSetupDone();
      onFinish();
    });

  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)]!);
  const ok = (v: boolean, warn = false) => (
    <Pill tone={v ? 'ok' : warn ? 'warn' : 'err'}>{v ? '✓' : warn ? '!' : '✕'}</Pill>
  );

  const canNext: Record<Step, boolean> = {
    check: !!sys,
    cli: !!sys?.cli.present,
    keyring: secretBackend === 'libsecret' ? sys?.keyring.recommended === 'libsecret' : encConsent,
    service: connection === 'connected',
    login: account?.status === 'ok',
    folders: false,
    prefs: false,
    done: false,
  };

  return (
    <div className="setup" data-testid="setup">
      <header className="setup-head">
        <span className="brand-mark">
          <Icon name="logo" size={26} />
        </span>
        <div>
          <h1>{S.title}</h1>
          <div className="muted">{S.subtitle}</div>
        </div>
      </header>
      <ol className="setup-steps" aria-label={S.stepsLabel}>
        {STEPS.map((s, i) => (
          <li key={s} className={i === idx ? 'on' : i < idx ? 'done' : ''}>
            <span className="setup-num">{i < idx ? <Icon name="check" size={14} /> : i + 1}</span>
            {S.steps[s]}
          </li>
        ))}
      </ol>
      <section className="card setup-card" data-testid={`setup-step-${step}`}>
        {step === 'check' ? (
          <>
            <h2>{S.checkTitle}</h2>
            <p className="muted">{S.checkIntro}</p>
            {!sys ? (
              <div className="loading-line">
                <Spinner /> {S.checking}
              </div>
            ) : (
              <table className="setup-table">
                <tbody>
                  <tr>
                    <td>{ok(sys.cli.present, true)}</td>
                    <td>{S.cliRow}</td>
                    <td className="muted">
                      {sys.cli.present ? S.cliFound(sys.cli.version ?? '?', sys.cli.path) : S.cliMissing}
                    </td>
                  </tr>
                  <tr>
                    <td>{ok(sys.keyring.recommended === 'libsecret', true)}</td>
                    <td>{S.keyringRow}</td>
                    <td className="muted">
                      {sys.keyring.secretService === 'none'
                        ? S.keyringNone
                        : !sys.keyring.secretTool
                          ? S.keyringNoTool
                          : S.keyringOk(sys.keyring.secretService === 'running')}
                    </td>
                  </tr>
                  <tr>
                    <td>{ok(sys.systemd)}</td>
                    <td>{S.systemdRow}</td>
                    <td className="muted">{sys.systemd ? S.systemdOk : S.systemdMissing}</td>
                  </tr>
                  <tr>
                    <td>{ok(true)}</td>
                    <td>{S.sessionRow}</td>
                    <td className="muted">
                      {S.sessionText(sys.session.type, sys.session.desktop || '–', sys.session.hyprland)}
                    </td>
                  </tr>
                  <tr>
                    <td>{ok(sys.tray.watcher, true)}</td>
                    <td>{S.trayRow}</td>
                    <td className="muted">{sys.tray.watcher ? S.trayOk : S.trayMissing(sys.session.hyprland)}</td>
                  </tr>
                  <tr>
                    <td>{ok(sys.install.kind !== 'dev', true)}</td>
                    <td>{S.installRow}</td>
                    <td className="muted">{S.installKind[sys.install.kind]}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        ) : null}

        {step === 'cli' && sys ? (
          <>
            <h2>{S.cliTitle}</h2>
            <p className="muted">{S.cliIntro}</p>
            {sys.cli.present ? (
              <>
                <div className="tone-ok setup-ok" data-testid="cli-present">
                  <Icon name="check" size={18} /> {S.cliFound(sys.cli.version ?? '?', sys.cli.path)}
                </div>
                {cliRelease ? (
                  <p className="muted small" data-testid="cli-verified">
                    {S.cliVerified(cliRelease.version, cliRelease.pinned)}
                    {cliRelease.tested ? '' : ` ${S.cliUntested}`}
                  </p>
                ) : !sys.cli.path.endsWith('/.local/bin/proton-drive') ? (
                  <p className="muted small">{S.cliFromPath}</p>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  icon="down"
                  busy={busy}
                  onClick={() => void installCli()}
                  data-testid="install-cli"
                >
                  {S.cliInstall}
                </Button>
                {cliProgress && busy ? (
                  <div className="setup-progress">
                    <Progress
                      value={cliProgress.total ? (cliProgress.bytes ?? 0) / cliProgress.total : 0}
                      indeterminate={!cliProgress.total}
                      tone="info"
                    />
                    <span className="muted">{S.cliPhase[cliProgress.phase as keyof typeof S.cliPhase] ?? ''}</span>
                  </div>
                ) : null}
              </>
            )}
            <p className="muted small">{S.cliNote}</p>
          </>
        ) : null}

        {step === 'keyring' && sys ? (
          <>
            <h2>{S.keyringTitle}</h2>
            {sys.keyring.recommended === 'libsecret' ? (
              <>
                <p>{S.keyringIntroOk}</p>
                <div className="choice-list">
                  {(['libsecret', 'encfile'] as const).map((b) => (
                    <button
                      key={b}
                      type="button"
                      className={`choice${secretBackend === b ? ' on' : ''}`}
                      onClick={() => setSecretBackend(b)}
                    >
                      <Icon name={b === 'libsecret' ? 'key' : 'file'} size={22} />
                      <span>
                        <b>{S.backend[b]}</b>
                        <span className="muted small">{S.backendHelp[b]}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {secretBackend === 'encfile' ? (
                  <label className="field-inline setup-consent">
                    <Checkbox state={encConsent} onChange={() => setEncConsent((v) => !v)} label={S.encConsent} />
                    <span>{S.encConsent}</span>
                  </label>
                ) : null}
              </>
            ) : (
              <>
                <div className="banner banner-warn" role="status">
                  <Icon name="warn" size={18} />
                  <div>
                    <b>{sys.keyring.secretService === 'none' ? S.noKeyringTitle : S.noToolTitle}</b>
                    <div className="small">{sys.keyring.secretService === 'none' ? S.noKeyringText : S.noToolText}</div>
                    <div className="mono small">{S.keyringInstallCmd}</div>
                  </div>
                </div>
                <div className="row">
                  <Button icon="refresh" onClick={() => void check()}>
                    {S.recheck}
                  </Button>
                </div>
                <label className="field-inline setup-consent">
                  <Checkbox
                    state={encConsent}
                    onChange={() => {
                      setSecretBackend('encfile');
                      setEncConsent((v) => !v);
                    }}
                    label={S.encConsent}
                  />
                  <span>{S.encConsent}</span>
                </label>
                <p className="muted small">{S.backendHelp.encfile}</p>
              </>
            )}
          </>
        ) : null}

        {step === 'service' && sys ? (
          <>
            <h2>{S.serviceTitle}</h2>
            <p>{S.serviceIntro}</p>
            <ul className="setup-list muted">
              {S.serviceWhat.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <label className="field-inline setup-consent">
              <Checkbox state={serviceConsent} onChange={() => setServiceConsent((v) => !v)} label={S.serviceConsent} />
              <span>{S.serviceConsent}</span>
            </label>
            <label className="field-inline setup-consent">
              <Checkbox state={autostart} onChange={() => setAutostart((v) => !v)} label={S.autostart} />
              <span>{S.autostart}</span>
            </label>
            {sys.session.hyprland && !sys.session.uwsm ? (
              <p className="muted small">
                {S.hyprlandHint} <span className="mono nowrap">exec-once = nucleon-sync-gui --hidden</span>
              </p>
            ) : null}
            <div className="row">
              <Button
                variant="primary"
                icon="play"
                busy={busy}
                disabled={!serviceConsent || busy}
                onClick={() => void installService()}
                data-testid="install-service"
              >
                {sys.service.active ? S.serviceUpdate : S.serviceInstall}
              </Button>
              {connection === 'connected' ? (
                <Pill tone="ok">{S.serviceRunning}</Pill>
              ) : service ? (
                <span className="muted">
                  <Spinner /> {S.serviceWaiting}
                </span>
              ) : null}
            </div>
            {service?.skipped ? (
              <div className="tone-warn">{service.skipped === 'foreign-unit' ? S.serviceForeign : service.skipped}</div>
            ) : null}
            {service?.steps.length ? (
              <pre className="setup-log mono small">
                {service.steps
                  .map((s) => `${s.ok ? '✓' : '✕'} ${s.cmd}${s.output ? `\n  ${s.output}` : ''}`)
                  .join('\n')}
              </pre>
            ) : null}
          </>
        ) : null}

        {step === 'login' ? (
          <>
            <h2>{S.loginTitle}</h2>
            {account?.status === 'ok' ? (
              <div className="tone-ok setup-ok" data-testid="login-ok">
                <Icon name="check" size={18} /> {S.loginOk(account.email ?? account.displayName)}
              </div>
            ) : login ? (
              <LoginPanel accountId={accountId!} name={displayName} onRetry={() => void startLogin()} />
            ) : (
              <>
                <p>{S.loginIntro}</p>
                <p className="muted small" data-testid="third-party-notice">
                  {t.accounts.thirdParty}
                </p>
                <label className="field">
                  <span>{S.displayName}</span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    data-testid="display-name"
                  />
                </label>
                <div className="row">
                  <Button
                    variant="primary"
                    icon="key"
                    busy={busy}
                    onClick={() => void startLogin()}
                    data-testid="start-login"
                  >
                    {S.loginStart}
                  </Button>
                </div>
              </>
            )}
          </>
        ) : null}

        {step === 'folders' ? (
          <>
            <h2>{S.foldersTitle}</h2>
            <p className="muted">{S.foldersIntro}</p>
            {devices.length ? <p className="muted small">{S.devices(devices.map((d) => d.name).join(', '))}</p> : null}
            {drafts.map((d, i) => {
              const set = (patch: Partial<PairDraft>) =>
                setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="setup-pair" data-testid="setup-pair">
                  <Checkbox state={d.on} onChange={() => set({ on: !d.on })} label={d.name} />
                  <div className="setup-pair-fields">
                    <div className="row">
                      <input
                        className="grow mono"
                        value={d.localRoot}
                        onChange={(e) => set({ localRoot: e.target.value })}
                        aria-label={S.local}
                      />
                      <Button
                        small
                        icon="folder"
                        onClick={() =>
                          void window.nucleonSync.pickFolder(d.localRoot).then((p) => p && set({ localRoot: p }))
                        }
                      >
                        {S.change}
                      </Button>
                    </div>
                    <div className="row">
                      <Icon name="cloud" size={16} />
                      <input
                        className="grow mono"
                        value={d.remoteRoot}
                        onChange={(e) => set({ remoteRoot: e.target.value })}
                        aria-label={S.remote}
                      />
                      <select
                        value={d.direction}
                        onChange={(e) => set({ direction: e.target.value as PairDirection })}
                        aria-label={S.direction}
                      >
                        {(['backup', 'mirror-down', 'upload-only', 'two-way'] as PairDirection[]).map((x) => (
                          <option key={x} value={x}>
                            {t.pair.direction[x]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="muted small">{S.directionHelp[d.direction as keyof typeof S.directionHelp]}</div>
                  </div>
                </div>
              );
            })}
            <div className="row">
              <Button
                icon="plus"
                onClick={() =>
                  setDrafts((all) => [
                    ...all,
                    {
                      on: true,
                      name: S.newFolder,
                      localRoot: sys?.folders.documents ?? '',
                      remoteRoot: `/my-files/${sys?.hostname ?? 'Computer'}/${S.newFolder}`,
                      direction: 'backup',
                    },
                  ])
                }
              >
                {S.addPair}
              </Button>
              <Button
                variant="primary"
                icon="check"
                busy={busy}
                disabled={!drafts.some((d) => d.on) || busy}
                onClick={() => void createPairs()}
                data-testid="create-pairs"
              >
                {S.createPairs}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'prefs' ? (
          <>
            <h2>{S.prefsTitle}</h2>
            <p className="muted">{S.prefsIntro}</p>
            <div className="setup-pair-fields">
              <label className="field-inline">
                <span>{S.incrementalEvery}</span>
                <select
                  value={prefs.incrementalHours}
                  data-testid="setup-incremental"
                  onChange={(e) => setPrefs((p) => ({ ...p, incrementalHours: Number(e.target.value) }))}
                >
                  {[3, 6, 12, 24].map((h) => (
                    <option key={h} value={h}>
                      {S.hours(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-inline">
                <span>{t.settings.fullWeekly}</span>
                <select
                  value={prefs.fullEveryWeeks}
                  onChange={(e) => setPrefs((p) => ({ ...p, fullEveryWeeks: Number(e.target.value) }))}
                >
                  {[1, 2, 4].map((w) => (
                    <option key={w} value={w}>
                      {t.settings.fullEvery[w]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">{t.settings.scheduleHint}</p>
              <label className="field-inline setup-consent">
                <Checkbox
                  state={prefs.desktop}
                  onChange={() => setPrefs((p) => ({ ...p, desktop: !p.desktop }))}
                  label={t.settings.desktop}
                />
                <span>{t.settings.desktop}</span>
              </label>
              <label className="field-inline setup-consent">
                <Checkbox
                  state={prefs.telegram}
                  onChange={() => setPrefs((p) => ({ ...p, telegram: !p.telegram }))}
                  label={t.settings.telegram}
                />
                <span>{t.settings.telegram}</span>
              </label>
              {prefs.telegram ? (
                <>
                  <p className="muted small">{t.settings.telegramHelp}</p>
                  <div className="row">
                    <input
                      className="mono"
                      aria-label={t.settings.chatId}
                      placeholder={t.settings.chatId}
                      inputMode="numeric"
                      value={prefs.chatId}
                      onChange={(e) => setPrefs((p) => ({ ...p, chatId: e.target.value }))}
                    />
                    <input
                      className="mono grow"
                      type="password"
                      autoComplete="off"
                      aria-label={t.settings.botToken}
                      placeholder={t.settings.tokenPlaceholder}
                      value={prefs.botToken}
                      onChange={(e) => setPrefs((p) => ({ ...p, botToken: e.target.value }))}
                    />
                  </div>
                </>
              ) : null}
              <p className="muted small">{S.prefsLater}</p>
            </div>
            <div className="row">
              <Button
                variant="primary"
                icon="check"
                busy={busy}
                disabled={busy || (prefs.telegram && (!/^-?\d+$/.test(prefs.chatId.trim()) || !prefs.botToken.trim()))}
                onClick={() => void savePrefs()}
                data-testid="save-prefs"
              >
                {S.savePrefs}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <h2>{S.doneTitle}</h2>
            <ul className="setup-list mono small">
              {created.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p>{S.doneIntro}</p>
            <div className="row">
              <Button variant="primary" icon="sync" busy={busy} onClick={() => void finish()} data-testid="finish">
                {S.finish}
              </Button>
            </div>
          </>
        ) : null}

        {err ? (
          <div className="tone-err setup-err" role="alert" data-testid="setup-error">
            {err}
          </div>
        ) : null}
        <footer className="setup-foot">
          <Button variant="ghost" disabled={idx === 0 || busy} onClick={() => setStep(STEPS[idx - 1]!)}>
            {S.back}
          </Button>
          <span className="grow" />
          {step !== 'folders' && step !== 'prefs' && step !== 'done' ? (
            <Button variant="primary" disabled={!canNext[step] || busy} onClick={next} data-testid="setup-next">
              {S.next}
            </Button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
