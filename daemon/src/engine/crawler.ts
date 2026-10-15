// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Remote crawler (ARCHITECTURE §4.3 step 2, docs/SYNC-RULES.md). Lists folders through the account's CLI pool and upserts
 * entries.r_* and remote_folders. Modes:
 *   full         every folder of the pair
 *   incremental  root + hot folders + parents of locally changed entries + a rotating slice of the least recently
 *                listed folders (budget) + every newly discovered folder; small pairs (< smallPairFolders) are always
 *                listed completely
 * A listing that failed never implies deletions: only children missing from a SUCCESSFUL listing become r_exists=0.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { belowRange, FLAG, joinRel, Stmts, tx, type PairRow } from '../db/repo.ts';
import { errorClassOf, type RemoteNode, type RemoteOps } from './remote.ts';
import type { RuleMatcher } from './rules.ts';

export interface CrawlOptions {
  db: DatabaseSync;
  pair: PairRow;
  rootUid: string;
  crawlId: number;
  mode: 'incremental' | 'full' | 'verify';
  remote: RemoteOps;
  matcher: RuleMatcher;
  /** extra folders to list (rel paths), e.g. parents of locally changed entries */
  extraFolders?: Iterable<string>;
  /**
   * a priority (interactive pair) run lists only the root, `extraFolders` and folders it newly
   * discovers there — no full crawl, no hot folders, no rotating slice. Remote changes elsewhere are picked up by the
   * next background run; nothing is concluded about folders that were not listed.
   */
  targeted?: boolean;
  sliceBudget?: number;
  timeBudgetMs?: number;
  smallPairFolders?: number;
  hotDays?: number;
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => number;
  onListed?: () => void;
}

export interface CrawlResult {
  status: 'ok' | 'partial' | 'root_missing' | 'aborted';
  listed: number;
  failed: number;
  files: number;
  folders: number;
  rootEmpty: boolean;
  errors: string[];
  durationMs: number;
}

interface FolderTask {
  rel: string;
  uid: string;
}

