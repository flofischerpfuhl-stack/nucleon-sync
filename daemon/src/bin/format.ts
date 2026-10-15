// SPDX-License-Identifier: GPL-3.0-or-later
/** Text formatting helpers of the `nucleon-sync` CLI client (separate module: nucleon-sync.ts runs main() on import). */
import type { StatusDto } from '@nucleon-sync/shared';

export const fmtBytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

export function fmtEta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return 'unknown';
  if (sec < 90) return `${Math.max(0, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.round((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : `${h} h ${m} min`;
}

/** Transfer lines of `nucleon-sync status`: running transfers with progress and the overall upload/download ETA. */
export function transferLines(s: StatusDto): string[] {
  const t = s.transfers;
  if (!t) return [];
  const out: string[] = [];
  for (const [label, b] of [
    ['upload', t.upload],
    ['download', t.download],
  ] as const) {
    if (!b.files && !b.blockedFiles) continue;
    const left = Math.max(0, b.bytes - b.bytesDone);
    out.push(
      `${label}: ${b.files} files / ${fmtBytes(left) || '0 B'} left` +
        (b.rateBps ? ` at ${fmtBytes(b.rateBps)}/s` : '') +
        ` · ETA ${b.files ? fmtEta(b.etaSeconds) : '—'}` +
        (b.blockedFiles ? ` · ${b.blockedFiles} blocked (${fmtBytes(b.blockedBytes)}, writes off)` : ''),
    );
  }
  for (const a of t.active) {
    const pct = a.bytesTotal ? Math.floor((a.bytesDone / a.bytesTotal) * 100) : 0;
    out.push(
      `  ${a.kind === 'upload' ? '↑' : '↓'} ${a.relPath ?? ''}${a.files > 1 ? ` (+${a.files - 1})` : ''}  ${pct} %  ${fmtBytes(a.bytesDone)}/${fmtBytes(a.bytesTotal)}` +
        (a.rateBps ? `  ${fmtBytes(a.rateBps)}/s` : '') +
        (a.etaSeconds !== null ? `  ETA ${fmtEta(a.etaSeconds)}` : ''),
    );
  }
  return out;
}
