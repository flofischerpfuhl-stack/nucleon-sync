// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure decision tables (docs/SYNC-RULES.md–3.4). Inputs are the 3-way deltas of one entry; output is an action.
 * Kept free of I/O so the tables can be tested exhaustively (daemon/test/engine/decide.test.ts).
 */
import type { ConflictKind, EntryState, PairDirection } from '@nucleon-sync/shared';

import type { EntryRow, PairOptions } from '../db/repo.ts';

export type LDelta = 'absent' | 'new' | 'unchanged' | 'changed' | 'deleted';
export type RDelta = 'absent' | 'new' | 'unchanged' | 'changed' | 'deleted';
/** content comparison of local vs remote: sha1 equal, digest-less match by size + mtime ±2 s, or different */
export type ContentEq = 'yes' | 'size_mtime' | 'no';

export type Action =
  | { kind: 'noop'; state: EntryState }
  | { kind: 'forget' }
  | { kind: 'upload' }
  | { kind: 'upload_revision'; force?: boolean }
  | { kind: 'download'; replace: boolean }
  | { kind: 'adopt'; digestMissing: boolean }
  | { kind: 'accept_remote' }
  | { kind: 'conflict'; conflict: ConflictKind }
  | { kind: 'pending_deletion'; remoteChanged: boolean }
  | { kind: 'trash_local' }
  | { kind: 'mkdir' }
  | { kind: 'mkdir_local' }
  // two-way only:
  /** deleted locally, unchanged in Proton -> Proton trash (subject to the mass-delete guard) */
  | { kind: 'trash_remote' }
  /** both sides differ: keep both (local renamed to a conflict copy and uploaded, remote downloaded); review listed */
  | { kind: 'conflict_copy'; conflict: ConflictKind }
  /** first contact, Proton file without sha1 and same size but other mtime: prove identity before adopting */
  | { kind: 'verify' }
  /** restore the side that deleted the file (the other side changed it, or the adoption run deletes nothing) */
  | { kind: 'restore'; to: 'local' | 'remote'; review: ConflictKind | null };

/** Extra facts for the two-way table (not part of the pair options). */
export interface DecideContext {
  /** remote file has no sha1 and the same size as the local file (identity unproven when eq = 'no') */
  digestlessSameSize?: boolean;
  /** two-way adoption run: nothing is deleted on either side, a missing file is restored */
  adopting?: boolean;
}

export const hasBase = (e: Pick<EntryRow, 'synced_at'>) => e.synced_at !== null;

export function localDelta(e: EntryRow): LDelta {
  if (!hasBase(e)) return e.l_exists ? 'new' : 'absent';
  if (!e.l_exists) return 'deleted';
  if (e.kind === 'folder') return 'unchanged';
  if (e.l_sha1 && e.b_sha1) return e.l_sha1 === e.b_sha1 ? 'unchanged' : 'changed';
  const sameMtime = e.l_mtime_us !== null && e.b_l_mtime_us !== null && Math.abs(e.l_mtime_us - e.b_l_mtime_us) < 1e3;
  return e.l_size === e.b_size && sameMtime ? 'unchanged' : 'changed';
}

export function remoteDelta(e: EntryRow): RDelta {
  if (!hasBase(e)) return e.r_exists ? 'new' : 'absent';
  if (!e.r_exists) return 'deleted';
  if (e.kind === 'folder') return 'unchanged';
  return e.r_rev_uid === e.b_r_rev_uid ? 'unchanged' : 'changed';
}

export function contentEq(e: EntryRow): ContentEq {
  if (e.l_sha1 && e.r_sha1) return e.l_sha1 === e.r_sha1 ? 'yes' : 'no';
  if (
    !e.r_sha1 &&
    e.l_size !== null &&
    e.l_size === e.r_size &&
    e.l_mtime_us !== null &&
    e.r_mtime_ms !== null &&
    Math.abs(e.l_mtime_us / 1e3 - e.r_mtime_ms) <= 2000
  )
    return 'size_mtime';
  return 'no';
}

const adoptOr = (eq: ContentEq, otherwise: Action): Action =>
  eq === 'yes'
    ? { kind: 'adopt', digestMissing: false }
    : eq === 'size_mtime'
      ? { kind: 'adopt', digestMissing: true }
      : otherwise;

