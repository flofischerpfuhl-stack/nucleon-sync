// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Executor (ARCHITECTURE §4.4): drains the persistent job queue per account through the account's CLI pool.
 * Every job verifies before acting (planned snapshot still valid, remote unchanged) and after acting (listing /
 * info of the result), records the result in the entry, the job row and the activity feed.
 *
 * Retries: transient/rate-limited/auth -> retry_wait with exponential backoff (30 s .. 30 min, 8 attempts);
 * integrity -> up to 3 attempts; other classes -> failed. Jobs found 'running' at startup are re-queued; their
 * pre-checks detect work that had already completed (crash recovery, no duplicate nodes or revisions).
 * Write guard: when writes are not allowed every job stays 'blocked' and nothing reaches the CLI.
 */
import { EventEmitter } from 'node:events';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  msg,
  nested,
  storeMsg,
  twoWayConflictName,
  type ActivityAction,
  type TextOrMsg,
  type ConflictKind,
  type ErrorClass,
  type FileSnapshot,
  type JobDto,
  type JobType,
} from '@nucleon-sync/shared';

import { CliError } from '../cli/replWorker.ts';
import { isRetryable } from '../cli/classify.ts';
import { baseName, FLAG, parentRel, Stmts, tx, type EntryRow, type JobRow, type PairRow } from '../db/repo.ts';
import {
  getEntry,
  getEntryByRel,
  localPath,
  resolveFolderUid,
  rewritePath,
  setBase,
  setRemote,
  settle,
  upsertRemoteFolder,
} from './entries.ts';
import { sha1File } from './hash.ts';
import {
  boostJobs,
  derivedPriority,
  insertJob,
  isLanePriority,
  jobDto,
  OPEN_SQL,
  payloadOf,
  SMALL_FILE,
  type JobPayload,
} from './queue.ts';
import { errorClassOf, type RemoteNode, type RemoteOps, type TransferOptions } from './remote.ts';
import type { LocalTrash } from './trash.ts';
import { cliJobScope, cliPriorityScope, CliGatedError, type CliPool } from '../cli/pool.ts';

export interface ExecutorDeps {
  db: DatabaseSync;
  pair: (id: number) => PairRow | null;
  remote: (accountId: string) => RemoteOps;
  pool: (accountId: string) => CliPool;
  /** reason when writes are blocked (production without NUCLEON_SYNC_ALLOW_WRITES=1) */
  writeGuard: () => TextOrMsg | null;
  /** may this account/pair execute jobs now (pause, offline, needs_login, cooldown)? */
  canRun: (accountId: string, pairId: number | null) => boolean;
  /**
   * pairs of the account that cannot run (paused, two-way deletions held): their jobs are skipped in the pick query
   * itself, so a long blocked backlog at the front of the queue never starves the account's other pairs
   */
  blockedPairs?: (accountId: string) => number[];
  stagingDir: () => string;
  trash: LocalTrash;
  activity: (a: {
    accountId: string;
    pairId?: number | null;
    runId?: number | null;
    jobId?: number | null;
    action: ActivityAction;
    relPath?: string | null;
    bytes?: number | null;
    durationMs?: number | null;
    message?: TextOrMsg | null;
  }) => void;
  onJob: (job: JobDto) => void;
  onOutcome: (o: { accountId: string; ok: boolean; errorClass?: ErrorClass; message?: string }) => void;
  onTransfer: (kind: 'upload' | 'download', bytes: number, ms: number, runId: number | null) => void;
  /** live progress of a running transfer (jobs = the batch); done=true when the command returned */
  onProgress?: (
    jobs: JobRow[],
    kind: 'upload' | 'download',
    p: { bytesDone: number; bytesTotal: number; source: string } | null,
  ) => void;
  /** run counters (the engine attributes the job to its run, or to the active run of its account/pair) */
  count: (job: JobRow, key: string, n?: number) => void;
  bandwidthBps: () => number | null;
  retryBaseMs?: number;
  retryMaxMs?: number;
  freeSpaceMarginBytes?: number;
  now?: () => number;
  /** host name used in two-way conflict copies ("Name (conflict <host> YYYY-MM-DD).ext"); default os.hostname() */
  hostname?: () => string;
  /**
   * nested pairs: name of another pair that owns this path (a child pair inside this pair's folders), or null.
   * Jobs on such paths are cancelled — two pairs never act on the same file.
   */
  ownedElsewhere?: (pair: PairRow, rel: string) => string | null;
}

class Requeue extends Error {
  readonly delayMs: number;
  constructor(reason: string, delayMs: number) {
    super(reason);
    this.delayMs = delayMs;
  }
}
class Cancel extends Error {}

const LOCAL_ONLY = new Set<JobType>(['trash_local', 'conflict_copy', 'move_local']);
/** CLI slot / global budget priority of commands issued by priority-lane jobs (background jobs use 50/100) */
const LANE_CLI_PRIORITY = 10;

export class Executor extends EventEmitter {
  private readonly d: ExecutorDeps;
  private readonly loops = new Map<
    string,
    { running: Set<number>; wake: (() => void) | null; timer: NodeJS.Timeout | null }
  >();
  private stopped = false;
  /** promises of jobs currently running (shutdown waits for them before the DB is closed) */
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(d: ExecutorDeps) {
    super();
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  /** Re-queue jobs that were 'running' when the daemon stopped (crash recovery). */
  recover(): number {
    const r = new Stmts(this.d.db)
      .get(
        "UPDATE jobs SET state = 'queued', worker = NULL, last_error = COALESCE(last_error, 'recovered after restart') WHERE state = 'running'",
      )
      .run();
    return Number(r.changes);
  }

  /** Move blocked jobs back to the queue (writes enabled). */
  unblock(): number {
    if (this.d.writeGuard()) return 0;
    return Number(
      new Stmts(this.d.db).get("UPDATE jobs SET state = 'queued', last_error = NULL WHERE state = 'blocked'").run()
        .changes,
    );
  }

  kick(accountId?: string): void {
    if (this.stopped) return;
    const ids = accountId ? [accountId] : [...this.loops.keys(), ...this.accountsWithJobs()];
    for (const id of new Set(ids)) {
      const l = this.loops.get(id);
      if (l) l.wake?.();
      else this.startLoop(id);
    }
  }

  private accountsWithJobs(): string[] {
    return (
      new Stmts(this.d.db).get(`SELECT DISTINCT account_id FROM jobs WHERE state IN ('queued','retry_wait')`).all() as {
        account_id: string;
      }[]
    ).map((r) => r.account_id);
  }

  runningCount(accountId?: string): number {
    let n = 0;
    for (const [id, l] of this.loops) if (!accountId || id === accountId) n += l.running.size;
    return n;
  }

  private startLoop(accountId: string): void {
    const l = { running: new Set<number>(), wake: null as (() => void) | null, timer: null as NodeJS.Timeout | null };
    this.loops.set(accountId, l);
    // the loop may be started from inside a job or a priority run (kick): it must not inherit their CLI scopes
    cliJobScope.exit(() =>
      cliPriorityScope.exit(() => void this.loop(accountId, l).catch((e) => this.emit('error', e))),
    );
  }

  private async loop(
    accountId: string,
    l: { running: Set<number>; wake: (() => void) | null; timer: NodeJS.Timeout | null },
  ) {
    const st = new Stmts(this.d.db);
    while (!this.stopped) {
      let nextWake = 5_000;
      if (this.d.canRun(accountId, null)) {
        const pool = this.d.pool(accountId);
        const bw = this.d.bandwidthBps();
        const cap = Math.max(1, Math.min(pool.effectiveSize() || 0, bw ? 1 : Infinity));
        const allowed = pool.effectiveSize() === 0 ? 0 : cap;
        const guard = this.d.writeGuard();
        if (guard) {
          // one statement for the whole queue: blocking job by job re-sorted the queue per job (quadratic) and
          // starved the event loop with tens of thousands of jobs (Sam's first mirror run, 2026-10-11)
          this.blockAll(accountId, guard);
        }
        while (!guard && l.running.size < allowed) {
          const job = this.pick(accountId, l.running);
          if (!job) break;
          l.running.add(job.id);
          const run = this.runJob(job).finally(() => {
            l.running.delete(job.id);
            this.inflight.delete(run);
            l.wake?.();
            this.emit('jobFinished', job);
          });
          this.inflight.add(run);
        }
        const due = st
          .get(
            "SELECT MIN(not_before) AS t FROM jobs WHERE account_id = ? AND state IN ('retry_wait','queued') AND not_before IS NOT NULL",
          )
          .get(accountId) as { t: number | null };
        if (due.t) nextWake = Math.max(20, Math.min(nextWake, due.t - this.now()));
      }
      if (!l.running.size) this.emit('idle', accountId);
      await new Promise<void>((resolve) => {
        l.wake = () => {
          l.wake = null;
          if (l.timer) clearTimeout(l.timer);
          resolve();
        };
        l.timer = setTimeout(() => l.wake?.(), nextWake);
        l.timer.unref();
      });
    }
  }

  /** Write guard active: every queued/retrying job of the account becomes 'blocked' (released by unblock()). */
  private blockAll(accountId: string, guard: TextOrMsg): number {
    const reason = storeMsg(guard);
    const st = new Stmts(this.d.db);
    const one = st
      .get("SELECT * FROM jobs WHERE account_id = ? AND state IN ('queued','retry_wait') ORDER BY id DESC LIMIT 1")
      .get(accountId) as unknown as JobRow | undefined;
    if (!one) return 0;
    const n = Number(
      st
        .get(
          "UPDATE jobs SET state = 'blocked', last_error = ? WHERE account_id = ? AND state IN ('queued','retry_wait')",
        )
        .run(reason, accountId).changes,
    );
    // one job event is enough for clients to refresh their queue counters
    this.d.onJob(jobDto({ ...one, state: 'blocked', last_error: reason }));
    return n;
  }

  private pick(accountId: string, running: Set<number>): JobRow | null {
    const t = this.now();
    const rows = new Stmts(this.d.db)
      .get(
        `SELECT * FROM jobs WHERE account_id = ? AND (state = 'queued' OR state = 'retry_wait') AND (not_before IS NULL OR not_before <= ?)
         AND (pair_id IS NULL OR pair_id NOT IN (SELECT value FROM json_each(?)))
         ORDER BY priority, id LIMIT 50`,
      )
      .all(accountId, t, JSON.stringify(this.d.blockedPairs?.(accountId) ?? [])) as unknown as JobRow[];
    for (const r of rows) {
      if (running.has(r.id)) continue;
      if (!this.d.canRun(accountId, r.pair_id)) continue;
      return r;
    }
    return null;
  }

  private transition(job: JobRow, f: Partial<JobRow>): void {
    const keys = Object.keys(f) as (keyof JobRow)[];
    new Stmts(this.d.db)
      .get(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => f[k] as string | number | null), job.id);
    Object.assign(job, f);
    this.d.onJob(jobDto(job));
  }

