// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Additive shared types of the two-way block (docs/ARCHITECTURE.md §10).
 * New types live here so parallel branches do not edit the same lines of api.ts.
 */

/** Options of a two-way pair (PairRow.options JSON / PairDto.options). */
export interface TwoWayPairOptions {
  /** minutes between automatic remote checks (listing) of the pair; default TWO_WAY_DEFAULTS.remoteCheckMinutes */
  remoteCheckMinutes?: number;
  /** mass-delete guard: more deletions than this in one run pause the pair until approved */
  massDeleteMaxFiles?: number;
  /** mass-delete guard: more than this share (%) of the pair's synced files (and at least massDeleteMinFiles) */
  massDeletePercent?: number;
  /**
   * read-only, daemon-managed: the pair was created as or switched to two-way and has not finished its adoption run
   * yet. While set, nothing is deleted on either side (a missing file is restored instead) and existing identical
   * files are only recorded (no transfer, no new remote revision).
   */
  twoWayAdoption?: boolean;
}

export const TWO_WAY_DEFAULTS = {
  remoteCheckMinutes: 10,
  massDeleteMaxFiles: 20,
  massDeletePercent: 10,
  /** the percentage rule only applies from this many deletions on (small pairs) */
  massDeleteMinFiles: 5,
  /** digest-less remote files up to this size are downloaded to staging and hashed during adoption */
  verifyMaxBytes: 64 * 1024 * 1024,
} as const;

/** POST /v1/pairs/:id/held-deletions — approve (carry out) or deny (restore) every held deletion of the pair. */
export interface DecideHeldDeletionsRequest {
  approve: boolean;
}

/** Answer of POST /v1/pairs/:id/held-deletions. */
export interface DecideHeldDeletionsResponse {
  ok: true;
  decided: number;
  jobIds: number[];
}

/** `Name (conflict <host> YYYY-MM-DD).ext`, `… YYYY-MM-DD 2).ext` for further copies; dir kept. */
export function twoWayConflictName(rel: string, host: string, date: Date, n = 1): string {
  const i = rel.lastIndexOf('/');
  const dir = i < 0 ? '' : rel.slice(0, i);
  const name = i < 0 ? rel : rel.slice(i + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  const safeHost = host.replace(/[/\\()\n\r]/g, '_').slice(0, 40) || 'host';
  const out = `${stem} (conflict ${safeHost} ${date.toISOString().slice(0, 10)}${n > 1 ? ` ${n}` : ''})${ext}`;
  return dir ? `${dir}/${out}` : out;
}
