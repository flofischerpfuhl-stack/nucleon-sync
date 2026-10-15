// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Planner (ARCHITECTURE §4.3 step 4, §8): classifies every entry of a pair with the decision tables, pairs local
 * moves (sha1, disambiguated by inode) and first-contact in-pair relocations (remote file at the old path, local file
 * at the new path), groups them into folder moves (>= 90 % of a folder), proposes adoption of identical content found
 * outside the pair (needs approval), and turns the result into jobs / conflicts / pending deletions / state updates.
 */
import type { DatabaseSync } from 'node:sqlite';

import {
  msg,
  TWO_WAY_DEFAULTS,
  type ActivityAction,
  type ConflictKind,
  type FileSnapshot,
  type Msg,
  type TextOrMsg,
} from '@nucleon-sync/shared';

import { baseName, FLAG, pairOptions, parentRel, Stmts, tx, type EntryRow, type PairRow } from '../db/repo.ts';
import { contentEq, decideFile, decideFolder, hasBase, localDelta, remoteDelta, type Action } from './decide.ts';
import { insertJob, OPEN_SQL, PRIORITY_FOLDER_DELETE, priorityFor, type JobPayload } from './queue.ts';
import { heuristicExcludes, type RuleMatcher } from './rules.ts';

export interface PlanContext {
  db: DatabaseSync;
  pair: PairRow;
  runId: number | null;
  matcher: RuleMatcher;
  now?: () => number;
  activity?: (a: {
    action: ActivityAction;
    relPath?: string | null;
    bytes?: number | null;
    message?: TextOrMsg | null;
  }) => void;
  /** max individual "adopted" activity rows per plan (the rest is summarised) */
  activityLimit?: number;
  /** two-way adoption: digest-less Proton files up to this size are verified by content (default 64 MiB) */
  verifyMaxBytes?: number;
}

export interface PlanResult {
  jobs: number;
  conflicts: number;
  pendingDeletions: number;
  adopted: number;
  moves: number;
  folderMoves: number;
  proposals: number;
  ambiguous: number;
  byAction: Record<string, number>;
  /** two-way: deletions planned (jobs) in this pass */
  deletions: number;
  /** two-way: deletions held by the mass-delete guard (pair must be paused until approved) */
  held: number;
  heldReason: Msg | null;
  /** two-way: remote moves/renames applied to the local files */
  remoteMoves: number;
  /** two-way: conflicts handled by keeping both versions (conflict copies) */
  keptBoth: number;
}

interface Move {
  from: EntryRow; // carries the remote node (uid)
  to: EntryRow; // the local file at the new path
  adopt: boolean; // first-contact relocation (no base) vs. local move
}

const nearMs = (lUs: number | null, rMs: number | null) =>
  lUs !== null && rMs !== null && Math.abs(lUs / 1e3 - rMs) <= 2000;

export function snapshotLocal(e: EntryRow): FileSnapshot | null {
  if (!e.l_exists) return null;
  return {
    size: e.l_size ?? 0,
    mtime: new Date(Math.round((e.l_mtime_us ?? 0) / 1e3)).toISOString(),
    sha1: e.l_sha1,
  };
}
export function snapshotRemote(e: EntryRow): FileSnapshot | null {
  if (!e.r_exists) return null;
  return {
    size: e.r_size ?? 0,
    mtime: new Date(e.r_mtime_ms ?? 0).toISOString(),
    sha1: e.r_sha1,
    revisionUid: e.r_rev_uid,
  };
}
export function snapshotBase(e: EntryRow): FileSnapshot | null {
  if (!hasBase(e)) return null;
  return {
    size: e.b_size ?? 0,
    mtime: new Date(Math.round((e.b_l_mtime_us ?? 0) / 1e3)).toISOString(),
    sha1: e.b_sha1,
    revisionUid: e.b_r_rev_uid,
  };
}

/** Common-suffix split: A/x/f -> B/x/f gives ['A', 'B']; returns null when one side is the pair root. */
export function folderMapping(fromRel: string, toRel: string): [string, string] | null {
  const a = fromRel.split('/');
  const b = toRel.split('/');
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  if (k === 0) return null; // file renamed: no folder mapping
  const fa = a.slice(0, a.length - k).join('/');
  const fb = b.slice(0, b.length - k).join('/');
  if (!fa || !fb || fa === fb) return null;
  return [fa, fb];
}