  // ---------------------------------------------------------------- running one job

  private runJob(job: JobRow): Promise<void> {
    // commands of a started job pass a soft gate (pause "finish the current file"); priority-lane jobs also get
    // CLI slots and the global process budget before background jobs
    return cliJobScope.run({ jobId: job.id }, () =>
      cliPriorityScope.run(isLanePriority(job.priority) ? LANE_CLI_PRIORITY : undefined, () => this.runJobInScope(job)),
    );
  }

  private async runJobInScope(job: JobRow): Promise<void> {
    const t0 = this.now();
    const batch: JobRow[] = [job];
    this.transition(job, { state: 'running', started_at: t0, worker: job.account_id });
    try {
      const pair = job.pair_id !== null ? this.d.pair(job.pair_id) : null;
      const p = payloadOf(job);
      if (job.pair_id !== null && !pair) throw new Cancel('pair removed');
      if (pair && this.d.ownedElsewhere && job.type !== 'empty_trash') {
        const owner =
          this.d.ownedElsewhere(pair, p.toRel ?? p.rel) ?? (p.fromRel ? this.d.ownedElsewhere(pair, p.fromRel) : null);
        if (owner) throw new Cancel(`path belongs to pair "${owner}" (nested pair)`);
      }
      switch (job.type as JobType) {
        case 'mkdir':
          await this.mkdir(job, pair!, p);
          break;
        case 'upload':
          await this.upload(job, pair!, p, batch);
          break;
        case 'upload_revision':
          await this.uploadRevision(job, pair!, p);
          break;
        case 'download':
          await this.download(job, pair!, p);
          break;
        case 'move':
        case 'rename':
          await this.move(job, pair!, p);
          break;
        case 'trash_remote':
          await this.trashRemote(job, pair!, p);
          break;
        case 'trash_local':
          await this.trashLocal(job, pair!, p);
          break;
        case 'digest_backfill':
          await this.digestBackfill(job, pair!, p);
          break;
        case 'conflict_copy':
          await this.conflictCopy(job, pair!, p);
          break;
        case 'verify_content':
          await this.verifyContent(job, pair!, p);
          break;
        case 'move_local':
          await this.moveLocal(job, pair!, p);
          break;
        case 'empty_trash':
          await this.d.remote(job.account_id).emptyTrash();
          this.d.activity({
            accountId: job.account_id,
            jobId: job.id,
            action: 'info',
            message: msg('activity.trashEmptied'),
          });
          break;
        default:
          throw new CliError(`unsupported job type ${job.type}`, 'fatal');
      }
      for (const j of batch) {
        if (j.state !== 'running') continue;
        this.transition(j, { state: 'done', finished_at: this.now(), last_error: null, error_class: null });
        const pl = payloadOf(j);
        if (pl.then)
          insertJob(this.d.db, {
            runId: j.run_id,
            accountId: j.account_id,
            pairId: j.pair_id,
            entryId: j.entry_id,
            ...pl.then,
            priority: derivedPriority(j, pl.then.type, null) ?? pl.then.priority,
          });
      }
      if (!LOCAL_ONLY.has(job.type as JobType)) this.d.onOutcome({ accountId: job.account_id, ok: true });
    } catch (e) {
      for (const j of batch) if (j.state === 'running') this.fail(j, e);
    }
  }

  private fail(job: JobRow, e: unknown): void {
    const now = this.now();
    if (e instanceof Requeue) {
      this.transition(job, { state: 'queued', not_before: now + e.delayMs, last_error: e.message });
      return;
    }
    if (e instanceof Cancel) {
      this.transition(job, { state: 'cancelled', finished_at: now, last_error: e.message });
      return;
    }
    const cls = errorClassOf(e);
    const errText = (e as Error).message?.slice(0, 1000) ?? String(e);
    // gated (pause / foreign CLI process) before the command started: back to the queue, no attempt counted
    if (e instanceof CliGatedError) {
      const why = e.msg ?? e.reason;
      this.transition(job, { state: 'queued', last_error: storeMsg(msg('job.waiting', { reason: nested(why) })) });
      return;
    }
    // paused "immediately": the worker was killed under the job -> back to the queue without burning an attempt
    if (!this.d.canRun(job.account_id, job.pair_id) && (cls === 'transient' || cls === 'fatal')) {
      this.transition(job, { state: 'queued', last_error: storeMsg(msg('job.abortedPause', { error: errText })) });
      return;
    }
    const attempts = job.attempts + 1;
    const maxAttempts = cls === 'integrity' ? Math.min(3, job.max_attempts) : job.max_attempts;
    const retryable = isRetryable(cls) || cls === 'integrity' || (cls === 'local_io' && /ENOSPC/.test(errText));
    if (retryable && attempts < maxAttempts) {
      const base = this.d.retryBaseMs ?? 30_000;
      const delay = Math.min(this.d.retryMaxMs ?? 30 * 60_000, base * 2 ** (attempts - 1));
      this.transition(job, {
        state: 'retry_wait',
        attempts,
        not_before: now + delay,
        error_class: cls,
        last_error: errText,
      });
    } else {
      this.transition(job, { state: 'failed', attempts, finished_at: now, error_class: cls, last_error: errText });
      if (job.entry_id)
        new Stmts(this.d.db)
          .get("UPDATE entries SET last_error = ?, state = 'error' WHERE id = ?")
          .run(errText, job.entry_id);
      this.d.count(job, 'errors');
      this.d.activity({
        accountId: job.account_id,
        pairId: job.pair_id,
        runId: job.run_id,
        jobId: job.id,
        action: 'error',
        relPath: safeRel(job),
        message: `${job.type}: ${errText}`,
      });
    }
    if (!LOCAL_ONLY.has(job.type as JobType))
      this.d.onOutcome({ accountId: job.account_id, ok: false, errorClass: cls, message: errText });
  }

  // ---------------------------------------------------------------- helpers

  /** progress hook for one transfer command; call the returned `end()` when it returned */
  private progress(jobs: JobRow[], kind: 'upload' | 'download'): { opts: TransferOptions; end: () => void } {
    const cb = this.d.onProgress;
    if (!cb) return { opts: {}, end: () => undefined };
    return {
      opts: { onProgress: (p) => cb(jobs, kind, p) },
      end: () => cb(jobs, kind, null),
    };
  }

  private entry(job: JobRow): EntryRow {
    const e = getEntry(this.d.db, job.entry_id);
    if (!e) throw new Cancel('entry no longer exists');
    return e;
  }

  /** Parent folder uid or Requeue when a mkdir/move that creates it is still open. */
  private parentUid(job: JobRow, pair: PairRow, rel: string): string {
    const uid = resolveFolderUid(this.d.db, pair, rel);
    if (uid) return uid;
    if (rel === '') throw new CliError('pair root uid unknown', 'transient');
    const st = new Stmts(this.d.db);
    const open = st
      .get(
        `SELECT id, payload FROM jobs WHERE pair_id = ? AND type IN ('mkdir','move','rename') AND state IN ${OPEN_SQL} AND id != ?`,
      )
      .all(pair.id, job.id) as { id: number; payload: string }[];
    for (const o of open) {
      const p = JSON.parse(o.payload) as JobPayload;
      const target = p.toRel ?? p.rel;
      if (rel === target || rel.startsWith(target + '/')) {
        if (isLanePriority(job.priority)) boostJobs(this.d.db, [o.id]); // the lane job must not wait for the backlog
        throw new Requeue(`waiting for parent folder "${target}"`, 500);
      }
    }
    const folder = st
      .get("SELECT * FROM entries WHERE pair_id = ? AND rel_path = ? AND kind = 'folder'")
      .get(pair.id, rel) as unknown as EntryRow | undefined;
    if (existsSync(localPath(pair, rel))) {
      // parent was never created remotely: create it first (self-healing, e.g. after a remote folder deletion)
      const r = insertJob(this.d.db, {
        runId: job.run_id,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: folder?.id ?? null,
        type: 'mkdir',
        payload: { rel, kind: 'folder', parentRel: parentRel(rel), name: baseName(rel) },
        priority: derivedPriority(job, 'mkdir', null),
        dedupeKey: `mkdir:${pair.id}:${rel}`,
      });
      if (r.id && !r.created && isLanePriority(job.priority)) boostJobs(this.d.db, [r.id]);
      if (r.id) {
        this.d.onJob(jobDto(st.get('SELECT * FROM jobs WHERE id = ?').get(r.id) as unknown as JobRow));
        throw new Requeue(`waiting for parent folder "${rel}"`, 500);
      }
    }
    throw new CliError(`parent folder "${rel}" not found remotely`, 'not_found');
  }

