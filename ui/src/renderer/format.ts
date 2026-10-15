// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Formatting helpers in the active UI language (pure apart from the locale; unit-tested). Sizes use binary units
 * with the labels of the Proton apps (KB, MB, GB). Numbers and words follow i18n/index.ts `setLocale`.
 */
import { intlTag, t } from './i18n/index.ts';

const cache = new Map<string, Intl.NumberFormat>();
function nfmt(digits: 0 | 1): Intl.NumberFormat {
  const key = `${intlTag()}|${digits}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
    cache.set(key, f);
  }
  return f;
}
const nf0 = { format: (x: number) => nfmt(0).format(x) };
const nf1 = { format: (x: number) => nfmt(1).format(x) };
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  if (n < 1024) return `${nf0.format(n)} B`;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  // 9.96 would round to "10,0": switch to integers at the rounding boundary
  return `${v < 9.95 ? nf1.format(v) : nf0.format(v)} ${UNITS[i]}`;
}

export function fmtCount(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : nf0.format(n);
}

export function fmtPercent(fraction: number): string {
  return `${nf0.format(Math.round(fraction * 100))} %`;
}

export function fmtRate(bytesPerSecond: number): string {
  return `${fmtBytes(bytesPerSecond)}/s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "12:01" */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const isDe = () => intlTag().startsWith('de');
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** German "10.10. 12:01", English "10 Oct 12:01" */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return isDe()
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${hm}`
    : `${d.getDate()} ${MONTHS_EN[d.getMonth()]} ${hm}`;
}

/** German "10.10.2026", English "10 Oct 2026" */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return isDe()
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
    : `${d.getDate()} ${MONTHS_EN[d.getMonth()]} ${d.getFullYear()}`;
}

/** today: "12:01:13", otherwise "09.10. 12:01" */
export function fmtStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return fmtDateTime(iso);
}

/** run time range: "10:02–10:06" today, "09.10. 10:02–10:06" otherwise */
export function fmtRange(startIso: string, endIso: string | null, now: Date = new Date()): string {
  const start = sameDay(new Date(startIso), now) ? fmtClock(startIso) : fmtDateTime(startIso);
  return `${start}–${endIso ? fmtClock(endIso) : '…'}`;
}

/** future times: "14:00" today, "tomorrow 03:00", "Sun 03:00" within 6 days, else a short date */
export function fmtWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (sameDay(d, now)) return fmtClock(iso);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return t.time.tomorrow(fmtClock(iso));
  const days = (d.getTime() - now.getTime()) / 86_400_000;
  if (days > 0 && days < 6.5) return `${t.time.weekdaysShort[d.getDay()]} ${fmtClock(iso)}`;
  return fmtDateTime(iso);
}

/** "0,8 s", "12 s", "2 min 5 s", "1 h 3 min" */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 10_000) return `${nf1.format(ms / 1000)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** remaining time: "12 min", "3 h 5 min", "2 days 4 h" */
export function fmtEta(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds >= 48 * 3600) {
    const d = Math.floor(seconds / 86400);
    const h = Math.round((seconds % 86400) / 3600);
    return h ? t.time.daysHours(d, h) : t.time.days(d);
  }
  return fmtDuration(Math.max(1, seconds) * 1000);
}

/** "5 min ago" style relative past time, for "last OK" */
export function fmtAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '–';
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t.time.justNow;
  if (s < 3600) return t.time.minutesAgo(Math.floor(s / 60));
  if (s < 86_400) return t.time.hoursAgo(Math.floor(s / 3600));
  return fmtDateTime(iso);
}

/** shortens long paths in the middle: "Dokumente/…/Projekt A/Angebot.xlsx" */
export function shortPath(p: string, max = 64): string {
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length <= 2) return '…' + p.slice(p.length - max + 1);
  const first = parts[0]!;
  let tail = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}/${tail}`;
    if (first.length + next.length + 3 > max) break;
    tail = next;
  }
  const out = `${first}/…/${tail}`;
  return out.length <= max ? out : '…' + p.slice(p.length - max + 1);
}

export function joinPath(root: string, rel: string | null | undefined): string {
  if (!rel) return root;
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

/** "nice" axis ticks from 0 for byte values (steps 1/2/2.5/5 × 10^k in the display unit) */
export function niceByteTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
  const raw = max / unit / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((f) => f * mag >= raw) ?? 10) * mag * unit;
  const ticks: number[] = [];
  for (let t = 0; t < max + step * 0.999; t += step) ticks.push(t);
  return ticks;
}
