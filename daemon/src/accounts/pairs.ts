// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pair management: create/patch/delete with validation (hard exclusions, overlapping roots, local root exists,
 * remote section + root uid resolution), the pair's user rules, the remote browser and the first-contact preview for
 * the pair wizard. Every remote access is a read (list/info) through the account's CLI pool.
 */
import { opendir, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

import {
  HARD_EXCLUDED_LOCAL_PATHS,
  msg,
  refOf,
  type Msg,
  type PairDto,
  type SelectionRule,
} from '@nucleon-sync/shared';
import type {
  CreatePairRequest,
  PairPreviewDto,
  PatchPairRequest,
  RemoteBrowseEntry,
  TwoWayPairOptions,
} from '@nucleon-sync/shared';

import type { PairRow } from '../db/repo.ts';
import { sha1File } from '../engine/hash.ts';
import { ownedPaths, relInside } from '../engine/nested.ts';
import { FLAG } from '../db/repo.ts';

const FLAG_CONFLICT_IGNORED = FLAG.CONFLICT_IGNORED;
import type { RemoteNode } from '../engine/remote.ts';
import { RuleMatcher } from '../engine/rules.ts';
import { readSettings } from '../engine/settings.ts';
import { badRequest, conflict, HttpError, notFound } from '../util/http.ts';
import type { AccountsService } from './accounts.ts';
import { stagingDirOf, type ServiceContext } from './context.ts';

const DIRECTIONS = ['backup', 'mirror-down', 'upload-only', 'two-way'] as const;
const ROOT_SECTIONS = ['my-files', 'devices', 'shared-with-me'] as const;

/** `/devices/Workstation/Documents` -> `/devices/Workstation`; `/my-files/x` -> `/my-files`; null when unsupported. */
export function remoteSectionOf(remoteRoot: string): string | null {
  const segs = remoteRoot.split('/').filter(Boolean);
  if (segs[0] === 'my-files') return '/my-files';
  if (segs[0] === 'devices' && segs[1]) return `/devices/${segs[1]}`;
  if (segs[0] === 'shared-with-me' && segs[1]) return '/shared-with-me';
  return null;
}

export function normalizeRemote(p: string): string {
  return '/' + p.split('/').filter(Boolean).join('/');
}

const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : b + '/');
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

export class PairsService {
  private readonly c: ServiceContext;
  private readonly accounts: AccountsService;

  constructor(c: ServiceContext, accounts: AccountsService) {
    this.c = c;
    this.accounts = accounts;
  }

  row(id: number): PairRow | null {
    return (this.c.db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as unknown as PairRow | undefined) ?? null;
  }

  require(id: number): PairRow {
    const r = this.row(id);
    if (!r) throw notFound(`unknown pair ${id}`);
    return r;
  }

  dto(id: number): PairDto {
    const p = this.c.engine.pairs().find((x) => x.id === id);
    if (!p) throw notFound(`unknown pair ${id}`);
    return p;
  }

  /** The pair's user selection rules (base for PUT /v1/pairs/:id/rules). */
  rules(id: number): SelectionRule[] {
    this.require(id);
    return (
      this.c.db
        .prepare('SELECT id, kind, pattern_type, pattern, source FROM rules WHERE pair_id = ? ORDER BY pattern, id')
        .all(id) as {
        id: number;
        kind: 'include' | 'exclude';
        pattern_type: 'prefix' | 'glob';
        pattern: string;
        source: 'user' | 'default';
      }[]
    ).map((r) => ({ id: r.id, kind: r.kind, patternType: r.pattern_type, pattern: r.pattern, source: r.source }));
  }

  /** Validates a rules body for PUT /v1/pairs/:id/rules (the engine stores them). */
  validateRules(id: number, body: unknown): SelectionRule[] {
    this.require(id);
    if (!Array.isArray(body)) throw badRequest('body must be a SelectionRule[]');
    if (body.length > 10_000) throw badRequest('too many rules');
    return body.map((r, i) => validateRule(r, `rules[${i}]`));
  }

  // ------------------------------------------------------------ validation

