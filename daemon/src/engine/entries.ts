// SPDX-License-Identifier: GPL-3.0-or-later
/** Entry mutations shared by executor and engine facade (moves, adoption, uid resolution, local paths). */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { belowRange, FLAG, joinRel, Stmts, tx, type EntryRow, type PairRow } from '../db/repo.ts';
import { contentEq, hasBase, localDelta, remoteDelta } from './decide.ts';
import { OPEN_SQL } from './queue.ts';
import type { RemoteNode } from './remote.ts';

export function getEntry(db: DatabaseSync, id: number | null): EntryRow | null {
  if (id === null) return null;
  return (new Stmts(db).get('SELECT * FROM entries WHERE id = ?').get(id) as unknown as EntryRow | undefined) ?? null;
}

export function getEntryByRel(db: DatabaseSync, pairId: number, rel: string): EntryRow | null {
  return (
    (new Stmts(db).get('SELECT * FROM entries WHERE pair_id = ? AND rel_path = ?').get(pairId, rel) as unknown as
      EntryRow | undefined) ?? null
  );
}

/** uid of a remote folder of the pair ('' = pair root). */
export function resolveFolderUid(db: DatabaseSync, pair: PairRow, rel: string): string | null {
  if (rel === '') return pair.remote_root_uid;
  const st = new Stmts(db);
  const rf = st.get('SELECT uid FROM remote_folders WHERE pair_id = ? AND rel_path = ?').get(pair.id, rel) as
    { uid: string } | undefined;
  if (rf) return rf.uid;
  const e = st
    .get("SELECT r_uid FROM entries WHERE pair_id = ? AND rel_path = ? AND kind = 'folder' AND r_exists = 1")
    .get(pair.id, rel) as { r_uid: string | null } | undefined;
  return e?.r_uid ?? null;
}

/**
 * Absolute local path for a rel path. rel_path is NFC; when the file system holds another normalisation the
 * segments are resolved by reading the directories (original bytes are kept on disk).
 */
export function localPath(pair: PairRow, rel: string): string {
  const direct = path.join(pair.local_root, rel);
  if (!rel || existsSync(direct)) return direct;
  let cur = pair.local_root;
  for (const seg of rel.split('/')) {
    let next = path.join(cur, seg);
    if (!existsSync(next)) {
      try {
        const hit = readdirSync(cur).find((n) => n.normalize('NFC') === seg);
        if (hit) next = path.join(cur, hit);
      } catch {
        return direct;
      }
    }
    cur = next;
  }
  return cur;
}

/** Record a remote node into an entry's r_* snapshot. */
export function setRemote(
  db: DatabaseSync,
  id: number,
  n: RemoteNode,
  crawlId: number | null = null,
  now = Date.now(),
): void {
  new Stmts(db)
    .get(
      `UPDATE entries SET r_exists = 1, r_uid = ?, r_parent_uid = ?, r_rev_uid = ?, r_size = ?, r_mtime_ms = ?, r_sha1 = ?,
       r_storage = ?, r_rev_storage = ?, r_media_type = ?, r_seen_crawl = COALESCE(?, r_seen_crawl), updated_at = ? WHERE id = ?`,
    )
    .run(
      n.uid,
      n.parentUid,
      n.rev?.uid ?? null,
      n.rev?.size ?? null,
      n.rev?.mtimeMs ?? null,
      n.rev?.sha1 ?? null,
      n.totalStorageSize,
      n.rev?.storageSize ?? null,
      n.mediaType,
      crawlId,
      now,
      id,
    );
}

