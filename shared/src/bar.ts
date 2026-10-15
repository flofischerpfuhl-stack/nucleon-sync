// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Status-bar module output (Waybar `custom/*` JSON, also read by the Omarchy 4 shell's `command` bar modules).
 * Pure; used by the daemon (writes `<runtime>/bar.json` + `bar-omarchy.json` on every change, so a bar can poll with
 * `cat`) and by `nucleon-sync bar [--watch]`. Unit-tested in daemon/test/bar.test.ts.
 *
 * States, in priority order: stopped (daemon not reachable) › error › conflicts (decisions open, login needed) ›
 * throttled › paused › syncing › idle. `alt` and `class` carry the state (Waybar `format-icons` / CSS); the Omarchy
 * shell only knows `class: "active"` (highlight), used for stopped/error/conflicts. Two-way review items (kept both)
 * count as conflicts, held mass deletions as pending deletions (state `conflicts`, plus one tooltip line per pair).
 */
import type { StatusDto, TransferBacklogDto } from './api.ts';

export type BarState = 'stopped' | 'error' | 'conflicts' | 'throttled' | 'paused' | 'syncing' | 'idle';
export type BarFormat = 'waybar' | 'omarchy';
export type BarLang = 'en' | 'de';

export interface BarOutput {
  text: string;
  alt: BarState;
  tooltip: string;
  class: string;
  /** 0–100 progress of the running upload/download backlog (Waybar `{percentage}`), omitted when unknown */
  percentage?: number;
}

/** Nerd Font (Material Design) glyphs, as used by Omarchy and most Waybar configs */
export const BAR_ICONS: Record<BarState, string> = {
  idle: '\u{f0160}', // nf-md-cloud_check
  syncing: '\u{f063f}', // nf-md-cloud_sync
  paused: '\u{f03e4}', // nf-md-pause
  throttled: '\u{f06ad}', // nf-md-timer_sand
  conflicts: '\u{f0026}', // nf-md-alert
  error: '\u{f0028}', // nf-md-alert_circle
  stopped: '\u{f0164}', // nf-md-cloud_off_outline
};

const L = {
  en: {
    app: 'Nucleon Sync',
    state: {
      idle: 'Up to date',
      syncing: 'Syncing',
      paused: 'Paused',
      throttled: 'Proton is throttling – slowing down',
      conflicts: 'Decisions needed',
      error: 'Error',
      stopped: 'Service not running',
    } satisfies Record<BarState, string>,
    pausedUntil: (t: string) => `Paused until ${t}`,
    up: 'Upload',
    down: 'Download',
    backlog: (files: number, left: string, rate: string | null, eta: string | null) =>
      `${files} files, ${left} left${rate ? ` at ${rate}/s` : ''}${eta ? ` · ETA ${eta}` : ''}`,
    conflicts: (n: number) => `${n} conflict${n === 1 ? '' : 's'}`,
    deletions: (n: number) => `${n} pending deletion${n === 1 ? '' : 's'}`,
    failed: (n: number) => `${n} failed job${n === 1 ? '' : 's'}`,
    held: (pair: string, n: number) =>
      `${pair}: ${n} deletion${n === 1 ? '' : 's'} held (two-way mass-delete guard) – approve or deny in the dashboard`,
    accounts: 'Accounts',
    paused: 'paused',
    next: (t: string) => `Next run ${t}`,
    hint: 'Left click: dashboard · right click: pause/resume · middle click: sync now',
    hintStopped: 'Left click: open the dashboard',
    account: {
      ok: 'OK',
      needs_login: 'login needed',
      login_pending: 'login running',
      needs_keyring: 'keyring locked',
      offline: 'offline',
      throttled: 'throttled',
      error: 'error',
      disabled: 'disabled',
    } as Record<string, string>,
  },
  de: {
    app: 'Nucleon Sync',
    state: {
      idle: 'Alles synchronisiert',
      syncing: 'Synchronisiere',
      paused: 'Pausiert',
      throttled: 'Proton bremst – langsamer',
      conflicts: 'Entscheidungen offen',
      error: 'Fehler',
      stopped: 'Dienst läuft nicht',
    } satisfies Record<BarState, string>,
    pausedUntil: (t: string) => `Pausiert bis ${t}`,
    up: 'Hochladen',
    down: 'Herunterladen',
    backlog: (files: number, left: string, rate: string | null, eta: string | null) =>
      `${files} Dateien, ${left} offen${rate ? ` mit ${rate}/s` : ''}${eta ? ` · noch ${eta}` : ''}`,
    conflicts: (n: number) => `${n} ${n === 1 ? 'Konflikt' : 'Konflikte'}`,
    deletions: (n: number) => `${n} ${n === 1 ? 'ausstehende Löschung' : 'ausstehende Löschungen'}`,
    failed: (n: number) => `${n} ${n === 1 ? 'fehlgeschlagener Auftrag' : 'fehlgeschlagene Aufträge'}`,
    held: (pair: string, n: number) =>
      `${pair}: ${n} ${n === 1 ? 'Löschung' : 'Löschungen'} angehalten (Zwei-Wege-Schutz) – im Dashboard ausführen oder ablehnen`,
    accounts: 'Konten',
    paused: 'pausiert',
    next: (t: string) => `Nächster Lauf ${t}`,
    hint: 'Links: Dashboard · Rechts: Pause/Fortsetzen · Mitte: jetzt synchronisieren',
    hintStopped: 'Links: Dashboard öffnen',
    account: {
      ok: 'OK',
      needs_login: 'Anmeldung nötig',
      login_pending: 'Anmeldung läuft',
      needs_keyring: 'Schlüsselbund gesperrt',
      offline: 'offline',
      throttled: 'gebremst',
      error: 'Fehler',
      disabled: 'deaktiviert',
    } as Record<string, string>,
  },
};