  /** Throws 400 on invalid input; returns normalised values + warnings. */
  validate(
    req: CreatePairRequest,
    o: { excludePairId?: number; requireLocalExists?: boolean } = {},
  ): { localRoot: string; remoteRoot: string; section: string; warnings: Msg[] } {
    if (!req || typeof req !== 'object') throw badRequest('body must be a CreatePairRequest');
    const acc = this.accounts.row(String(req.accountId ?? ''));
    if (!acc) throw badRequest(`unknown account ${String(req.accountId)}`);
    if (!DIRECTIONS.includes(req.direction)) throw badRequest(`direction must be one of ${DIRECTIONS.join(', ')}`);
    const name = String(req.name ?? '').trim();
    if (!name || name.length > 80) throw badRequest('name required (max 80 chars)');
    if (typeof req.localRoot !== 'string' || !path.isAbsolute(req.localRoot))
      throw badRequest('localRoot must be an absolute path');
    if (/[\n\r\0]/.test(req.localRoot) || /[\n\r\0]/.test(String(req.remoteRoot)))
      throw badRequest('paths must not contain newlines');
    const localRoot = path.resolve(req.localRoot.normalize('NFC'));
    if (localRoot === '/') throw badRequest('localRoot must not be /');
    for (const h of [...HARD_EXCLUDED_LOCAL_PATHS, ...(this.c.config.protectedPaths ?? [])])
      if (overlaps(localRoot, h)) throw badRequest(`${localRoot} overlaps the protected path ${h} (never synced)`);
    const staging = stagingDirOf(this.c);
    if (overlaps(localRoot, staging)) throw badRequest(`${localRoot} overlaps the staging dir ${staging}`);
    if (overlaps(localRoot, this.c.paths.stateDir)) throw badRequest('localRoot overlaps the nucleon-sync state dir');
    const warnings: Msg[] = [];
    if (o.requireLocalExists !== false) {
      let st;
      try {
        st = statSync(localRoot);
      } catch {
        throw badRequest(`local folder ${localRoot} does not exist`);
      }
      if (!st.isDirectory()) throw badRequest(`${localRoot} is not a folder`);
    }
    if (typeof req.remoteRoot !== 'string') throw badRequest('remoteRoot required');
    const remoteRoot = normalizeRemote(req.remoteRoot.normalize('NFC'));
    const section = remoteSectionOf(remoteRoot);
    if (!section) throw badRequest(`remoteRoot must start with /my-files, /devices/<device> or /shared-with-me/<…>`);
    for (const p of this.c.db.prepare('SELECT * FROM pairs').all() as unknown as PairRow[]) {
      if (p.id === o.excludePairId) continue;
      const nested = nestingOf({ localRoot, remoteRoot, accountId: acc.id }, p);
      if (typeof nested === 'string') throw badRequest(nested);
      if (nested) warnings.push(nested.warning);
    }
    if (acc.status !== 'ok')
      warnings.push(msg('preview.accountNotReady', { account: acc.display_name, status: acc.status }));
    return { localRoot, remoteRoot, section, warnings };
  }

  /** Resolves the remote root uid (read-only `info`); null when the account cannot run right now. */
  private async resolveRoot(accountId: string, remoteRoot: string): Promise<RemoteNode | null> {
    const acc = this.accounts.row(accountId)!;
    if (acc.status !== 'ok' || this.accounts.gate(accountId)) return null;
    try {
      const node = await this.c.engine.remote(accountId).info({ path: remoteRoot });
      if (node.type !== 'folder') throw badRequest(`${remoteRoot} is not a folder in Proton`);
      return node;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const cls = (e as { errorClass?: string }).errorClass;
      if (cls === 'not_found' || /not found|not supported/i.test((e as Error).message))
        throw badRequest(`Proton folder ${remoteRoot} not found`);
      return null; // transient: resolved by the engine on the first run
    }
  }

  // ------------------------------------------------------------ CRUD