  private ref(pair: PairRow, uid: string) {
    return { section: pair.remote_section, uid };
  }

  private statLocal(abs: string): { size: number; mtimeUs: number; ino: number; dev: number; ctimeUs: number } | null {
    try {
      const s = statSync(abs, { bigint: true });
      if (!s.isFile()) return null;
      return {
        size: Number(s.size),
        mtimeUs: Number(s.mtimeNs / 1000n),
        ino: Number(s.ino),
        dev: Number(s.dev),
        ctimeUs: Number(s.ctimeNs / 1000n),
      };
    } catch {
      return null;
    }
  }

  private sameLocal(s: { size: number; mtimeUs: number } | null, p: JobPayload): boolean {
    return (
      !!s && s.size === p.size && p.mtimeUs !== null && p.mtimeUs !== undefined && Math.abs(s.mtimeUs - p.mtimeUs) < 1e3
    );
  }

  /** Planned local snapshot is stale -> cancel; the next scan re-plans the entry. */
  private replan(job: JobRow, why: string): never {
    if (job.entry_id)
      new Stmts(this.d.db)
        .get("UPDATE entries SET state = 'local_changed', l_sha1 = NULL, updated_at = ? WHERE id = ?")
        .run(this.now(), job.entry_id);
    throw new Cancel(why);
  }

