// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * docs/SYNC-RULES.md Schedule & settings: forms bound to SettingsDto (GET/PUT /v1/settings), plus language/appearance (UI
 * preferences in the main process), the notification log and the agents section (screens/Agents.tsx).
 */
import { useEffect, useState, type ReactNode } from 'react';

import type { SettingsDto } from '@nucleon-sync/shared';

import { api } from '../api.ts';
import { Button, Empty, Switch } from '../components/ui.tsx';
import { LOCALES, section, t, type Locale } from '../i18n/index.ts';
import { normalizeSettings } from '../logic/normalize.ts';
import { DEFAULT_SETTINGS } from '../shared.ts';
import { fmtDateTime } from '../format.ts';
import { applyUiState, toast, toastError, useApi, useStore } from '../store.ts';
import { AgentsCard } from './Agents.tsx';

const S = section('settings');
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function Num({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  label,
  width = 90,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  width?: number;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step}
      style={{ width }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="set-row">
      <div className="set-label">{label}</div>
      <div className="set-ctrl">
        {children}
        {hint ? <span className="muted small">{hint}</span> : null}
      </div>
    </div>
  );
}

/** language + desktop theme: stored by the main process, applied at once (no save button) */
function AppearanceCard() {
  const ui = useStore((s) => s.ui);
  const pref = ui.language?.preference ?? 'system';
  const sys = (ui.language?.system ?? 'en') as Locale;
  const theme = ui.theme;
  const set = (patch: Parameters<typeof window.nucleonSync.setPrefs>[0]) =>
    void window.nucleonSync.setPrefs(patch).then(applyUiState).catch(toastError);
  const src = t.settings.themeSource;
  return (
    <section className="card" data-testid="appearance-card">
      <h2>{S.appearance}</h2>
      <Row label={S.language}>
        <select
          aria-label={S.language}
          value={pref}
          onChange={(e) => set({ language: e.target.value })}
          data-testid="language-select"
        >
          <option value="system">{S.languageSystem(LOCALES[sys]?.name ?? sys)}</option>
          {(Object.keys(LOCALES) as Locale[]).map((l) => (
            <option key={l} value={l}>
              {LOCALES[l].name}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label={S.theme}
        hint={
          theme?.source === 'omarchy'
            ? src.omarchy(theme.name ?? '')
            : theme?.source === 'kde'
              ? src.kde
              : theme?.source === 'env'
                ? src.env
                : src.system
        }
      >
        <Switch checked={ui.prefs?.followTheme !== false} label={S.theme} onChange={(v) => set({ followTheme: v })} />
      </Row>
      <p className="muted small">{S.shortcutsHint}</p>
    </section>
  );
}

/** The daemon.json notify command (the channel beyond the desktop) and a test button. */
function NotificationChannels() {
  const cfg = useApi(() => api.notificationConfig(), []);
  const [busy, setBusy] = useState(false);
  if (cfg.error) return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label={S.command} hint={S.commandHelp}>
        <span className={cfg.data?.command.configured ? 'mono' : 'muted small'}>
          {cfg.data?.command.configured ? S.commandConfigured(cfg.data.command.program ?? '?') : S.commandNone}
        </span>
      </Row>
      <Row label="">
        <Button
          small
          icon="info"
          busy={busy}
          onClick={() =>
            void run(async () => {
              const r = await api.testNotification();
              toast(
                r.length && r.every((x) => x.ok) ? 'ok' : 'err',
                r.length ? r.map((x) => S.testResult(x.channel, x.ok, x.detail)).join(' · ') : S.testNothing,
              );
            })
          }
        >
          {S.test}
        </Button>
      </Row>
    </>
  );
}

function NotificationLog() {
  const log = useApi(() => api.notifications(10), [], ['notice']);
  if (log.error) return null;
  return (
    <div className="set-row" data-testid="notification-log">
      <div className="set-label">{S.recentNotifications}</div>
      <div className="set-ctrl" style={{ display: 'block' }}>
        {(log.data ?? []).length === 0 ? (
          <span className="muted small">{S.noNotifications}</span>
        ) : (
          (log.data ?? []).map((n) => (
            <div key={n.id} className="small">
              <span className="muted">{fmtDateTime(n.ts)}</span> · {n.channel} · {n.ok === false ? '✕ ' : ''}
              {n.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function Settings() {
  const remote = useApi(async () => normalizeSettings(await api.settings(), DEFAULT_SETTINGS), []);
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (remote.data) setDraft(structuredClone(remote.data));
  }, [remote.data]);
  if (remote.error)
    return (
      <div className="stack settings">
        <AppearanceCard />
        <Empty icon="settings">{remote.error.notImplemented ? S.unavailable : remote.error.message}</Empty>
      </div>
    );
  if (!draft || !remote.data)
    return (
      <div className="stack settings">
        <AppearanceCard />
        <Empty icon="settings">{t.shell.connecting}</Empty>
      </div>
    );
  const d = draft;
  const set = (fn: (x: SettingsDto) => void) => {
    const next = structuredClone(d);
    fn(next);
    setDraft(next);
  };
  const dirty = JSON.stringify(d) !== JSON.stringify(remote.data);
  const save = async () => {
    setSaving(true);
    try {
      const { globalExcludes: _g, ...patch } = d;
      await api.putSettings(patch);
      remote.reload();
      toast('ok', S.saved);
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  const q = d.transfer.quietHours;
  return (
    <div className="stack settings">
      <AppearanceCard />
      <section className="card">
        <h2>{S.schedule}</h2>
        <Row label={S.incrementalEvery}>
          <Num
            label={S.incrementalEvery}
            value={d.schedule.incrementalEveryMinutes}
            min={15}
            step={15}
            onChange={(v) => set((x) => (x.schedule.incrementalEveryMinutes = v))}
          />
          <span>{S.minutes}</span>
        </Row>
        <Row label={S.fullWeekly}>
          <select
            aria-label={`${S.fullWeekly}: ${S.fullEvery[4]}`}
            value={d.schedule.fullEveryWeeks}
            data-testid="full-every"
            onChange={(e) => set((x) => (x.schedule.fullEveryWeeks = Number(e.target.value)))}
          >
            {[...new Set([1, 2, 4, d.schedule.fullEveryWeeks])].map((w) => (
              <option key={w} value={w}>
                {S.fullEvery[w] ?? `${w}×7`}
              </option>
            ))}
          </select>
          <span>{S.on}</span>
          <select
            aria-label={S.fullWeekly}
            value={d.schedule.fullWeekly.weekday}
            onChange={(e) =>
              set(
                (x) =>
                  (x.schedule.fullWeekly.weekday = Number(
                    e.target.value,
                  ) as SettingsDto['schedule']['fullWeekly']['weekday']),
              )
            }
          >
            {S.weekday.map((w, i) => (
              <option key={w} value={i}>
                {w}
              </option>
            ))}
          </select>
          <span>{S.at}</span>
          <Num
            label={S.oclock}
            value={d.schedule.fullWeekly.hour}
            min={0}
            max={23}
            width={70}
            onChange={(v) => set((x) => (x.schedule.fullWeekly.hour = v))}
          />
          <span>{S.oclock}</span>
        </Row>
        <Row label={S.catchUp}>
          <Num
            label={S.catchUp}
            value={d.schedule.runOnStartupDelayMinutes}
            min={0}
            onChange={(v) => set((x) => (x.schedule.runOnStartupDelayMinutes = v))}
          />
          <span>{S.minutes}</span>
        </Row>
        <p className="muted small">{S.scheduleHint}</p>
      </section>

      <section className="card">
        <h2>{S.transfers}</h2>
        <Row label={S.workersTotal} hint={S.workersHint}>
          <Num
            label={S.workersTotal}
            value={d.transfer.maxWorkersTotal}
            min={1}
            max={6}
            width={70}
            onChange={(v) => set((x) => (x.transfer.maxWorkersTotal = v))}
          />
          <span>{S.workersPerAccount}</span>
          <Num
            label={S.workersPerAccount}
            value={d.transfer.maxWorkersPerAccount}
            min={1}
            max={6}
            width={70}
            onChange={(v) => set((x) => (x.transfer.maxWorkersPerAccount = v))}
          />
        </Row>
        <Row label={S.bandwidth}>
          <Switch
            checked={d.transfer.bandwidthLimitKBps !== null}
            label={S.bandwidth}
            onChange={(on) => set((x) => (x.transfer.bandwidthLimitKBps = on ? 5000 : null))}
          />
          {d.transfer.bandwidthLimitKBps !== null ? (
            <>
              <Num
                label={S.bandwidth}
                value={d.transfer.bandwidthLimitKBps}
                min={50}
                step={50}
                width={110}
                onChange={(v) => set((x) => (x.transfer.bandwidthLimitKBps = v))}
              />
              <span>{S.kbps}</span>
            </>
          ) : (
            <span className="muted">{S.unlimited}</span>
          )}
        </Row>
        <Row label={S.quietHours}>
          <Switch
            checked={!!q}
            label={S.quietHours}
            onChange={(on) =>
              set((x) => (x.transfer.quietHours = on ? { from: '22:00', to: '07:00', bandwidthLimitKBps: 1000 } : null))
            }
          />
          {q ? (
            <>
              <span>{S.quietFrom}</span>
              <input
                type="time"
                aria-label={S.quietFrom}
                value={q.from}
                onChange={(e) => set((x) => (x.transfer.quietHours!.from = e.target.value))}
              />
              <span>{S.quietTo}</span>
              <input
                type="time"
                aria-label={S.quietTo}
                value={q.to}
                onChange={(e) => set((x) => (x.transfer.quietHours!.to = e.target.value))}
              />
              <span>{S.quietLimit}</span>
              <Num
                label={S.quietLimit}
                value={q.bandwidthLimitKBps ?? 0}
                min={0}
                step={50}
                width={100}
                onChange={(v) => set((x) => (x.transfer.quietHours!.bandwidthLimitKBps = v || null))}
              />
              <span>{S.kbps}</span>
            </>
          ) : null}
        </Row>
        <Row label={S.thumbnails}>
          <Switch
            checked={d.transfer.thumbnails}
            label={S.thumbnails}
            onChange={(v) => set((x) => (x.transfer.thumbnails = v))}
          />
        </Row>
        <Row label={S.maxFile}>
          <Switch
            checked={d.transfer.maxFileBytes !== null}
            label={S.maxFile}
            onChange={(on) => set((x) => (x.transfer.maxFileBytes = on ? 4096 * MiB : null))}
          />
          {d.transfer.maxFileBytes !== null ? (
            <>
              <Num
                label={S.maxFile}
                value={Math.round(d.transfer.maxFileBytes / MiB)}
                min={1}
                width={110}
                onChange={(v) => set((x) => (x.transfer.maxFileBytes = v * MiB))}
              />
              <span>{S.mb}</span>
            </>
          ) : (
            <span className="muted">{S.noLimit}</span>
          )}
        </Row>
      </section>

      <section className="card">
        <h2>{S.notifications}</h2>
        <Row label={S.desktop}>
          <Switch
            checked={d.notifications.desktop}
            label={S.desktop}
            onChange={(v) => set((x) => (x.notifications.desktop = v))}
          />
        </Row>
        <NotificationChannels />
        <Row label={S.minInterval}>
          <Num
            label={S.minInterval}
            value={Math.round(d.notifications.minIntervalMinutes / 60)}
            min={1}
            width={70}
            onChange={(v) => set((x) => (x.notifications.minIntervalMinutes = v * 60))}
          />
          <span>{S.hoursPerKind}</span>
        </Row>
        <NotificationLog />
      </section>

      <section className="card">
        <h2>{S.storage}</h2>
        <Row label={S.poolSize}>
          <Num
            label={S.poolSize}
            value={d.storagePoolBytes ? Math.round(d.storagePoolBytes / GiB) : 0}
            min={0}
            step={100}
            width={110}
            onChange={(v) => set((x) => (x.storagePoolBytes = v ? v * GiB : null))}
          />
          <span>{S.gb}</span>
        </Row>
      </section>

      <AgentsCard />

      {dirty ? (
        <div className="changes-bar">
          <span>{S.dirty}</span>
          <span className="spacer" />
          <Button onClick={() => setDraft(structuredClone(remote.data))}>{t.actions.discard}</Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            {t.actions.save}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