export async function crawlRemote(o: CrawlOptions): Promise<CrawlResult> {
  const t0 = Date.now();
  const now = o.now ?? Date.now;
  const st = new Stmts(o.db);
  const res: CrawlResult = {
    status: 'ok',
    listed: 0,
    failed: 0,
    files: 0,
    folders: 0,
    rootEmpty: false,
    errors: [],
    durationMs: 0,
  };
  const pairId = o.pair.id;

  const known = new Map<string, { uid: string; last: number | null; hot: number }>();
  for (const r of st
    .get('SELECT rel_path, uid, last_listed_at, hot FROM remote_folders WHERE pair_id = ?')
    .all(pairId) as {
    rel_path: string;
    uid: string;
    last_listed_at: number | null;
    hot: number;
  }[])
    known.set(r.rel_path, { uid: r.uid, last: r.last_listed_at, hot: r.hot });
  const firstContact = !known.has('') || known.get('')!.last === null;
  if (!known.has('')) {
    st.get('INSERT OR REPLACE INTO remote_folders (pair_id, rel_path, uid) VALUES (?, ?, ?)').run(
      pairId,
      '',
      o.rootUid,
    );
  }
  known.set('', { uid: o.rootUid, last: known.get('')?.last ?? null, hot: known.get('')?.hot ?? 0 });

  const full =
    !o.targeted &&
    (o.mode !== 'incremental' ||
      firstContact ||
      known.size < (o.smallPairFolders ?? 2000) ||
      o.pair.direction === 'mirror-down');
  const queue: FolderTask[] = [];
  const queued = new Set<string>();
  const enqueue = (rel: string, uid: string) => {
    if (queued.has(rel)) return;
    // a sub folder owned by a nested pair is that pair's business (never listed by the outer pair)
    if (rel && o.matcher.match(rel).by === 'pair') return;
    queued.add(rel);
    queue.push({ rel, uid });
  };
  enqueue('', o.rootUid);
  if (!full) {
    const t = now();
    if (!o.targeted) for (const [rel, k] of known) if (k.hot > t) enqueue(rel, k.uid);
    for (const rel of o.extraFolders ?? []) {
      // nearest known ancestor of a locally changed path
      let r = rel;
      for (;;) {
        const k = known.get(r);
        if (k) {
          enqueue(r, k.uid);
          break;
        }
        if (!r) break;
        const i = r.lastIndexOf('/');
        r = i < 0 ? '' : r.slice(0, i);
      }
    }
    const slice = [...known.entries()]
      .filter(([rel]) => !queued.has(rel))
      .sort((a, b) => (a[1].last ?? 0) - (b[1].last ?? 0))
      .slice(0, o.targeted ? 0 : (o.sliceBudget ?? 600));
    for (const [rel, k] of slice) enqueue(rel, k.uid);
  }

  const deadline = full ? Infinity : t0 + (o.timeBudgetMs ?? 15 * 60_000);
  const hotUntil = () => now() + (o.hotDays ?? 7) * 86400_000;

  const upsertFile =
    st.get(`INSERT INTO entries (pair_id, rel_path, kind, r_exists, r_uid, r_parent_uid, r_rev_uid, r_size, r_mtime_ms,
      r_sha1, r_storage, r_rev_storage, r_media_type, r_seen_crawl, state, flags, updated_at)
    VALUES (?, ?, 'file', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pair_id, rel_path) DO UPDATE SET r_exists = 1, r_uid = excluded.r_uid, r_parent_uid = excluded.r_parent_uid,
      r_rev_uid = excluded.r_rev_uid, r_size = excluded.r_size, r_mtime_ms = excluded.r_mtime_ms, r_sha1 = excluded.r_sha1,
      r_storage = excluded.r_storage, r_rev_storage = excluded.r_rev_storage, r_media_type = excluded.r_media_type,
      r_seen_crawl = excluded.r_seen_crawl,
      flags = (entries.flags & ~${FLAG.DUPLICATE_REMOTE_NAME | FLAG.UNSUPPORTED}) | excluded.flags,
      state = CASE WHEN excluded.state = 'unsupported' THEN 'unsupported'
                   WHEN entries.state = 'unsupported' AND entries.kind = 'file' THEN 'synced' ELSE entries.state END,
      updated_at = excluded.updated_at`);
  const upsertFolder =
    st.get(`INSERT INTO entries (pair_id, rel_path, kind, r_exists, r_uid, r_parent_uid, r_seen_crawl, state, updated_at)
    VALUES (?, ?, 'folder', 1, ?, ?, ?, ?, ?)
    ON CONFLICT (pair_id, rel_path) DO UPDATE SET r_exists = 1, r_uid = excluded.r_uid, r_parent_uid = excluded.r_parent_uid,
      r_seen_crawl = excluded.r_seen_crawl,
      state = CASE WHEN excluded.state = 'excluded' AND entries.l_exists = 0 THEN 'excluded' ELSE entries.state END,
      updated_at = excluded.updated_at`);
  const upsertRf = st.get(`INSERT INTO remote_folders (pair_id, rel_path, uid) VALUES (?, ?, ?)
    ON CONFLICT (pair_id, rel_path) DO UPDATE SET uid = excluded.uid`);

  const applyListing = (task: FolderTask, nodes: RemoteNode[]) => {
    const t = now();
    const seen = new Set<string>();
    const names = new Set(nodes.filter((n) => n.name !== null && !n.trashed).map((n) => n.name!));
    const siblingsOf = (folderRel: string) => (folderRel === task.rel ? names : undefined);
    const hash = createHash('sha1');
    const prev = st
      .get('SELECT listing_hash FROM remote_folders WHERE pair_id = ? AND rel_path = ?')
      .get(pairId, task.rel) as { listing_hash: string | null } | undefined;
    const sorted = [...nodes].sort((a, b) => (a.uid < b.uid ? -1 : 1));
    for (const n of sorted) hash.update(`${n.uid}|${n.rev?.uid ?? ''}|${n.name ?? ''}\n`);
    const listingHash = hash.digest('hex');
    const newFolders: FolderTask[] = [];
    tx(o.db, () => {
      for (const n of nodes) {
        if (n.trashed || n.name === null) continue; // undecryptable names are addressed by uid only (not tracked)
        const rel = joinRel(task.rel, n.name);
        const dup = seen.has(rel);
        if (dup) {
          st.get(
            `UPDATE entries SET flags = flags | ${FLAG.DUPLICATE_REMOTE_NAME} WHERE pair_id = ? AND rel_path = ?`,
          ).run(pairId, rel);
          continue; // first node wins; the planner raises a duplicate_remote_name conflict
        }
        seen.add(rel);
        const m = o.matcher.match(rel, siblingsOf);
        if (n.type === 'folder') {
          res.folders++;
          upsertFolder.run(pairId, rel, n.uid, task.uid, o.crawlId, m.excluded ? 'excluded' : 'synced', t);
          if (m.excluded) continue;
          upsertRf.run(pairId, rel, n.uid);
          const k = known.get(rel);
          if (!k || k.uid !== n.uid || full) newFolders.push({ rel, uid: n.uid });
          if (!k) known.set(rel, { uid: n.uid, last: null, hot: 0 });
        } else if (n.type === 'file') {
          if (m.excluded) continue;
          res.files++;
          const r = n.rev!;
          upsertFile.run(
            pairId,
            rel,
            n.uid,
            task.uid,
            r.uid,
            r.size,
            r.mtimeMs,
            r.sha1,
            n.totalStorageSize,
            r.storageSize,
            n.mediaType,
            o.crawlId,
            n.isProtonDoc ? 'unsupported' : 'synced',
            n.isProtonDoc ? FLAG.UNSUPPORTED : 0,
            t,
          );
        }
      }
      // children known under this folder but missing from the (successful) listing are gone remotely — except
      // nodes still listed under a name that cannot be decrypted right now (same uid): unknown, not deleted
      const unnamed = new Set(nodes.filter((n) => n.name === null && !n.trashed).map((n) => n.uid));
      const gone = st
        .get('SELECT id, rel_path, kind, r_uid FROM entries WHERE pair_id = ? AND r_parent_uid = ? AND r_exists = 1')
        .all(pairId, task.uid) as { id: number; rel_path: string; kind: string; r_uid: string | null }[];
      for (const g of gone) {
        if (seen.has(g.rel_path) || (g.r_uid && unnamed.has(g.r_uid))) continue;
        st.get('UPDATE entries SET r_exists = 0, r_seen_crawl = ?, updated_at = ? WHERE id = ?').run(
          o.crawlId,
          t,
          g.id,
        );
        if (g.kind === 'folder') {
          const [a, b] = belowRange(g.rel_path);
          st.get(
            'UPDATE entries SET r_exists = 0, r_seen_crawl = ?, updated_at = ? WHERE pair_id = ? AND rel_path >= ? AND rel_path < ? AND r_exists = 1',
          ).run(o.crawlId, t, pairId, a, b);
          st.get(
            'DELETE FROM remote_folders WHERE pair_id = ? AND (rel_path = ? OR (rel_path >= ? AND rel_path < ?))',
          ).run(pairId, g.rel_path, a, b);
          known.delete(g.rel_path);
        }
      }
      const changed = prev?.listing_hash && prev.listing_hash !== listingHash;
      st.get(
        `UPDATE remote_folders SET last_listed_at = ?, listing_hash = ?, child_count = ?, hot = CASE WHEN ? THEN ? ELSE hot END
         WHERE pair_id = ? AND rel_path = ?`,
      ).run(t, listingHash, nodes.length, changed ? 1 : 0, hotUntil(), pairId, task.rel);
    });
    if (task.rel === '' && nodes.filter((n) => !n.trashed).length === 0) res.rootEmpty = true;
    for (const f of newFolders) enqueue(f.rel, f.uid);
  };

  let fatal: unknown = null;
  const processTask = async (task: FolderTask) => {
    try {
      const nodes = await o.remote.list({ section: o.pair.remote_section, uid: task.uid });
      applyListing(task, nodes);
      res.listed++;
      o.onListed?.();
    } catch (e) {
      res.failed++;
      if (res.errors.length < 20) res.errors.push(`${task.rel || '/'}: ${(e as Error).message}`);
      if (task.rel === '' && errorClassOf(e) === 'not_found') res.status = 'root_missing';
      if (errorClassOf(e) === 'auth') fatal ??= e;
    }
  };
  let inflight = 0;
  const waiters: (() => void)[] = [];
  const worker = async () => {
    for (;;) {
      if (o.signal?.aborted || fatal || Date.now() > deadline) return;
      const task = queue.shift();
      if (!task) {
        if (inflight === 0) return;
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      inflight++;
      try {
        await processTask(task);
      } finally {
        inflight--;
        for (const w of waiters.splice(0)) w();
      }
    }
  };
  // the root first and alone (pool warm-up, root checks), then the rest in parallel
  await processTask(queue.shift()!);
  if (res.status !== 'root_missing') {
    const n = Math.max(1, o.concurrency ?? 2);
    await Promise.all(Array.from({ length: n }, () => worker()));
  }
  if (fatal) throw fatal;
  if (o.signal?.aborted) res.status = 'aborted';
  else if (res.status === 'ok' && res.failed > 0) res.status = 'partial';
  res.durationMs = Date.now() - t0;
  return res;
}

/** Crawl one adoption source (read-only search space outside the pairs) into remote_index. */
export async function crawlAdoptionSource(o: {
  db: DatabaseSync;
  accountId: string;
  section: string;
  rootPath: string;
  rootUid: string;
  remote: RemoteOps;
  signal?: AbortSignal;
  maxFolders?: number;
}): Promise<{ listed: number; failed: number; files: number }> {
  const st = new Stmts(o.db);
  const queue: { path: string; uid: string }[] = [{ path: o.rootPath, uid: o.rootUid }];
  const res = { listed: 0, failed: 0, files: 0 };
  const up =
    st.get(`INSERT INTO remote_index (account_id, uid, parent_uid, section, path, name, size, mtime_ms, sha1, rev_uid, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'crawl', ?)
    ON CONFLICT (account_id, uid) DO UPDATE SET parent_uid = excluded.parent_uid, section = excluded.section, path = excluded.path,
      name = excluded.name, size = excluded.size, mtime_ms = excluded.mtime_ms, sha1 = excluded.sha1, rev_uid = excluded.rev_uid,
      source = 'crawl', updated_at = excluded.updated_at`);
  const started = Date.now();
  while (queue.length && res.listed < (o.maxFolders ?? 100_000)) {
    if (o.signal?.aborted) break;
    const f = queue.shift()!;
    let nodes: RemoteNode[];
    try {
      nodes = await o.remote.list({ section: o.section, uid: f.uid });
    } catch {
      res.failed++;
      continue;
    }
    res.listed++;
    tx(o.db, () => {
      for (const n of nodes) {
        if (n.trashed || n.name === null) continue;
        const p = `${f.path}/${n.name}`;
        if (n.type === 'folder') queue.push({ path: p, uid: n.uid });
        else if (n.type === 'file' && n.rev) {
          res.files++;
          up.run(
            o.accountId,
            n.uid,
            f.uid,
            o.section,
            p,
            n.name,
            n.rev.size,
            n.rev.mtimeMs,
            n.rev.sha1,
            n.rev.uid,
            Date.now(),
          );
        }
      }
    });
  }
  // files of this source that were not seen in a complete crawl are gone
  if (!res.failed && !o.signal?.aborted)
    st.get(
      "DELETE FROM remote_index WHERE account_id = ? AND source = 'crawl' AND (path LIKE ? ESCAPE '\\') AND updated_at < ?",
    ).run(o.accountId, `${o.rootPath.replace(/[\\%_]/g, (c) => '\\' + c)}/%`, started);
  return res;
}