export function planPair(ctx: PlanContext): PlanResult {
  const { db, pair } = ctx;
  const now = ctx.now ?? Date.now;
  const st = new Stmts(db);
  const opts = pairOptions(pair);
  const res: PlanResult = {
    jobs: 0,
    conflicts: 0,
    pendingDeletions: 0,
    adopted: 0,
    moves: 0,
    folderMoves: 0,
    proposals: 0,
    ambiguous: 0,
    byAction: {},
    deletions: 0,
    held: 0,
    heldReason: null,
    remoteMoves: 0,
    keptBoth: 0,
  };
  const twoWay = pair.direction === 'two-way';
  const adopting = twoWay && !!opts.twoWayAdoption;
  const count = (k: string) => (res.byAction[k] = (res.byAction[k] ?? 0) + 1);

  const entries = st.get('SELECT * FROM entries WHERE pair_id = ?').all(pair.id) as unknown as EntryRow[];
  const byRel = new Map(entries.map((e) => [e.rel_path, e]));
  const openJobs = new Set(
    (
      st
        .get(`SELECT entry_id FROM jobs WHERE pair_id = ? AND state IN ${OPEN_SQL} AND entry_id IS NOT NULL`)
        .all(pair.id) as {
        entry_id: number;
      }[]
    ).map((r) => r.entry_id),
  );
  // payload entry ids (move targets) are busy too
  for (const r of st
    .get(`SELECT payload FROM jobs WHERE pair_id = ? AND state IN ${OPEN_SQL} AND type IN ('move','move_local')`)
    .all(pair.id) as {
    payload: string;
  }[]) {
    const p = JSON.parse(r.payload) as JobPayload & { toEntryId?: number };
    if (p.toEntryId) openJobs.add(p.toEntryId);
  }
  const openConflicts = new Map(
    (
      st
        .get(
          'SELECT c.id, c.entry_id FROM conflicts c JOIN entries e ON e.id = c.entry_id WHERE e.pair_id = ? AND c.resolution IS NULL',
        )
        .all(pair.id) as { id: number; entry_id: number }[]
    ).map((r) => [r.entry_id, r.id]),
  );
  const openPending = new Map(
    (
      st
        .get(
          'SELECT p.id, p.entry_id, p.decision, p.side FROM pending_deletions p JOIN entries e ON e.id = p.entry_id WHERE e.pair_id = ? AND p.executed_at IS NULL',
        )
        .all(pair.id) as { id: number; entry_id: number; decision: string | null; side: string }[]
    ).map((r) => [r.entry_id, r]),
  );
  const proposals = new Map(
    (
      st
        .get(
          "SELECT entry_id, state FROM adoption_proposals WHERE pair_id = ? AND state IN ('pending','accepted','rejected')",
        )
        .all(pair.id) as { entry_id: number; state: string }[]
    ).map((r) => [r.entry_id, r.state]),
  );

  // ---------------------------------------------------------------- exclusion
  let childIndex: Map<string, Set<string>> | null = null;
  const childNames = (folder: string): Set<string> => {
    if (!childIndex) {
      childIndex = new Map();
      for (const x of entries) {
        const p = parentRel(x.rel_path);
        let set = childIndex.get(p);
        if (!set) childIndex.set(p, (set = new Set()));
        set.add(baseName(x.rel_path));
      }
    }
    return childIndex.get(folder) ?? new Set();
  };
  const exclMemo = new Map<string, boolean>();
  const excluded = (rel: string): boolean => {
    const m = exclMemo.get(rel);
    if (m !== undefined) return m;
    let v = ctx.matcher.match(rel).excluded;
    if (!v) {
      const e = byRel.get(rel);
      if (e && e.kind === 'folder' && e.state === 'excluded')
        v = heuristicExcludes(baseName(rel), childNames(parentRel(rel)));
    }
    if (!v && rel.includes('/')) v = excluded(parentRel(rel));
    exclMemo.set(rel, v);
    return v;
  };

  const actionable = (e: EntryRow) => !openJobs.has(e.id) && !excluded(e.rel_path);

  // ---------------------------------------------------------------- moves (backup and two-way pairs)
  const moves: Move[] = [];
  const claimed = new Set<number>();
  if (pair.direction === 'backup' || twoWay) {
    const gone = new Map<string, EntryRow[]>();
    const remoteOnlyBySha = new Map<string, EntryRow[]>();
    const remoteOnlyByNameSize = new Map<string, EntryRow[]>();
    const fresh: EntryRow[] = [];
    for (const e of entries) {
      if (e.kind !== 'file' || !actionable(e) || openConflicts.has(e.id)) continue;
      if (
        hasBase(e) &&
        !e.l_exists &&
        e.r_exists &&
        e.r_rev_uid === e.b_r_rev_uid &&
        !(e.flags & FLAG.KEEP_REMOTE_ONLY)
      ) {
        const sha = e.b_sha1 ?? e.l_sha1;
        if (sha && (!openPending.has(e.id) || openPending.get(e.id)!.decision === null)) push(gone, sha, e);
      } else if (!hasBase(e) && e.l_exists && !e.r_exists && e.l_sha1 && proposals.get(e.id) !== 'accepted') {
        fresh.push(e);
      } else if (!hasBase(e) && !e.l_exists && e.r_exists && e.r_uid && !twoWay) {
        // first-contact relocation (backup only): in a two-way pair the remote file stays where it is (another
        // device may use it there) and the local file is uploaded in addition
        if (e.r_sha1) push(remoteOnlyBySha, e.r_sha1, e);
        else push(remoteOnlyByNameSize, `${baseName(e.rel_path)}\0${e.r_size}`, e);
      }
    }
    for (const f of fresh) {
      let cand = (gone.get(f.l_sha1!) ?? []).filter((g) => !claimed.has(g.id) && g.l_size === f.l_size);
      const several = cand.length > 1;
      if (several) cand = cand.filter((g) => g.l_inode !== null && g.l_inode === f.l_inode && g.l_dev === f.l_dev);
      if (several && cand.length !== 1) {
        res.ambiguous++;
        continue;
      }
      let adopt = false;
      if (cand.length === 0) {
        cand = (remoteOnlyBySha.get(f.l_sha1!) ?? []).filter((g) => !claimed.has(g.id));
        if (cand.length === 0)
          cand = (remoteOnlyByNameSize.get(`${baseName(f.rel_path)}\0${f.l_size}`) ?? []).filter(
            (g) => !claimed.has(g.id) && nearMs(f.l_mtime_us, g.r_mtime_ms),
          );
        adopt = true;
      }
      if (cand.length === 1) {
        claimed.add(cand[0]!.id);
        claimed.add(f.id);
        moves.push({ from: cand[0]!, to: f, adopt });
      } else if (cand.length > 1) res.ambiguous++;
    }
  }

  // two-way: a remote move/rename keeps the node uid -> the local file is moved the same way (no trash + download)
  const remoteMoves: { from: EntryRow; to: EntryRow }[] = [];
  if (twoWay) {
    const goneByUid = new Map<string, EntryRow[]>();
    const newByUid = new Map<string, EntryRow[]>();
    for (const e of entries) {
      if (e.kind !== 'file' || claimed.has(e.id) || !actionable(e) || openConflicts.has(e.id) || !e.r_uid) continue;
      if (openPending.has(e.id)) continue;
      if (hasBase(e) && !e.r_exists && e.l_exists) push(goneByUid, e.r_uid, e);
      else if (!hasBase(e) && e.r_exists && !e.l_exists) push(newByUid, e.r_uid, e);
    }
    for (const [uid, gone] of goneByUid) {
      const to = newByUid.get(uid);
      if (gone.length !== 1 || to?.length !== 1) continue;
      claimed.add(gone[0]!.id);
      claimed.add(to[0]!.id);
      remoteMoves.push({ from: gone[0]!, to: to[0]! });
    }
  }

  // folder moves: >= 90 % of a remote folder's files reappear under one new local folder
  const folderMoves: { from: EntryRow; to: EntryRow; covered: Move[] }[] = [];
  const oldPrefixes: string[] = [];
  let rfb: Map<string, number> | null = null;
  const remoteFilesBelow = (): Map<string, number> => {
    if (rfb) return rfb;
    rfb = new Map();
    for (const e of entries) {
      if (e.kind !== 'file' || !e.r_exists) continue;
      let p = parentRel(e.rel_path);
      while (p) {
        rfb.set(p, (rfb.get(p) ?? 0) + 1);
        p = parentRel(p);
      }
    }
    return rfb;
  };
  if (moves.length) {
    const groups = new Map<string, Move[]>();
    for (const m of moves) {
      const fm = folderMapping(m.from.rel_path, m.to.rel_path);
      if (fm) push(groups, `${fm[0]}\0${fm[1]}`, m);
    }
    const sorted = [...groups.entries()].sort((a, b) => a[0].split('\0')[0]!.length - b[0].split('\0')[0]!.length);
    for (const [key, ms] of sorted) {
      const [fa, fb] = key.split('\0') as [string, string];
      if (oldPrefixes.some((p) => fa === p || fa.startsWith(p + '/'))) continue; // inside a folder that moves anyway
      const fromF = byRel.get(fa);
      const toF = byRel.get(fb);
      if (!fromF || !toF || fromF.kind !== 'folder' || toF.kind !== 'folder') continue;
      if (!fromF.r_exists || !fromF.r_uid || fromF.l_exists || !toF.l_exists || toF.r_exists) continue;
      if (openJobs.has(fromF.id) || openJobs.has(toF.id)) continue;
      const remoteFiles = remoteFilesBelow().get(fa) ?? 0;
      if (remoteFiles === 0 || ms.length < 0.9 * remoteFiles) continue;
      folderMoves.push({ from: fromF, to: toF, covered: ms });
      oldPrefixes.push(fa);
    }
  }
  const coveredMoves = new Set(folderMoves.flatMap((f) => f.covered));
  const underOld = (rel: string) => oldPrefixes.some((p) => rel === p || rel.startsWith(p + '/'));
  const newPrefixMap = new Map(folderMoves.map((f) => [f.to.rel_path, f.from.rel_path]));
  /** folder at the new location whose counterpart moves with the folder move */
  const coveredNewFolder = (rel: string): boolean => {
    for (const [nb, oa] of newPrefixMap) {
      if (rel === nb) return true;
      if (rel.startsWith(nb + '/')) {
        const old = byRel.get(oa + rel.slice(nb.length));
        if (old && old.kind === 'folder' && old.r_exists) return true;
      }
    }
    return false;
  };

  // ---------------------------------------------------------------- apply
  const t = now();
  const activityLimit = ctx.activityLimit ?? 200;
  let adoptedLogged = 0;
  const setState = st.get('UPDATE entries SET state = ?, updated_at = ? WHERE id = ? AND state != ?');
  const job = (
    e: EntryRow,
    type: Parameters<typeof insertJob>[1]['type'],
    payload: JobPayload,
    bytes: number | null,
    priority?: number,
  ) => {
    const r = insertJob(
      db,
      {
        runId: ctx.runId,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: e.id,
        type,
        payload,
        bytes,
        priority: priority ?? priorityFor(type, bytes),
        dedupeKey: `${type}:${pair.id}:${payload.fromRel ?? payload.rel}`,
      },
      t,
    );
    if (r.created) {
      res.jobs++;
      count(type);
    }
    openJobs.add(e.id);
  };
  const filePayload = (e: EntryRow): JobPayload => ({
    rel: e.rel_path,
    kind: e.kind,
    parentRel: parentRel(e.rel_path),
    name: baseName(e.rel_path),
    size: e.l_size,
    mtimeUs: e.l_mtime_us,
    sha1: e.l_sha1,
    uid: e.r_uid,
    expectedRevUid: e.r_exists ? e.r_rev_uid : null,
    remoteSha1: e.r_sha1,
    remoteMtimeMs: e.r_mtime_ms,
  });
  const conflict = (e: EntryRow, kind: ConflictKind) => {
    if (!openConflicts.has(e.id)) {
      const r = st
        .get(
          'INSERT INTO conflicts (entry_id, kind, detected_at, local_snapshot, remote_snapshot, base_snapshot) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          e.id,
          kind,
          t,
          JSON.stringify(snapshotLocal(e)),
          JSON.stringify(snapshotRemote(e)),
          JSON.stringify(snapshotBase(e)),
        );
      openConflicts.set(e.id, Number(r.lastInsertRowid));
      res.conflicts++;
      ctx.activity?.({ action: 'conflict', relPath: e.rel_path, bytes: e.l_size ?? e.r_size, message: kind });
    }
    setState.run('conflict', t, e.id, 'conflict');
  };
  /**
   * two-way: the engine already acted on a conflict (restored the side that deleted a file the other side changed);
   * the case is listed for review only and does not block the entry (resolution set, needs_review = 1)
   */
  const reviewConflict = (e: EntryRow, kind: ConflictKind, resolution: 'keep_local' | 'keep_remote') => {
    // listed once per case (a cancelled restore that is planned again does not add a second review item)
    if (st.get('SELECT 1 FROM conflicts WHERE entry_id = ? AND kind = ? AND needs_review = 1').get(e.id, kind)) return;
    st.get(
      `INSERT INTO conflicts (entry_id, kind, detected_at, local_snapshot, remote_snapshot, base_snapshot, resolution, resolved_at,
       resolved_by, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', 1)`,
    ).run(
      e.id,
      kind,
      t,
      JSON.stringify(snapshotLocal(e)),
      JSON.stringify(snapshotRemote(e)),
      JSON.stringify(snapshotBase(e)),
      resolution,
      t,
    );
    res.conflicts++;
    ctx.activity?.({
      action: 'conflict',
      relPath: e.rel_path,
      bytes: e.l_size ?? e.r_size,
      message: msg(
        kind === 'remote_changed_local_deleted' ? 'activity.restoredFromProton' : 'activity.reuploadedLocal',
      ),
    });
  };
  const adopt = (e: EntryRow, digestMissing: boolean, quiet = false) => {
    let flags = e.flags & ~FLAG.CONFLICT_IGNORED;
    if (digestMissing) flags |= FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME;
    else if (e.r_sha1) flags &= ~(FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME);
    st.get(
      `UPDATE entries SET b_sha1 = ?, b_size = ?, b_l_mtime_us = ?, b_r_rev_uid = ?, synced_at = ?, state = 'synced', flags = ?,
       last_error = NULL, updated_at = ? WHERE id = ?`,
    ).run(e.l_sha1 ?? e.r_sha1, e.l_size ?? e.r_size, e.l_mtime_us, e.r_rev_uid, t, flags, t, e.id);
    if (e.kind === 'file' && !quiet) {
      res.adopted++;
      if (adoptedLogged++ < activityLimit)
        ctx.activity?.({
          action: 'adopted',
          relPath: e.rel_path,
          bytes: e.l_size,
          message: msg(digestMissing ? 'activity.adoptedNoChecksum' : 'activity.adopted'),
        });
    }
  };

  const apply = (e: EntryRow, a: Action, L: string, R: string) => {
    switch (a.kind) {
      case 'noop':
        setState.run(a.state, t, e.id, a.state);
        return;
      case 'forget':
        st.get('DELETE FROM entries WHERE id = ?').run(e.id);
        return;
      case 'adopt':
        adopt(e, a.digestMissing, L !== 'new');
        return;
      case 'accept_remote':
        st.get("UPDATE entries SET b_r_rev_uid = r_rev_uid, state = 'synced', updated_at = ? WHERE id = ?").run(
          t,
          e.id,
        );
        return;
      case 'conflict':
        conflict(e, a.conflict);
        return;
      case 'pending_deletion': {
        if (!openPending.has(e.id)) {
          st.get(
            'INSERT INTO pending_deletions (entry_id, detected_at, size, remote_rev_uid_at_detect) VALUES (?, ?, ?, ?)',
          ).run(e.id, t, e.b_size ?? e.l_size ?? e.r_size ?? 0, e.b_r_rev_uid);
          res.pendingDeletions++;
          ctx.activity?.({
            action: 'deletion_pending',
            relPath: e.rel_path,
            bytes: e.b_size,
            message: msg(a.remoteChanged ? 'activity.deletionPendingChanged' : 'activity.deletionPending'),
          });
        }
        setState.run('pending_remote_delete', t, e.id, 'pending_remote_delete');
        return;
      }
      case 'upload':
        job(
          e,
          'upload',
          pair.direction === 'mirror-down'
            ? { ...filePayload(e), fromPc: true }
            : twoWay
              ? { ...filePayload(e), twoWay: true }
              : filePayload(e),
          e.l_size,
        );
        setState.run(R === 'deleted' ? 'remote_deleted' : 'local_new', t, e.id, '');
        return;
      case 'upload_revision':
        job(
          e,
          'upload_revision',
          { ...filePayload(e), expectedRevUid: a.force ? e.r_rev_uid : e.b_r_rev_uid, force: !!a.force },
          e.l_size,
        );
        setState.run('local_changed', t, e.id, 'local_changed');
        return;
      case 'download':
        job(e, 'download', { ...filePayload(e), replace: a.replace, ...(twoWay ? { twoWay: true } : {}) }, e.r_size);
        setState.run(R === 'new' ? 'remote_new' : 'remote_changed', t, e.id, '');
        return;
      case 'trash_local':
        job(
          e,
          'trash_local',
          e.kind === 'folder'
            ? { rel: e.rel_path, kind: 'folder', twoWay: true }
            : { ...filePayload(e), ...(twoWay ? { twoWay: true } : {}) },
          e.l_size,
          e.kind === 'folder' ? PRIORITY_FOLDER_DELETE.trash_local : undefined,
        );
        if (twoWay) res.deletions++;
        setState.run('remote_deleted', t, e.id, 'remote_deleted');
        return;
      case 'mkdir':
        job(
          e,
          'mkdir',
          { rel: e.rel_path, kind: 'folder', parentRel: parentRel(e.rel_path), name: baseName(e.rel_path) },
          null,
        );
        setState.run('local_new', t, e.id, 'local_new');
        return;
      case 'mkdir_local':
        job(e, 'download', { rel: e.rel_path, kind: 'folder', uid: e.r_uid }, null);
        setState.run('remote_new', t, e.id, 'remote_new');
        return;
      // ---- two-way
      case 'trash_remote':
        job(
          e,
          'trash_remote',
          {
            rel: e.rel_path,
            kind: e.kind,
            uid: e.r_uid,
            expectedRevUid: e.r_rev_uid,
            size: e.b_size ?? e.r_size,
            parentRel: parentRel(e.rel_path),
            name: baseName(e.rel_path),
            twoWay: true,
          },
          e.r_size,
          e.kind === 'folder' ? PRIORITY_FOLDER_DELETE.trash_remote : undefined,
        );
        res.deletions++;
        setState.run('pending_remote_delete', t, e.id, 'pending_remote_delete');
        return;
      case 'conflict_copy':
        job(e, 'conflict_copy', { ...filePayload(e), conflictKind: a.conflict, twoWay: true }, e.l_size);
        setState.run('conflict', t, e.id, 'conflict');
        res.keptBoth++;
        return;
      case 'verify':
        if ((e.r_size ?? 0) <= (ctx.verifyMaxBytes ?? TWO_WAY_DEFAULTS.verifyMaxBytes))
          job(e, 'verify_content', { ...filePayload(e), twoWay: true }, e.r_size);
        else conflict(e, 'needs_check'); // too big to download just for a check: the user decides, nothing written
        return;
      case 'restore':
        if (a.to === 'local') {
          job(e, 'download', { ...filePayload(e), replace: false, twoWay: true }, e.r_size);
          setState.run('remote_changed', t, e.id, 'remote_changed');
          if (a.review) reviewConflict(e, a.review, 'keep_remote');
        } else {
          job(e, 'upload', { ...filePayload(e), uid: null, expectedRevUid: null, twoWay: true }, e.l_size);
          setState.run('remote_deleted', t, e.id, 'remote_deleted');
          if (a.review) reviewConflict(e, a.review, 'keep_local');
        }
        return;
    }
  };

  tx(db, () => {
    // moves first
    for (const fm of folderMoves) {
      job(
        fm.from,
        'move',
        {
          rel: fm.from.rel_path,
          kind: 'folder',
          uid: fm.from.r_uid,
          fromRel: fm.from.rel_path,
          toRel: fm.to.rel_path,
          folderMove: true,
          parentRel: parentRel(fm.to.rel_path),
          name: baseName(fm.to.rel_path),
          ...({ toEntryId: fm.to.id } as object),
        },
        null,
      );
      openJobs.add(fm.to.id);
      res.folderMoves++;
      for (const m of fm.covered) {
        setState.run('moved', t, m.from.id, 'moved');
        setState.run('moved', t, m.to.id, 'moved');
      }
    }
    for (const m of moves) {
      if (coveredMoves.has(m)) continue;
      if (underOld(m.from.rel_path)) {
        // the remote node moves with its folder first; it is re-planned afterwards
        continue;
      }
      job(
        m.from,
        'move',
        {
          rel: m.from.rel_path,
          kind: 'file',
          uid: m.from.r_uid,
          fromRel: m.from.rel_path,
          toRel: m.to.rel_path,
          parentRel: parentRel(m.to.rel_path),
          name: baseName(m.to.rel_path),
          sha1: m.to.l_sha1,
          size: m.to.l_size,
          mtimeUs: m.to.l_mtime_us,
          expectedRevUid: m.from.r_rev_uid,
          ...({ toEntryId: m.to.id, adopt: m.adopt } as object),
        },
        m.to.l_size,
      );
      openJobs.add(m.to.id);
      res.moves++;
      setState.run('moved', t, m.from.id, 'moved');
      setState.run('moved', t, m.to.id, 'moved');
    }

    // two-way: deletions are collected first (mass-delete guard), folders are decided after their files
    const deletionQueue: { e: EntryRow; a: Action; side: 'local' | 'remote' }[] = [];
    const twoWayFolders: EntryRow[] = [];
    for (const e of entries) {
      if (claimed.has(e.id) || openJobs.has(e.id)) continue;
      if (excluded(e.rel_path)) {
        setState.run('excluded', t, e.id, 'excluded');
        continue;
      }
      if (underOld(e.rel_path)) continue; // re-planned after the folder move
      if (e.kind === 'folder' && twoWay) {
        twoWayFolders.push(e);
        continue;
      }
      if (e.kind === 'folder') {
        if (coveredNewFolder(e.rel_path)) continue;
        const pend = openPending.get(e.id);
        if (pend && e.l_exists) {
          st.get('DELETE FROM pending_deletions WHERE id = ?').run(pend.id);
          openPending.delete(e.id);
        } else if (pend && pend.decision === null) {
          if (!e.r_exists) {
            st.get('DELETE FROM entries WHERE id = ?').run(e.id);
          }
          continue;
        }
        apply(e, decideFolder(pair.direction, !!e.l_exists, !!e.r_exists, hasBase(e)), '', '');
        continue;
      }
      if (e.state === 'unsupported' || e.flags & FLAG.UNSUPPORTED) {
        setState.run('unsupported', t, e.id, 'unsupported');
        continue;
      }
      // open conflict: wait for the user unless both sides became identical meanwhile
      if (openConflicts.has(e.id)) {
        if (e.l_exists && e.r_exists && contentEq(e) === 'yes') {
          st.get("UPDATE conflicts SET resolution = 'ignore', resolved_at = ?, resolved_by = 'auto' WHERE id = ?").run(
            t,
            openConflicts.get(e.id)!,
          );
          openConflicts.delete(e.id);
          adopt(e, false, true);
        }
        continue;
      }
      if (e.flags & FLAG.DUPLICATE_REMOTE_NAME) {
        conflict(e, 'duplicate_remote_name');
        continue;
      }
      // pending deletion: undone (the file is back on the side that deleted it) or gone on both sides; otherwise
      // wait for the decision. side 'remote' = deleted in Proton (two-way, held by the mass-delete guard)
      const pend = openPending.get(e.id);
      if (pend && twoWay && pend.decision !== null) {
        // two-way: decided, but its job is gone (cancelled because the file changed, or failed): the decision no
        // longer applies -> the entry is decided again from scratch (e.g. changed here + deleted there -> restore)
        st.get('DELETE FROM pending_deletions WHERE id = ?').run(pend.id);
        openPending.delete(e.id);
      } else if (pend) {
        const remoteSide = pend.side === 'remote';
        if (remoteSide ? e.r_exists : e.l_exists) {
          st.get('DELETE FROM pending_deletions WHERE id = ?').run(pend.id);
          openPending.delete(e.id);
        } else if (remoteSide ? !e.l_exists : !e.r_exists) {
          st.get('DELETE FROM entries WHERE id = ?').run(e.id);
          continue;
        } else continue;
      }
      if (e.flags & FLAG.KEEP_REMOTE_ONLY && !e.l_exists) continue;
      const L = localDelta(e);
      const R = remoteDelta(e);
      if (L === 'new' && !e.l_sha1) continue; // not hashed yet (too fresh)
      const fileOpts =
        pair.direction === 'mirror-down' && opts.uploadLocalNew
          ? { ...opts, uploadLocalNew: L === 'new' && uploadsFromPc(e, opts.uploadLocalNewSince) }
          : opts;
      let action = decideFile(pair.direction, L, R, contentEq(e), fileOpts, {
        digestlessSameSize: !e.r_sha1 && !!e.r_exists && e.l_size !== null && e.l_size === e.r_size,
        adopting,
      });
      if (twoWay && (action.kind === 'trash_remote' || action.kind === 'trash_local')) {
        deletionQueue.push({ e, a: action, side: action.kind === 'trash_remote' ? 'local' : 'remote' });
        continue;
      }
      if (action.kind === 'upload' && L === 'new' && R === 'absent' && pair.direction !== 'mirror-down') {
        const prop = proposals.get(e.id);
        if (prop === 'pending' || prop === 'accepted') {
          setState.run('local_new', t, e.id, 'local_new');
          continue;
        }
        if (prop !== 'rejected' && proposeAdoption(ctx, st, e, t, res)) {
          setState.run('local_new', t, e.id, 'local_new');
          continue;
        }
      }
      if (action.kind === 'noop' && action.state === 'error')
        action = { kind: 'noop', state: e.state === 'synced' ? 'error' : e.state };
      apply(e, action, L, R);
    }
    if (!twoWay) return;

    // ---- two-way: remote moves/renames -> the local file follows (one rename, no trash + download)
    for (const m of remoteMoves) {
      job(
        m.from,
        'move_local',
        {
          rel: m.from.rel_path,
          kind: 'file',
          fromRel: m.from.rel_path,
          toRel: m.to.rel_path,
          size: m.from.l_size,
          mtimeUs: m.from.l_mtime_us,
          sha1: m.from.l_sha1,
          uid: m.to.r_uid,
          twoWay: true,
          ...({ toEntryId: m.to.id } as object),
        },
        m.from.l_size,
      );
      openJobs.add(m.to.id);
      res.remoteMoves++;
      setState.run('moved', t, m.from.id, 'moved');
      setState.run('moved', t, m.to.id, 'moved');
    }

    // ---- two-way: mass-delete guard. Too many deletions in one run -> nothing is deleted, every deletion is held
    // (pending_deletions.held = 1) and the engine pauses the pair (safety brake) until approved or denied.
    if (deletionQueue.length) {
      const tracked = (
        st
          .get("SELECT COUNT(*) AS n FROM entries WHERE pair_id = ? AND kind = 'file' AND synced_at IS NOT NULL")
          .get(pair.id) as { n: number }
      ).n;
      const n = deletionQueue.length;
      const max = opts.massDeleteMaxFiles ?? TWO_WAY_DEFAULTS.massDeleteMaxFiles;
      const pct = opts.massDeletePercent ?? TWO_WAY_DEFAULTS.massDeletePercent;
      const trip = n > max || (n >= TWO_WAY_DEFAULTS.massDeleteMinFiles && n > (pct / 100) * tracked);
      if (!trip) for (const d of deletionQueue) apply(d.e, d.a, '', '');
      else {
        const ins = st.get(
          'INSERT INTO pending_deletions (entry_id, detected_at, size, remote_rev_uid_at_detect, side, held) VALUES (?, ?, ?, ?, ?, 1)',
        );
        let local = 0;
        for (const d of deletionQueue) {
          ins.run(d.e.id, t, d.e.b_size ?? d.e.l_size ?? d.e.r_size ?? 0, d.e.r_rev_uid ?? d.e.b_r_rev_uid, d.side);
          openPending.set(d.e.id, { id: 0, entry_id: d.e.id, decision: null, side: d.side });
          setState.run(
            d.side === 'local' ? 'pending_remote_delete' : 'remote_deleted',
            t,
            d.e.id,
            d.side === 'local' ? 'pending_remote_delete' : 'remote_deleted',
          );
          if (d.side === 'local') local++;
        }
        res.held = n;
        res.pendingDeletions += n;
        res.heldReason = msg('brake.massDeleteHeld', { count: n, tracked, local, remote: n - local });
      }
    }

    // ---- two-way folders (after their files): a folder deleted on one side is removed on the other only when
    // nothing below it stays there (and the executor removes it only when it is really empty)
    const localTrash = new Set<string>();
    const remoteTrash = new Set<string>();
    if (!res.held) for (const d of deletionQueue) (d.side === 'remote' ? localTrash : remoteTrash).add(d.e.rel_path);
    for (const r of st
      .get(
        `SELECT j.type, e.rel_path FROM jobs j JOIN entries e ON e.id = j.entry_id WHERE j.pair_id = ? AND j.state IN ${OPEN_SQL}
         AND j.type IN ('trash_local','trash_remote')`,
      )
      .all(pair.id) as { type: string; rel_path: string }[])
      (r.type === 'trash_local' ? localTrash : remoteTrash).add(r.rel_path);
    const keepLocal = new Set<string>();
    const keepRemote = new Set<string>();
    const addAncestors = (set: Set<string>, rel: string) => {
      for (let p = parentRel(rel); p && !set.has(p); p = parentRel(p)) set.add(p);
    };
    for (const e of entries) {
      if (e.kind === 'folder' && e.state !== 'excluded') continue;
      if (e.l_exists && !localTrash.has(e.rel_path)) addAncestors(keepLocal, e.rel_path);
      if (e.r_exists && !remoteTrash.has(e.rel_path)) addAncestors(keepRemote, e.rel_path);
    }
    for (const e of twoWayFolders) {
      if (coveredNewFolder(e.rel_path)) continue;
      const a = decideFolder('two-way', !!e.l_exists, !!e.r_exists, hasBase(e), { adopting });
      if (a.kind === 'trash_local' && (res.held || keepLocal.has(e.rel_path))) {
        setState.run('remote_deleted', t, e.id, 'remote_deleted'); // recreated by the uploads below it
        continue;
      }
      if (a.kind === 'trash_remote' && (res.held || keepRemote.has(e.rel_path))) {
        setState.run('pending_remote_delete', t, e.id, 'pending_remote_delete'); // recreated by the downloads
        continue;
      }
      apply(e, a, '', '');
    }
  });
  if (res.adopted > adoptedLogged)
    ctx.activity?.({ action: 'adopted', message: msg('activity.adoptedMore', { count: res.adopted - adoptedLogged }) });
  return res;
}