  private setLocal(
    id: number,
    s: { size: number; mtimeUs: number; ino: number; dev: number; ctimeUs: number },
    sha1: string | null,
  ) {
    new Stmts(this.d.db)
      .get(
        `UPDATE entries SET l_exists = 1, l_size = ?, l_mtime_us = ?, l_ctime_us = ?, l_inode = ?, l_dev = ?, l_sha1 = ?, l_hashed_at = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(s.size, s.mtimeUs, s.ctimeUs, s.ino, s.dev, sha1, sha1 ? this.now() : null, this.now(), id);
  }

  // ---------------------------------------------------------------- job types

  private async mkdir(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const e = getEntry(this.d.db, job.entry_id);
    if (e && !e.l_exists) throw new Cancel('local folder is gone');
    const parent = this.parentUid(job, pair, p.parentRel ?? parentRel(p.rel));
    const node = await this.d.remote(pair.account_id).mkdir(this.ref(pair, parent), p.name ?? baseName(p.rel));
    tx(this.d.db, () => {
      upsertRemoteFolder(this.d.db, pair.id, p.rel, node.uid);
      if (e) {
        setRemote(this.d.db, e.id, node);
        settle(this.d.db, e.id);
      }
    });
  }

  private async upload(job: JobRow, pair: PairRow, p: JobPayload, batch: JobRow[]): Promise<void> {
    const remote = this.d.remote(pair.account_id);
    const parentRelPath = p.parentRel ?? parentRel(p.rel);
    const parent = this.parentUid(job, pair, parentRelPath);
    // batching: small files into the same parent, up to 50 files / 256 MiB per command (docs/SYNC-RULES.md)
    if ((job.bytes ?? 0) <= SMALL_FILE) {
      // a priority-lane upload only takes other lane uploads along (never up to 256 MiB of the backlog)
      const lane = isLanePriority(job.priority) ? 'AND priority < 0' : '';
      const more = new Stmts(this.d.db)
        .get(
          `SELECT * FROM jobs WHERE account_id = ? AND pair_id = ? AND type = 'upload' AND state = 'queued' AND id != ?
           AND (not_before IS NULL OR not_before <= ?) AND COALESCE(bytes, 0) <= ? ${lane} ORDER BY id LIMIT 200`,
        )
        .all(job.account_id, pair.id, job.id, this.now(), SMALL_FILE) as unknown as JobRow[];
      let bytes = job.bytes ?? 0;
      for (const m of more) {
        if (batch.length >= 50 || bytes + (m.bytes ?? 0) > 256 * 1024 * 1024) break;
        const mp = payloadOf(m);
        if ((mp.parentRel ?? parentRel(mp.rel)) !== parentRelPath) continue;
        if (batch.some((b) => payloadOf(b).name === mp.name)) continue;
        this.transition(m, { state: 'running', started_at: this.now(), worker: job.account_id });
        batch.push(m);
        bytes += m.bytes ?? 0;
      }
    }
    // pre-checks per file
    const files: { job: JobRow; p: JobPayload; abs: string; entry: EntryRow }[] = [];
    let listing: RemoteNode[] | null = null;
    for (const j of batch) {
      const jp = payloadOf(j);
      try {
        const entry = this.entry(j);
        const abs = localPath(pair, jp.rel);
        if (!this.sameLocal(this.statLocal(abs), jp)) this.replan(j, 'local file changed since planning');
        if (jp.fromPc || jp.twoWay || j.attempts > 0 || j.last_error?.startsWith('recovered')) {
          // crash recovery / retry: the upload may have completed before. Uploads from the PC into a mirror
          // (uploadLocalNew) and two-way uploads always look first ("re-list before write"): a same-named remote
          // file (e.g. created by another device meanwhile) is never touched, both are kept.
          listing ??= await remote.list(this.ref(pair, parent));
          const done = listing.find((n) => n.type === 'file' && !n.trashed && n.name === jp.name?.normalize('NFC'));
          if (done && done.rev?.sha1 && done.rev.sha1 === jp.sha1) {
            this.finishUpload(j, pair, jp, entry, done, abs, 'uploaded', 0);
            this.transition(j, { state: 'done', finished_at: this.now(), last_error: null });
            continue;
          }
          if (done && (jp.fromPc || jp.twoWay)) {
            if (sameDigestless(done, jp)) {
              this.finishUpload(j, pair, jp, entry, done, abs, 'uploaded', 0);
              this.transition(j, { state: 'done', finished_at: this.now(), last_error: null });
              continue;
            }
            const kept = await this.keepBothFromPc(j, pair, jp, entry, done, listing);
            files.push({ job: j, ...kept });
            continue;
          }
        }
        files.push({ job: j, p: jp, abs, entry });
      } catch (e) {
        this.fail(j, e);
      }
    }
    if (!files.length) return;
    const bytes = files.reduce((s, f) => s + (f.p.size ?? 0), 0);
    const t0 = this.now();
    const prog = this.progress(
      files.map((f) => f.job),
      'upload',
    );
    let r;
    try {
      r = await remote.upload(
        files.map((f) => f.abs),
        this.ref(pair, parent),
        'skip',
        bytes,
        prog.opts,
      );
    } finally {
      prog.end();
    }
    const ms = this.now() - t0;
    this.d.onTransfer('upload', r.summary.transferredBytes, ms, job.run_id);
    await this.pace(r.summary.transferredBytes, ms);
    const nodes = await remote.list(this.ref(pair, parent));
    const byName = new Map(nodes.filter((n) => n.type === 'file' && n.name && !n.trashed).map((n) => [n.name!, n]));
    for (const f of files) {
      try {
        const failure = r.summary.failures.find((x) => x.name === path.basename(f.abs));
        if (failure) throw new CliError(failure.error, classifyFailure(failure.error));
        const node = byName.get(f.p.name!.normalize('NFC'));
        if (!node) throw new CliError(`"${f.p.name}" not found after upload`, 'transient');
        if ((f.p.fromPc || f.p.twoWay) && !(node.rev?.sha1 ? node.rev.sha1 === f.p.sha1 : sameDigestless(node, f.p))) {
          // a same-named file reached Proton between our listing and the upload; -f skip kept it -> keep both
          const kept = await this.keepBothFromPc(f.job, pair, f.p, f.entry, node, nodes);
          this.transition(f.job, {
            state: 'queued',
            payload: JSON.stringify(kept.p),
            last_error: storeMsg(msg('job.nameTaken')),
          });
          continue;
        }
        this.finishUpload(f.job, pair, f.p, f.entry, node, f.abs, 'uploaded', ms);
        this.transition(f.job, { state: 'done', finished_at: this.now(), last_error: null });
      } catch (e) {
        this.fail(f.job, e);
      }
    }
    if (r.error && !r.summary.failures.length) throw r.error;
  }

  /**
   * uploadLocalNew in a mirror-down pair (or a two-way upload), but Proton has a different file with the same name:
   * never touch it. The local file is renamed to `name (from PC YYYY-MM-DD).ext` (two-way: `name (conflict <host>
   * YYYY-MM-DD).ext`, listed for review) with no-clobber and uploaded under that name; the original entry now
   * describes the remote file only and is downloaded into the freed name (both sides end up with both).
   */
  private async keepBothFromPc(
    job: JobRow,
    pair: PairRow,
    p: JobPayload,
    entry: EntryRow,
    node: RemoteNode,
    listing: RemoteNode[],
  ): Promise<{ p: JobPayload; abs: string; entry: EntryRow }> {
    const db = this.d.db;
    const oldAbs = localPath(pair, p.rel);
    const taken = new Set(listing.filter((n) => n.name && !n.trashed).map((n) => n.name!.normalize('NFC')));
    const date = new Date(this.now());
    const twoWay = !!p.twoWay && !p.fromPc;
    const { rel: newRel, abs: newAbs } = this.renameAside(
      oldAbs,
      (i) => (twoWay ? twoWayConflictName(p.rel, this.host(), date, i) : fromPcName(p.rel, date, i)),
      pair,
      taken,
    );
    const s = this.statLocal(newAbs);
    if (!s) throw new CliError(`renamed file "${newRel}" vanished`, 'local_io');
    const t = this.now();
    const np: JobPayload = {
      ...p,
      rel: newRel,
      name: baseName(newRel),
      uid: null,
      expectedRevUid: null,
      keptBothOf: p.name,
    };
    let newEntry!: EntryRow;
    tx(db, () => {
      const st = new Stmts(db);
      const r = st
        .get(
          `INSERT INTO entries (pair_id, rel_path, kind, l_exists, l_size, l_mtime_us, l_ctime_us, l_inode, l_dev, l_sha1, l_hashed_at,
           state, updated_at) VALUES (?, ?, 'file', 1, ?, ?, ?, ?, ?, ?, ?, 'local_new', ?)`,
        )
        .run(pair.id, newRel, s.size, s.mtimeUs, s.ctimeUs, s.ino, s.dev, p.sha1 ?? null, t, t);
      newEntry = getEntry(db, Number(r.lastInsertRowid))!;
      if (twoWay) {
        this.insertReviewConflict(entry.id, 'initial_mismatch', newRel, {
          local: { size: p.size ?? 0, mtime: new Date((p.mtimeUs ?? 0) / 1e3).toISOString(), sha1: p.sha1 ?? null },
          remote: nodeSnapshot(node),
          base: null,
        });
        this.d.count(job, 'conflicts');
      }
      st.get(
        `UPDATE entries SET l_exists = 0, l_size = NULL, l_mtime_us = NULL, l_ctime_us = NULL, l_inode = NULL, l_dev = NULL,
         l_sha1 = NULL, l_hashed_at = NULL, state = 'remote_new', updated_at = ? WHERE id = ?`,
      ).run(t, entry.id);
      setRemote(db, entry.id, node);
      st.get('UPDATE jobs SET entry_id = ?, payload = ?, dedupe_key = ? WHERE id = ?').run(
        newEntry.id,
        JSON.stringify(np),
        `upload:${pair.id}:${newRel}`,
        job.id,
      );
      job.entry_id = newEntry.id;
      job.payload = JSON.stringify(np);
      job.dedupe_key = `upload:${pair.id}:${newRel}`;
      // the remote file comes down into the freed name right away (remote is master in a mirror)
      insertJob(db, {
        runId: job.run_id,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: entry.id,
        priority: derivedPriority(job, 'download', null),
        type: 'download',
        payload: {
          rel: p.rel,
          kind: 'file',
          parentRel: parentRel(p.rel),
          name: baseName(p.rel),
          size: null,
          mtimeUs: null,
          sha1: null,
          uid: node.uid,
          expectedRevUid: node.rev?.uid ?? null,
          remoteSha1: node.rev?.sha1 ?? null,
          remoteMtimeMs: node.rev?.mtimeMs ?? null,
          replace: false,
        },
        bytes: node.rev?.size ?? null,
        dedupeKey: `download:${pair.id}:${p.rel}`,
      });
    });
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: twoWay ? 'conflict' : 'info',
      relPath: newRel,
      message: msg(twoWay ? 'activity.keptBothTwoWay' : 'activity.keptBothFromPc', {
        name: p.name ?? '',
        copy: baseName(newRel),
      }),
    });
    return { p: np, abs: newAbs, entry: newEntry };
  }

  /** conflict copies carry this host name (two-way) */
  private host(): string {
    return this.d.hostname?.() ?? hostname();
  }

  /**
   * Renames a local file to the first free name of `nameFor(i)` (i = 1, 2, …) without ever replacing a file
   * (link + unlink: fails with EEXIST instead of clobbering). Names taken in the remote listing or by another entry
   * of the pair are skipped as well.
   */
  private renameAside(
    oldAbs: string,
    nameFor: (i: number) => string,
    pair: PairRow,
    taken: Set<string> = new Set(),
  ): { rel: string; abs: string } {
    for (let i = 1; i < 1000; i++) {
      const rel = nameFor(i);
      const abs = path.join(path.dirname(oldAbs), baseName(rel));
      if (taken.has(baseName(rel).normalize('NFC')) || getEntryByRel(this.d.db, pair.id, rel) || existsSync(abs))
        continue;
      let linked = false;
      try {
        linkSync(oldAbs, abs); // no-clobber: fails with EEXIST instead of replacing a file
        linked = true;
        rmSync(oldAbs);
      } catch (e) {
        if (linked) {
          rmSync(abs, { force: true }); // the second name of the same inode goes again; the file stays as it was
          throw e;
        }
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw e;
        if (existsSync(abs)) continue;
        renameSync(oldAbs, abs);
      }
      return { rel, abs };
    }
    throw new CliError(`no free name for a copy of ${oldAbs}`, 'local_io');
  }

  /**
   * two-way: the engine already kept both versions; the conflict is listed for review only (it no longer blocks the
   * entry: resolution 'keep_both' by 'auto', needs_review = 1).
   */
  private insertReviewConflict(
    entryId: number,
    kind: ConflictKind,
    copyRel: string | null,
    snaps: { local: FileSnapshot | null; remote: FileSnapshot | null; base: FileSnapshot | null },
  ): void {
    const t = this.now();
    new Stmts(this.d.db)
      .get(
        `INSERT INTO conflicts (entry_id, kind, detected_at, local_snapshot, remote_snapshot, base_snapshot, resolution, resolved_at,
         resolved_by, needs_review, copy_rel_path) VALUES (?, ?, ?, ?, ?, ?, 'keep_both', ?, 'auto', 1, ?)`,
      )
      .run(
        entryId,
        kind,
        t,
        JSON.stringify(snaps.local),
        JSON.stringify(snaps.remote),
        JSON.stringify(snaps.base),
        t,
        copyRel,
      );
  }

  /** Post-check of a new upload (-f skip): decides adopt / conflict and advances the base. */
  private finishUpload(
    job: JobRow,
    pair: PairRow,
    p: JobPayload,
    entry: EntryRow,
    node: RemoteNode,
    abs: string,
    action: ActivityAction,
    ms: number,
  ): void {
    const db = this.d.db;
    const after = this.statLocal(abs);
    const changedDuring = !this.sameLocal(after, p);
    tx(db, () => {
      setRemote(db, entry.id, node);
      const rev = node.rev;
      const uploadedOurs = rev?.sha1 ? rev.sha1 === p.sha1 : false;
      const digestlessSame =
        !rev?.sha1 &&
        rev?.size === p.size &&
        rev?.mtimeMs !== null &&
        p.mtimeUs != null &&
        Math.abs((rev?.mtimeMs ?? 0) - p.mtimeUs / 1e3) <= 2000;
      if (!uploadedOurs && !digestlessSame) {
        // -f skip kept an unexpected different remote file: never overwrite blindly
        const cur = getEntry(db, entry.id)!;
        new Stmts(db)
          .get('UPDATE entries SET l_sha1 = ?, l_size = ?, l_mtime_us = ? WHERE id = ?')
          .run(p.sha1 ?? null, p.size ?? null, p.mtimeUs ?? null, entry.id);
        new Stmts(db)
          .get(
            'INSERT INTO conflicts (entry_id, kind, detected_at, local_snapshot, remote_snapshot, base_snapshot) VALUES (?, ?, ?, ?, ?, NULL)',
          )
          .run(
            entry.id,
            'initial_mismatch',
            this.now(),
            JSON.stringify({ size: p.size, mtime: new Date((p.mtimeUs ?? 0) / 1e3).toISOString(), sha1: p.sha1 }),
            JSON.stringify({
              size: rev?.size ?? 0,
              mtime: new Date(rev?.mtimeMs ?? 0).toISOString(),
              sha1: rev?.sha1 ?? null,
              revisionUid: rev?.uid,
            }),
          );
        new Stmts(db).get("UPDATE entries SET state = 'conflict' WHERE id = ?").run(cur.id);
        this.d.count(job, 'conflicts');
        this.d.activity({
          accountId: pair.account_id,
          pairId: pair.id,
          runId: job.run_id,
          jobId: job.id,
          action: 'conflict',
          relPath: p.rel,
          message: 'initial_mismatch',
        });
        return;
      }
      // base := what was uploaded (the planned snapshot), local snapshot := what is on disk now
      new Stmts(db)
        .get(
          `UPDATE entries SET b_sha1 = ?, b_size = ?, b_l_mtime_us = ?, b_r_rev_uid = ?, synced_at = ?, state = ?, last_error = NULL,
           flags = (flags & ~${FLAG.CONFLICT_IGNORED}) | ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          p.sha1 ?? null,
          p.size ?? null,
          p.mtimeUs ?? null,
          rev?.uid ?? null,
          this.now(),
          changedDuring ? 'local_changed' : 'synced',
          digestlessSame && !uploadedOurs ? FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME : 0,
          this.now(),
          entry.id,
        );
      if (changedDuring && after)
        this.setLocal(entry.id, after, null); // re-hashed by the next scan
      else if (after) this.setLocal(entry.id, after, p.sha1 ?? null);
    });
    // a node whose revision predates this job existed already (identical content, skipped by the CLI) -> adopted
    const preexisting =
      !node.rev?.sha1 || (node.rev.creationTimeMs !== null && node.rev.creationTimeMs < (job.started_at ?? 0) - 1000);
    this.d.count(job, preexisting ? 'adopted' : 'uploaded');
    if (!preexisting) this.d.count(job, 'uploadedBytes', p.size ?? 0);
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: preexisting ? 'adopted' : action,
      relPath: p.rel,
      bytes: p.size ?? null,
      durationMs: ms || null,
      message: changedDuring
        ? msg('activity.changedDuringUpload')
        : preexisting
          ? msg(node.rev?.sha1 ? 'activity.adopted' : 'activity.adoptedNoChecksum')
          : p.fromPc
            ? p.keptBothOf
              ? msg('activity.uploadedFromPcRenamed', { name: p.keptBothOf })
              : msg('activity.uploadedFromPc')
            : null,
    });
  }

  private async uploadRevision(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const remote = this.d.remote(pair.account_id);
    const entry = this.entry(job);
    const abs = localPath(pair, p.rel);
    if (!this.sameLocal(this.statLocal(abs), p)) this.replan(job, 'local file changed since planning');
    if (!entry.r_uid) throw new Cancel('remote node unknown');
    // verify-before: the remote must still be the revision our base knows (else: conflict, never overwrite)
    const node = await remote.info(this.ref(pair, entry.r_uid));
    if (node.trashed) throw new Cancel('remote file was trashed meanwhile');
    if (!p.force && node.rev?.uid !== p.expectedRevUid) {
      setRemote(this.d.db, entry.id, node);
      if (node.rev?.sha1 && node.rev.sha1 === p.sha1) {
        // our revision had already been uploaded (crash between upload and bookkeeping)
        this.finishRevision(job, pair, p, entry, node, abs, 0);
        return;
      }
      throw new Cancel('remote changed since planning (re-planned as conflict)');
    }
    const parent = node.parentUid ?? entry.r_parent_uid;
    if (!parent) throw new CliError('remote parent unknown', 'not_found');
    const t0 = this.now();
    const prog = this.progress([job], 'upload');
    const r = await remote
      .upload([abs], this.ref(pair, parent), 'create-new-revision', p.size ?? 0, prog.opts)
      .finally(prog.end);
    if (r.error) throw r.error;
    const ms = this.now() - t0;
    this.d.onTransfer('upload', r.summary.transferredBytes, ms, job.run_id);
    await this.pace(r.summary.transferredBytes, ms);
    const after = await remote.info(this.ref(pair, entry.r_uid));
    setRemote(this.d.db, entry.id, after);
    if (after.rev?.sha1 !== p.sha1)
      throw new CliError(`new revision has sha1 ${after.rev?.sha1}, expected ${p.sha1}`, 'transient');
    this.finishRevision(job, pair, p, entry, after, abs, ms);
  }

  private finishRevision(
    job: JobRow,
    pair: PairRow,
    p: JobPayload,
    entry: EntryRow,
    node: RemoteNode,
    abs: string,
    ms: number,
  ) {
    const after = this.statLocal(abs);
    const changedDuring = !this.sameLocal(after, p);
    new Stmts(this.d.db)
      .get(
        `UPDATE entries SET b_sha1 = ?, b_size = ?, b_l_mtime_us = ?, b_r_rev_uid = ?, synced_at = ?, state = ?, last_error = NULL,
         flags = flags & ~${FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME | FLAG.CONFLICT_IGNORED}, updated_at = ? WHERE id = ?`,
      )
      .run(
        p.sha1 ?? null,
        p.size ?? null,
        p.mtimeUs ?? null,
        node.rev?.uid ?? null,
        this.now(),
        changedDuring ? 'local_changed' : 'synced',
        this.now(),
        entry.id,
      );
    if (after) this.setLocal(entry.id, after, changedDuring ? null : (p.sha1 ?? null));
    this.d.count(job, 'uploaded');
    this.d.count(job, 'uploadedBytes', p.size ?? 0);
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: 'new_revision',
      relPath: p.rel,
      bytes: p.size ?? null,
      durationMs: ms || null,
      message: changedDuring ? msg('activity.changedDuringUpload') : null,
    });
  }

  private async download(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const db = this.d.db;
    if (p.kind === 'folder') {
      const abs = localPath(pair, p.rel);
      mkdirSync(abs, { recursive: true });
      const e = getEntry(db, job.entry_id);
      if (e) {
        new Stmts(db).get('UPDATE entries SET l_exists = 1, updated_at = ? WHERE id = ?').run(this.now(), e.id);
        settle(db, e.id);
      }
      return;
    }
    let entry = this.entry(job);
    if (!entry.r_exists || !entry.r_uid) throw new Cancel('remote file is gone');
    if (p.twoWay && !p.targetRel) {
      // two-way: another device may have changed or trashed the file since the listing -> look again first
      let node: RemoteNode;
      try {
        node = await this.d.remote(pair.account_id).info(this.ref(pair, entry.r_uid));
      } catch (e) {
        if (errorClassOf(e) === 'not_found') throw new Cancel('remote file is gone (re-planned)');
        throw e;
      }
      if (node.trashed) {
        new Stmts(db).get('UPDATE entries SET r_exists = 0, updated_at = ? WHERE id = ?').run(this.now(), entry.id);
        throw new Cancel('remote file was trashed meanwhile (re-planned)');
      }
      if (node.rev?.uid !== entry.r_rev_uid) {
        setRemote(db, entry.id, node); // newer revision: download that one (the local side is checked below)
        entry = this.entry(job);
      }
    }
    const targetRel = p.targetRel ?? p.rel;
    const target = localPath(pair, targetRel);
    const cur = this.statLocal(target);
    if (p.targetRel) {
      if (cur) throw new Cancel('target name exists already');
    } else if (p.replace) {
      if (!this.sameLocal(cur, p)) this.replan(job, 'local file changed since planning');
    } else if (cur) {
      throw new Cancel('a local file appeared at the target path (re-planned)');
    }
    const size = entry.r_size ?? 0;
    const margin = this.d.freeSpaceMarginBytes ?? 1024 ** 3;
    const dir = path.dirname(target);
    mkdirSync(dir, { recursive: true });
    const fs = statfsSync(dir);
    if (fs.bavail * fs.bsize < size + margin)
      throw new CliError(`ENOSPC: not enough free space for ${size} bytes in ${dir}`, 'local_io');
    const staging = path.join(this.d.stagingDir(), `job-${job.id}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const t0 = this.now();
      const prog = this.progress([job], 'download');
      const r = await this.d
        .remote(pair.account_id)
        .download(this.ref(pair, entry.r_uid!), staging, size, prog.opts)
        .finally(prog.end);
      if (r.error) throw r.error;
      const ms = this.now() - t0;
      this.d.onTransfer('download', r.summary.transferredBytes, ms, job.run_id);
      const got = readdirSync(staging);
      if (got.length !== 1)
        throw new CliError(`download produced ${got.length} files`, r.summary.skippedItems ? 'fatal' : 'transient');
      const file = path.join(staging, got[0]!);
      const st = statSync(file);
      const sha1 = await sha1File(file);
      if ((entry.r_size !== null && st.size !== entry.r_size) || (entry.r_sha1 && sha1 !== entry.r_sha1))
        throw new CliError(
          `Integrity verification failed: got ${st.size} bytes / sha1 ${sha1}, expected ${entry.r_size} / ${entry.r_sha1 ?? '-'}`,
          'integrity',
        );
      if (entry.r_mtime_ms) utimesSync(file, new Date(), new Date(entry.r_mtime_ms));
      const now = this.statLocal(target);
      const e1 = getEntry(db, entry.id);
      if (
        now &&
        p.twoWay &&
        !p.targetRel &&
        !p.replace &&
        e1?.l_exists &&
        this.sameLocal(now, { rel: '', size: e1.l_size, mtimeUs: e1.l_mtime_us })
      )
        // meanwhile the engine put a tracked version there itself (conflict review "keep local"): this download is
        // obsolete — the Proton version stays in Proton, the next run uploads the local one as a new revision
        throw new Cancel('superseded by a local decision');
      if (now && p.twoWay && !p.targetRel && !(p.replace && this.sameLocal(now, p))) {
        // two-way: the local file changed (or appeared) while downloading -> it is never trashed, both are kept
        await this.copyAside(job, pair, entry, targetRel, now, null, 'both_changed', false);
      } else if (now) {
        if (p.reason === 'preserve_local') {
          const keep = localPath(pair, conflictCopyName(targetRel, 'local edit'));
          renameSync(target, keep);
        } else this.d.trash.trash(target);
      }
      moveInto(file, target);
      const after = this.statLocal(target)!;
      if (!p.targetRel) {
        tx(db, () => {
          this.setLocal(entry.id, after, sha1);
          const e2 = getEntry(db, entry.id)!;
          setBase(db, e2, { digestMissing: !entry.r_sha1 });
          new Stmts(db)
            .get(
              'UPDATE pending_deletions SET executed_at = ? WHERE entry_id = ? AND executed_at IS NULL AND decision IS NOT NULL',
            )
            .run(this.now(), entry.id);
        });
      }
      this.d.count(job, 'downloaded');
      this.d.count(job, 'downloadedBytes', st.size);
      this.d.activity({
        accountId: pair.account_id,
        pairId: pair.id,
        runId: job.run_id,
        jobId: job.id,
        action: 'downloaded',
        relPath: targetRel,
        bytes: st.size,
        durationMs: ms,
        message: p.replace ? msg('activity.changedInProton') : null,
      });
      await this.pace(st.size, ms);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private async move(
    job: JobRow,
    pair: PairRow,
    p: JobPayload & { toEntryId?: number; adopt?: boolean },
  ): Promise<void> {
    const db = this.d.db;
    const remote = this.d.remote(pair.account_id);
    if (!p.uid || !p.toRel) throw new CliError('move without uid/target', 'fatal');
    const srcRef = { section: p.sourceSection ?? pair.remote_section, uid: p.uid };
    const toParentRel = parentRel(p.toRel);
    const toName = baseName(p.toRel);
    const target = p.toEntryId ? getEntry(db, p.toEntryId) : null;
    if (p.toEntryId && (!target || !target.l_exists)) throw new Cancel('local file at the target is gone');
    let node: RemoteNode;
    try {
      node = await remote.info(srcRef);
    } catch (e) {
      if (errorClassOf(e) === 'not_found') throw new Cancel('remote node is gone');
      throw e;
    }
    if (node.trashed) throw new Cancel('remote node was trashed');
    if (p.expectedRevUid && node.rev && node.rev.uid !== p.expectedRevUid)
      throw new Cancel('remote changed since planning');
    const parentUid = this.parentUid(job, pair, toParentRel);
    let moved = false;
    if (node.parentUid !== parentUid) {
      await remote.move([srcRef], this.ref(pair, parentUid));
      moved = true;
    }
    if (node.name !== toName.normalize('NFC')) await remote.rename(this.ref(pair, p.uid), toName);
    const renamedOnly = !moved && node.name !== toName.normalize('NFC');
    const fresh = await remote.info(this.ref(pair, p.uid));
    tx(db, () => {
      if (p.proposalId) {
        // adoption from outside the pair: the target entry gets the moved node as its remote side
        if (target) {
          setRemote(db, target.id, fresh);
          if (fresh.type === 'folder') upsertRemoteFolder(db, pair.id, p.toRel!, fresh.uid);
          settle(db, target.id);
        }
        new Stmts(db)
          .get("UPDATE adoption_proposals SET state = 'done', job_id = ? WHERE id = ?")
          .run(job.id, p.proposalId);
        new Stmts(db).get('DELETE FROM remote_index WHERE account_id = ? AND uid = ?').run(pair.account_id, p.uid!);
        new Stmts(db).get('UPDATE entries SET r_exists = 0 WHERE r_uid = ? AND pair_id != ?').run(p.uid!, pair.id);
      } else {
        const ids = rewritePath(db, pair.id, p.fromRel ?? p.rel, p.toRel!, parentUid);
        if (fresh.type === 'folder') upsertRemoteFolder(db, pair.id, p.toRel!, fresh.uid);
        for (const id of ids) {
          const e = getEntry(db, id);
          if (e && e.rel_path === p.toRel) setRemote(db, id, fresh);
          settle(db, id);
        }
      }
    });
    this.d.count(job, 'moved');
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: renamedOnly ? 'renamed' : 'moved',
      relPath: p.toRel,
      bytes: p.size ?? null,
      message: p.proposalId
        ? msg('activity.adoptedFromProton', { from: p.fromRel ?? p.rel ?? '', to: p.toRel ?? '' })
        : `${p.fromRel ?? p.rel} → ${p.toRel}`,
    });
  }

  private async trashRemote(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const db = this.d.db;
    const remote = this.d.remote(pair.account_id);
    if (!p.uid) throw new CliError('trash without uid', 'fatal');
    if (p.twoWay) {
      // two-way: the file/folder must still be gone here (an editor saving via delete + rename brings it back)
      if (existsSync(localPath(pair, p.rel))) throw new Cancel('exists locally again (re-planned)');
      // a folder waits for the files below it (no CLI call while they wait)
      if (p.kind === 'folder') this.waitBelow(pair.id, p.rel, ['trash_remote'], job.id);
    }
    let node: RemoteNode | null = null;
    try {
      node = await remote.info(this.ref(pair, p.uid));
    } catch (e) {
      if (errorClassOf(e) !== 'not_found') throw e;
    }
    if (node && !node.trashed && node.type === 'folder' && p.twoWay) {
      // two-way folder deletion: only an empty folder goes (its files were trashed one by one before). Anything
      // else in it (a file another device just added, or files never tracked here such as desktop.ini) keeps it:
      // the folder is created here again (the next run downloads what it tracks), so the pair converges
      const kids = (await remote.list(this.ref(pair, p.uid))).filter((n) => !n.trashed);
      if (kids.length) {
        mkdirSync(localPath(pair, p.rel), { recursive: true });
        if (job.entry_id)
          new Stmts(db)
            .get('UPDATE entries SET l_exists = 1, updated_at = ? WHERE id = ?')
            .run(this.now(), job.entry_id);
        if (job.entry_id) settle(db, job.entry_id);
        this.d.activity({
          accountId: pair.account_id,
          pairId: pair.id,
          runId: job.run_id,
          jobId: job.id,
          action: 'info',
          relPath: p.rel,
          message: msg('activity.folderKeptRemoteFiles'),
        });
        return;
      }
    }
    if (node && !node.trashed) {
      if (node.type === 'file' && p.expectedRevUid && node.rev?.uid !== p.expectedRevUid) {
        // remote changed after the decision: back to the pending list with a warning, never trash automatically
        tx(db, () => {
          if (job.entry_id) setRemote(db, job.entry_id, node!);
          new Stmts(db)
            .get(
              'UPDATE pending_deletions SET decision = NULL, decided_at = NULL, decided_by = NULL, job_id = NULL WHERE id = ?',
            )
            .run(p.pendingId ?? -1);
        });
        this.d.activity({
          accountId: pair.account_id,
          pairId: pair.id,
          jobId: job.id,
          action: 'info',
          relPath: p.rel,
          message: msg('activity.notDeletedChanged'),
        });
        throw new Cancel('remote changed after the decision');
      }
      await remote.trash([this.ref(pair, p.uid)]);
    }
    tx(db, () => {
      new Stmts(db)
        .get('UPDATE pending_deletions SET executed_at = ?, job_id = ? WHERE id = ?')
        .run(this.now(), job.id, p.pendingId ?? -1);
      if (job.entry_id) {
        const e = getEntry(db, job.entry_id);
        if (e?.kind === 'folder') {
          new Stmts(db)
            .get('DELETE FROM entries WHERE pair_id = ? AND rel_path >= ? AND rel_path < ? AND l_exists = 0')
            .run(pair.id, `${e.rel_path}/`, `${e.rel_path}/\u{10FFFF}`);
          new Stmts(db).get('DELETE FROM remote_folders WHERE pair_id = ? AND rel_path = ?').run(pair.id, e.rel_path);
        }
        new Stmts(db).get('DELETE FROM entries WHERE id = ?').run(job.entry_id);
      }
    });
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: 'trashed_remote',
      relPath: p.rel,
      bytes: p.size ?? null,
      message: msg('activity.movedToProtonTrash'),
    });
  }

  private async trashLocal(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const db = this.d.db;
    if (p.kind === 'folder') return this.trashLocalFolder(job, pair, p);
    const abs = localPath(pair, p.rel);
    const cur = this.statLocal(abs);
    if (cur && !this.sameLocal(cur, p)) this.replan(job, 'local file changed since planning');
    if (p.twoWay && cur && p.uid) {
      // two-way: Proton must really not have it any more (a listing gap is no deletion)
      let node: RemoteNode | null = null;
      try {
        node = await this.d.remote(pair.account_id).info(this.ref(pair, p.uid));
      } catch (e) {
        if (errorClassOf(e) !== 'not_found') throw e;
      }
      // still there = not trashed and still in a folder of the pair that is alive (a node below a trashed folder is
      // not marked trashed itself)
      const parentAlive =
        !!node?.parentUid &&
        (node.parentUid === pair.remote_root_uid ||
          !!new Stmts(db)
            .get("SELECT 1 FROM entries WHERE pair_id = ? AND kind = 'folder' AND r_uid = ? AND r_exists = 1")
            .get(pair.id, node.parentUid));
      // ... at the same place (same folder, same or undecryptable name): a listing gap, not a deletion. Moved
      // elsewhere (outside what this pair sees) still counts as gone from the pair.
      const e0 = getEntry(db, job.entry_id);
      const samePlace =
        !!e0 && node?.parentUid === e0.r_parent_uid && (node.name === null || node.name === baseName(p.rel));
      if (node && !node.trashed && parentAlive && samePlace) {
        if (job.entry_id) setRemote(db, job.entry_id, node);
        throw new Cancel('still in Proton (re-planned)');
      }
    }
    if (cur) this.d.trash.trash(abs);
    if (p.pendingId)
      new Stmts(db)
        .get('UPDATE pending_deletions SET executed_at = ?, job_id = ? WHERE id = ?')
        .run(this.now(), job.id, p.pendingId);
    if (job.entry_id) {
      const e = getEntry(db, job.entry_id);
      if (e && !e.r_exists) new Stmts(db).get('DELETE FROM entries WHERE id = ?').run(e.id);
      else if (e) new Stmts(db).get("UPDATE entries SET l_exists = 0, state = 'synced' WHERE id = ?").run(e.id);
    }
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: 'trashed_local',
      relPath: p.rel,
      bytes: p.size ?? null,
      message: msg('activity.deletedInProtonTrashedLocal'),
    });
  }

  /**
   * Folder deletions wait for open jobs of the given types on entries below rel: Requeue until the earliest of them
   * may run again (never a busy loop of CLI calls while one of them sits in retry_wait).
   */
  private waitBelow(pairId: number, rel: string, types: string[], exceptJob: number): void {
    const r = new Stmts(this.d.db)
      .get(
        `SELECT COUNT(*) AS n, MIN(COALESCE(j.not_before, 0)) AS nb FROM jobs j JOIN entries e ON e.id = j.entry_id
         WHERE j.pair_id = ? AND j.id != ? AND j.state IN ${OPEN_SQL}
         AND j.type IN (${types.map((t) => `'${t}'`).join(',')}) AND e.rel_path >= ? AND e.rel_path < ?`,
      )
      .get(pairId, exceptJob, `${rel}/`, `${rel}/\u{10FFFF}`) as { n: number; nb: number | null };
    if (!r.n) return;
    throw new Requeue('waiting for the files below the folder', Math.max(1000, (r.nb ?? 0) - this.now()));
  }

  /**
   * two-way: a folder deleted in Proton. Removed locally only when it is empty (its files went to the trash one by
   * one before). Anything else left in it (new, untracked or excluded files) keeps it: the folder is created in Proton
   * again instead — nothing the engine does not track is ever removed.
   */
  private async trashLocalFolder(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const db = this.d.db;
    const abs = localPath(pair, p.rel);
    const e = getEntry(db, job.entry_id);
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      /* gone already */
    }
    if (!names.length) {
      if (existsSync(abs)) rmdirSync(abs);
      if (e && !e.r_exists) new Stmts(db).get('DELETE FROM entries WHERE id = ?').run(e.id);
      else if (e) new Stmts(db).get("UPDATE entries SET l_exists = 0, state = 'synced' WHERE id = ?").run(e.id);
      this.d.activity({
        accountId: pair.account_id,
        pairId: pair.id,
        runId: job.run_id,
        jobId: job.id,
        action: 'trashed_local',
        relPath: p.rel,
        message: msg('activity.folderDeletedInProtonRemoved'),
      });
      return;
    }
    this.waitBelow(pair.id, p.rel, ['trash_local', 'move_local', 'conflict_copy'], job.id);
    insertJob(db, {
      runId: job.run_id,
      accountId: pair.account_id,
      pairId: pair.id,
      entryId: e?.id ?? null,
      type: 'mkdir',
      payload: { rel: p.rel, kind: 'folder', parentRel: parentRel(p.rel), name: baseName(p.rel) },
      priority: derivedPriority(job, 'mkdir', null),
      dedupeKey: `mkdir:${pair.id}:${p.rel}`,
    });
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: 'info',
      relPath: p.rel,
      message: msg('activity.folderDeletedInProtonKept'),
    });
  }

  /**
   * two-way: renames the local version aside to `Name (conflict <host> YYYY-MM-DD).ext` (no-clobber), tracks it as a
   * new local file with its upload, lists the case for review and (scheduleDownload) downloads the remote version
   * into the freed name. The original entry loses its base: it is plain "remote only" afterwards.
   */
  private async copyAside(
    job: JobRow,
    pair: PairRow,
    entry: EntryRow,
    rel: string,
    cur: { size: number; mtimeUs: number },
    sha1: string | null,
    kind: ConflictKind,
    scheduleDownload: boolean,
  ): Promise<string> {
    const db = this.d.db;
    const date = new Date(this.now());
    const { rel: newRel, abs: newAbs } = this.renameAside(
      localPath(pair, rel),
      (i) => twoWayConflictName(rel, this.host(), date, i),
      pair,
    );
    const s = this.statLocal(newAbs);
    if (!s) throw new CliError(`conflict copy "${newRel}" vanished`, 'local_io');
    const hash = sha1 && s.size === cur.size && Math.abs(s.mtimeUs - cur.mtimeUs) < 1e3 ? sha1 : await sha1File(newAbs);
    const t = this.now();
    tx(db, () => {
      const st = new Stmts(db);
      const r = st
        .get(
          `INSERT INTO entries (pair_id, rel_path, kind, l_exists, l_size, l_mtime_us, l_ctime_us, l_inode, l_dev, l_sha1, l_hashed_at,
           state, updated_at) VALUES (?, ?, 'file', 1, ?, ?, ?, ?, ?, ?, ?, 'local_new', ?)`,
        )
        .run(pair.id, newRel, s.size, s.mtimeUs, s.ctimeUs, s.ino, s.dev, hash, t, t);
      const copyId = Number(r.lastInsertRowid);
      this.insertReviewConflict(entry.id, kind, newRel, {
        local: { size: s.size, mtime: new Date(s.mtimeUs / 1e3).toISOString(), sha1: hash },
        remote: entry.r_exists
          ? {
              size: entry.r_size ?? 0,
              mtime: new Date(entry.r_mtime_ms ?? 0).toISOString(),
              sha1: entry.r_sha1,
              revisionUid: entry.r_rev_uid,
            }
          : null,
        base:
          entry.synced_at !== null
            ? {
                size: entry.b_size ?? 0,
                mtime: new Date((entry.b_l_mtime_us ?? 0) / 1e3).toISOString(),
                sha1: entry.b_sha1,
                revisionUid: entry.b_r_rev_uid,
              }
            : null,
      });
      st.get(
        `UPDATE entries SET l_exists = 0, l_size = NULL, l_mtime_us = NULL, l_ctime_us = NULL, l_inode = NULL, l_dev = NULL,
         l_sha1 = NULL, l_hashed_at = NULL, b_sha1 = NULL, b_size = NULL, b_l_mtime_us = NULL, b_r_rev_uid = NULL,
         synced_at = NULL, state = 'remote_new', updated_at = ? WHERE id = ?`,
      ).run(t, entry.id);
      insertJob(db, {
        runId: job.run_id,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: copyId,
        type: 'upload',
        payload: {
          rel: newRel,
          kind: 'file',
          parentRel: parentRel(newRel),
          name: baseName(newRel),
          size: s.size,
          mtimeUs: s.mtimeUs,
          sha1: hash,
          twoWay: true,
          keptBothOf: baseName(rel),
        },
        bytes: s.size,
        priority: derivedPriority(job, 'upload', s.size),
        dedupeKey: `upload:${pair.id}:${newRel}`,
      });
      if (scheduleDownload && entry.r_exists && entry.r_uid)
        insertJob(db, {
          runId: job.run_id,
          accountId: pair.account_id,
          pairId: pair.id,
          entryId: entry.id,
          type: 'download',
          payload: {
            rel,
            kind: 'file',
            parentRel: parentRel(rel),
            name: baseName(rel),
            size: null,
            mtimeUs: null,
            sha1: null,
            uid: entry.r_uid,
            expectedRevUid: entry.r_rev_uid,
            remoteSha1: entry.r_sha1,
            remoteMtimeMs: entry.r_mtime_ms,
            replace: false,
            twoWay: true,
          },
          bytes: entry.r_size,
          priority: derivedPriority(job, 'download', entry.r_size),
          dedupeKey: `download:${pair.id}:${rel}`,
        });
    });
    this.d.count(job, 'conflicts');
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: 'conflict',
      relPath: rel,
      bytes: s.size,
      message: msg('activity.keptBothConflict', { copy: baseName(newRel) }),
    });
    return newRel;
  }

  /** two-way conflict (both sides changed / first contact with different content): keep both, never overwrite */
  private async conflictCopy(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const entry = this.entry(job);
    const abs = localPath(pair, p.rel);
    const cur = this.statLocal(abs);
    if (!cur) throw new Cancel('local file is gone (re-planned)');
    if (!this.sameLocal(cur, p)) this.replan(job, 'local file changed since planning');
    await this.copyAside(job, pair, entry, p.rel, cur, p.sha1 ?? null, p.conflictKind ?? 'both_changed', true);
  }

  /**
   * two-way adoption of a Proton file without sha1 (old Windows upload) whose mtime differs: download it to staging
   * and compare hashes. Same content -> recorded as synced (no upload, no new revision); different -> keep both.
   */
  private async verifyContent(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const db = this.d.db;
    let entry = this.entry(job);
    if (!entry.r_exists || !entry.r_uid) throw new Cancel('remote file is gone (re-planned)');
    const abs = localPath(pair, p.rel);
    if (!this.sameLocal(this.statLocal(abs), p)) this.replan(job, 'local file changed since planning');
    const remote = this.d.remote(pair.account_id);
    const node = await remote.info(this.ref(pair, entry.r_uid));
    if (node.trashed) throw new Cancel('remote file was trashed meanwhile');
    if (node.rev?.uid !== entry.r_rev_uid) {
      setRemote(db, entry.id, node);
      throw new Cancel('remote changed since planning (re-planned)');
    }
    const staging = path.join(this.d.stagingDir(), `job-${job.id}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const t0 = this.now();
      const r = await remote.download(this.ref(pair, entry.r_uid), staging, entry.r_size ?? 0);
      if (r.error) throw r.error;
      this.d.onTransfer('download', r.summary.transferredBytes, this.now() - t0, job.run_id);
      const got = readdirSync(staging);
      if (got.length !== 1) throw new CliError(`download produced ${got.length} files`, 'transient');
      const file = path.join(staging, got[0]!);
      const size = statSync(file).size;
      const sha1 = await sha1File(file);
      if (size === p.size && sha1 === p.sha1) {
        entry = this.entry(job);
        setBase(db, entry, { digestMissing: true });
        this.d.count(job, 'adopted');
        this.d.activity({
          accountId: pair.account_id,
          pairId: pair.id,
          runId: job.run_id,
          jobId: job.id,
          action: 'adopted',
          relPath: p.rel,
          bytes: size,
          message: msg('activity.adoptedVerified'),
        });
        return;
      }
      insertJob(db, {
        runId: job.run_id,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: entry.id,
        type: 'conflict_copy',
        payload: { ...p, conflictKind: 'initial_mismatch' },
        bytes: p.size ?? null,
        priority: derivedPriority(job, 'conflict_copy', null),
        dedupeKey: `conflict_copy:${pair.id}:${p.rel}`,
      });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * two-way: the file was moved/renamed in Proton (same node uid at a new path) -> the local file follows with one
   * rename (no trash + download). With `replaceTarget` (conflict "keep local") the moved file replaces the target,
   * whose current local version goes to the trash first.
   */
  private async moveLocal(job: JobRow, pair: PairRow, p: JobPayload & { toEntryId?: number }): Promise<void> {
    const db = this.d.db;
    if (!p.fromRel || !p.toRel) throw new CliError('move_local without paths', 'fatal');
    const from = this.entry(job);
    const to = p.toEntryId ? getEntry(db, p.toEntryId) : getEntryByRel(db, pair.id, p.toRel);
    const src = localPath(pair, p.fromRel);
    const cur = this.statLocal(src);
    if (!cur) throw new Cancel('local file is gone (re-planned)');
    if (!this.sameLocal(cur, p)) this.replan(job, 'local file changed since planning');
    const dst = existsSync(localPath(pair, p.toRel)) ? localPath(pair, p.toRel) : path.join(pair.local_root, p.toRel);
    const there = this.statLocal(dst);
    if (p.review) {
      const rt = p.replaceTarget;
      if (there && rt && !(there.size === rt.size && rt.mtimeUs !== null && Math.abs(there.mtimeUs - rt.mtimeUs) < 1e3))
        throw new Cancel('target changed since the decision');
      if (there) this.d.trash.trash(dst);
    } else if (there || existsSync(dst)) throw new Cancel('a local file exists at the target (re-planned)');
    mkdirSync(path.dirname(dst), { recursive: true });
    try {
      linkSync(src, dst); // no-clobber
      rmSync(src);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new Cancel('a local file exists at the target (re-planned)');
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw e;
      if (existsSync(dst)) throw new Cancel('a local file exists at the target (re-planned)');
      renameSync(src, dst);
    }
    const after = this.statLocal(dst);
    tx(db, () => {
      const st = new Stmts(db);
      if (!p.review && to) {
        // the entry at the new path (remote side seen there) takes over the local side and the base of the moved one
        st.get(
          `UPDATE entries SET l_exists = 1, l_size = ?, l_mtime_us = ?, l_ctime_us = ?, l_inode = ?, l_dev = ?, l_sha1 = ?,
           l_hashed_at = ?, b_sha1 = ?, b_size = ?, b_l_mtime_us = ?, b_r_rev_uid = ?, synced_at = ?, flags = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          after?.size ?? from.l_size,
          after?.mtimeUs ?? from.l_mtime_us,
          after?.ctimeUs ?? from.l_ctime_us,
          after?.ino ?? from.l_inode,
          after?.dev ?? from.l_dev,
          from.l_sha1,
          from.l_hashed_at,
          from.b_sha1,
          from.b_size,
          from.b_l_mtime_us,
          from.b_r_rev_uid,
          from.synced_at,
          from.flags & ~FLAG.CONFLICT_IGNORED,
          this.now(),
          to.id,
        );
        st.get('DELETE FROM entries WHERE id = ?').run(from.id);
        if (!settle(db, to.id)) st.get("UPDATE entries SET state = 'remote_changed' WHERE id = ?").run(to.id);
      } else {
        if (to && after) this.setLocal(to.id, after, p.sha1 ?? null);
        // conflict "keep local" before the Proton version was downloaded: the target has no base yet. The Proton
        // version is what both sides knew -> base := remote, so the next run uploads the local one as a revision
        if (to && to.synced_at === null && to.r_exists)
          st.get(
            `UPDATE entries SET b_sha1 = r_sha1, b_size = r_size, b_l_mtime_us = NULL, b_r_rev_uid = r_rev_uid,
             synced_at = ?, state = 'local_changed' WHERE id = ?`,
          ).run(this.now(), to.id);
        st.get(
          `UPDATE entries SET l_exists = 0, l_size = NULL, l_mtime_us = NULL, l_ctime_us = NULL, l_inode = NULL, l_dev = NULL,
           l_sha1 = NULL, l_hashed_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(this.now(), from.id);
      }
    });
    this.d.count(job, 'moved');
    const sameDir = parentRel(p.fromRel) === parentRel(p.toRel);
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: sameDir ? 'renamed' : 'moved',
      relPath: p.toRel,
      bytes: p.size ?? null,
      message: msg(p.review ? 'activity.localVersionKept' : 'activity.movedInProton', { from: p.fromRel, to: p.toRel }),
    });
  }

  private async digestBackfill(job: JobRow, pair: PairRow, p: JobPayload): Promise<void> {
    const db = this.d.db;
    const remote = this.d.remote(pair.account_id);
    const e = this.entry(job);
    // -f replace has no revision check: on a two-way pair it could trash another device's newer version
    if (pair.direction === 'two-way') throw new Cancel('digest backfill is not available for two-way pairs');
    if (!(e.flags & FLAG.DIGEST_MISSING) && e.r_sha1) return; // done already
    if (e.state !== 'synced' || !e.l_sha1 || e.l_sha1 !== e.b_sha1) throw new Cancel('entry not in sync');
    const abs = localPath(pair, e.rel_path);
    const s = this.statLocal(abs);
    if (!s || s.size !== e.l_size || e.l_mtime_us === null || Math.abs(s.mtimeUs - e.l_mtime_us) >= 1e3)
      this.replan(job, 'local file changed');
    const parent = e.r_parent_uid ?? resolveFolderUid(db, pair, parentRel(e.rel_path));
    if (!parent) throw new CliError('remote parent unknown', 'not_found');
    const t0 = this.now();
    const prog = this.progress([job], 'upload');
    const r = await remote.upload([abs], this.ref(pair, parent), 'replace', e.l_size ?? 0, prog.opts).finally(prog.end);
    if (r.error) throw r.error;
    const ms = this.now() - t0;
    this.d.onTransfer('upload', r.summary.transferredBytes, ms, job.run_id);
    const nodes = await remote.list(this.ref(pair, parent));
    const node = nodes.find((n) => n.type === 'file' && n.name === baseName(e.rel_path));
    if (!node || node.rev?.sha1 !== e.l_sha1)
      throw new CliError('replaced file not found with the expected sha1', 'transient');
    tx(db, () => {
      setRemote(db, e.id, node);
      new Stmts(db)
        .get(
          `UPDATE entries SET b_r_rev_uid = ?, b_sha1 = ?, flags = flags & ~${FLAG.DIGEST_MISSING | FLAG.MATCHED_BY_SIZE_MTIME}, updated_at = ? WHERE id = ?`,
        )
        .run(node.rev!.uid, e.l_sha1, this.now(), e.id);
    });
    this.d.count(job, 'uploaded');
    this.d.count(job, 'uploadedBytes', e.l_size ?? 0);
    this.d.activity({
      accountId: pair.account_id,
      pairId: pair.id,
      runId: job.run_id,
      jobId: job.id,
      action: 'info',
      relPath: e.rel_path,
      bytes: e.l_size,
      durationMs: ms,
      message: msg('activity.checksumAdded', p.reason ? { reason: p.reason } : {}),
    });
    await this.pace(e.l_size ?? 0, ms);
  }

  private async pace(bytes: number, ms: number): Promise<void> {
    const limit = this.d.bandwidthBps();
    if (!limit || !bytes) return;
    const delay = Math.max(0, (bytes / limit) * 1000 - ms);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  stop(): void {
    this.stopped = true;
    for (const l of this.loops.values()) l.wake?.();
  }

  /** Waits (bounded) until running jobs have recorded their outcome — call after stop() and before closing the DB. */
  async drain(timeoutMs = 10_000): Promise<void> {
    if (!this.inflight.size) return;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((r) => {
        t = setTimeout(r, timeoutMs);
        t.unref();
      }),
    ]);
    if (t) clearTimeout(t);
  }
}