/** Base := current local + remote (both sides agree). */
export function setBase(db: DatabaseSync, e: EntryRow, opts: { digestMissing?: boolean } = {}, now = Date.now()): void {
  let flags = e.flags & ~FLAG.CONFLICT_IGNORED;
  if (opts.digestMissing) flags |= FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME;
  else if (e.r_sha1) flags &= ~(FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME);
  new Stmts(db)
    .get(
      `UPDATE entries SET b_sha1 = ?, b_size = ?, b_l_mtime_us = ?, b_r_rev_uid = ?, synced_at = ?, state = 'synced', flags = ?,
       last_error = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(e.l_sha1 ?? e.r_sha1, e.l_size ?? e.r_size, e.l_mtime_us, e.r_rev_uid, now, flags, now, e.id);
}

/**
 * After a move: if both sides now agree, settle the entry right away (no extra run needed).
 * Returns true when the entry is synced afterwards.
 */
export function settle(db: DatabaseSync, id: number, now = Date.now()): boolean {
  const e = getEntry(db, id);
  if (!e) return false;
  if (e.kind === 'folder') {
    if (e.l_exists && e.r_exists) {
      if (!hasBase(e)) setBase(db, e, {}, now);
      else new Stmts(db).get("UPDATE entries SET state = 'synced' WHERE id = ?").run(id);
      return true;
    }
    return false;
  }
  if (!e.l_exists || !e.r_exists) return false;
  if (hasBase(e)) {
    if (localDelta(e) === 'unchanged' && remoteDelta(e) === 'unchanged') {
      new Stmts(db).get("UPDATE entries SET state = 'synced', updated_at = ? WHERE id = ?").run(now, id);
      return true;
    }
    return false;
  }
  const eq = contentEq(e);
  if (eq === 'no') return false;
  setBase(db, e, { digestMissing: eq === 'size_mtime' }, now);
  return true;
}

/**
 * Rewrites entries (and remote_folders) from fromRel to toRel after a successful remote move/rename. Rows that
 * already exist at the new path (the local side scanned there) are merged: their local snapshot is kept, the
 * remote snapshot and base come from the moved row. Returns the ids of the rewritten rows.
 */
export function rewritePath(
  db: DatabaseSync,
  pairId: number,
  fromRel: string,
  toRel: string,
  newParentUid: string | null,
  now = Date.now(),
): number[] {
  const st = new Stmts(db);
  const ids: number[] = [];
  tx(db, () => {
    const [a, b] = belowRange(fromRel);
    const rows = st
      .get('SELECT * FROM entries WHERE pair_id = ? AND (rel_path = ? OR (rel_path >= ? AND rel_path < ?))')
      .all(pairId, fromRel, a, b) as unknown as EntryRow[];
    for (const old of rows) {
      const newRel = toRel + old.rel_path.slice(fromRel.length);
      const ex = st.get('SELECT * FROM entries WHERE pair_id = ? AND rel_path = ?').get(pairId, newRel) as unknown as
        EntryRow | undefined;
      if (ex && ex.id !== old.id) {
        st.get(
          `UPDATE jobs SET state = 'cancelled', finished_at = ?, last_error = 'merged after move' WHERE entry_id = ? AND state IN ${OPEN_SQL} AND state != 'running'`,
        ).run(now, ex.id);
        st.get('DELETE FROM entries WHERE id = ?').run(ex.id);
        st.get(
          `UPDATE entries SET rel_path = ?, l_exists = ?, l_size = ?, l_mtime_us = ?, l_ctime_us = ?, l_inode = ?, l_dev = ?, l_sha1 = ?,
           l_hashed_at = ?, l_seen_scan = ?, updated_at = ? WHERE id = ?`,
        ).run(
          newRel,
          ex.l_exists,
          ex.l_size,
          ex.l_mtime_us,
          ex.l_ctime_us,
          ex.l_inode,
          ex.l_dev,
          ex.l_sha1,
          ex.l_hashed_at,
          ex.l_seen_scan,
          now,
          old.id,
        );
      } else {
        st.get('UPDATE entries SET rel_path = ?, updated_at = ? WHERE id = ?').run(newRel, now, old.id);
      }
      if (old.rel_path === fromRel && newParentUid)
        st.get('UPDATE entries SET r_parent_uid = ? WHERE id = ?').run(newParentUid, old.id);
      ids.push(old.id);
    }
    const rfs = st
      .get(
        'SELECT rel_path, uid FROM remote_folders WHERE pair_id = ? AND (rel_path = ? OR (rel_path >= ? AND rel_path < ?))',
      )
      .all(pairId, fromRel, a, b) as { rel_path: string; uid: string }[];
    for (const rf of rfs) {
      const newRel = toRel + rf.rel_path.slice(fromRel.length);
      st.get('DELETE FROM remote_folders WHERE pair_id = ? AND rel_path = ?').run(pairId, newRel);
      st.get('UPDATE remote_folders SET rel_path = ?, hot = ? WHERE pair_id = ? AND rel_path = ?').run(
        newRel,
        now + 7 * 86400_000,
        pairId,
        rf.rel_path,
      );
    }
  });
  return ids;
}

export function upsertRemoteFolder(db: DatabaseSync, pairId: number, rel: string, uid: string, now = Date.now()): void {
  new Stmts(db)
    .get(
      `INSERT INTO remote_folders (pair_id, rel_path, uid, hot) VALUES (?, ?, ?, ?)
       ON CONFLICT (pair_id, rel_path) DO UPDATE SET uid = excluded.uid, hot = excluded.hot`,
    )
    .run(pairId, rel, uid, now + 7 * 86400_000);
}

export { joinRel };
