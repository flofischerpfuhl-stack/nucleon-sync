// SPDX-License-Identifier: GPL-3.0-or-later
/** Typed rows and small helpers around the state DB (owned by ). */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { EntryState, PairDirection } from '@nucleon-sync/shared';

export const FLAG = {
  DIGEST_MISSING: 1 << 0,
  NEEDS_VERIFICATION: 1 << 1,
  FROM_IMPORT: 1 << 2,
  MATCHED_BY_SIZE_MTIME: 1 << 3,
  KEEP_REMOTE_ONLY: 1 << 4,
  EXCLUDED_KEPT_REMOTE: 1 << 5,
  CONFLICT_IGNORED: 1 << 6,
  DUPLICATE_REMOTE_NAME: 1 << 7,
  UNSUPPORTED: 1 << 8,
} as const;

export interface EntryRow {
  id: number;
  pair_id: number;
  rel_path: string;
  kind: 'file' | 'folder';
  l_exists: number;
  l_size: number | null;
  l_mtime_us: number | null;
  l_ctime_us: number | null;
  l_inode: number | null;
  l_dev: number | null;
  l_sha1: string | null;
  l_hashed_at: number | null;
  l_seen_scan: number | null;
  r_exists: number;
  r_uid: string | null;
  r_parent_uid: string | null;
  r_rev_uid: string | null;
  r_size: number | null;
  r_mtime_ms: number | null;
  r_sha1: string | null;
  r_storage: number | null;
  r_rev_storage: number | null;
  r_media_type: string | null;
  r_seen_crawl: number | null;
  b_sha1: string | null;
  b_size: number | null;
  b_l_mtime_us: number | null;
  b_r_rev_uid: string | null;
  synced_at: number | null;
  state: EntryState;
  flags: number;
  last_error: string | null;
  updated_at: number;
}

export interface PairRow {
  id: number;
  account_id: string;
  name: string;
  local_root: string;
  remote_root: string;
  remote_section: string;
  remote_root_uid: string | null;
  direction: PairDirection;
  enabled: number;
  paused: number;
  options: string;
  last_run_at: number | null;
  last_full_at: number | null;
  created_at: number;
}

export interface PairOptions {
  /** backup pairs: remote edit with unchanged local -> 'download' (default) or 'conflict' */
  remoteChanges?: 'download' | 'conflict';
  /** backup pairs: remote deletion with local present -> 'reupload' (default) or 'ask' */
  remoteDeletions?: 'reupload' | 'ask';
  /**
   * mirror-down pairs: files that appear new locally (no base, not in Proton) are uploaded to the mapped remote path
   * (`-f skip`; never overwrites or deletes anything remotely; same-named remote file -> both kept). UI: "Neue Dateien
   * vom PC hochladen". Used e.g. by an agent that files documents into a shared folder.
   */
  uploadLocalNew?: boolean;
  /** set by the daemon when uploadLocalNew is switched on (ms): only files created/renamed locally after it qualify */
  uploadLocalNewSince?: number;
  /** two-way: minutes between automatic remote checks (default TWO_WAY_DEFAULTS.remoteCheckMinutes) */
  remoteCheckMinutes?: number;
  /** two-way: mass-delete guard thresholds (defaults TWO_WAY_DEFAULTS) */
  massDeleteMaxFiles?: number;
  massDeletePercent?: number;
  /** two-way, daemon-managed: adoption run pending (nothing is deleted on either side, identical files recorded) */
  twoWayAdoption?: boolean;
}

export interface AccountRow {
  id: string;
  display_name: string;
  email: string | null;
  credential_backend: 'keyring-shim' | 'keychain-direct' | 'mock' | 'encfile';
  secret_service: string | null;
  secret_key: string | null;
  secret_schema: string | null;
  workers: number;
  status: string;
  last_error: string | null;
  last_ok_at: number | null;
  paused: number;
  enabled: number;
  created_at: number;
}

export interface JobRow {
  id: number;
  run_id: number | null;
  account_id: string;
  pair_id: number | null;
  entry_id: number | null;
  type: string;
  payload: string;
  priority: number;
  state: string;
  attempts: number;
  max_attempts: number;
  not_before: number | null;
  error_class: string | null;
  last_error: string | null;
  bytes: number | null;
  worker: string | null;
  dedupe_key: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export function pairOptions(p: PairRow): PairOptions {
  try {
    return JSON.parse(p.options || '{}') as PairOptions;
  } catch {
    return {};
  }
}

/** Statement cache: prepare once per SQL text and DB. */
export class Stmts {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  get(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** SQL range for "rel_path is below prefix" using the (pair_id, rel_path) index. */
export function belowRange(prefix: string): [string, string] {
  return [`${prefix}/`, `${prefix}/\u{10FFFF}`];
}
