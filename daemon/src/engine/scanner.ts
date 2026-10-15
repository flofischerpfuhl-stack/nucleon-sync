// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Local scanner (ARCHITECTURE §4.3 step 1): `fs.opendir` walk of one pair root.
 *  - stat only; sha1 only for new/changed files (size/mtime/inode, in `full` mode also ctime), streaming + bounded
 *  - symlinks, sockets, FIFOs, devices skipped (counted); names with newlines -> 'unsupported'
 *  - names NFC-normalised for rel_path, original bytes kept for fs access
 *  - excluded folders are recorded once (state 'excluded', not descended) so the tree can show them
 *  - files younger than `freshMs` are postponed (not hashed, not created, never treated as deleted)
 *  - the "missing" set is returned, not applied: the engine evaluates safety brakes first
 */
import { opendir, lstat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Stmts, tx, type PairRow } from '../db/repo.ts';
import { limit, sha1File } from './hash.ts';
import type { RuleMatcher } from './rules.ts';

export interface ScanOptions {
  db: DatabaseSync;
  pair: PairRow;
  scanId: number;
  mode: 'incremental' | 'full' | 'verify';
  matcher: RuleMatcher;
  freshMs?: number;
  hashConcurrency?: number;
  statConcurrency?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface ScanResult {
  status: 'ok' | 'root_missing' | 'aborted';
  files: number;
  folders: number;
  bytes: number;
  hashed: number;
  postponed: number;
  /** when the youngest postponed file stops being "too fresh" (ms since epoch; 0 = nothing postponed) */
  freshUntilMs: number;
  skippedSpecial: number;
  symlinks: string[];
  unsupported: number;
  /** folders that could not be read (EACCES, EIO, ...): nothing below them counts as deleted */
  unreadable: string[];
  /** entries that were present before and are gone now (not yet applied) */
  missing: { id: number; rel_path: string; kind: string; hasBase: boolean }[];
  /** entries not visited because their path is now excluded */
  nowExcluded: number[];
  durationMs: number;
}

interface Known {
  id: number;
  kind: string;
  l_exists: number;
  l_size: number | null;
  l_mtime_us: number | null;
  l_ctime_us: number | null;
  l_inode: number | null;
  l_sha1: string | null;
  state: string;
  synced_at: number | null;
  seen: boolean;
}

interface Change {
  rel: string;
  kind: 'file' | 'folder';
  size: number | null;
  mtimeUs: number | null;
  ctimeUs: number | null;
  ino: number | null;
  dev: number | null;
  sha1: string | null;
  excluded: boolean;
  unsupported?: boolean;
}

const MS = 1e3; // µs per ms

export async function scanLocal(o: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now();
  const now = o.now ?? Date.now;
  const freshMs = o.freshMs ?? 10_000;
  const res: ScanResult = {
    status: 'ok',
    files: 0,
    folders: 0,
    bytes: 0,
    hashed: 0,
    postponed: 0,
    freshUntilMs: 0,
    skippedSpecial: 0,
    symlinks: [],
    unsupported: 0,
    unreadable: [],
    missing: [],
    nowExcluded: [],
    durationMs: 0,
  };
  const root = o.pair.local_root;
  try {
    const st = await lstat(root);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    res.status = 'root_missing';
    res.durationMs = Date.now() - t0;
    return res;
  }

  const stmts = new Stmts(o.db);
  const known = new Map<string, Known>();
  for (const r of stmts
    .get(
      'SELECT id, rel_path, kind, l_exists, l_size, l_mtime_us, l_ctime_us, l_inode, l_sha1, state, synced_at FROM entries WHERE pair_id = ?',
    )
    .iterate(o.pair.id) as Iterable<Known & { rel_path: string }>) {
    known.set(r.rel_path, { ...r, seen: false });
  }

  const changes: Change[] = [];
  const excludedSeen = new Set<string>();
  const unreadableSeen = new Set<string>();
  const hashLimit = limit(o.hashConcurrency ?? 3);
  const statLimit = limit(o.statConcurrency ?? 32);
  const hashTasks: Promise<void>[] = [];
  const upsert =
    stmts.get(`INSERT INTO entries (pair_id, rel_path, kind, l_exists, l_size, l_mtime_us, l_ctime_us, l_inode, l_dev,
      l_sha1, l_hashed_at, l_seen_scan, state, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pair_id, rel_path) DO UPDATE SET kind = excluded.kind, l_exists = 1, l_size = excluded.l_size,
      l_mtime_us = excluded.l_mtime_us, l_ctime_us = excluded.l_ctime_us, l_inode = excluded.l_inode, l_dev = excluded.l_dev,
      l_sha1 = COALESCE(excluded.l_sha1, entries.l_sha1), l_hashed_at = COALESCE(excluded.l_hashed_at, entries.l_hashed_at),
      l_seen_scan = excluded.l_seen_scan,
      state = CASE WHEN excluded.state IN ('excluded','unsupported') THEN excluded.state
                   WHEN entries.state IN ('excluded','unsupported') THEN 'synced' ELSE entries.state END,
      updated_at = excluded.updated_at`);
  const flush = () => {
    if (!changes.length) return;
    const batch = changes.splice(0);
    const t = now();
    tx(o.db, () => {
      for (const c of batch)
        upsert.run(
          o.pair.id,
          c.rel,
          c.kind,
          c.size,
          c.mtimeUs,
          c.ctimeUs,
          c.ino,
          c.dev,
          c.sha1,
          c.sha1 ? t : null,
          o.scanId,
          c.unsupported ? 'unsupported' : c.excluded ? 'excluded' : 'synced',
          t,
        );
    });
  };
  const push = (c: Change) => {
    changes.push(c);
    if (changes.length >= 2000) flush();
  };

  const verifySample = o.mode === 'verify' ? 0.01 : 0;
  const recentUs = (now() - 30 * 86400_000) * MS;

  const visitFile = async (abs: string, rel: string) => {
    let s;
    try {
      s = await lstat(abs, { bigint: true });
    } catch {
      return; // vanished during the walk -> treated as missing if it was known
    }
    if (!s.isFile()) return;
    const k = known.get(rel);
    if (k) k.seen = true;
    const size = Number(s.size);
    const mtimeUs = Number(s.mtimeNs / 1000n);
    const ctimeUs = Number(s.ctimeNs / 1000n);
    const ino = Number(s.ino);
    const dev = Number(s.dev);
    res.files++;
    res.bytes += size;
    if (now() - mtimeUs / MS < freshMs) {
      res.postponed++; // file is probably still being written -> next run
      res.freshUntilMs = Math.max(res.freshUntilMs, Math.ceil(mtimeUs / MS) + freshMs);
      return;
    }
    const unchanged =
      k &&
      k.kind === 'file' &&
      k.l_exists === 1 &&
      k.l_sha1 !== null &&
      k.l_size === size &&
      k.l_mtime_us !== null &&
      Math.abs(k.l_mtime_us - mtimeUs) < MS &&
      (k.l_inode === null || k.l_inode === ino) &&
      (o.mode !== 'full' || k.l_ctime_us === null || Math.abs(k.l_ctime_us - ctimeUs) < MS) &&
      !(verifySample && (Math.random() < verifySample || mtimeUs > recentUs)) &&
      k.state !== 'excluded' &&
      k.state !== 'unsupported';
    if (unchanged) {
      if (k.l_inode === null || k.l_ctime_us === null)
        push({ rel, kind: 'file', size, mtimeUs, ctimeUs, ino, dev, sha1: null, excluded: false });
      return;
    }
    hashTasks.push(
      hashLimit(async () => {
        if (o.signal?.aborted) return;
        let sha1: string;
        try {
          sha1 = await sha1File(abs);
          const after = await lstat(abs, { bigint: true });
          if (Number(after.size) !== size || Number(after.mtimeNs / 1000n) !== mtimeUs) {
            res.postponed++; // changed while hashing
            return;
          }
        } catch {
          return;
        }
        res.hashed++;
        push({ rel, kind: 'file', size, mtimeUs, ctimeUs, ino, dev, sha1, excluded: false });
      }),
    );
  };

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (o.signal?.aborted) return;
    let dir;
    try {
      dir = await opendir(absDir);
    } catch {
      if (relDir) unreadableSeen.add(relDir); // unknown, not deleted
      return;
    }
    const dirents: Dirent[] = [];
    for await (const d of dir) dirents.push(d);
    const names = new Set(dirents.map((d) => d.name.normalize('NFC')));
    const siblingsOf = (folderRel: string) => (folderRel === relDir ? names : undefined);
    const subdirs: [string, string][] = [];
    const files: Promise<void>[] = [];
    for (const d of dirents) {
      const name = d.name.normalize('NFC');
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, d.name);
      if (/[\r\n]/.test(d.name)) {
        res.unsupported++;
        const k = known.get(rel);
        if (k) k.seen = true;
        push({
          rel,
          kind: d.isDirectory() ? 'folder' : 'file',
          size: null,
          mtimeUs: null,
          ctimeUs: null,
          ino: null,
          dev: null,
          sha1: null,
          excluded: false,
          unsupported: true,
        });
        continue;
      }
      if (d.isSymbolicLink()) {
        if (res.symlinks.length < 1000) res.symlinks.push(rel);
        continue;
      }
      if (d.isDirectory()) {
        const m = o.matcher.match(rel, siblingsOf);
        const k = known.get(rel);
        if (k) k.seen = true;
        if (m.excluded) {
          excludedSeen.add(rel);
          if (m.by !== 'hard' && (!k || k.state !== 'excluded' || k.l_exists !== 1))
            push({
              rel,
              kind: 'folder',
              size: null,
              mtimeUs: null,
              ctimeUs: null,
              ino: null,
              dev: null,
              sha1: null,
              excluded: true,
            });
          continue;
        }
        res.folders++;
        if (!k || k.l_exists !== 1 || k.kind !== 'folder' || k.state === 'excluded')
          push({
            rel,
            kind: 'folder',
            size: null,
            mtimeUs: null,
            ctimeUs: null,
            ino: null,
            dev: null,
            sha1: null,
            excluded: false,
          });
        subdirs.push([abs, rel]);
      } else if (d.isFile()) {
        const m = o.matcher.match(rel, siblingsOf);
        if (m.excluded) continue; // junk/default-excluded files are not tracked at all
        files.push(statLimit(() => visitFile(abs, rel)));
      } else {
        res.skippedSpecial++;
      }
    }
    await Promise.all(files);
    for (const [abs, rel] of subdirs) await walk(abs, rel);
  };

  await walk(root, '');
  await Promise.all(hashTasks);
  if (o.signal?.aborted) {
    flush();
    res.status = 'aborted';
    res.durationMs = Date.now() - t0;
    return res;
  }
  flush();

  for (const [rel, k] of known) {
    if (k.seen || k.l_exists !== 1) continue;
    const m = o.matcher.match(rel);
    if (isBelowExcluded(rel, unreadableSeen)) continue; // folder not readable this time: state unknown
    if (m.excluded || isBelowExcluded(rel, excludedSeen)) res.nowExcluded.push(k.id);
    else res.missing.push({ id: k.id, rel_path: rel, kind: k.kind, hasBase: k.synced_at !== null });
  }
  res.unreadable = [...unreadableSeen].slice(0, 100);
  res.durationMs = Date.now() - t0;
  return res;
}

/** An unvisited entry below a folder that is (now) excluded is excluded, not deleted. */
function isBelowExcluded(rel: string, excludedSeen: Set<string>): boolean {
  let i = rel.lastIndexOf('/');
  while (i > 0) {
    if (excludedSeen.has(rel.slice(0, i))) return true;
    i = rel.lastIndexOf('/', i - 1);
  }
  return false;
}

/** Apply the scan's missing/excluded sets (after the safety brakes passed). */
export function applyScanResult(db: DatabaseSync, scanId: number, r: ScanResult, now = Date.now()): void {
  const st = new Stmts(db);
  tx(db, () => {
    for (const m of r.missing)
      st.get('UPDATE entries SET l_exists = 0, l_seen_scan = ?, updated_at = ? WHERE id = ?').run(scanId, now, m.id);
    for (const id of r.nowExcluded)
      st.get("UPDATE entries SET state = 'excluded', updated_at = ? WHERE id = ?").run(now, id);
  });
}