/** Files. Unreachable combinations (e.g. L=new with R=unchanged, which needs a base) return a noop 'error'. */
export function decideFile(
  dir: PairDirection,
  L: LDelta,
  R: RDelta,
  eq: ContentEq,
  opts: PairOptions = {},
  ctx: DecideContext = {},
): Action {
  const key = `${L}/${R}`;
  if (dir === 'two-way') return decideTwoWay(key, eq, ctx);
  if (dir === 'backup') {
    switch (key) {
      case 'absent/absent':
        return { kind: 'forget' };
      case 'new/absent':
        return { kind: 'upload' }; // row 1 (adoption lookup happens before, in the planner)
      case 'new/new':
        return adoptOr(eq, { kind: 'conflict', conflict: 'initial_mismatch' }); // rows 2-4
      case 'absent/new':
        return { kind: 'download', replace: false }; // row 12
      case 'unchanged/unchanged':
        return { kind: 'noop', state: 'synced' };
      case 'changed/unchanged':
        return { kind: 'upload_revision' }; // row 5
      case 'unchanged/changed':
        return opts.remoteChanges === 'conflict'
          ? { kind: 'conflict', conflict: 'both_changed' }
          : { kind: 'download', replace: true }; // row 6
      case 'changed/changed':
        return eq === 'yes' ? { kind: 'adopt', digestMissing: false } : { kind: 'conflict', conflict: 'both_changed' }; // row 7
      case 'deleted/unchanged':
        return { kind: 'pending_deletion', remoteChanged: false }; // row 8
      case 'deleted/changed':
        return { kind: 'pending_deletion', remoteChanged: true }; // row 9
      case 'unchanged/deleted':
        return opts.remoteDeletions === 'ask'
          ? { kind: 'conflict', conflict: 'local_present_remote_deleted' }
          : { kind: 'upload' }; // row 10
      case 'changed/deleted':
        return { kind: 'upload' }; // row 11
      case 'deleted/deleted':
        return { kind: 'forget' };
    }
  } else if (dir === 'mirror-down') {
    // remote is master; with opts.uploadLocalNew files new on the PC are uploaded, nothing else is ever written remotely
    switch (key) {
      case 'absent/absent':
        return { kind: 'forget' };
      case 'new/absent':
        // extra local file in a mirror: uploaded only with the option "upload new files from the PC"
        // (the planner passes uploadLocalNew only for files that qualify, see planner.ts uploadsFromPc)
        return opts.uploadLocalNew ? { kind: 'upload' } : { kind: 'noop', state: 'local_new' };
      case 'new/new':
        // same name in Proton meanwhile: the upload keeps both (local file renamed "name (from PC YYYY-MM-DD).ext")
        return adoptOr(
          eq,
          opts.uploadLocalNew ? { kind: 'upload' } : { kind: 'conflict', conflict: 'mirror_local_edit' },
        );
      case 'absent/new':
        return { kind: 'download', replace: false };
      case 'unchanged/unchanged':
        return { kind: 'noop', state: 'synced' };
      case 'changed/unchanged':
        return { kind: 'conflict', conflict: 'mirror_local_edit' };
      case 'unchanged/changed':
        return { kind: 'download', replace: true };
      case 'changed/changed':
        return eq === 'yes'
          ? { kind: 'adopt', digestMissing: false }
          : { kind: 'conflict', conflict: 'mirror_local_edit' };
      case 'deleted/unchanged':
      case 'deleted/changed':
        return { kind: 'download', replace: false }; // mirror is read-mostly: re-download
      case 'unchanged/deleted':
        return { kind: 'trash_local' };
      case 'changed/deleted':
        return { kind: 'conflict', conflict: 'mirror_local_edit' };
      case 'deleted/deleted':
        return { kind: 'forget' };
    }
  } else {
    switch (key) {
      case 'absent/absent':
        return { kind: 'forget' };
      case 'new/absent':
        return { kind: 'upload' };
      case 'new/new':
        return adoptOr(eq, { kind: 'conflict', conflict: 'initial_mismatch' });
      case 'absent/new':
        return { kind: 'noop', state: 'remote_new' }; // outbox never downloads
      case 'unchanged/unchanged':
        return { kind: 'noop', state: 'synced' };
      case 'changed/unchanged':
        return { kind: 'upload_revision' };
      case 'unchanged/changed':
        return { kind: 'accept_remote' }; // remote changes are ignored
      case 'changed/changed':
        return { kind: 'upload_revision', force: true };
      case 'deleted/unchanged':
      case 'deleted/changed':
      case 'deleted/deleted':
        return { kind: 'forget' }; // local deletions are ignored, the remote copy stays
      case 'unchanged/deleted':
        return { kind: 'noop', state: 'remote_deleted' };
      case 'changed/deleted':
        return { kind: 'upload' };
    }
  }
  return { kind: 'noop', state: 'error' };
}