/** `de` for German locales (LC_ALL › LC_MESSAGES › LANG), else English */
export function barLang(env: NodeJS.ProcessEnv = process.env): BarLang {
  const v = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^de(_|$|\.|-)/i.test(v) ? 'de' : 'en';
}

const ATTENTION_ACCOUNT = new Set(['needs_login', 'needs_keyring', 'login_pending']);

export function barState(s: StatusDto | null): BarState {
  if (!s) return 'stopped';
  if (
    s.state === 'error' ||
    s.state === 'offline' ||
    s.accounts.some((a) => a.status === 'error' || a.status === 'offline')
  )
    return 'error';
  if (
    s.openConflicts > 0 ||
    s.pendingDeletions > 0 ||
    s.queue.failed > 0 ||
    s.pairs.some((p) => p.brake || p.heldDeletions) ||
    s.accounts.some((a) => ATTENTION_ACCOUNT.has(a.status))
  )
    return 'conflicts';
  if (s.accounts.some((a) => a.status === 'throttled')) return 'throttled';
  if (s.paused || s.state === 'paused') return 'paused';
  if (s.state === 'syncing') return 'syncing';
  return 'idle';
}

function bytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function eta(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${h} h` : `${h} h ${Math.round((sec % 3600) / 60)} min`;
}

function clock(iso: string, now: Date): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getDate()}.${d.getMonth() + 1}. ${hm}`;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function barOutput(
  s: StatusDto | null,
  o: { format?: BarFormat; lang?: BarLang; now?: Date; detail?: string } = {},
): BarOutput {
  const t = L[o.lang ?? 'en'];
  const now = o.now ?? new Date();
  const state = barState(s);
  const lines: string[] = [];
  let percentage: number | undefined;
  if (!s) {
    lines.push(`${t.app}: ${t.state.stopped}`);
    if (o.detail) lines.push(o.detail);
    lines.push('', t.hintStopped);
  } else {
    const head = state === 'paused' && s.pausedUntil ? t.pausedUntil(clock(s.pausedUntil, now)) : t.state[state];
    lines.push(`${t.app}: ${head}`);
    const tr = s.transfers;
    const back = (label: string, b: TransferBacklogDto | undefined) => {
      if (!b || !b.files) return;
      const left = Math.max(0, b.bytes - b.bytesDone);
      lines.push(
        `${label}: ${t.backlog(b.files, bytes(left), b.rateBps ? bytes(b.rateBps) : null, eta(b.etaSeconds))}`,
      );
    };
    back(`↑ ${t.up}`, tr?.upload);
    back(`↓ ${t.down}`, tr?.download);
    if (tr) {
      const total = tr.upload.bytes + tr.download.bytes;
      if (total > 0)
        percentage = Math.min(100, Math.floor(((tr.upload.bytesDone + tr.download.bytesDone) / total) * 100));
      for (const a of tr.active.slice(0, 3)) {
        const pct = a.bytesTotal ? Math.floor((a.bytesDone / a.bytesTotal) * 100) : 0;
        lines.push(
          `  ${a.kind === 'upload' ? '↑' : '↓'} ${a.relPath ?? ''} ${pct} %${a.etaSeconds !== null ? ` · ${eta(a.etaSeconds)}` : ''}`,
        );
      }
    }
    const issues = [
      s.openConflicts ? t.conflicts(s.openConflicts) : null,
      s.pendingDeletions ? t.deletions(s.pendingDeletions) : null,
      s.queue.failed ? t.failed(s.queue.failed) : null,
      ...s.pairs.filter((p) => p.brake && !p.heldDeletions).map((p) => `${p.name}: ${p.brake!.reason}`),
    ].filter(Boolean);
    if (issues.length) lines.push(issues.join(' · '));
    // two-way: a held mass deletion stops the pair until the user decides – one line per pair
    for (const p of s.pairs) if (p.heldDeletions) lines.push(`⚠ ${t.held(p.name, p.heldDeletions)}`);
    if (s.accounts.length) {
      lines.push('', `${t.accounts}:`);
      for (const a of s.accounts)
        lines.push(`  ${a.displayName}: ${t.account[a.status] ?? a.status}${a.paused ? ` (${t.paused})` : ''}`);
    }
    const next = s.nextRuns.find((r) => r.mode === 'incremental') ?? s.nextRuns[0];
    if (next && state !== 'syncing' && state !== 'paused') lines.push(t.next(clock(next.at, now)));
    lines.push('', t.hint);
  }
  const count = s ? s.openConflicts + s.pendingDeletions : 0;
  const text = state === 'conflicts' && count ? `${BAR_ICONS[state]} ${count}` : BAR_ICONS[state];
  const highlight = state === 'stopped' || state === 'error' || state === 'conflicts';
  return {
    text,
    alt: state,
    // Waybar renders the tooltip as Pango markup
    tooltip: o.format === 'omarchy' ? lines.join('\n') : esc(lines.join('\n')),
    class: o.format === 'omarchy' ? (highlight ? 'active' : state) : state,
    ...(percentage !== undefined ? { percentage } : {}),
  };
}