  /**
   * Setup wizard: creates the remote root folder (and missing parents) below the section root. Uses the write-guarded
   * RemoteOps (refused in planning mode). Existing folders are reused; a file in the way is an error.
   */
  private async ensureRemoteFolder(accountId: string, remoteRoot: string, section: string): Promise<void> {
    const remote = this.c.engine.remote(accountId);
    let cur = await remote.info({ path: section });
    const rest = remoteRoot.slice(section.length).split('/').filter(Boolean);
    for (const name of rest) {
      const kids = await remote.list({ section, uid: cur.uid });
      const hit = kids.find((k) => k.name === name.normalize('NFC') && !k.trashed);
      if (hit && hit.type !== 'folder') throw badRequest(`${name} is a file in Proton, not a folder`);
      cur = hit ?? (await remote.mkdir({ section, uid: cur.uid }, name));
    }
  }

  async create(req: CreatePairRequest): Promise<PairDto> {
    const v = this.validate(req);
    if (req.createRemote) {
      const acc = this.accounts.row(req.accountId)!;
      if (acc.status !== 'ok') throw badRequest(`account ${acc.display_name} is not signed in`);
      try {
        await this.ensureRemoteFolder(req.accountId, v.remoteRoot, v.section);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw badRequest(`Proton folder ${v.remoteRoot} could not be created: ${(e as Error).message}`);
      }
    }
    const node = await this.resolveRoot(req.accountId, v.remoteRoot);
    let id: number;
    try {
      id = Number(
        this.c.db
          .prepare(
            `INSERT INTO pairs (account_id, name, local_root, remote_root, remote_section, remote_root_uid, direction, enabled, options,
             created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            req.accountId,
            String(req.name).trim(),
            v.localRoot,
            v.remoteRoot,
            v.section,
            node?.uid ?? null,
            req.direction,
            req.enabled === false ? 0 : 1,
            req.direction === 'two-way' ? JSON.stringify({ twoWayAdoption: true }) : '{}',
            Date.now(),
          ).lastInsertRowid,
      );
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) throw conflict('a pair with this local or remote folder exists already');
      throw e;
    }
    await this.c.engine.reload();
    return this.dto(id);
  }

  /** Field changes; `direction` changes are confirmed by the route (they change what happens to deletions). */
  async patch(id: number, req: PatchPairRequest): Promise<PairDto> {
    const p = this.require(id);
    if (!req || typeof req !== 'object') throw badRequest('body must be an object');
    const allowed = ['name', 'direction', 'enabled', 'paused', 'options'];
    const unknown = Object.keys(req).filter((k) => !allowed.includes(k) && k !== 'confirmToken');
    if (unknown.length) throw badRequest(`cannot change ${unknown.join(', ')} (roots are fixed; create a new pair)`);
    const db = this.c.db;
    if (req.name !== undefined) {
      const n = String(req.name).trim();
      if (!n || n.length > 80) throw badRequest('name required (max 80 chars)');
      db.prepare('UPDATE pairs SET name = ? WHERE id = ?').run(n, id);
    }
    if (req.direction !== undefined) {
      if (!DIRECTIONS.includes(req.direction)) throw badRequest(`direction must be one of ${DIRECTIONS.join(', ')}`);
      if (req.direction !== p.direction) this.switchDirection(p, req.direction);
    }
    for (const k of ['enabled', 'paused'] as const) {
      if (req[k] === undefined) continue;
      if (typeof req[k] !== 'boolean') throw badRequest(`${k} must be boolean`);
      db.prepare(`UPDATE pairs SET ${k} = ? WHERE id = ?`).run(req[k] ? 1 : 0, id);
    }
    if (req.options !== undefined) {
      const o = req.options;
      if (!o || typeof o !== 'object') throw badRequest('options must be an object');
      if (o.remoteChanges !== undefined && !['download', 'conflict'].includes(o.remoteChanges))
        throw badRequest('options.remoteChanges must be download|conflict');
      if (o.remoteDeletions !== undefined && !['reupload', 'ask'].includes(o.remoteDeletions))
        throw badRequest('options.remoteDeletions must be reupload|ask');
      if (o.uploadLocalNew !== undefined && typeof o.uploadLocalNew !== 'boolean')
        throw badRequest('options.uploadLocalNew must be boolean');
      const direction = req.direction ?? p.direction;
      if (o.uploadLocalNew === true && direction !== 'mirror-down')
        throw badRequest('options.uploadLocalNew is only available for mirror-down pairs');
      const tw = o as TwoWayPairOptions;
      const intIn = (
        k: 'remoteCheckMinutes' | 'massDeleteMaxFiles' | 'massDeletePercent',
        min: number,
        max: number,
      ) => {
        const val = tw[k];
        if (val === undefined) return;
        if (direction !== 'two-way') throw badRequest(`options.${k} is only available for two-way pairs`);
        if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max)
          throw badRequest(`options.${k} must be an integer ${min}..${max}`);
      };
      intIn('remoteCheckMinutes', 1, 1440);
      intIn('massDeleteMaxFiles', 0, 1_000_000);
      intIn('massDeletePercent', 0, 100);
      const cur = JSON.parse(this.require(id).options || '{}') as Record<string, unknown>;
      const next: Record<string, unknown> = { ...cur, ...o };
      next.twoWayAdoption = cur.twoWayAdoption; // daemon-managed
      if (next.twoWayAdoption === undefined) delete next.twoWayAdoption;
      delete next.uploadLocalNewSince; // daemon-managed
      // only files created locally after switching the option on are uploaded (never a pre-existing local tree)
      if (next.uploadLocalNew === true)
        next.uploadLocalNewSince =
          cur.uploadLocalNew === true && typeof cur.uploadLocalNewSince === 'number'
            ? cur.uploadLocalNewSince
            : Date.now();
      else delete next.uploadLocalNew;
      db.prepare('UPDATE pairs SET options = ? WHERE id = ?').run(JSON.stringify(next), id);
    }
    await this.c.engine.reload();
    return this.dto(id);
  }

  /**
   * Direction change. Switching TO two-way goes through adoption first: entries that are not in a clean synced state
   * lose their base (they are compared again like at first contact: identical files are only recorded), and the pair
   * gets `twoWayAdoption` — until its first complete run nothing is deleted on either side (a missing file is
   * restored). Switching away from two-way drops the flag.
   */
  private switchDirection(p: PairRow, direction: PairRow['direction']): void {
    const db = this.c.db;
    const opts = JSON.parse(p.options || '{}') as Record<string, unknown>;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE pairs SET direction = ? WHERE id = ?').run(direction, p.id);
      if (direction === 'two-way') {
        opts.twoWayAdoption = true;
        db.prepare(
          `UPDATE entries SET synced_at = NULL, b_sha1 = NULL, b_size = NULL, b_l_mtime_us = NULL, b_r_rev_uid = NULL
           WHERE pair_id = ? AND (NOT (state = 'synced' AND l_exists = 1 AND r_exists = 1)
             -- "synced" although the sides differ (conflict ignored, upload-only accepting remote edits): compare again
             OR (flags & ${FLAG_CONFLICT_IGNORED}) != 0
             OR (l_sha1 IS NOT NULL AND r_sha1 IS NOT NULL AND l_sha1 != r_sha1)
             OR (r_sha1 IS NULL AND l_size IS NOT r_size))
           AND id NOT IN (SELECT entry_id FROM pending_deletions WHERE executed_at IS NULL)`,
        ).run(p.id);
      } else delete opts.twoWayAdoption;
      db.prepare('UPDATE pairs SET options = ? WHERE id = ?').run(JSON.stringify(opts), p.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Number of tracked entries (for confirm summaries). */
  entryStats(id: number): { entries: number; bytes: number } {
    const r = this.c.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN kind = 'file' THEN COALESCE(l_size, r_size) END), 0) AS b FROM entries WHERE pair_id = ?",
      )
      .get(id) as { n: number; b: number };
    return { entries: r.n, bytes: r.b };
  }

  /** Deletes the pair and its state (entries, rules, jobs). Files on both sides stay untouched. */
  async remove(id: number): Promise<void> {
    this.require(id);
    const running = (
      this.c.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE pair_id = ? AND state = 'running'").get(id) as {
        n: number;
      }
    ).n;
    if (running) throw conflict('the pair has running jobs; pause it and try again');
    const db = this.c.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE runs SET pair_id = NULL WHERE pair_id = ?').run(id);
      db.prepare("DELETE FROM pause_timers WHERE scope = 'pair' AND target = ?").run(String(id));
      // held/decided two-way deletions point at the pair's jobs (no cascade on job_id)
      db.prepare('DELETE FROM pending_deletions WHERE entry_id IN (SELECT id FROM entries WHERE pair_id = ?)').run(id);
      db.prepare(
        'UPDATE pending_deletions SET job_id = NULL WHERE job_id IN (SELECT id FROM jobs WHERE pair_id = ?)',
      ).run(id);
      db.prepare('DELETE FROM jobs WHERE pair_id = ?').run(id);
      db.prepare('DELETE FROM pairs WHERE id = ?').run(id); // cascades entries, rules, remote_folders, scans, brakes, ...
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    await this.c.engine.reload();
  }

  // ------------------------------------------------------------ remote browser (pair wizard)

  async browse(accountId: string, p: string): Promise<RemoteBrowseEntry[]> {
    const acc = this.accounts.require(accountId);
    const remotePath = normalizeRemote(p || '/');
    if (remotePath === '/') return ROOT_SECTIONS.map((s) => ({ name: s, uid: `section:${s}`, type: 'folder' }));
    if (acc.status !== 'ok') throw conflict(`account ${acc.display_name} is not ready (${acc.status})`);
    const gate = this.accounts.gate(accountId);
    if (gate) throw conflict(gate);
    const remote = this.c.engine.remote(accountId);
    try {
      if (remotePath === '/devices')
        return (await remote.listDevices())
          .filter((d) => d.name)
          .map((d) => ({ name: d.name!, uid: d.rootFolderUid, type: 'folder' as const }));
      const nodes = await remote.list({ path: remotePath });
      return nodes
        .filter((n) => n.name && !n.trashed && n.type !== 'other')
        .map((n) => ({ name: n.name!, uid: n.uid, type: n.type as 'folder' | 'file' }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'de') : a.type === 'folder' ? -1 : 1));
    } catch (e) {
      if (/not found|not supported|Device not found/i.test((e as Error).message))
        throw notFound(`Proton folder ${remotePath} not found`);
      throw new HttpError(502, 'internal', `Proton listing failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // ------------------------------------------------------------ first-contact preview (dry run, nothing written)

  async preview(
    req: CreatePairRequest,
    limits = { maxLocalFiles: 300_000, maxRemoteFolders: 3_000, hashBudgetBytes: 2 * 1024 ** 3 },
  ): Promise<PairPreviewDto> {
    const v = this.validate(req);
    const warnings: Msg[] = [...v.warnings];
    const out: PairPreviewDto = {
      adopt: 0,
      upload: 0,
      uploadBytes: 0,
      download: 0,
      downloadBytes: 0,
      conflicts: 0,
      excluded: 0,
      warnings: [],
    };
    // nested pairs: sub folders owned by existing pairs are not part of the new pair
    const others = this.c.db.prepare('SELECT * FROM pairs').all() as unknown as PairRow[];
    const owned = ownedPaths(
      {
        id: -1,
        name: String(req.name ?? ''),
        account_id: req.accountId,
        local_root: v.localRoot,
        remote_root: v.remoteRoot,
      },
      others,
    ).map((x) => x.rel);
    const matcher = new RuleMatcher({
      rules: readSettings(this.c.db).globalExcludes,
      localRoot: v.localRoot,
      hardExcluded: [...HARD_EXCLUDED_LOCAL_PATHS, ...(this.c.config.protectedPaths ?? [])],
      ownedPaths: owned,
    });
    // local side
    const local = new Map<string, { size: number; mtimeMs: number; abs: string }>();
    let truncated = false;
    const walk = async (dirAbs: string, rel: string): Promise<void> => {
      if (truncated) return;
      const names: { name: string; dir: boolean; file: boolean }[] = [];
      try {
        for await (const d of await opendir(dirAbs))
          names.push({ name: d.name, dir: d.isDirectory(), file: d.isFile() });
      } catch {
        warnings.push(msg('preview.folderUnreadable', { path: rel || '/' }));
        return;
      }
      const siblings = new Set(names.map((n) => n.name));
      for (const n of names) {
        const childRel = rel ? `${rel}/${n.name.normalize('NFC')}` : n.name.normalize('NFC');
        if (matcher.match(childRel, (f) => (f === rel ? siblings : undefined)).excluded) {
          out.excluded++;
          continue;
        }
        const abs = path.join(dirAbs, n.name);
        if (n.dir) await walk(abs, childRel);
        else if (n.file) {
          if (local.size >= limits.maxLocalFiles) {
            truncated = true;
            return;
          }
          const st = await stat(abs).catch(() => null);
          if (st) local.set(childRel, { size: st.size, mtimeMs: st.mtimeMs, abs });
        }
      }
    };
    await walk(v.localRoot, '');
    if (truncated) warnings.push(msg('preview.truncatedLocal', { max: limits.maxLocalFiles }));
    // remote side (read-only listing, breadth first)
    const remote = new Map<string, { size: number; mtimeMs: number | null; sha1: string | null }>();
    const root = await this.resolveRoot(req.accountId, v.remoteRoot).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 400 && /^Proton folder .* not found$/.test(e.message))
        return 'missing' as const;
      throw e;
    });
    if (root === 'missing') warnings.push(msg('preview.remoteMissing', { path: v.remoteRoot }));
    else if (!root) warnings.push(msg('preview.remoteNotChecked'));
    else {
      const ops = this.c.engine.remote(req.accountId);
      const queue: { uid: string; rel: string }[] = [{ uid: root.uid, rel: '' }];
      let listed = 0;
      while (queue.length) {
        if (listed >= limits.maxRemoteFolders) {
          warnings.push(msg('preview.truncatedRemote', { max: limits.maxRemoteFolders }));
          break;
        }
        const batch = queue.splice(0, 2);
        listed += batch.length;
        const lists = await Promise.all(
          batch.map((f) => ops.list({ section: v.section, uid: f.uid }).then((n) => ({ f, n }))),
        );
        for (const { f, n } of lists)
          for (const node of n) {
            if (!node.name || node.trashed) continue;
            const rel = f.rel ? `${f.rel}/${node.name}` : node.name;
            if (matcher.match(rel).excluded) continue;
            if (node.type === 'folder') queue.push({ uid: node.uid, rel });
            else if (node.type === 'file' && node.rev && !node.isProtonDoc)
              remote.set(rel, { size: node.rev.size ?? 0, mtimeMs: node.rev.mtimeMs, sha1: node.rev.sha1 });
          }
      }
    }
    // classify (docs/SYNC-RULES.md rows 1-4, 12; §3.3; §3.4)
    const up = req.direction !== 'mirror-down';
    const down = req.direction !== 'upload-only';
    let hashed = 0;
    let sizeOnly = 0;
    for (const [rel, l] of local) {
      const r = remote.get(rel);
      if (!r) {
        if (up) {
          out.upload++;
          out.uploadBytes += l.size;
        }
        continue;
      }
      remote.delete(rel);
      if (r.size !== l.size) {
        out.conflicts++;
        continue;
      }
      if (r.sha1) {
        if (hashed + l.size <= limits.hashBudgetBytes) {
          hashed += l.size;
          const sha = await sha1File(l.abs).catch(() => null);
          if (sha === r.sha1) out.adopt++;
          else out.conflicts++;
        } else {
          sizeOnly++;
          out.adopt++;
        }
      } else if (r.mtimeMs !== null && Math.abs(r.mtimeMs - l.mtimeMs) <= 2000) out.adopt++;
      else out.conflicts++;
    }
    if (down)
      for (const r of remote.values()) {
        out.download++;
        out.downloadBytes += r.size;
      }
    if (sizeOnly) warnings.push(msg('preview.sizeOnly', { count: sizeOnly }));
    out.warnings = warnings.map((w) => w.text);
    out.warningMsgs = warnings.map((w) => refOf(w)!);
    return out;
  }
}

/**
 * Nested pairs: one pair may lie inside another (local folder, and for the same account also the
 * Proton folder at the same sub path); the outer pair then excludes that sub folder automatically. Refused: the same
 * folder twice, crossed nesting, a Proton folder nested without its local folder, and different sub paths. Returns null when
 * the pairs are unrelated, an error text, or a warning for the wizard.
 */
export function nestingOf(
  n: { localRoot: string; remoteRoot: string; accountId: string },
  p: PairRow,
): string | { warning: Msg } | null {
  const same = p.account_id === n.accountId;
  if (n.localRoot === p.local_root) return `${n.localRoot} is already the local folder of pair "${p.name}"`;
  if (same && n.remoteRoot === p.remote_root) return `${n.remoteRoot} is already the Proton folder of pair "${p.name}"`;
  const innerL = relInside(n.localRoot, p.local_root); // new pair inside p
  const outerL = relInside(p.local_root, n.localRoot); // p inside the new pair
  const innerR = same ? relInside(n.remoteRoot, p.remote_root) : null;
  const outerR = same ? relInside(p.remote_root, n.remoteRoot) : null;
  if ((innerL !== null || innerR !== null) && (outerL !== null || outerR !== null))
    return `${n.localRoot} ⇄ ${n.remoteRoot} is nested crosswise with pair "${p.name}" (${p.local_root} ⇄ ${p.remote_root})`;
  // a Proton folder inside another pair's Proton folder must also be the same sub folder locally (otherwise the
  // outer pair would stop backing up its own local sub folder)
  if (innerR !== null && innerL === null)
    return `${n.remoteRoot} overlaps the Proton folder of pair "${p.name}" (${p.remote_root}), but ${n.localRoot} is not the matching sub folder of ${p.local_root}`;
  if (outerR !== null && outerL === null)
    return `${n.remoteRoot} contains the Proton folder of pair "${p.name}" (${p.remote_root}), but ${n.localRoot} does not contain its local folder`;
  if (innerL !== null && innerR !== null && innerL !== innerR)
    return `${n.localRoot} lies in pair "${p.name}" as "${innerL}", but its Proton folder as "${innerR}" – nested pairs need the same sub path on both sides`;
  if (outerL !== null && outerR !== null && outerL !== outerR)
    return `pair "${p.name}" lies in ${n.localRoot} as "${outerL}", but in its Proton folder as "${outerR}" – nested pairs need the same sub path on both sides`;
  if (innerL !== null || innerR !== null)
    return { warning: msg('preview.nestedInner', { pair: p.name, path: (innerL ?? innerR)! }) };
  if (outerL !== null || outerR !== null)
    return { warning: msg('preview.nestedOuter', { pair: p.name, path: (outerL ?? outerR)! }) };
  return null;
}

export function validateRule(r: unknown, where: string): SelectionRule {
  const o = r as Partial<SelectionRule>;
  if (!o || typeof o !== 'object') throw badRequest(`${where}: must be an object`);
  if (o.kind !== 'include' && o.kind !== 'exclude') throw badRequest(`${where}.kind must be include|exclude`);
  if (o.patternType !== 'prefix' && o.patternType !== 'glob')
    throw badRequest(`${where}.patternType must be prefix|glob`);
  if (typeof o.pattern !== 'string' || /[\n\r\0]/.test(o.pattern) || o.pattern.length > 1024)
    throw badRequest(`${where}.pattern must be a string without newlines`);
  if (o.patternType === 'glob' && (!o.pattern || o.pattern.includes('/')))
    throw badRequest(`${where}: a glob matches one name (no "/")`);
  if (o.patternType === 'prefix' && o.pattern.split('/').includes('..')) throw badRequest(`${where}: ".." not allowed`);
  const source = o.source ?? 'user';
  if (source !== 'user' && source !== 'default') throw badRequest(`${where}.source must be user|default`);
  return { kind: o.kind, patternType: o.patternType, pattern: o.pattern, source };
}