/**
 * Two-way: both sides are equal partners, compared three-way against the base. Nothing is ever
 * overwritten blindly: both sides changed -> both versions kept; a deletion goes to the trash of the other side, and
 * only if that side did not change the file meanwhile (otherwise the file is restored and the case listed).
 */
function decideTwoWay(key: string, eq: ContentEq, ctx: DecideContext): Action {
  switch (key) {
    case 'absent/absent':
      return { kind: 'forget' };
    case 'new/absent':
      return { kind: 'upload' };
    case 'absent/new':
      return { kind: 'download', replace: false };
    case 'new/new':
      // first contact (adoption): identical content is only recorded -> no transfer, no new remote revision
      if (eq === 'yes') return { kind: 'adopt', digestMissing: false };
      if (eq === 'size_mtime') return { kind: 'adopt', digestMissing: true };
      if (ctx.digestlessSameSize) return { kind: 'verify' };
      return { kind: 'conflict_copy', conflict: 'initial_mismatch' };
    case 'unchanged/unchanged':
      return { kind: 'noop', state: 'synced' };
    case 'changed/unchanged':
      return { kind: 'upload_revision' };
    case 'unchanged/changed':
      // a new remote revision with the content we already have (e.g. another device's digest backfill): record it
      return eq === 'yes' ? { kind: 'adopt', digestMissing: false } : { kind: 'download', replace: true };
    case 'changed/changed':
      // same content on both sides (sha1, or digest-less size + mtime ±2 s like at adoption): nothing to keep twice
      return eq === 'yes'
        ? { kind: 'adopt', digestMissing: false }
        : eq === 'size_mtime'
          ? { kind: 'adopt', digestMissing: true }
          : { kind: 'conflict_copy', conflict: 'both_changed' };
    case 'deleted/unchanged':
      return ctx.adopting ? { kind: 'restore', to: 'local', review: null } : { kind: 'trash_remote' };
    case 'deleted/changed':
      return { kind: 'restore', to: 'local', review: 'remote_changed_local_deleted' };
    case 'unchanged/deleted':
      return ctx.adopting ? { kind: 'restore', to: 'remote', review: null } : { kind: 'trash_local' };
    case 'changed/deleted':
      return { kind: 'restore', to: 'remote', review: 'local_changed_remote_deleted' };
    case 'deleted/deleted':
      return { kind: 'forget' };
  }
  return { kind: 'noop', state: 'error' };
}

/** Folders: existence only. */
export function decideFolder(
  dir: PairDirection,
  lExists: boolean,
  rExists: boolean,
  base: boolean,
  ctx: DecideContext = {},
): Action {
  if (!lExists && !rExists) return { kind: 'forget' };
  if (lExists && rExists) return base ? { kind: 'noop', state: 'synced' } : { kind: 'adopt', digestMissing: false };
  if (dir === 'two-way') {
    // a folder deleted on one side is removed on the other only once it is empty there (the planner and the
    // executor check that); the adoption run never deletes
    if (lExists) return base && !ctx.adopting ? { kind: 'trash_local' } : { kind: 'mkdir' };
    return base && !ctx.adopting ? { kind: 'trash_remote' } : { kind: 'mkdir_local' };
  }
  if (dir === 'backup') {
    if (lExists) return { kind: 'mkdir' }; // new local folder, or remote folder deleted (local is master)
    return base ? { kind: 'pending_deletion', remoteChanged: false } : { kind: 'mkdir_local' };
  }
  if (dir === 'mirror-down') {
    if (rExists) return { kind: 'mkdir_local' };
    return { kind: 'noop', state: base ? 'remote_deleted' : 'local_new' };
  }
  // upload-only
  if (lExists) return base ? { kind: 'noop', state: 'remote_deleted' } : { kind: 'mkdir' };
  return { kind: 'forget' };
}