/**
 * Conflict copies the engine itself writes next to mirrored files (they stay on the PC, never uploaded). "lokal
 * geändert" is the label of copies written by earlier versions (still recognised).
 */
export const CONFLICT_COPY_RE = / \((?:local edit|lokal geändert|Proton) \d{4}-\d{2}-\d{2}[^)]*\)(?:\.[^./]*)?$/;

/**
 * mirror-down + uploadLocalNew: does this local-only file qualify for an upload? It must have been created (or
 * renamed/moved) locally after the option was switched on — ctime, which every create/rename/copy updates — so a
 * pre-existing local tree is never pushed into Proton; and it must not be one of the engine's own conflict copies.
 */
export function uploadsFromPc(e: EntryRow, sinceMs: number | undefined): boolean {
  if (e.kind !== 'file' || !e.l_exists) return false;
  const name = baseName(e.rel_path);
  if (CONFLICT_COPY_RE.test(name)) return false;
  if (sinceMs !== undefined && (e.l_ctime_us === null || e.l_ctime_us / 1e3 < sinceMs)) return false;
  return true;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/**
 * Looks up identical content outside the pair: adoption sources (remote_index) and remote-only entries of disabled
 * pairs of the same account. A unique, unclaimed hit becomes a pending proposal (needs approval, docs/SYNC-RULES.md).
 */
function proposeAdoption(ctx: PlanContext, st: Stmts, e: EntryRow, t: number, res: PlanResult): boolean {
  const acc = ctx.pair.account_id;
  type Hit = {
    uid: string;
    section: string;
    path: string;
    size: number | null;
    by: 'sha1' | 'name_size_mtime';
    entryId: number | null;
  };
  const hits: Hit[] = [];
  const idx = st
    .get('SELECT uid, section, path, size, mtime_ms, sha1 FROM remote_index WHERE account_id = ? AND sha1 = ?')
    .all(acc, e.l_sha1) as { uid: string; section: string; path: string; size: number | null }[];
  for (const r of idx) hits.push({ ...r, by: 'sha1', entryId: null });
  const other = st
    .get(
      `SELECT e.id, e.r_uid, e.rel_path, e.r_size, p.remote_section, p.remote_root FROM entries e JOIN pairs p ON p.id = e.pair_id
       WHERE p.account_id = ? AND p.enabled = 0 AND p.id != ? AND e.r_sha1 = ? AND e.r_exists = 1 AND e.l_exists = 0`,
    )
    .all(acc, ctx.pair.id, e.l_sha1) as {
    id: number;
    r_uid: string;
    rel_path: string;
    r_size: number;
    remote_section: string;
    remote_root: string;
  }[];
  for (const r of other)
    hits.push({
      uid: r.r_uid,
      section: r.remote_section,
      path: `${r.remote_root}/${r.rel_path}`,
      size: r.r_size,
      by: 'sha1',
      entryId: r.id,
    });
  if (!hits.length) {
    const name = baseName(e.rel_path);
    const byName = st
      .get(
        'SELECT uid, section, path, size, mtime_ms FROM remote_index WHERE account_id = ? AND name = ? AND size = ? AND sha1 IS NULL',
      )
      .all(acc, name, e.l_size) as {
      uid: string;
      section: string;
      path: string;
      size: number;
      mtime_ms: number | null;
    }[];
    for (const r of byName)
      if (nearMs(e.l_mtime_us, r.mtime_ms))
        hits.push({ uid: r.uid, section: r.section, path: r.path, size: r.size, by: 'name_size_mtime', entryId: null });
  }
  const unclaimed = hits.filter(
    (h) =>
      !st
        .get("SELECT 1 FROM adoption_proposals WHERE source_uid = ? AND state IN ('pending','accepted','done')")
        .get(h.uid),
  );
  const uniq = new Map(unclaimed.map((h) => [h.uid, h]));
  if (uniq.size !== 1) {
    if (uniq.size > 1) res.ambiguous++;
    return false;
  }
  const h = [...uniq.values()][0]!;
  st.get(
    `INSERT OR IGNORE INTO adoption_proposals (account_id, pair_id, entry_id, target_rel_path, source_remote_path, source_uid, source_section,
       source_entry_id, size, matched_by, outside_pair, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(acc, ctx.pair.id, e.id, e.rel_path, h.path, h.uid, h.section, h.entryId, e.l_size ?? h.size ?? 0, h.by, t);
  res.proposals++;
  return true;
}