function classifyFailure(text: string): ErrorClass {
  if (/Name conflict|already exists/i.test(text)) return 'conflict';
  if (/ENOENT|EACCES|EPERM/i.test(text)) return 'local_io';
  if (/quota|storage/i.test(text)) return 'quota';
  return 'transient';
}

function safeRel(job: JobRow): string | null {
  try {
    return payloadOf(job).rel ?? null;
  } catch {
    return null;
  }
}

function nodeSnapshot(node: RemoteNode): FileSnapshot {
  return {
    size: node.rev?.size ?? 0,
    mtime: new Date(node.rev?.mtimeMs ?? 0).toISOString(),
    sha1: node.rev?.sha1 ?? null,
    revisionUid: node.rev?.uid ?? null,
  };
}

/** digest-less remote file that matches the planned local snapshot by size + mtime ±2 s */
function sameDigestless(node: RemoteNode, p: JobPayload): boolean {
  const rev = node.rev;
  return (
    !rev?.sha1 &&
    rev?.size === p.size &&
    rev?.mtimeMs != null &&
    p.mtimeUs != null &&
    Math.abs(rev.mtimeMs - p.mtimeUs / 1e3) <= 2000
  );
}

/** `name (from PC YYYY-MM-DD).ext`, `name (from PC YYYY-MM-DD 2).ext`, … next to the original. */
export function fromPcName(rel: string, date: Date, n = 1): string {
  const dir = parentRel(rel);
  const name = baseName(rel);
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const out = `${stem} (from PC ${date.toISOString().slice(0, 10)}${n > 1 ? ` ${n}` : ''})${ext}`;
  return dir ? `${dir}/${out}` : out;
}

/** `name (<label> YYYY-MM-DD).ext` next to the original. */
export function conflictCopyName(rel: string, label: string, date = new Date()): string {
  const dir = parentRel(rel);
  const name = baseName(rel);
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const d = date.toISOString().slice(0, 10);
  const time = label.startsWith('Proton') ? ` ${date.toISOString().slice(11, 16).replace(':', '-')}` : '';
  const n = `${stem} (${label} ${d}${time})${ext}`;
  return dir ? `${dir}/${n}` : n;
}

/** Atomic rename into place; across filesystems copy next to the target first, then rename. */
function moveInto(file: string, target: string): void {
  try {
    renameSync(file, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    const tmp = path.join(path.dirname(target), `.nucleon-sync-tmp-${process.pid}-${path.basename(target)}`);
    copyFileSync(file, tmp);
    const s = statSync(file);
    utimesSync(tmp, s.atime, s.mtime);
    renameSync(tmp, target);
    rmSync(file, { force: true });
  }
}
