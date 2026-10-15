// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Engine facade used by the API server (EngineApi). Wires the per-account CLI pools, the limiter, the scheduler,
 * the run pipeline (scan -> crawl -> brakes -> plan -> execute, ARCHITECTURE §4.3) and the persistent executor.
 */
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  API_VERSION,
  cliWorkerDir,
  decodeMsg,
  isMsg,
  msg,
  nested,
  refOf,
  storeMsg,
  textOf,
  type Msg,
  type MsgRef,
  type TextOrMsg,
  type AccountDto,
  type ActivityItem,
  type AdoptionProposalDto,
  type ConflictDto,
  type ConflictResolution,
  type DaemonEvent,
  type DecideDeletionsRequest,
  type JobDto,
  type Notice,
  type PairDto,
  type PauseRequest,
  type PendingDeletionDto,
  type NucleonSyncPaths,
  type RunDto,
  type RunLane,
  type RunMode,
  type SelectionRule,
  type StatusDto,
  type SyncRequest,
  type TransferBacklogDto,
  type TransferProgressDto,
  type TreeNodeDto,
  TWO_WAY_DEFAULTS,
} from '@nucleon-sync/shared';

import { buildCliEnv, type AccountCliConfig } from '../cli/env.ts';
import { binaryFingerprint, checkCliVersion } from '../cli/compat.ts';
import { OneShotWorker } from '../cli/oneshot.ts';
import {
  cliPriorityScope,
  CliGatedError,
  CliPool,
  ProcessBudget,
  type GateState,
  type PoolWorker,
} from '../cli/pool.ts';
import { CliError, ReplWorker } from '../cli/replWorker.ts';
import {
  belowRange,
  FLAG,
  pairOptions,
  parentRel,
  baseName,
  Stmts,
  tx,
  type AccountRow,
  type EntryRow,
  type JobRow,
  type PairRow,
} from '../db/repo.ts';
import { log } from '../util/log.ts';
import type { ActivityFilter, EngineApi } from './api.ts';
import { crawlAdoptionSource, crawlRemote } from './crawler.ts';
import { getEntry, getEntryByRel } from './entries.ts';
import { conflictCopyName, Executor } from './executor.ts';
import {
  AccountLimiter,
  DEFAULT_LIMITER_CONFIG,
  effectiveBandwidthBps,
  parseApiLogLatency,
  Semaphore,
  type LimiterConfig,
} from './limiter.ts';
import { planPair, type PlanResult } from './planner.ts';
import { boostJobs, insertJob, isLanePriority, jobDto, type JobPayload } from './queue.ts';
import { errorClassOf, RemoteOps, type CliTimeouts } from './remote.ts';
import { RuleMatcher } from './rules.ts';
import { applyScanResult, scanLocal, type ScanResult } from './scanner.ts';
import { Scheduler, type NextRun } from './scheduler.ts';
import { readBrakes, readEngineSetting, readSettings, writeEngineSetting, type BrakeSettings } from './settings.ts';
import { LocalTrash } from './trash.ts';
import { ownedPaths, ownerOf } from './nested.ts';

export interface EngineOptions {
  db: DatabaseSync;
  paths: NucleonSyncPaths;
  cliPath: string;
  mode: 'production' | 'mock';
  version: string;
  /** per-account extra env (mock remotes) */
  accountEnv?: Record<string, Record<string, string>>;
  secretFileDir?: string;
  // ---- tuning (all optional; defaults are the production values from docs/ARCHITECTURE.md)
  /** process env used for the write guard and the CLI env (default process.env) */
  env?: NodeJS.ProcessEnv;
  /** download staging dir; ideally on the same filesystem as the pair roots (default <state>/staging) */
  stagingDir?: string;
  /** absolute local paths that are never synced (daemon.json protectedPaths) */
  protectedPaths?: string[];
  /** fixed freedesktop trash dir (tests); default <topdir>/.Trash-<uid> */
  trashDir?: string;
  limiter?: Partial<LimiterConfig>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  probeIntervalMs?: number;
  offlineAfterFailures?: number;
  freshMs?: number;
  brakes?: Partial<BrakeSettings>;
  scheduler?: boolean;
  schedulerTickMs?: number;
  versionCheck?: boolean;
  freeSpaceMarginBytes?: number;
  shimPollMs?: number;
  logTailMs?: number;
  restartBackoffMs?: number[];
  /** max time a run waits for its jobs before finishing as 'partial' */
  runJobWaitMs?: number;
  /**
   * extra per-account gate (e.g. a foreign proton-drive process uses the adopted session, keyring not ready).
   * Returns a reason when the account must not run CLI commands right now.
   */
  accountGate?: (accountId: string) => TextOrMsg | null;
  /** per-command CLI timeouts (daemon.json `cliTimeouts`; tests use small values) */
  cliTimeouts?: Partial<CliTimeouts>;
  /** idle CLI workers are stopped after this (default 10 min) */
  poolIdleMs?: number;
  /** how often live CLI processes are checked against pause/foreign-process gates (default 15 s) */
  gateCheckMs?: number;
  /**
   * runs that were running or queued when the daemon stopped are requested again (incremental,
   * same scope, trigger 'startup') this long after start (default 60 s; false = never)
   */
  resumeRunsDelayMs?: number | false;
  /** a priority run lifts open jobs of files changed locally within this window (default 10 min) */
  priorityRecentMs?: number;
  /** two-way conflict copies carry this host name (default os.hostname(); tests simulate two devices) */
  hostname?: string;
  /** two-way adoption: digest-less Proton files up to this size are downloaded and hashed (default 64 MiB) */
  twoWayVerifyMaxBytes?: number;
  /**
   * two-way pairs are re-listed (remote change detection) every `options.remoteCheckMinutes`; this is how often the
   * engine looks for due pairs (default 30 s; false = never, e.g. tests that trigger runs themselves). Default: on
   * when the scheduler is on.
   */
  remoteCheckTickMs?: number | false;
}

interface ActiveTransfer {
  jobs: JobRow[];
  accountId: string;
  pairId: number | null;
  kind: 'upload' | 'download';
  relPath: string | null;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  source: TransferProgressDto['source'];
  lastSample: { t: number; bytes: number } | null;
  announced: boolean;
}

/** files at least this big get an activity row when their transfer starts (with the ETA) */
const BIG_FILE_BYTES = 100 * 1000 * 1000;
/** .git internals in backup pairs: local always wins (docs/SYNC-RULES.md) */
const GIT_INTERNAL_SQL = "(e.rel_path GLOB '.git/*' OR e.rel_path GLOB '*/.git/*')";

/**
 * A run that is executing. Runs are scheduled in *lanes*: every account has one background lane
 * (`acct:<id>`: scheduled, global, account-scoped and full/verify runs, one at a time per account) and every pair a
 * priority lane (`pair:<id>`: pair-scoped incremental runs such as an agent's `sync --pair N`). Runs in different
 * lanes run in parallel; the CLI pools keep each account at its worker count and the process budget keeps the total.
 */
interface ActiveRun {
  id: number;
  mode: RunMode;
  req: SyncRequest;
  trigger: RunDto['trigger'];
  counters: RunDto['counters'];
  status: RunDto['status'];
  abort: AbortController;
  /** files postponed as "still being written": the youngest becomes old enough at this time (ms) */
  freshUntil: number;
  /** this run is the automatic re-run for postponed fresh files (never chains another one) */
  freshFollowUp: boolean;
  lane: RunLane;
  /** lane keys this run still holds (a global run releases each account's lane when that account is done) */
  holds: Set<string>;
  /** accounts the run is still working on */
  accounts: Set<string>;
  /** a queued run took over one of this run's lanes (no fresh-file re-run then) */
  handedOver: boolean;
}

/** A requested run waiting for its lane; its `runs` row exists with status 'queued' (the id is final). */
interface QueuedRun {
  id: number;
  key: string;
  req: SyncRequest;
  trigger: RunDto['trigger'];
  lane: RunLane;
  freshFollowUp: boolean;
}

export interface SyncTicket {
  runIds: number[];
  followUp: boolean;
  queuedBehind: number[];
}

/** pair-scoped incremental requests run in the pair's priority lane */
export const laneOf = (req: { pairId?: number | null; mode?: RunMode }): RunLane =>
  req.pairId !== undefined && req.pairId !== null && (req.mode ?? 'incremental') === 'incremental'
    ? 'priority'
    : 'background';

/** CLI priority of the commands of a priority-lane run (crawl listings); background runs use 50/100 */
const PRIORITY_RUN_CLI = 20;
/** a priority run also lifts already queued jobs of its pair whose local file changed this recently ... */
const PRIORITY_RECENT_MS = 10 * 60_000;
/** ... at most this many (the newest first) */
const PRIORITY_RECENT_LIMIT = 200;
const RUN_MODE_ORDER: Record<RunMode, number> = { incremental: 0, verify: 1, full: 2 };

interface AccountHealth {
  transientFailures: number;
  probeTimer: NodeJS.Timeout | null;
  offlineSince: number | null;
  throttledSince: number | null;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const emptyCounters = (): RunDto['counters'] => ({
  scannedLocal: 0,
  listedRemoteFolders: 0,
  uploaded: 0,
  uploadedBytes: 0,
  downloaded: 0,
  downloadedBytes: 0,
  moved: 0,
  adopted: 0,
  conflicts: 0,
  pendingDeletions: 0,
  errors: 0,
});

export class Engine extends EventEmitter implements EngineApi {
  private readonly o: EngineOptions;
  private readonly db: DatabaseSync;
  private readonly st: Stmts;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startedAt = Date.now();
  private readonly pools = new Map<string, CliPool>();
  private readonly remotes = new Map<string, RemoteOps>();
  private readonly limiters = new Map<string, AccountLimiter>();
  private readonly health = new Map<string, AccountHealth>();
  private readonly global: Semaphore;
  private readonly executor: Executor;
  private readonly trash: LocalTrash;
  private scheduler: Scheduler | null = null;
  /** executing runs by id */
  private readonly active = new Map<number, ActiveRun>();
  /** lane key ('acct:<id>' | 'pair:<id>') -> id of the run holding it */
  private readonly laneHolder = new Map<string, number>();
  /** lane key -> run waiting for that lane */
  private readonly queued = new Map<string, QueuedRun>();
  /** per-pair mutex around the local scan: two runs never walk the same pair at the same time */
  private readonly scanLocks = new Map<number, Promise<void>>();
  private idleWaiters: (() => void)[] = [];
  private readonly budget: ProcessBudget;
  private readOnlyReason: Msg | null = null;
  private versionChecked: Promise<void> | null = null;
  private transfers: { t: number; kind: 'upload' | 'download'; bytes: number }[] = [];
  private statusTimer: NodeJS.Timeout | null = null;
  private jobBuffer: JobDto | null = null;
  private jobTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private shimOffset = 0;
  private logOffsets = new Map<string, number>();
  private closed = false;
  /** running transfer commands, keyed by the first job id of the batch */
  private readonly xfers = new Map<number, ActiveTransfer>();
  /** throughput EWMA per direction (bytes/s), persisted in meta('rate:<kind>') */
  private readonly rateEwma: Record<'upload' | 'download', number | null> = { upload: null, download: null };

  constructor(o: EngineOptions) {
    super();
    this.o = o;
    this.db = o.db;
    this.st = new Stmts(o.db);
    this.env = o.env ?? process.env;
    this.trash = new LocalTrash(o.trashDir ? { fixedDir: o.trashDir } : {});
    this.global = new Semaphore(readSettings(this.db).transfer.maxWorkersTotal);
    // live proton-drive processes over all accounts never exceed the same cap (memory)
    this.budget = new ProcessBudget(() => this.global.size);
    this.executor = new Executor({
      db: this.db,
      pair: (id) => this.pairRow(id),
      remote: (a) => this.remote(a),
      pool: (a) => this.pool(a),
      writeGuard: () => this.writeGuardMsg(),
      canRun: (a, p) => this.canRun(a, p),
      blockedPairs: (a) =>
        this.pairRows()
          .filter((p) => p.account_id === a && (p.paused || (p.direction === 'two-way' && this.heldCount(p.id) > 0)))
          .map((p) => p.id),
      stagingDir: () => this.stagingDir(),
      trash: this.trash,
      activity: (a) => this.addActivity(a),
      onJob: (j) => this.emitJob(j),
      onOutcome: (r) => this.onOutcome(r.accountId, r.ok, r.errorClass, r.message),
      onTransfer: (kind, bytes, ms) => this.onTransferDone(kind, bytes, ms),
      onProgress: (jobs, kind, p) => this.onProgress(jobs, kind, p),
      count: (job, key, n = 1) => this.count(job, key, n),
      bandwidthBps: () => {
        const tr = readSettings(this.db).transfer;
        return effectiveBandwidthBps(tr.bandwidthLimitKBps, tr.quietHours);
      },
      retryBaseMs: o.retryBaseMs,
      retryMaxMs: o.retryMaxMs,
      freeSpaceMarginBytes: o.freeSpaceMarginBytes,
      hostname: o.hostname ? () => o.hostname! : undefined,
      ownedElsewhere: (pair, rel) => ownerOf(rel, ownedPaths(pair, this.pairRows()))?.pairName ?? null,
    });
    this.executor.on('error', (e) => log('error', 'executor loop failed', { err: String(e) }));
    this.boot();
  }

  // ================================================================ lifecycle

  private boot(): void {
    const recovered = this.executor.recover();
    if (recovered) log('info', 'jobs re-queued after restart', { recovered });
    this.executor.unblock();
    // runs that were running or queued when the daemon stopped: cancelled, and requested again below
    const interrupted = this.st
      .get("SELECT id, account_id, pair_id FROM runs WHERE status IN ('running','queued') ORDER BY id")
      .all() as { id: number; account_id: string | null; pair_id: number | null }[];
    this.st
      .get("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running','queued')")
      .run(Date.now());
    try {
      rmSync(this.stagingDir(), { recursive: true, force: true }); // partial downloads only live here
    } catch {
      /* ignore */
    }
    this.st.get('DELETE FROM activity WHERE ts < ?').run(Date.now() - 180 * 86400_000);
    const shim = this.shimEventsFile();
    this.shimOffset = existsSync(shim) ? statSync(shim).size : 0;
    const shimT = setInterval(() => this.pollShimEvents(), this.o.shimPollMs ?? 2000);
    shimT.unref();
    const logT = setInterval(() => this.pollCliLogs(), this.o.logTailMs ?? 5000);
    logT.unref();
    const limT = setInterval(() => {
      for (const l of this.limiters.values()) l.tick();
      this.checkLongStates();
    }, 1000);
    limT.unref();
    // live CLI processes of paused / foreign-gated accounts are stopped (pause must be airtight)
    const gateT = setInterval(() => this.enforceGates(), this.o.gateCheckMs ?? 15_000);
    gateT.unref();
    this.timers.push(shimT, logT, limT, gateT);
    for (const k of ['upload', 'download'] as const) {
      const v = Number(
        (this.st.get('SELECT value FROM meta WHERE key = ?').get(`rate:${k}`) as { value: string } | undefined)?.value,
      );
      if (v > 0) this.rateEwma[k] = v;
    }
    this.autoResolveGitConflicts();
    if (this.o.scheduler !== false) {
      this.scheduler = new Scheduler({
        settings: () => readSettings(this.db).schedule,
        load: () => readEngineSetting<NextRun[]>(this.db, 'nextRuns') ?? null,
        save: (r) => writeEngineSetting(this.db, 'nextRuns', r),
        onDue: (mode, trigger) => this.requestSync({ mode }, trigger),
        tickMs: this.o.schedulerTickMs,
      });
      this.scheduler.start();
    }
    if (this.st.get("SELECT 1 FROM jobs WHERE state IN ('queued','retry_wait') LIMIT 1").get()) this.executor.kick();
    this.resumeInterrupted(interrupted);
    const rc = this.o.remoteCheckTickMs ?? (this.o.scheduler !== false ? 30_000 : false);
    if (rc !== false) {
      const t = setInterval(() => this.remoteChecks(), rc);
      t.unref();
      this.timers.push(t);
    }
  }

  private readonly remoteCheckRequested = new Map<number, number>();
  /**
   * two-way pairs: the CLI has no change feed, so remote changes are found by listing. Every pair whose last run is
   * older than its `remoteCheckMinutes` (default 10) gets a pair run (priority lane, full listing of a small pair).
   * Paused, braked or blocked pairs are skipped; a pair is requested at most once per interval.
   */
  remoteChecks(now = Date.now()): number[] {
    const started: number[] = [];
    for (const p of this.pairRows()) {
      if (p.direction !== 'two-way' || !p.enabled || p.paused) continue;
      const every = (pairOptions(p).remoteCheckMinutes ?? TWO_WAY_DEFAULTS.remoteCheckMinutes) * 60_000;
      if (p.last_run_at && now - p.last_run_at < every) continue;
      if (now - (this.remoteCheckRequested.get(p.id) ?? 0) < every) continue;
      if (this.laneHolder.has(`pair:${p.id}`) || this.queued.has(`pair:${p.id}`)) continue;
      if (this.syncBlocker({ pairId: p.id }) || this.heldCount(p.id) || this.brakeActive(p.id)) continue;
      this.remoteCheckRequested.set(p.id, now);
      started.push(...this.requestSyncTicket({ pairId: p.id, mode: 'incremental' }, 'schedule').runIds);
    }
    return started;
  }

  private brakeActive(pairId: number): boolean {
    return !!this.st
      .get(
        'SELECT 1 FROM pair_state WHERE pair_id = ? AND brake_reason IS NOT NULL AND brake_at IS NOT NULL AND (brake_released_at IS NULL OR brake_released_at < brake_at)',
      )
      .get(pairId);
  }

  /**
   * Runs interrupted by a restart continue: their scopes are requested again as incremental runs (the queued jobs
   * resumed already at boot; the run re-plans and waits for them). Each lane gets at most one run (merging).
   */
  private resumeInterrupted(rows: { id: number; account_id: string | null; pair_id: number | null }[]): void {
    const delay = this.o.resumeRunsDelayMs ?? 60_000;
    if (delay === false || !rows.length) return;
    const t = setTimeout(() => {
      if (this.closed) return;
      for (const r of rows) {
        const req: SyncRequest = {
          ...(r.pair_id !== null ? { pairId: r.pair_id } : r.account_id !== null ? { accountId: r.account_id } : {}),
          mode: 'incremental',
        };
        if (r.pair_id !== null && !this.pairRow(r.pair_id)) continue;
        if (r.pair_id === null && r.account_id !== null && !this.accountRow(r.account_id)) continue;
        const ticket = this.requestSyncTicket(req, 'startup');
        log('info', 'interrupted run resumed', { interrupted: r.id, runIds: ticket.runIds });
      }
    }, delay);
    t.unref();
    this.timers.push(t);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.scheduler?.stop();
    for (const t of this.timers) clearTimeout(t);
    for (const h of this.health.values()) if (h.probeTimer) clearTimeout(h.probeTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.jobTimer) clearTimeout(this.jobTimer);
    for (const r of this.active.values()) r.abort.abort();
    // queued runs never start now; their rows stay 'queued' and are resumed at the next start
    this.queued.clear();
    this.notifyIdle();
    this.executor.stop();
    await Promise.allSettled([...this.pools.values()].map((p) => p.shutdown()));
    // jobs interrupted by the pool shutdown still write their outcome; the caller closes the DB afterwards
    await this.executor.drain();
  }

  async reload(): Promise<void> {
    const s = readSettings(this.db);
    this.global.setCapacity(s.transfer.maxWorkersTotal);
    for (const a of this.accountRows()) {
      const p = this.pools.get(a.id);
      if (p) p.setSize(Math.min(a.workers, s.transfer.maxWorkersPerAccount));
    }
    for (const id of [...this.pools.keys()]) {
      if (!this.accountRows().some((a) => a.id === id)) {
        await this.pools.get(id)!.shutdown();
        this.pools.delete(id);
        this.remotes.delete(id);
      }
    }
    this.scheduler?.reschedule();
    this.executor.unblock();
    this.executor.kick();
    this.scheduleStatus();
  }

  // ================================================================ events

  emitEvent(e: DaemonEvent): void {
    this.emit('event', e);
  }

  private scheduleStatus(): void {
    if (this.statusTimer || this.closed) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (!this.closed) this.emitEvent({ type: 'status', status: this.status() });
    }, 1000);
    this.statusTimer.unref();
  }

  /** job events are throttled to <= 4/s (latest wins) */
  private emitJob(j: JobDto): void {
    this.jobBuffer = j;
    if (this.jobTimer) return;
    this.emitEvent({ type: 'job', job: j });
    this.jobBuffer = null;
    this.jobTimer = setTimeout(() => {
      this.jobTimer = null;
      if (this.jobBuffer && !this.closed) this.emitJob(this.jobBuffer);
    }, 250);
    this.jobTimer.unref();
    this.scheduleStatus();
  }

  private notice(n: Omit<Notice, 'title' | 'body'> & { title: Msg; body: TextOrMsg }): void {
    const { title, body, ...rest } = n;
    this.emitEvent({
      type: 'notice',
      notice: {
        ...rest,
        title: title.text,
        body: textOf(body),
        titleMsg: refOf(title),
        ...(isMsg(body) ? { bodyMsg: refOf(body) } : {}),
      },
    });
  }

  addActivity(a: {
    accountId: string;
    pairId?: number | null;
    runId?: number | null;
    jobId?: number | null;
    action: ActivityItem['action'];
    relPath?: string | null;
    bytes?: number | null;
    durationMs?: number | null;
    /** English text, or a message (key + params for the dashboard, English text for everyone else) */
    message?: TextOrMsg | null;
  }): void {
    const ts = Date.now();
    const runId = a.runId ?? this.runOf(a.accountId, a.pairId ?? null)?.id ?? null;
    const text = textOf(a.message);
    const ref = isMsg(a.message) ? refOf(a.message) : null;
    const res = this.st
      .get(
        'INSERT INTO activity (ts, account_id, pair_id, run_id, job_id, action, rel_path, bytes, duration_ms, message, msg) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        ts,
        a.accountId,
        a.pairId ?? null,
        runId,
        a.jobId ?? null,
        a.action,
        a.relPath ?? null,
        a.bytes ?? null,
        a.durationMs ?? null,
        text,
        ref ? JSON.stringify(ref) : null,
      );
    this.emitEvent({
      type: 'activity',
      item: {
        id: Number(res.lastInsertRowid),
        ts: new Date(ts).toISOString(),
        accountId: a.accountId,
        pairId: a.pairId ?? null,
        action: a.action,
        relPath: a.relPath ?? null,
        bytes: a.bytes ?? null,
        durationMs: a.durationMs ?? null,
        message: text,
        ...(ref ? { msg: ref } : {}),
        runId,
      },
    });
  }

  /**
   * Run counters of an executed job: its own run while active, otherwise the active run of its pair's priority lane
   * (lane jobs) or of its account (e.g. the backlog of a run interrupted by a restart counts into the resumed run).
   */
  private count(job: JobRow, key: string, n: number): void {
    const c =
      (job.run_id !== null ? this.active.get(job.run_id) : undefined) ??
      this.runOf(job.account_id, isLanePriority(job.priority) ? job.pair_id : null);
    if (!c) return;
    const k = key as keyof RunDto['counters'];
    if (k in c.counters) c.counters[k] += n;
  }

  /** active run working on this pair (its priority run first) or account */
  private runOf(accountId: string, pairId: number | null): ActiveRun | undefined {
    const byPair = pairId !== null ? this.laneHolder.get(`pair:${pairId}`) : undefined;
    const id = byPair ?? this.laneHolder.get(`acct:${accountId}`);
    return id !== undefined ? this.active.get(id) : undefined;
  }

  // ================================================================ accounts, pools, health

  private accountRows(): AccountRow[] {
    return this.st.get('SELECT * FROM accounts ORDER BY created_at').all() as unknown as AccountRow[];
  }

  private accountRow(id: string): AccountRow | null {
    return (this.st.get('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined) ?? null;
  }

  private pairRows(): PairRow[] {
    return this.st.get('SELECT * FROM pairs ORDER BY id').all() as unknown as PairRow[];
  }

  private pairRow(id: number): PairRow | null {
    return (this.st.get('SELECT * FROM pairs WHERE id = ?').get(id) as unknown as PairRow | undefined) ?? null;
  }

  private limiter(accountId: string): AccountLimiter {
    let l = this.limiters.get(accountId);
    if (!l) {
      l = new AccountLimiter(accountId, { ...DEFAULT_LIMITER_CONFIG, ...(this.o.limiter ?? {}) });
      l.on('change', (state: string, reason: string) => this.onLimiterChange(accountId, state, reason));
      this.limiters.set(accountId, l);
    }
    return l;
  }

  pool(accountId: string): CliPool {
    let p = this.pools.get(accountId);
    if (p) return p;
    const row = this.accountRow(accountId);
    if (!row) throw new CliError(`unknown account ${accountId}`, 'fatal');
    const s = readSettings(this.db);
    const cfg: AccountCliConfig = {
      accountId,
      credentialBackend: row.credential_backend,
      secretService: row.secret_service,
      secretKey: row.secret_key,
      secretSchema: row.secret_schema,
      extraEnv: this.o.accountEnv?.[accountId] ?? {},
    };
    const oneshot = this.env.NUCLEON_SYNC_CLI_ONESHOT === '1';
    const makeWorker = (i: number): PoolWorker => {
      const env = buildCliEnv(this.env, cfg, cliWorkerDir(this.o.paths, accountId, i), {
        shimEventsFile: this.shimEventsFile(),
        secretFileDir: this.o.secretFileDir,
        encFile: { dir: this.o.paths.secretsDir, keyFile: this.o.paths.secretKeyFile },
      });
      const name = `${accountId}/w${i}`;
      const w = oneshot
        ? new OneShotWorker({ cliPath: this.o.cliPath, env, name })
        : new ReplWorker({ cliPath: this.o.cliPath, env, name });
      w.on('exit', () => log('warn', 'cli worker exited', { worker: name }));
      return w as PoolWorker;
    };
    p = new CliPool({
      accountId,
      size: Math.min(row.workers, s.transfer.maxWorkersPerAccount),
      makeWorker,
      limiter: this.limiter(accountId),
      global: this.global,
      restartBackoffMs: this.o.restartBackoffMs,
      gate: () => this.cliGateState(accountId),
      idleMs: this.o.poolIdleMs,
      budget: this.budget,
    });
    this.pools.set(accountId, p);
    return p;
  }

  remote(accountId: string): RemoteOps {
    let r = this.remotes.get(accountId);
    if (!r) {
      r = new RemoteOps({
        pool: this.pool(accountId),
        writeGuard: () => this.writeGuard(),
        skipThumbnails: () => !readSettings(this.db).transfer.thumbnails,
        timeouts: this.o.cliTimeouts,
        tempDir: () => path.join(this.stagingDir(), 'upload-links'),
        expectedBps: (kind) => this.rateEwma[kind] ?? (kind === 'upload' ? 2 : 4) * 1024 * 1024,
      });
      this.remotes.set(accountId, r);
    }
    return r;
  }

  /** Reason why Proton writes are refused right now (English), or null. */
  writeGuard(): string | null {
    return this.writeGuardMsg()?.text ?? null;
  }

  /** writeGuard() as a message (key + params for the dashboard). */
  writeGuardMsg(): Msg | null {
    if (this.readOnlyReason) return this.readOnlyReason;
    if (this.o.mode === 'production' && this.env.NUCLEON_SYNC_ALLOW_WRITES !== '1') return msg('guard.writesDisabled');
    return null;
  }

  /**
   * Why this account must not run ANY proton-drive process right now (CliPool gate), else null: global or account
   * pause, or a foreign proton-drive process using the same session. Pair pauses do not stop the account's workers.
   */
  cliGate(accountId: string): string | null {
    return this.cliGateState(accountId)?.reason ?? null;
  }

  /** pause = soft (a job that already runs finishes its file), foreign process = hard */
  private cliGateState(accountId: string): GateState | null {
    const foreign = this.o.accountGate?.(accountId);
    if (foreign) return { reason: textOf(foreign), ...(isMsg(foreign) ? { msg: foreign } : {}), soft: false };
    const gate = (m: Msg): GateState => ({ reason: m.text, msg: m, soft: true });
    if (this.closed) return gate(msg('gate.shuttingDown'));
    if (this.globalPaused()) return gate(msg('gate.paused'));
    const a = this.accountRow(accountId);
    if (a?.paused) return gate(msg('gate.accountPaused', { account: a.display_name }));
    return null;
  }

  /** Stop CLI processes of gated accounts (idle ones always; busy ones too when `hard` or a foreign process runs). */
  enforceGates(accountId?: string, hard = false): void {
    for (const [id, pool] of this.pools) {
      if (accountId && id !== accountId) continue;
      if (!pool.aliveCount()) continue;
      const reason = this.cliGate(id);
      if (!reason) continue;
      const foreign = !!this.o.accountGate?.(id);
      pool.enforceGate(hard || foreign);
      log('info', 'cli workers stopped (gate)', { account: id, reason, hard: hard || foreign });
    }
  }

  private globalPaused(): boolean {
    return (
      (this.st.get("SELECT value FROM meta WHERE key = 'paused'").get() as { value: string } | undefined)?.value === '1'
    );
  }

  private canRun(accountId: string, pairId: number | null): boolean {
    if (this.closed || this.globalPaused()) return false;
    const a = this.accountRow(accountId);
    if (!a || a.paused || !a.enabled) return false;
    if (['needs_login', 'needs_keyring', 'offline', 'login_pending', 'disabled'].includes(a.status)) return false;
    if (this.o.accountGate?.(accountId)) return false;
    if (pairId !== null) {
      const p = this.pairRow(pairId);
      if (!p || p.paused) return false;
      // two-way mass-delete guard: the whole pair waits (no job runs) until the held deletions are decided
      if (p.direction === 'two-way' && this.heldCount(pairId) > 0) return false;
    }
    return true;
  }

  private heldCache = new Map<number, { at: number; n: number }>();
  /** undecided deletions held by the two-way mass-delete guard (cached 1 s; decisions clear the cache) */
  heldCount(pairId: number): number {
    const c = this.heldCache.get(pairId);
    if (c && Date.now() - c.at < 1000) return c.n;
    const n = (
      this.st
        .get(
          `SELECT COUNT(*) AS n FROM pending_deletions d JOIN entries e ON e.id = d.entry_id
           WHERE e.pair_id = ? AND d.held = 1 AND d.decision IS NULL AND d.executed_at IS NULL`,
        )
        .get(pairId) as { n: number }
    ).n;
    this.heldCache.set(pairId, { at: Date.now(), n });
    return n;
  }

  private healthOf(accountId: string): AccountHealth {
    let h = this.health.get(accountId);
    if (!h) {
      h = { transientFailures: 0, probeTimer: null, offlineSince: null, throttledSince: null };
      this.health.set(accountId, h);
    }
    return h;
  }

  /** `err`: a plain text (CLI error) or a message; stored with `storeMsg` (accounts.last_error) */
  private setAccountStatus(id: string, status: AccountDto['status'], err: TextOrMsg | null): void {
    const cur = this.accountRow(id);
    if (!cur) return;
    const stored = storeMsg(err);
    if (cur.status === status && cur.last_error === stored && status !== 'ok') return;
    this.st
      .get(
        "UPDATE accounts SET status = ?, last_error = ?, last_ok_at = CASE WHEN ? = 'ok' THEN ? ELSE last_ok_at END WHERE id = ?",
      )
      .run(status, stored, status, Date.now(), id);
    if (cur.status !== status) {
      this.emitEvent({
        type: 'account',
        accountId: id,
        status,
        ...(err ? { message: textOf(err) } : {}),
        ...(isMsg(err) ? { msg: refOf(err) } : {}),
      });
      this.scheduleStatus();
    }
  }

  private onOutcome(accountId: string, ok: boolean, cls?: string, message?: string): void {
    const h = this.healthOf(accountId);
    const a = this.accountRow(accountId);
    if (ok) {
      h.transientFailures = 0;
      if (a && (a.status === 'error' || a.status === 'offline')) this.setAccountStatus(accountId, 'ok', null);
      else if (a && a.status === 'ok')
        this.st.get('UPDATE accounts SET last_ok_at = ? WHERE id = ?').run(Date.now(), accountId);
      return;
    }
    if (cls === 'transient') {
      h.transientFailures++;
      if (h.transientFailures >= (this.o.offlineAfterFailures ?? 3))
        this.goOffline(accountId, message ?? msg('account.networkError'));
    } else if (cls === 'auth') {
      this.setAccountStatus(accountId, 'needs_login', message ?? msg('account.loginNeeded'));
      this.notice({
        key: `error:auth:${accountId}`,
        severity: 'error',
        title: msg('notice.loginNeeded'),
        body: msg('notice.loginNeededBody', { account: a?.display_name ?? accountId }),
        accountId,
      });
    } else if (cls === 'quota') {
      this.setAccountStatus(accountId, 'error', msg('account.storageFull'));
      this.notice({
        key: `quota:${accountId}`,
        severity: 'error',
        title: msg('notice.quotaFull'),
        body: message ?? '',
        accountId,
      });
    } else if (cls === 'local_io' && message && /ENOSPC/.test(message)) {
      this.notice({ key: 'disk:full', severity: 'error', title: msg('notice.diskFull'), body: message, accountId });
    }
  }

  private goOffline(accountId: string, message: TextOrMsg): void {
    const h = this.healthOf(accountId);
    if (h.offlineSince === null) h.offlineSince = Date.now();
    this.setAccountStatus(accountId, 'offline', message);
    if (h.probeTimer) return;
    const probe = async () => {
      h.probeTimer = null;
      if (this.closed) return;
      try {
        await this.remote(accountId).probe();
        h.transientFailures = 0;
        h.offlineSince = null;
        this.setAccountStatus(accountId, 'ok', null);
        this.addActivity({ accountId, action: 'info', message: msg('activity.backOnline') });
        this.executor.kick(accountId);
      } catch (e) {
        if (errorClassOf(e) === 'auth') {
          h.offlineSince = null;
          this.onOutcome(accountId, false, 'auth', (e as Error).message);
          return;
        }
        h.probeTimer = setTimeout(() => void probe(), this.o.probeIntervalMs ?? 30_000);
        h.probeTimer.unref();
      }
    };
    h.probeTimer = setTimeout(() => void probe(), this.o.probeIntervalMs ?? 30_000);
    h.probeTimer.unref();
  }

  private onLimiterChange(accountId: string, state: string, reason: string): void {
    const h = this.healthOf(accountId);
    const l = this.limiter(accountId);
    if (state === 'normal') {
      h.throttledSince = null;
      const a = this.accountRow(accountId);
      if (a?.status === 'throttled') this.setAccountStatus(accountId, 'ok', null);
    } else {
      h.throttledSince ??= Date.now();
      const until = new Date(l.cooldownUntil);
      const m =
        state === 'cooldown'
          ? msg('account.throttledUntil', {
              time: `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`,
            })
          : msg('account.throttledOneWorker');
      this.setAccountStatus(accountId, 'throttled', m);
      this.addActivity({
        accountId,
        action: 'info',
        message: msg('activity.throttled', { status: nested(m), reason }),
      });
    }
    this.executor.kick(accountId);
    this.scheduleStatus();
  }

  /** notices for long-lasting states (throttled > 30 min, offline > 2 h) */
  private checkLongStates(): void {
    const t = Date.now();
    for (const [id, h] of this.health) {
      if (h.throttledSince && t - h.throttledSince > 30 * 60_000)
        this.notice({
          key: `throttled:${id}`,
          severity: 'warn',
          title: msg('notice.throttled'),
          body: msg('notice.throttledBody'),
          accountId: id,
        });
      if (h.offlineSince && t - h.offlineSince > 2 * 3600_000)
        this.notice({
          key: `offline:${id}`,
          severity: 'warn',
          title: msg('notice.offline'),
          body: msg('notice.offlineBody'),
          accountId: id,
        });
    }
  }

  private shimEventsFile(): string {
    return path.join(this.o.paths.stateDir, 'shim-events.jsonl');
  }

  /** `rm suppressed` from the shim = a worker lost the refresh race -> restart the account's workers. */
  private pollShimEvents(): void {
    const f = this.shimEventsFile();
    for (const line of readNew(f, this.shimOffset, (n) => (this.shimOffset = n))) {
      try {
        const ev = JSON.parse(line) as { account?: string; op?: string; result?: string };
        if (ev.op === 'rm' && ev.result === 'suppressed' && ev.account) this.pools.get(ev.account)?.markStale();
      } catch {
        /* ignore */
      }
    }
  }

  /** CLI request log (`INFO [api] ... (NNNms)`) of every worker dir feeds the limiter. */
  private pollCliLogs(): void {
    for (const accountId of this.pools.keys()) {
      const dir = path.join(this.o.paths.accountsDir, accountId, 'cli');
      let workers: string[];
      try {
        workers = readdirSync(dir);
      } catch {
        continue;
      }
      for (const w of workers) {
        const f = path.join(dir, w, 'proton-drive.log');
        const off = this.logOffsets.get(f) ?? (existsSync(f) ? statSync(f).size : 0);
        this.logOffsets.set(f, off);
        for (const line of readNew(f, off, (n) => this.logOffsets.set(f, n))) {
          const ms = parseApiLogLatency(line);
          if (ms !== null) this.limiter(accountId).recordLatency(ms);
        }
      }
    }
  }

  private stagingDir(): string {
    return this.o.stagingDir ?? path.join(this.o.paths.stateDir, 'staging');
  }

  private versionFingerprint: string | null = null;

  private async ensureVersion(): Promise<void> {
    if (this.o.versionCheck === false) return;
    const fp = binaryFingerprint(this.o.cliPath);
    if (fp !== this.versionFingerprint) {
      // first run or the binary changed (CLI update): check again
      this.versionFingerprint = fp;
      this.versionChecked = null;
      this.readOnlyReason = null;
    }
    this.versionChecked ??= checkCliVersion(this.o.cliPath, this.env).then((v) => {
      if (!v.compatible) {
        this.readOnlyReason = msg('guard.cliUpdated', { version: v.cliVersion ?? 'unknown' });
        this.notice({
          key: 'cli:version',
          severity: 'warn',
          title: msg('notice.cliUpdated'),
          body: this.readOnlyReason,
        });
      } else if (v.updateHint) {
        this.addActivity({ accountId: this.accountRows()[0]?.id ?? '-', action: 'info', message: v.updateHint });
      }
    });
    return this.versionChecked;
  }

  // ================================================================ transfer progress / ETA

  private onTransferDone(kind: 'upload' | 'download', bytes: number, ms: number): void {
    this.transfers.push({ t: Date.now(), kind, bytes });
    if (bytes >= 1024 * 1024 && ms > 0) this.updateRate(kind, (bytes / ms) * 1000, 0.3);
  }

  private updateRate(kind: 'upload' | 'download', bps: number, alpha: number): void {
    if (!(bps > 0) || !Number.isFinite(bps)) return;
    const old = this.rateEwma[kind];
    this.rateEwma[kind] = old === null ? bps : old + alpha * (bps - old);
    try {
      this.st
        .get('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(`rate:${kind}`, String(Math.round(this.rateEwma[kind]!)));
    } catch {
      /* db closed during shutdown */
    }
  }

  private onProgress(
    jobs: JobRow[],
    kind: 'upload' | 'download',
    p: { bytesDone: number; bytesTotal: number; source: string } | null,
  ): void {
    const first = jobs[0];
    if (!first || this.closed) return;
    const key = first.id;
    if (!p) {
      this.xfers.delete(key);
      this.scheduleStatus();
      return;
    }
    const now = Date.now();
    let a = this.xfers.get(key);
    if (!a) {
      let rel: string | null = null;
      try {
        rel = (JSON.parse(first.payload) as JobPayload).rel ?? null;
      } catch {
        /* ignore */
      }
      a = {
        jobs,
        accountId: first.account_id,
        pairId: first.pair_id,
        kind,
        relPath: rel,
        bytesDone: 0,
        bytesTotal: p.bytesTotal,
        startedAt: now,
        source: 'estimate',
        lastSample: null,
        announced: false,
      };
      this.xfers.set(key, a);
    }
    // live throughput from measured progress (not from the time-based estimate)
    if (p.source !== 'estimate') {
      if (a.lastSample && now - a.lastSample.t >= 5000 && p.bytesDone > a.lastSample.bytes) {
        this.updateRate(kind, ((p.bytesDone - a.lastSample.bytes) / (now - a.lastSample.t)) * 1000, 0.1);
        a.lastSample = { t: now, bytes: p.bytesDone };
      } else if (!a.lastSample) a.lastSample = { t: now, bytes: p.bytesDone };
    }
    a.bytesDone = p.bytesDone;
    a.bytesTotal = p.bytesTotal;
    a.source = p.source as ActiveTransfer['source'];
    const dto = this.transferDto(a);
    if (!a.announced && a.bytesTotal >= BIG_FILE_BYTES) {
      a.announced = true;
      this.addActivity({
        accountId: a.accountId,
        pairId: a.pairId,
        runId: first.run_id,
        jobId: first.id,
        action: 'info',
        relPath: a.relPath,
        bytes: a.bytesTotal,
        message: msg(kind === 'upload' ? 'activity.bigUpload' : 'activity.bigDownload', {
          bytes: a.bytesTotal,
          ...(dto.etaSeconds !== null ? { eta: dto.etaSeconds } : {}),
        }),
      });
    }
    this.emitJob({ ...jobDto(first), ...this.progressFields(a) });
    this.scheduleStatus();
  }

  private progressFields(a: ActiveTransfer): Pick<JobDto, 'progress' | 'bytesDone' | 'etaSeconds'> {
    const d = this.transferDto(a);
    return {
      progress: a.bytesTotal > 0 ? Math.min(1, a.bytesDone / a.bytesTotal) : null,
      bytesDone: a.bytesDone,
      etaSeconds: d.etaSeconds,
    };
  }

  private transferDto(a: ActiveTransfer): TransferProgressDto {
    const elapsed = (Date.now() - a.startedAt) / 1000;
    const own = a.source !== 'estimate' && elapsed >= 5 && a.bytesDone > 0 ? a.bytesDone / elapsed : null;
    const rate = own ?? this.rateEwma[a.kind];
    const left = Math.max(0, a.bytesTotal - a.bytesDone);
    return {
      jobIds: a.jobs.map((j) => j.id),
      accountId: a.accountId,
      pairId: a.pairId,
      kind: a.kind,
      relPath: a.relPath,
      files: a.jobs.length,
      bytesDone: a.bytesDone,
      bytesTotal: a.bytesTotal,
      startedAt: new Date(a.startedAt).toISOString(),
      rateBps: own !== null ? Math.round(own) : null,
      etaSeconds: rate ? Math.round(left / rate) : null,
      source: a.source,
    };
  }

  /** Live transfers + open backlog per direction with an ETA (StatusDto.transfers, `nucleon-sync status`). */
  transfersStatus(): NonNullable<StatusDto['transfers']> {
    const active = [...this.xfers.values()].map((a) => this.transferDto(a));
    const backlog = (kind: 'upload' | 'download'): TransferBacklogDto => {
      const types = kind === 'upload' ? "('upload','upload_revision','digest_backfill')" : "('download')";
      const open = this.st
        .get(
          `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM jobs WHERE type IN ${types} AND state IN ('queued','running','retry_wait')`,
        )
        .get() as { n: number; b: number };
      const blocked = this.st
        .get(
          `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM jobs WHERE type IN ${types} AND state = 'blocked'`,
        )
        .get() as { n: number; b: number };
      const mine = active.filter((a) => a.kind === kind);
      const done = mine.reduce((x, a) => x + a.bytesDone, 0);
      const live = mine.reduce((x, a) => x + (a.rateBps ?? 0), 0);
      const rate = this.rateEwma[kind] ?? (live > 0 ? live : null);
      const left = Math.max(0, open.b - done);
      // per-file overhead (listing + bookkeeping) ~0.5 s, small files are batched
      const eta = open.n === 0 ? 0 : rate ? Math.round(left / rate + open.n * 0.5) : null;
      return {
        files: open.n,
        bytes: open.b,
        bytesDone: done,
        rateBps: rate ? Math.round(rate) : null,
        etaSeconds: eta,
        blockedFiles: blocked.n,
        blockedBytes: blocked.b,
      };
    };
    return { active, upload: backlog('upload'), download: backlog('download') };
  }

  // ================================================================ .git internals: local wins

  /**
   * Conflicts on files inside a `.git/` folder of a backup (or upload-only) pair are resolved automatically with
   * "keep local": the repository on the PC is the truth (index, worktree gitdir files, refs change all the time and
   * are meaningless to merge). Logged in the activity feed. Only when the local file exists.
   */
  autoResolveGitConflicts(pairId?: number): number {
    const rows = this.st
      .get(
        `SELECT c.id, e.rel_path, e.pair_id, p.account_id FROM conflicts c JOIN entries e ON e.id = c.entry_id JOIN pairs p ON p.id = e.pair_id
         WHERE c.resolution IS NULL AND p.direction IN ('backup','upload-only') AND e.l_exists = 1
         AND c.kind != 'duplicate_remote_name' AND ${GIT_INTERNAL_SQL} ${pairId !== undefined ? 'AND e.pair_id = ?' : ''}`,
      )
      .all(...(pairId !== undefined ? [pairId] : [])) as {
      id: number;
      rel_path: string;
      pair_id: number;
      account_id: string;
    }[];
    let n = 0;
    for (const r of rows) {
      try {
        this.resolveConflict(r.id, 'keep_local', 'auto:.git');
        n++;
        this.addActivity({
          accountId: r.account_id,
          pairId: r.pair_id,
          action: 'info',
          relPath: r.rel_path,
          message: msg('activity.gitAutoResolved'),
        });
      } catch (e) {
        log('warn', 'auto-resolve .git conflict failed', { conflict: r.id, err: String(e) });
      }
    }
    if (n) log('info', '.git conflicts auto-resolved (keep_local)', { count: n });
    return n;
  }

  // ================================================================ queries

  accounts(): AccountDto[] {
    const s = readSettings(this.db);
    const activeBy = new Map<string, number[]>();
    for (const r of [...this.active.values()].sort((a, b) => a.id - b.id))
      for (const a of r.accounts) activeBy.set(a, [...(activeBy.get(a) ?? []), r.id]);
    const queuedBy = new Map<string, number[]>();
    for (const q of [...this.queued.values()].sort((a, b) => a.id - b.id)) {
      const a = q.req.accountId;
      if (a) queuedBy.set(a, [...(queuedBy.get(a) ?? []), q.id]);
    }
    return this.accountRows().map((r) => {
      const configured = Math.min(r.workers, s.transfer.maxWorkersPerAccount);
      const l = this.limiters.get(r.id);
      return {
        id: r.id,
        displayName: r.display_name,
        email: r.email,
        status: r.status as AccountDto['status'],
        ...lastErrorFields(r.last_error),
        lastOkAt: iso(r.last_ok_at),
        credentialBackend: r.credential_backend,
        workers: { configured, active: l ? l.allowedWorkers(configured) : this.pools.has(r.id) ? configured : 0 },
        paused: !!r.paused,
        activeRunIds: activeBy.get(r.id) ?? [],
        queuedRunIds: queuedBy.get(r.id) ?? [],
      };
    });
  }

  private pairCountCache: { at: number; counts: Map<number, { counts: PairDto['counts']; bytes: number }> } | null =
    null;

  pairs(): PairDto[] {
    // per-state counts scan the entries index (~0.1-0.2 s for 400k rows): cached for 3 s, status() runs <= 1/s
    const cache = this.pairCountCache && Date.now() - this.pairCountCache.at < 3000 ? this.pairCountCache.counts : null;
    const fresh = new Map<number, { counts: PairDto['counts']; bytes: number }>();
    const countStmt = this.st.get(
      "SELECT state, COUNT(*) AS n, COALESCE(SUM(CASE WHEN kind = 'file' THEN l_size END),0) AS b FROM entries WHERE pair_id = ? GROUP BY state",
    );
    const brakes = new Map<number, NonNullable<PairDto['brake']>>();
    for (const b of this.st
      .get(
        'SELECT pair_id, brake_reason, brake_at FROM pair_state WHERE brake_reason IS NOT NULL AND brake_at IS NOT NULL AND (brake_released_at IS NULL OR brake_released_at < brake_at)',
      )
      .all() as { pair_id: number; brake_reason: string; brake_at: number }[])
      brakes.set(
        b.pair_id,
        (({ text, msg: m }) => ({ reason: text ?? '', at: iso(b.brake_at)!, reasonMsg: m }))(decodeMsg(b.brake_reason)),
      );
    const allPairs = this.pairRows();
    const remoteChecks = new Map(
      (
        this.st
          .get(
            "SELECT pair_id, MAX(finished_at) AS t FROM scans WHERE side = 'remote' AND status = 'ok' GROUP BY pair_id",
          )
          .all() as { pair_id: number; t: number | null }[]
      ).map((r) => [r.pair_id, r.t]),
    );
    const held = new Map(
      (
        this.st
          .get(
            `SELECT e.pair_id, COUNT(*) AS n FROM pending_deletions d JOIN entries e ON e.id = d.entry_id
             WHERE d.held = 1 AND d.decision IS NULL AND d.executed_at IS NULL GROUP BY e.pair_id`,
          )
          .all() as { pair_id: number; n: number }[]
      ).map((r) => [r.pair_id, r.n]),
    );
    const out = allPairs.map((r) => {
      let hit = cache?.get(r.id);
      if (!hit) {
        const counts: PairDto['counts'] = {};
        let bytes = 0;
        for (const c of countStmt.all(r.id) as { state: string; n: number; b: number }[]) {
          counts[c.state as keyof PairDto['counts']] = c.n;
          if (c.state !== 'excluded') bytes += c.b;
        }
        hit = { counts, bytes };
      }
      fresh.set(r.id, hit);
      const { counts, bytes } = hit;
      return {
        id: r.id,
        accountId: r.account_id,
        name: r.name,
        localRoot: r.local_root,
        remoteRoot: r.remote_root,
        direction: r.direction,
        enabled: !!r.enabled,
        paused: !!r.paused,
        counts,
        bytesTracked: bytes,
        lastRunAt: iso(r.last_run_at),
        lastFullAt: iso(r.last_full_at),
        brake: brakes.get(r.id) ?? null,
        options: pairOptions(r),
        lastRemoteCheckAt: iso(remoteChecks.get(r.id) ?? null),
        heldDeletions: held.get(r.id) ?? 0,
        ownedElsewhere: ownedPaths(r, allPairs).map((o) => ({
          relPath: o.rel,
          pairId: o.pairId,
          pairName: o.pairName,
        })),
      };
    });
    if (!cache) this.pairCountCache = { at: Date.now(), counts: fresh };
    return out;
  }

  private runDto(r: Record<string, unknown>): RunDto {
    const id = Number(r.id);
    const live = this.active.get(id) ?? null;
    const q = live ? null : [...this.queued.values()].find((x) => x.id === id);
    const pairId = (r.pair_id as number) ?? null;
    const holder = q ? this.laneHolder.get(q.key) : undefined;
    return {
      id,
      trigger: r.trigger as RunDto['trigger'],
      mode: r.mode as RunDto['mode'],
      accountId: (r.account_id as string) ?? null,
      pairId,
      startedAt: iso(Number(r.started_at))!,
      finishedAt: iso(r.finished_at as number | null),
      status: live ? 'running' : (r.status as RunDto['status']),
      lane: live?.lane ?? laneOf({ pairId, mode: r.mode as RunMode }),
      ...(live ? { activeAccounts: [...live.accounts] } : {}),
      ...(q ? { waitingFor: holder !== undefined ? [holder] : [] } : {}),
      counters: live
        ? { ...live.counters }
        : { ...emptyCounters(), ...(JSON.parse(String(r.counters ?? '{}')) as object) },
    };
  }

  private run(id: number): RunDto | null {
    const r = this.st.get('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.runDto(r) : null;
  }

  runById(id: number): RunDto | null {
    return this.run(id);
  }

  runs(limit = 50): RunDto[] {
    return (
      this.st.get('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000)) as Record<string, unknown>[]
    ).map((r) => this.runDto(r));
  }

  jobs(filter: { state?: JobDto['state']; limit?: number }): JobDto[] {
    const limit = Math.min(filter.limit ?? 200, 5000);
    const rows = (filter.state
      ? this.st.get('SELECT * FROM jobs WHERE state = ? ORDER BY priority, id LIMIT ?').all(filter.state, limit)
      : this.st.get('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit)) as unknown as JobRow[];
    return rows.map((r) => {
      const a = [...this.xfers.values()].find((x) => x.jobs.some((j) => j.id === r.id));
      return a ? { ...jobDto(r), ...this.progressFields(a) } : jobDto(r);
    });
  }

  activity(limit = 100, beforeId?: number, filter: ActivityFilter = {}): ActivityItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, ...v: (string | number)[]) => {
      where.push(sql);
      args.push(...v);
    };
    if (beforeId) add('id < ?', beforeId);
    if (filter.accountId) add('account_id = ?', filter.accountId);
    if (filter.pairId) add('pair_id = ?', filter.pairId);
    if (filter.actions?.length) {
      where.push(`action IN (${filter.actions.map(() => '?').join(',')})`);
      args.push(...filter.actions);
    }
    if (filter.since) add('ts >= ?', Date.parse(filter.since));
    if (filter.q) {
      where.push('(rel_path LIKE ? OR message LIKE ?)');
      args.push(`%${filter.q}%`, `%${filter.q}%`);
    }
    const sql = `SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, Math.min(limit, 5000)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: iso(Number(r.ts))!,
      accountId: String(r.account_id),
      pairId: (r.pair_id as number) ?? null,
      action: r.action as ActivityItem['action'],
      relPath: (r.rel_path as string) ?? null,
      bytes: (r.bytes as number) ?? null,
      durationMs: (r.duration_ms as number) ?? null,
      message: (r.message as string) ?? null,
      ...(r.msg ? { msg: parseRef(r.msg as string) } : {}),
      runId: (r.run_id as number) ?? null,
    }));
  }

  /** active runs, oldest first */
  activeRuns(): RunDto[] {
    return [...this.active.keys()]
      .sort((a, b) => a - b)
      .map((id) => this.run(id))
      .filter((r): r is RunDto => !!r);
  }

  /** queued runs, oldest first */
  queuedRuns(): RunDto[] {
    return [...this.queued.values()]
      .map((q) => q.id)
      .sort((a, b) => a - b)
      .map((id) => this.run(id))
      .filter((r): r is RunDto => !!r);
  }

  status(): StatusDto {
    const last = this.st
      .get("SELECT * FROM runs WHERE status NOT IN ('running','queued') ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    const activeRuns = this.activeRuns();
    const q = (state: string) =>
      (this.st.get('SELECT COUNT(*) AS n FROM jobs WHERE state = ?').get(state) as { n: number }).n;
    const accounts = this.accounts();
    const t = Date.now();
    this.transfers = this.transfers.filter((x) => t - x.t < 30_000);
    // finished transfers of the last 30 s plus the live rate of running ones (big files used to show 0 B/s for hours)
    const rate = (k: 'upload' | 'download') =>
      Math.round(this.transfers.filter((x) => x.kind === k).reduce((s, x) => s + x.bytes, 0) / 30) +
      [...this.xfers.values()].filter((a) => a.kind === k).reduce((s, a) => s + (this.transferDto(a).rateBps ?? 0), 0);
    const ewmas = [...this.limiters.values()].map((l) => l.ewma).filter((x): x is number => x !== null);
    const paused = this.globalPaused();
    return {
      apiVersion: API_VERSION,
      daemonVersion: this.o.version,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      mode: this.o.mode,
      state: paused
        ? 'paused'
        : accounts.some((a) => a.status === 'offline')
          ? 'offline'
          : activeRuns.length || this.executor.runningCount() > 0
            ? 'syncing'
            : accounts.some((a) => a.status === 'error' || a.status === 'needs_login')
              ? 'error'
              : 'idle',
      paused,
      // most recently started active run (older clients show one run)
      currentRun: activeRuns.length
        ? activeRuns.reduce((a, b) => (Date.parse(b.startedAt) > Date.parse(a.startedAt) ? b : a))
        : null,
      activeRuns,
      queuedRuns: this.queuedRuns(),
      lastRun: last ? this.runDto(last) : null,
      nextRuns: (this.scheduler?.nextRuns() ?? []).map((r) => ({ mode: r.mode, at: new Date(r.at).toISOString() })),
      accounts,
      pairs: this.pairs(),
      queue: {
        queued: q('queued'),
        running: q('running'),
        retryWait: q('retry_wait'),
        failed: q('failed'),
        blocked: q('blocked'),
      },
      openConflicts: (
        this.st.get('SELECT COUNT(*) AS n FROM conflicts WHERE resolution IS NULL OR needs_review = 1').get() as {
          n: number;
        }
      ).n,
      pendingDeletions: (
        this.st
          .get('SELECT COUNT(*) AS n FROM pending_deletions WHERE decision IS NULL AND executed_at IS NULL')
          .get() as { n: number }
      ).n,
      rate: {
        uploadBps: rate('upload'),
        downloadBps: rate('download'),
        metaLatencyMsEwma: ewmas.length ? Math.round(ewmas.reduce((a, b) => a + b, 0) / ewmas.length) : null,
      },
      transfers: this.transfersStatus(),
    };
  }

  // ================================================================ pause / resume

  pause(req: PauseRequest): void {
    this.setPaused(req, true);
    if (req.immediate) {
      const accounts =
        req.scope === 'all'
          ? [...this.pools.keys()]
          : req.scope === 'account'
            ? [String(req.id)]
            : [this.pairRow(Number(req.id))?.account_id].filter((x): x is string => !!x);
      for (const a of accounts) this.pools.get(a)?.killAll();
      if (req.scope === 'all') for (const r of this.active.values()) r.abort.abort();
    }
    // account/global pause: no proton-drive process may stay alive for the account (idle ones stop now, busy ones
    // when the current file is done; with `immediate` they were killed above)
    if (req.scope !== 'pair') this.enforceGates(req.scope === 'account' ? String(req.id) : undefined);
    this.scheduleStatus();
    this.emitEvent({ type: 'status', status: this.status() });
  }

  resume(req: PauseRequest): void {
    this.setPaused(req, false);
    this.executor.kick();
    this.emitEvent({ type: 'status', status: this.status() });
  }

  private setPaused(req: PauseRequest, v: boolean): void {
    if (req.scope === 'all')
      this.st
        .get(
          "INSERT INTO meta (key, value) VALUES ('paused', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(v ? '1' : '0');
    else if (req.scope === 'account')
      this.st.get('UPDATE accounts SET paused = ? WHERE id = ?').run(v ? 1 : 0, String(req.id));
    else if (req.scope === 'pair')
      this.st.get('UPDATE pairs SET paused = ? WHERE id = ?').run(v ? 1 : 0, Number(req.id));
  }

  // ================================================================ runs

  requestSync(req: SyncRequest, trigger: RunDto['trigger'] = 'api'): number {
    return this.requestSyncTicket(req, trigger).runIds[0]!;
  }

  /**
   * Starts or queues the run(s) covering a request. Pair-scoped incremental requests go to the
   * pair's priority lane and start at once unless the same pair already has a priority run; everything else goes to
   * the background lane of each covered account. A request for a busy lane becomes (or merges into) that lane's
   * queued run, whose id is returned right away. A global request while some accounts are busy is split: one run per
   * account, free accounts start now.
   */
  requestSyncTicket(
    req: SyncRequest,
    trigger: RunDto['trigger'] = 'api',
    opts: { freshFollowUp?: boolean } = {},
  ): SyncTicket {
    const mode: RunMode = req.mode ?? 'incremental';
    if (laneOf(req) === 'priority') {
      const pair = this.pairRow(Number(req.pairId));
      const r: SyncRequest = { pairId: Number(req.pairId), mode, ...(pair ? { accountId: pair.account_id } : {}) };
      return this.enqueue(`pair:${r.pairId}`, r, trigger, 'priority', opts.freshFollowUp ?? false);
    }
    let accounts: string[];
    let scoped: SyncRequest;
    if (req.pairId !== undefined) {
      const pair = this.pairRow(Number(req.pairId));
      accounts = pair ? [pair.account_id] : [];
      scoped = { pairId: Number(req.pairId), mode, ...(pair ? { accountId: pair.account_id } : {}) };
    } else if (req.accountId !== undefined) {
      accounts = [req.accountId];
      scoped = { accountId: req.accountId, mode };
    } else {
      accounts = (
        this.st.get('SELECT DISTINCT account_id FROM pairs WHERE enabled = 1 ORDER BY account_id').all() as {
          account_id: string;
        }[]
      ).map((r) => r.account_id);
      scoped = { mode };
    }
    const busy = accounts.filter((a) => this.laneHolder.has(`acct:${a}`));
    if (!busy.length) {
      const id = this.startRun(scoped, trigger, 'background', accounts, opts.freshFollowUp ?? false);
      return { runIds: [id], followUp: false, queuedBehind: [] };
    }
    if (accounts.length === 1)
      return this.enqueue(`acct:${accounts[0]}`, scoped, trigger, 'background', opts.freshFollowUp ?? false);
    // global request, some accounts busy: one run per account (free ones start now, busy ones queue)
    const out: SyncTicket = { runIds: [], followUp: false, queuedBehind: [] };
    for (const a of accounts) {
      const t = this.enqueue(`acct:${a}`, { accountId: a, mode }, trigger, 'background', false);
      out.runIds.push(...t.runIds);
      out.queuedBehind.push(...t.queuedBehind);
      out.followUp ||= t.followUp;
    }
    return out;
  }

  /** start a run in a free lane, or queue it (merging with a run already queued for that lane) */
  private enqueue(
    key: string,
    req: SyncRequest,
    trigger: RunDto['trigger'],
    lane: RunLane,
    freshFollowUp: boolean,
  ): SyncTicket {
    const holder = this.laneHolder.get(key);
    if (holder === undefined) {
      const accounts = req.accountId ? [req.accountId] : [];
      const id = this.startRun(req, trigger, lane, accounts, freshFollowUp);
      return { runIds: [id], followUp: false, queuedBehind: [] };
    }
    let q = this.queued.get(key);
    if (q) {
      // merged (scope union within the lane, the bigger mode wins)
      const m = q.req;
      q.req = {
        ...(m.accountId !== undefined ? { accountId: m.accountId } : {}),
        ...(m.pairId !== undefined && m.pairId === req.pairId ? { pairId: m.pairId } : {}),
        mode: RUN_MODE_ORDER[req.mode ?? 'incremental'] > RUN_MODE_ORDER[m.mode ?? 'incremental'] ? req.mode : m.mode,
      };
      q.trigger = trigger;
      q.freshFollowUp &&= freshFollowUp;
      this.st
        .get('UPDATE runs SET trigger = ?, mode = ?, account_id = ?, pair_id = ? WHERE id = ?')
        .run(trigger, q.req.mode ?? 'incremental', q.req.accountId ?? null, q.req.pairId ?? null, q.id);
    } else {
      const id = Number(
        this.st
          .get(
            "INSERT INTO runs (trigger, mode, account_id, pair_id, started_at, status) VALUES (?, ?, ?, ?, ?, 'queued')",
          )
          .run(trigger, req.mode ?? 'incremental', req.accountId ?? null, req.pairId ?? null, Date.now())
          .lastInsertRowid,
      );
      q = { id, key, req, trigger, lane, freshFollowUp };
      this.queued.set(key, q);
      log('info', 'run queued', { runId: id, lane: key, behind: holder });
    }
    this.emitEvent({ type: 'run', run: this.run(q.id)! });
    this.scheduleStatus();
    return { runIds: [q.id], followUp: true, queuedBehind: [holder] };
  }

  /** Why a sync of this scope would not do anything right now (English, for agents and the CLI), or null. */
  syncBlocker(req: SyncRequest): string | null {
    return this.syncBlockerMsg(req)?.text ?? null;
  }

  /** syncBlocker() as a message (key + params for the dashboard). */
  syncBlockerMsg(req: SyncRequest): Msg | null {
    if (this.globalPaused()) return msg('gate.pausedGlobally');
    const account = (id: string): Msg | null => {
      const a = this.accountRow(id);
      if (!a) return msg('gate.unknownAccount', { id });
      if (!a.enabled) return msg('gate.accountDisabled', { account: a.display_name });
      if (a.paused) return msg('gate.accountPaused', { account: a.display_name });
      if (['needs_login', 'needs_keyring', 'offline', 'login_pending', 'disabled'].includes(a.status))
        return msg('gate.accountStatus', { account: a.display_name, status: a.status });
      if (this.o.accountGate?.(id)) return msg('gate.accountWaitsForeign', { account: a.display_name });
      return null;
    };
    if (req.pairId !== undefined) {
      const p = this.pairRow(Number(req.pairId));
      if (!p) return msg('gate.unknownPair', { id: String(req.pairId) });
      if (!p.enabled) return msg('gate.pairDisabled', { id: p.id, pair: p.name });
      if (p.paused) return msg('gate.pairPaused', { id: p.id, pair: p.name });
      return account(p.account_id);
    }
    if (req.accountId !== undefined) return account(req.accountId);
    return null;
  }

  /** Resolves when no run is active or queued any more — for tests and diagnostics. */
  async waitIdle(): Promise<void> {
    while (this.active.size || this.queued.size) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /** Resolves when the given run finished (or immediately when it is not active/queued). */
  async waitRun(id: number): Promise<RunDto | null> {
    while (this.active.has(id) || [...this.queued.values()].some((q) => q.id === id))
      await new Promise<void>((r) => this.idleWaiters.push(r));
    return this.run(id);
  }

  private notifyIdle(): void {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  private startRun(
    req: SyncRequest,
    trigger: RunDto['trigger'],
    lane: RunLane,
    accounts: string[],
    freshFollowUp: boolean,
    queuedId?: number,
  ): number {
    const mode = req.mode ?? 'incremental';
    const t = Date.now();
    let id: number;
    if (queuedId !== undefined) {
      id = queuedId;
      this.st
        .get(
          "UPDATE runs SET status = 'running', started_at = ?, trigger = ?, mode = ?, account_id = ?, pair_id = ? WHERE id = ?",
        )
        .run(t, trigger, mode, req.accountId ?? null, req.pairId ?? null, id);
    } else {
      id = Number(
        this.st
          .get('INSERT INTO runs (trigger, mode, account_id, pair_id, started_at) VALUES (?, ?, ?, ?, ?)')
          .run(trigger, mode, req.accountId ?? null, req.pairId ?? null, t).lastInsertRowid,
      );
    }
    const holds = lane === 'priority' ? [`pair:${req.pairId}`] : accounts.map((a) => `acct:${a}`);
    const run: ActiveRun = {
      id,
      mode,
      req,
      trigger,
      counters: emptyCounters(),
      status: 'running',
      abort: new AbortController(),
      freshUntil: 0,
      freshFollowUp,
      lane,
      holds: new Set(holds),
      accounts: new Set(accounts),
      handedOver: false,
    };
    for (const k of holds) this.laneHolder.set(k, id);
    this.active.set(id, run);
    // an agent's pair run does not postpone the scheduled backup runs
    if (lane === 'background') this.scheduler?.ranNow(mode);
    log('info', 'run started', { runId: id, lane, scope: req, accounts });
    this.emitEvent({ type: 'run', run: this.run(id)! });
    this.scheduleStatus();
    void this.executeRun(run)
      .catch((e) => {
        log('error', 'run failed', { runId: id, err: (e as Error).stack ?? String(e) });
        run.status = 'failed';
      })
      .finally(() => this.finishRun(run));
    return id;
  }

  /** a run is done with one lane: the lane's queued run (if any) starts now */
  private releaseLane(run: ActiveRun, key: string): void {
    if (!run.holds.delete(key)) return;
    if (this.laneHolder.get(key) === run.id) this.laneHolder.delete(key);
    const q = this.queued.get(key);
    if (!q || this.closed) return;
    this.queued.delete(key);
    run.handedOver = true;
    this.startRun(q.req, q.trigger, q.lane, q.req.accountId ? [q.req.accountId] : [], q.freshFollowUp, q.id);
  }

  /** a background run finished all pairs of one account: the account is free for other runs */
  private releaseAccount(run: ActiveRun, accountId: string): void {
    run.accounts.delete(accountId);
    if (run.lane === 'background') this.releaseLane(run, `acct:${accountId}`);
    this.scheduleStatus();
  }

  private finishRun(run: ActiveRun): void {
    const id = run.id;
    const cur = run;
    const mode = run.mode;
    const status = cur.status === 'running' ? (cur.counters.errors ? 'partial' : 'ok') : cur.status;
    // stopped by the daemon shutdown: the row stays 'running', the next start cancels it and resumes its scope
    const interrupted = this.closed && run.abort.signal.aborted;
    try {
      if (interrupted) this.st.get('UPDATE runs SET counters = ? WHERE id = ?').run(JSON.stringify(cur.counters), id);
      else
        this.st
          .get('UPDATE runs SET finished_at = ?, status = ?, counters = ? WHERE id = ?')
          .run(Date.now(), status, JSON.stringify(cur.counters), id);
    } catch (e) {
      log('warn', 'run row not updated', { runId: id, err: String(e) }); // DB closed during shutdown
    }
    this.active.delete(id);
    run.accounts.clear();
    for (const k of [...run.holds]) this.releaseLane(run, k);
    this.pairCountCache = null;
    if (this.closed) {
      this.notifyIdle();
      return;
    }
    this.autoResolveGitConflicts(); // conflicts the executor raised during the run
    const dto = this.run(id)!;
    log('info', 'run finished', { runId: id, status, counters: cur.counters });
    this.emitEvent({ type: 'run', run: dto });
    this.emitEvent({ type: 'status', status: this.status() });
    this.emitEvent({ type: 'conflicts_changed', open: this.status().openConflicts });
    this.emitEvent({ type: 'deletions_changed', pending: this.status().pendingDeletions });
    if (status !== 'ok' && cur.counters.errors > 0)
      this.notice({
        key: `run:errors`,
        severity: 'error',
        title: msg('notice.runErrors'),
        body: msg('notice.runErrorsBody', { run: id, errors: cur.counters.errors }),
      });
    if (cur.counters.conflicts > 0)
      this.notice({
        key: 'conflicts:new',
        severity: 'warn',
        title: msg('notice.newConflicts'),
        body: msg('notice.newConflictsBody', { count: cur.counters.conflicts }),
      });
    if (cur.counters.pendingDeletions > 0)
      this.notice({
        key: 'deletions:pending',
        severity: 'info',
        title: msg('notice.pendingDeletions'),
        body: msg('notice.pendingDeletionsBody', { count: this.status().pendingDeletions }),
      });
    if (mode === 'full') this.maybeBackupDb();
    // files that were "still being written" during a user-triggered run: one automatic re-run once they are old
    // enough (otherwise they would wait for the next scheduled run, e.g. 2 h after the setup wizard's first sync)
    if (cur.freshUntil && !cur.handedOver && !cur.freshFollowUp && cur.trigger !== 'schedule') {
      const t = setTimeout(
        () => {
          if (!this.closed) this.requestSyncTicket(cur.req, cur.trigger, { freshFollowUp: true });
        },
        Math.min(60_000, Math.max(0, cur.freshUntil - Date.now()) + 500),
      );
      t.unref();
      this.timers.push(t);
    }
    this.notifyIdle();
  }

  private async executeRun(run: ActiveRun): Promise<void> {
    const pairs = this.pairRows().filter(
      (p) =>
        p.enabled &&
        (!run.req.accountId || p.account_id === run.req.accountId) &&
        (!run.req.pairId || p.id === run.req.pairId),
    );
    const byAccount = new Map<string, PairRow[]>();
    for (const p of pairs) byAccount.set(p.account_id, [...(byAccount.get(p.account_id) ?? []), p]);
    // accounts of the run without runnable pairs are free at once
    for (const a of [...run.accounts]) if (!byAccount.has(a)) this.releaseAccount(run, a);
    const cliPrio = run.lane === 'priority' ? PRIORITY_RUN_CLI : undefined;
    await Promise.all(
      [...byAccount.entries()].map(([accountId, list]) =>
        cliPriorityScope.run(cliPrio, async () => {
          try {
            for (const p of list) {
              if (run.abort.signal.aborted) return;
              if (!this.canRun(accountId, p.id)) continue;
              await this.runPair(run, p);
            }
          } finally {
            this.releaseAccount(run, accountId);
          }
        }),
      ),
    );
    if (run.abort.signal.aborted) run.status = 'cancelled';
  }

  private matcherFor(pair: PairRow): RuleMatcher {
    const s = readSettings(this.db);
    const rules = this.st
      .get('SELECT kind, pattern_type AS patternType, pattern, source FROM rules WHERE pair_id = ? OR pair_id IS NULL')
      .all(pair.id) as unknown as SelectionRule[];
    return new RuleMatcher({
      rules: [...s.globalExcludes, ...rules],
      localRoot: pair.local_root,
      hardExcluded: this.o.protectedPaths,
      ownedPaths: ownedPaths(pair, this.pairRows()).map((x) => x.rel),
    });
  }

  private async ensureRootUid(pair: PairRow): Promise<string> {
    if (pair.remote_root_uid) return pair.remote_root_uid;
    const node = await this.remote(pair.account_id).info({ path: pair.remote_root });
    if (node.type !== 'folder') throw new CliError(`${pair.remote_root} is not a folder`, 'not_found');
    this.st.get('UPDATE pairs SET remote_root_uid = ? WHERE id = ?').run(node.uid, pair.id);
    pair.remote_root_uid = node.uid;
    return node.uid;
  }

  private async runPair(run: ActiveRun, pairIn: PairRow): Promise<void> {
    const pair = this.pairRow(pairIn.id) ?? pairIn;
    const accountId = pair.account_id;
    const signal = run.abort.signal;
    try {
      await this.ensureVersion();
      let rootUid: string;
      try {
        rootUid = await this.ensureRootUid(pair);
      } catch (e) {
        if (errorClassOf(e) === 'not_found')
          return this.brake(run, pair, msg('brake.remoteRootNotFound', { path: pair.remote_root }));
        throw e;
      }
      this.onOutcome(accountId, true);
      const matcher = this.matcherFor(pair);
      // 1. local scan
      const doScan = async () => {
        const scanId = Number(
          this.st
            .get("INSERT INTO scans (run_id, pair_id, side, mode, started_at) VALUES (?, ?, 'local', ?, ?)")
            .run(run.id, pair.id, run.mode, Date.now()).lastInsertRowid,
        );
        const scan = await scanLocal({
          db: this.db,
          pair,
          scanId,
          mode: run.mode,
          matcher,
          freshMs: this.o.freshMs,
          signal,
        });
        this.st.get('UPDATE scans SET finished_at = ?, status = ?, stats = ? WHERE id = ?').run(
          Date.now(),
          scan.status === 'ok' ? 'ok' : 'failed',
          JSON.stringify({
            ...scan,
            missing: scan.missing.length,
            nowExcluded: scan.nowExcluded.length,
            symlinks: scan.symlinks.length,
          }),
          scanId,
        );
        return { scanId, scan };
      };
      // the local scan (and applying what it found missing) is exclusive per pair: a priority run and a background
      // run of the same pair never walk it at the same time
      const scanned = await this.withScanLock(pair.id, async () => {
        let { scanId, scan } = await doScan();
        // a pair-scoped manual/API run (e.g. an agent filed a document and syncs at once) waits for just-written
        // files to leave the 10 s "still being written" window instead of skipping them until the next run
        if (
          scan.status === 'ok' &&
          scan.postponed > 0 &&
          run.req.pairId === pair.id &&
          run.trigger !== 'schedule' &&
          scan.freshUntilMs - Date.now() <= 30_000
        ) {
          await sleepAbortable(Math.max(0, scan.freshUntilMs - Date.now()) + 250, signal);
          if (signal.aborted) return null;
          ({ scanId, scan } = await doScan());
        }
        run.counters.scannedLocal += scan.files;
        if (scan.postponed > 0) run.freshUntil = Math.max(run.freshUntil, scan.freshUntilMs);
        if (scan.status === 'aborted' || signal.aborted) return null;
        // 2. safety brakes (before anything is interpreted as deleted)
        const brake = this.checkBrakes(pair, scan);
        if (brake) {
          this.brake(run, pair, brake);
          return null;
        }
        applyScanResult(this.db, scanId, scan);
        return { scanId, scan };
      });
      if (!scanned) return;
      const { scanId, scan } = scanned;
      if (scan.unreadable.length)
        this.addActivity({
          accountId,
          pairId: pair.id,
          action: 'error',
          message: msg('activity.unreadableFolders', { count: scan.unreadable.length, example: scan.unreadable[0]! }),
        });
      if (scan.symlinks.length)
        this.addActivity({
          accountId,
          pairId: pair.id,
          action: 'info',
          message: msg('activity.symlinksSkipped', { count: scan.symlinks.length, example: scan.symlinks[0]! }),
        });
      // 3. remote crawl
      const crawlId = Number(
        this.st
          .get("INSERT INTO scans (run_id, pair_id, side, mode, started_at) VALUES (?, ?, 'remote', ?, ?)")
          .run(run.id, pair.id, run.mode, Date.now()).lastInsertRowid,
      );
      const twoWay = pair.direction === 'two-way';
      const adopting = twoWay && !!pairOptions(pair).twoWayAdoption;
      const crawl = await crawlRemote({
        db: this.db,
        pair,
        rootUid,
        crawlId,
        // the two-way adoption run lists everything (it decides what both sides agree on)
        mode: adopting ? 'full' : run.mode,
        remote: this.remote(accountId),
        matcher,
        // a priority run only lists where something changed locally (stays fast next to a long background run)
        extraFolders:
          run.lane === 'priority' ? this.changedParents(pair.id, scanId) : this.dirtyParents(pair.id, scanId),
        // two-way: "sync now" and the periodic remote check must see changes made by other devices anywhere
        targeted: run.lane === 'priority' && !twoWay,
        concurrency: this.pool(accountId).configuredSize,
        signal,
        onListed: () => (run.counters.listedRemoteFolders++, this.scheduleStatus()),
      });
      this.st
        .get('UPDATE scans SET finished_at = ?, status = ?, stats = ? WHERE id = ?')
        .run(Date.now(), crawl.status, JSON.stringify(crawl), crawlId);
      if (crawl.status === 'root_missing')
        return this.brake(run, pair, msg('brake.remoteRootMissing', { path: pair.remote_root }));
      if (crawl.failed && this.cliGate(accountId)) return; // paused / foreign process mid-crawl: not an error
      if (crawl.failed) {
        run.counters.errors += crawl.failed;
        this.addActivity({
          accountId,
          pairId: pair.id,
          action: 'error',
          message: msg('activity.listingFailed', { error: crawl.errors[0] ?? '' }),
        });
      }
      if (crawl.rootEmpty && (pair.direction === 'mirror-down' || twoWay) && this.baseFileCount(pair.id) > 0)
        return this.brake(run, pair, msg('brake.remoteRootEmpty'));
      if (signal.aborted) return;
      // adoption sources are crawled by background runs only (an interactive pair run stays short)
      if (run.lane === 'background') await this.crawlSources(accountId, run.mode, signal);
      // 4. plan + 5. execute (a second pass settles what folder moves/relocations revealed)
      for (let pass = 0; pass < 3; pass++) {
        const plan = planPair({
          db: this.db,
          pair,
          runId: run.id,
          matcher,
          verifyMaxBytes: this.o.twoWayVerifyMaxBytes,
          activity: (a) => this.addActivity({ ...a, accountId, pairId: pair.id, runId: run.id }),
        });
        this.addPlanCounters(run, plan);
        if (plan.held) {
          // two-way mass-delete guard: nothing was deleted; the pair pauses until the deletions are approved/denied
          this.heldCache.delete(pair.id);
          this.emitEvent({ type: 'deletions_changed', pending: this.status().pendingDeletions });
          this.brake(run, pair, plan.heldReason ?? msg('brake.massDeleteHeldShort'), true);
        }
        if (run.lane === 'priority') this.liftIntoPriorityLane(run, pair);
        if (plan.conflicts) this.autoResolveGitConflicts(pair.id);
        if (plan.conflicts) this.emitEvent({ type: 'conflicts_changed', open: this.status().openConflicts });
        if (plan.pendingDeletions)
          this.emitEvent({ type: 'deletions_changed', pending: this.status().pendingDeletions });
        if (plan.proposals)
          this.notice({
            key: `adoption:${pair.id}`,
            severity: 'info',
            title: msg('notice.adoption'),
            body: msg('notice.adoptionBody', { count: plan.proposals }),
            accountId,
          });
        this.executor.kick(accountId);
        await this.waitPairJobs(pair, run);
        if (plan.held || plan.moves + plan.folderMoves === 0 || signal.aborted) break;
      }
      if (adopting && crawl.status === 'ok' && !signal.aborted) this.finishAdoption(pair);
      this.st
        .get(`UPDATE pairs SET last_run_at = ?${run.mode !== 'incremental' ? ', last_full_at = ?' : ''} WHERE id = ?`)
        .run(...(run.mode !== 'incremental' ? [Date.now(), Date.now(), pair.id] : [Date.now(), pair.id]));
    } catch (e) {
      if (e instanceof CliGatedError) return; // paused or waiting for a foreign process: the pair just stops
      const cls = errorClassOf(e);
      run.counters.errors++;
      this.addActivity({
        accountId,
        pairId: pair.id,
        action: 'error',
        message: msg('activity.runAborted', { pair: pair.name, errorClass: cls, error: (e as Error).message }),
      });
      this.onOutcome(accountId, false, cls, (e as Error).message);
    }
  }

  /**
   * two-way: the adoption run is complete when the whole remote tree was listed and no job of the pair is still
   * open — from now on deletions are propagated (to the trash of the other side, mass-delete guard applies).
   */
  private finishAdoption(pair: PairRow): void {
    const open = this.st
      .get(`SELECT COUNT(*) AS n FROM jobs WHERE pair_id = ? AND state IN ('queued','running','retry_wait','blocked')`)
      .get(pair.id) as { n: number };
    if (open.n > 0) return;
    // a restore that failed for good must not turn into a deletion on the next run: adoption goes on until it works
    const failed = this.st
      .get("SELECT COUNT(*) AS n FROM entries WHERE pair_id = ? AND state = 'error'")
      .get(pair.id) as { n: number };
    if (failed.n > 0) return;
    const row = this.pairRow(pair.id);
    if (!row) return;
    const opts = pairOptions(row) as Record<string, unknown>;
    if (!opts.twoWayAdoption) return;
    delete opts.twoWayAdoption;
    this.st.get('UPDATE pairs SET options = ? WHERE id = ?').run(JSON.stringify(opts), pair.id);
    this.addActivity({
      accountId: pair.account_id,
      pairId: pair.id,
      action: 'info',
      message: msg('activity.twoWayAdoptionDone'),
    });
    this.pairCountCache = null;
  }

  private addPlanCounters(run: ActiveRun, plan: PlanResult): void {
    run.counters.adopted += plan.adopted;
    run.counters.conflicts += plan.conflicts;
    run.counters.pendingDeletions += plan.pendingDeletions;
  }

  private baseFileCount(pairId: number): number {
    return (
      this.st
        .get("SELECT COUNT(*) AS n FROM entries WHERE pair_id = ? AND kind = 'file' AND synced_at IS NOT NULL")
        .get(pairId) as { n: number }
    ).n;
  }

  /** Parents of entries the scan changed -> listed in incremental crawls so decisions use fresh remote data. */
  private dirtyParents(pairId: number, scanId: number): string[] {
    const rows = this.st
      .get('SELECT DISTINCT rel_path FROM entries WHERE pair_id = ? AND l_seen_scan = ? LIMIT 5000')
      .all(pairId, scanId) as { rel_path: string }[];
    return [...new Set(rows.map((r) => parentRel(r.rel_path)))];
  }

  /**
   * Parents of entries whose local side changed in this scan (new, modified, missing) or that still wait for work;
   * the targeted crawl of a priority run lists only these (plus the root).
   */
  private changedParents(pairId: number, scanId: number): string[] {
    // entries that already have an open job need no listing (e.g. the backlog of a long background run)
    const withJob = new Set(
      (
        this.st
          .get(
            "SELECT entry_id FROM jobs WHERE pair_id = ? AND entry_id IS NOT NULL AND state IN ('queued','running','retry_wait','blocked')",
          )
          .all(pairId) as { entry_id: number }[]
      ).map((r) => r.entry_id),
    );
    const rows = this.st
      .get(
        `SELECT id, rel_path FROM entries WHERE pair_id = ? AND l_seen_scan = ? AND (
           l_exists = 0
           OR (kind = 'folder' AND r_exists = 0)
           OR (kind = 'file' AND (b_size IS NULL OR l_size IS NOT b_size
               OR ABS(COALESCE(l_mtime_us, 0) - COALESCE(b_l_mtime_us, 0)) > 1000)))`,
      )
      .all(pairId, scanId) as { id: number; rel_path: string }[];
    const out = new Set<string>();
    for (const r of rows) {
      if (withJob.has(r.id)) continue;
      out.add(parentRel(r.rel_path));
      if (out.size >= 500) break;
    }
    return [...out];
  }

  private checkBrakes(pair: PairRow, scan: ScanResult): Msg | null {
    const ps = this.st.get('SELECT * FROM pair_state WHERE pair_id = ?').get(pair.id) as
      { brake_at: number | null; brake_released_at: number | null } | undefined;
    const released = !!ps?.brake_released_at && (!ps.brake_at || ps.brake_released_at >= ps.brake_at);
    if (scan.status === 'root_missing') return msg('brake.localRootMissing', { path: pair.local_root });
    const tracked = this.baseFileCount(pair.id);
    // two-way: held deletions (mass-delete guard) keep the pair paused until every one is approved or denied
    const held = pair.direction === 'two-way' ? this.heldCount(pair.id) : 0;
    if (held) return msg('brake.massDeleteWaiting', { count: held });
    if (released) {
      this.st
        .get('UPDATE pair_state SET brake_reason = NULL, brake_at = NULL, brake_released_at = NULL WHERE pair_id = ?')
        .run(pair.id);
      return null;
    }
    if (tracked > 0 && scan.files === 0) return msg('brake.localRootEmpty', { path: pair.local_root });
    // two-way pairs: mass deletions (on either side) are held by the planner's mass-delete guard instead
    if (pair.direction === 'two-way') return null;
    const b = { ...readBrakes(this.db), ...(this.o.brakes ?? {}) };
    const gone = scan.missing.filter((m) => m.hasBase && m.kind === 'file').length;
    if (
      gone >= b.massDeletionAbsolute ||
      (gone >= b.massDeletionMinFiles && gone > (b.massDeletionPercent / 100) * tracked)
    )
      return msg('brake.massDeleteDetected', { gone, tracked });
    return null;
  }

  /** `held`: the two-way mass-delete guard (a decision is needed, not an error of the run) */
  private brake(run: ActiveRun, pair: PairRow, reason: Msg, held = false): void {
    if (!held) run.counters.errors++;
    this.st
      .get(
        `INSERT INTO pair_state (pair_id, brake_reason, brake_at) VALUES (?, ?, ?)
         ON CONFLICT (pair_id) DO UPDATE SET brake_reason = excluded.brake_reason, brake_at = excluded.brake_at`,
      )
      .run(pair.id, storeMsg(reason), Date.now());
    this.addActivity({
      accountId: pair.account_id,
      pairId: pair.id,
      action: held ? 'deletion_pending' : 'error',
      message: msg('activity.brake', { reason: nested(reason) }),
    });
    this.notice({
      key: `brake:${pair.id}`,
      severity: held ? 'warn' : 'error',
      title: msg(held ? 'notice.massDeleteHeld' : 'notice.brake', { pair: pair.name }),
      body: reason,
      accountId: pair.account_id,
    });
  }

  /** User confirmed a safety brake ("really deleted") -> next run of the pair proceeds once. */
  releaseBrake(pairId: number, by: string): void {
    this.st
      .get(
        `INSERT INTO pair_state (pair_id, brake_released_at) VALUES (?, ?)
         ON CONFLICT (pair_id) DO UPDATE SET brake_released_at = excluded.brake_released_at`,
      )
      .run(pairId, Date.now());
    const p = this.pairRow(pairId);
    if (p)
      this.addActivity({
        accountId: p.account_id,
        pairId,
        action: 'info',
        message: msg('activity.brakeReleased', { by }),
      });
    this.requestSync({ pairId }, 'manual');
  }

  private async crawlSources(accountId: string, mode: RunMode, signal: AbortSignal): Promise<void> {
    const sources = this.st
      .get('SELECT * FROM adoption_sources WHERE account_id = ? AND enabled = 1')
      .all(accountId) as {
      id: number;
      remote_path: string;
      remote_section: string;
      uid: string | null;
      last_crawled_at: number | null;
    }[];
    for (const s of sources) {
      if (signal.aborted) return;
      if (mode === 'incremental' && s.last_crawled_at && Date.now() - s.last_crawled_at < 7 * 86400_000) continue;
      try {
        const uid = s.uid ?? (await this.remote(accountId).info({ path: s.remote_path })).uid;
        const r = await crawlAdoptionSource({
          db: this.db,
          accountId,
          section: s.remote_section,
          rootPath: s.remote_path,
          rootUid: uid,
          remote: this.remote(accountId),
          signal,
        });
        this.st.get('UPDATE adoption_sources SET uid = ?, last_crawled_at = ? WHERE id = ?').run(uid, Date.now(), s.id);
        log('info', 'adoption source crawled', { source: s.remote_path, ...r });
      } catch (e) {
        log('warn', 'adoption source crawl failed', { source: s.remote_path, err: (e as Error).message });
      }
    }
  }

  /**
   * Priority run: its own jobs and the open jobs of files changed locally within the last 10 minutes (at most
   * PRIORITY_RECENT_LIMIT, newest first) move into the priority lane, so they run before the backlog of the account's
   * long background run — e.g. a document an agent filed seconds ago that a background run had already planned.
   */
  private liftIntoPriorityLane(run: ActiveRun, pair: PairRow): void {
    const open = "j.priority >= 0 AND j.state IN ('queued','retry_wait','blocked')";
    const own = this.st
      .get(`SELECT j.id FROM jobs j WHERE j.pair_id = ? AND j.run_id = ? AND ${open}`)
      .all(pair.id, run.id) as { id: number }[];
    const since = Date.now() - (this.o.priorityRecentMs ?? PRIORITY_RECENT_MS);
    const recent = this.st
      .get(
        `SELECT j.id FROM jobs j JOIN entries e ON e.id = j.entry_id
         WHERE j.pair_id = ? AND ${open} AND e.l_ctime_us >= ?
         ORDER BY e.l_ctime_us DESC LIMIT ?`,
      )
      .all(pair.id, since * 1000, PRIORITY_RECENT_LIMIT) as { id: number }[];
    const n = boostJobs(
      this.db,
      [...own, ...recent].map((r) => r.id),
    );
    if (n) {
      log('info', 'jobs moved into the priority lane', { runId: run.id, pair: pair.id, jobs: n });
      this.executor.kick(pair.account_id);
    }
  }

  /** per-pair mutex (FIFO) */
  private async withScanLock<T>(pairId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.scanLocks.get(pairId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.scanLocks.set(pairId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.scanLocks.get(pairId) === tail) this.scanLocks.delete(pairId);
    }
  }

  /**
   * Waits until the pair has no queued/running jobs (and no retries due soon). A priority run only waits for the
   * pair's priority-lane jobs: `sync --pair N --wait` returns when that work is done, not after the long backlog.
   */
  private async waitPairJobs(pair: PairRow, run: ActiveRun): Promise<void> {
    const deadline = Date.now() + (this.o.runJobWaitMs ?? 6 * 3600_000);
    const lane = run.lane === 'priority' ? 'AND priority < 0' : '';
    for (;;) {
      if (run.abort.signal.aborted || this.closed) return;
      const busy = this.st
        .get(
          `SELECT COUNT(*) AS n FROM jobs WHERE pair_id = ? ${lane} AND (state IN ('queued','running') OR (state = 'retry_wait' AND not_before <= ?))`,
        )
        .get(pair.id, Date.now() + 5 * 60_000) as { n: number };
      if (busy.n === 0) return;
      const a = this.accountRow(pair.account_id);
      const offline = a?.status === 'offline';
      if (!offline && !this.canRun(pair.account_id, pair.id)) return; // paused / needs login: jobs stay queued
      if (Date.now() > deadline) return;
      await new Promise<void>((r) => {
        const done = () => {
          clearTimeout(t);
          this.executor.off('jobFinished', done);
          r();
        };
        const t = setTimeout(done, 200);
        this.executor.on('jobFinished', done);
      });
    }
  }

  private maybeBackupDb(): void {
    try {
      const dir = path.join(this.o.paths.stateDir, 'backup');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const files = readdirSync(dir)
        .filter((f) => f.startsWith('state-'))
        .sort();
      const lastName = files[files.length - 1];
      if (lastName && Date.now() - statSync(path.join(dir, lastName)).mtimeMs < 7 * 86400_000) return;
      const target = path.join(dir, `state-${new Date().toISOString().slice(0, 10)}.sqlite`);
      if (!existsSync(target)) this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      for (const old of readdirSync(dir)
        .filter((f) => f.startsWith('state-'))
        .sort()
        .slice(0, -4))
        rmSync(path.join(dir, old), { force: true });
    } catch (e) {
      log('warn', 'db backup failed', { err: (e as Error).message });
    }
  }

  // ================================================================ tree & rules

  async tree(pairId: number, relPath: string): Promise<TreeNodeDto[]> {
    const pair = this.pairRow(pairId);
    if (!pair) throw new Error(`unknown pair ${pairId}`);
    const matcher = this.matcherFor(pair);
    const rel = relPath.replace(/^\/+|\/+$/g, '').normalize('NFC');
    const [a, b] = rel ? belowRange(rel) : ['', '\u{10FFFF}'];
    const rows = this.st
      .get(
        'SELECT rel_path, kind, state, l_exists, l_size, r_exists, r_size FROM entries WHERE pair_id = ? AND rel_path >= ? AND rel_path < ?',
      )
      .all(pairId, a, b) as {
      rel_path: string;
      kind: string;
      state: string;
      l_exists: number;
      l_size: number | null;
      r_exists: number;
      r_size: number | null;
    }[];
    const prefixLen = rel ? rel.length + 1 : 0;
    const nodes = new Map<string, TreeNodeDto & { _excludedBelow: boolean }>();
    for (const r of rows) {
      const rest = r.rel_path.slice(prefixLen);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const childRel = rel ? `${rel}/${name}` : name;
      let n = nodes.get(name);
      if (!n) {
        const m = matcher.match(childRel);
        n = {
          name,
          relPath: childRel,
          kind: 'folder',
          selection: m.excluded ? 'excluded' : 'included',
          excludedBy: m.excluded ? m.by : null,
          localBytes: 0,
          remoteBytes: 0,
          localFiles: 0,
          states: {},
          hasChildren: false,
          _excludedBelow: false,
        };
        nodes.set(name, n);
      }
      if (slash < 0) {
        n.kind = r.kind as 'file' | 'folder';
        if (r.state === 'excluded' && n.selection !== 'excluded') {
          n.selection = 'excluded';
          n.excludedBy = 'default';
        }
      } else {
        n.hasChildren = true;
        if (r.state === 'excluded') n._excludedBelow = true;
      }
      if (r.kind === 'file') {
        if (r.l_exists) {
          n.localBytes! += r.l_size ?? 0;
          n.localFiles! += 1;
        }
        if (r.r_exists) n.remoteBytes! += r.r_size ?? 0;
        n.states[r.state as keyof TreeNodeDto['states']] = (n.states[r.state as keyof TreeNodeDto['states']] ?? 0) + 1;
      }
    }
    return [...nodes.values()]
      .map(({ _excludedBelow, ...n }) => ({
        ...n,
        selection:
          n.selection === 'excluded'
            ? 'excluded'
            : _excludedBelow || matcher.hasRulesBelow(n.relPath)
              ? 'partial'
              : 'included',
      }))
      .sort((x, y) =>
        x.kind === y.kind ? x.name.localeCompare(y.name, 'de') : x.kind === 'folder' ? -1 : 1,
      ) as TreeNodeDto[];
  }

  setRules(pairId: number, rules: SelectionRule[]): void {
    const pair = this.pairRow(pairId);
    if (!pair) throw new Error(`unknown pair ${pairId}`);
    const before = this.matcherFor(pair);
    const t = Date.now();
    tx(this.db, () => {
      this.st.get('DELETE FROM rules WHERE pair_id = ?').run(pairId);
      for (const r of rules)
        this.st
          .get('INSERT INTO rules (pair_id, kind, pattern_type, pattern, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            pairId,
            r.kind,
            r.patternType,
            r.pattern.replace(/^\/+|\/+$/g, '').normalize('NFC'),
            r.source ?? 'user',
            t,
          );
    });
    const after = this.matcherFor(pair);
    let newlyIncluded = 0;
    tx(this.db, () => {
      const rows = this.st.get('SELECT id, rel_path, state FROM entries WHERE pair_id = ?').all(pairId) as {
        id: number;
        rel_path: string;
        state: string;
      }[];
      for (const r of rows) {
        const was = before.match(r.rel_path).excluded;
        const now = after.match(r.rel_path).excluded;
        if (now && !was) {
          // excluding never deletes anything remotely; open jobs for the subtree are cancelled
          this.st.get("UPDATE entries SET state = 'excluded', updated_at = ? WHERE id = ?").run(t, r.id);
          this.st
            .get(
              `UPDATE jobs SET state = 'cancelled', finished_at = ?, last_error = 'excluded' WHERE entry_id = ? AND state IN ('queued','retry_wait','blocked')`,
            )
            .run(t, r.id);
        } else if (!now && (was || r.state === 'excluded')) {
          this.st.get("UPDATE entries SET state = 'synced', updated_at = ? WHERE id = ?").run(t, r.id);
          newlyIncluded++;
        }
      }
    });
    const rulesIncluded = rules.some((r) => r.kind === 'include');
    if (newlyIncluded || rulesIncluded) this.requestSync({ pairId }, 'manual'); // mini-run for the re-included subtree
    this.scheduleStatus();
  }

  // ================================================================ conflicts

  conflicts(): ConflictDto[] {
    const rows = this.st
      .get(
        `SELECT c.*, e.pair_id, e.rel_path, p.account_id, p.direction FROM conflicts c JOIN entries e ON e.id = c.entry_id
         JOIN pairs p ON p.id = e.pair_id WHERE c.resolution IS NULL OR c.needs_review = 1 ORDER BY c.id`,
      )
      .all() as Record<string, unknown>[];
    const snap = (v: unknown) => (v ? (JSON.parse(String(v)) as ConflictDto['local']) : null);
    return rows.map((r) => ({
      id: Number(r.id),
      pairId: Number(r.pair_id),
      accountId: String(r.account_id),
      relPath: String(r.rel_path),
      kind: r.kind as ConflictDto['kind'],
      detectedAt: iso(Number(r.detected_at))!,
      local: snap(r.local_snapshot),
      remote: snap(r.remote_snapshot),
      base: snap(r.base_snapshot),
      direction: r.direction as ConflictDto['direction'],
      keptBoth: r.needs_review ? { copyRelPath: (r.copy_rel_path as string | null) ?? null } : null,
    }));
  }

  resolveConflict(id: number, resolution: ConflictResolution, by: string): void {
    const c = this.st
      .get('SELECT * FROM conflicts WHERE id = ? AND (resolution IS NULL OR needs_review = 1)')
      .get(id) as
      { id: number; entry_id: number; kind: string; needs_review: number; copy_rel_path: string | null } | undefined;
    if (!c) throw new Error(`conflict ${id} not found or already resolved`);
    const e = getEntry(this.db, c.entry_id);
    if (!e) throw new Error('entry of the conflict no longer exists');
    const pair = this.pairRow(e.pair_id)!;
    if (c.needs_review) return this.resolveReview(c, e, pair, resolution, by);
    const mirror = pair.direction === 'mirror-down';
    if (resolution === 'keep_local' && mirror)
      throw new Error('mirror pairs never write to Proton: "keep local" is not possible here');
    const t = Date.now();
    const base: JobPayload = {
      rel: e.rel_path,
      kind: 'file',
      parentRel: parentRel(e.rel_path),
      name: baseName(e.rel_path),
      size: e.l_size,
      mtimeUs: e.l_mtime_us,
      sha1: e.l_sha1,
      uid: e.r_uid,
      expectedRevUid: e.r_rev_uid,
      remoteSha1: e.r_sha1,
      conflictId: id,
    };
    const job = (type: JobDto['type'], payload: JobPayload, bytes: number | null) =>
      insertJob(this.db, {
        runId: null,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: e.id,
        type,
        payload,
        bytes,
        dedupeKey: `${type}:${pair.id}:${payload.targetRel ?? e.rel_path}`,
      });
    tx(this.db, () => {
      this.st
        .get('UPDATE conflicts SET resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(resolution, t, by, id);
      if (c.kind === 'duplicate_remote_name') {
        this.st
          .get(`UPDATE entries SET flags = flags & ~${FLAG.DUPLICATE_REMOTE_NAME}, state = 'synced' WHERE id = ?`)
          .run(e.id);
        return;
      }
      if (resolution === 'ignore') {
        // accept both sides as they are now; the next change on either side is handled normally
        this.st
          .get(
            `UPDATE entries SET b_sha1 = COALESCE(l_sha1, r_sha1), b_size = COALESCE(l_size, r_size), b_l_mtime_us = l_mtime_us,
             b_r_rev_uid = r_rev_uid, synced_at = ?, state = 'synced', flags = flags | ${FLAG.CONFLICT_IGNORED} WHERE id = ?`,
          )
          .run(t, e.id);
        return;
      }
      this.st.get("UPDATE entries SET state = 'synced' WHERE id = ?").run(e.id);
      if (resolution === 'keep_local') {
        if (!e.l_exists) {
          if (e.r_exists) job('trash_remote', { ...base }, e.r_size);
        } else if (e.r_exists) job('upload_revision', { ...base, force: true }, e.l_size);
        else job('upload', base, e.l_size);
      } else if (resolution === 'keep_remote') {
        if (e.r_exists)
          job(
            'download',
            { ...base, replace: !!e.l_exists, ...(mirror && e.l_exists ? { reason: 'preserve_local' } : {}) },
            e.r_size,
          );
        else if (e.l_exists) job('trash_local', base, e.l_size);
      } else if (resolution === 'keep_both') {
        if (e.r_exists && e.l_exists && pair.direction === 'two-way')
          job('conflict_copy', { ...base, conflictKind: c.kind as ConflictDto['kind'], twoWay: true }, e.l_size);
        else if (e.r_exists && e.l_exists) {
          if (mirror) job('download', { ...base, replace: true, reason: 'preserve_local' }, e.r_size);
          else
            job(
              'download',
              {
                ...base,
                targetRel: conflictCopyName(e.rel_path, 'Proton'),
                then: { type: 'upload_revision', payload: { ...base, force: true } },
              },
              e.r_size,
            );
        } else if (e.l_exists && !mirror) job('upload', base, e.l_size);
        else if (e.r_exists) job('download', { ...base, replace: false }, e.r_size);
      }
    });
    this.executor.kick(pair.account_id);
    this.emitEvent({ type: 'conflicts_changed', open: this.status().openConflicts });
    this.emitCountsNow();
  }

  /**
   * two-way review items: the engine already kept both versions (or restored the side that deleted a changed file).
   * Resolving only cleans up, through the normal two-way propagation (local trash / local rename, then the next run
   * carries it to Proton):
   *  - conflict copy: keep_remote -> the copy goes to the trash; keep_local -> the copy replaces the original (the
   *    original's local version goes to the trash, the next run uploads a new revision); keep_both/ignore -> dismiss
   *  - restored after "deleted here, changed there": the resolution that names the deleting side carries out the
   *    deletion after all (local trash, then Proton trash); the other choices dismiss
   */
  private resolveReview(
    c: { id: number; kind: string; copy_rel_path: string | null },
    e: EntryRow,
    pair: PairRow,
    resolution: ConflictResolution,
    by: string,
  ): void {
    const t = Date.now();
    const snapshotJob = (x: EntryRow, type: 'trash_local', extra: Partial<JobPayload> = {}) =>
      insertJob(this.db, {
        runId: null,
        accountId: pair.account_id,
        pairId: pair.id,
        entryId: x.id,
        type,
        payload: {
          rel: x.rel_path,
          kind: 'file',
          parentRel: parentRel(x.rel_path),
          name: baseName(x.rel_path),
          size: x.l_size,
          mtimeUs: x.l_mtime_us,
          sha1: x.l_sha1,
          conflictId: c.id,
          ...extra,
        },
        bytes: x.l_size,
        dedupeKey: `${type}:${pair.id}:${x.rel_path}`,
      });
    const jobIds = new Set<number>();
    tx(this.db, () => {
      const copy = c.copy_rel_path ? getEntryByRel(this.db, pair.id, c.copy_rel_path) : null;
      if (copy?.l_exists && resolution === 'keep_remote') {
        jobIds.add(snapshotJob(copy, 'trash_local').id);
      } else if (copy?.l_exists && resolution === 'keep_local') {
        const j = insertJob(this.db, {
          runId: null,
          accountId: pair.account_id,
          pairId: pair.id,
          entryId: copy.id,
          type: 'move_local',
          payload: {
            rel: copy.rel_path,
            kind: 'file',
            fromRel: copy.rel_path,
            toRel: e.rel_path,
            size: copy.l_size,
            mtimeUs: copy.l_mtime_us,
            sha1: copy.l_sha1,
            review: true,
            replaceTarget: e.l_exists ? { size: e.l_size, mtimeUs: e.l_mtime_us } : null,
            conflictId: c.id,
            ...({ toEntryId: e.id } as object),
          },
          bytes: copy.l_size,
          dedupeKey: `move_local:${pair.id}:${copy.rel_path}`,
        });
        jobIds.add(j.id);
      } else if (
        e.l_exists &&
        ((c.kind === 'remote_changed_local_deleted' && resolution === 'keep_local') ||
          (c.kind === 'local_changed_remote_deleted' && resolution === 'keep_remote'))
      ) {
        jobIds.add(snapshotJob(e, 'trash_local').id);
      }
      this.st
        .get('UPDATE conflicts SET needs_review = 0, resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(resolution, t, by, c.id);
    });
    jobIds.delete(0);
    if (jobIds.size) {
      // the local change is carried to Proton by a pair run right after the job(s)
      const onDone = (j: JobRow) => {
        if (!jobIds.delete(j.id) || jobIds.size) return;
        this.executor.off('jobFinished', onDone);
        if (!this.closed) this.requestSync({ pairId: pair.id }, 'api');
      };
      this.executor.on('jobFinished', onDone);
      this.executor.kick(pair.account_id);
    }
    this.emitEvent({ type: 'conflicts_changed', open: this.status().openConflicts });
    this.emitCountsNow();
  }

  /** pair counts changed by a user decision: every client (main window, tray flyout) gets a fresh status at once */
  private emitCountsNow(): void {
    this.pairCountCache = null;
    if (!this.closed) this.emitEvent({ type: 'status', status: this.status() });
  }

  // ================================================================ pending deletions

  deletions(): PendingDeletionDto[] {
    const rows = this.st
      .get(
        `SELECT d.*, e.pair_id, e.rel_path, e.r_rev_uid, e.r_exists, p.account_id FROM pending_deletions d JOIN entries e ON e.id = d.entry_id
         JOIN pairs p ON p.id = e.pair_id WHERE d.decision IS NULL AND d.executed_at IS NULL ORDER BY e.rel_path`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      pairId: Number(r.pair_id),
      accountId: String(r.account_id),
      relPath: String(r.rel_path),
      size: Number(r.size ?? 0),
      detectedAt: iso(Number(r.detected_at))!,
      remoteChangedSinceDelete: r.side !== 'remote' && !!r.r_exists && r.r_rev_uid !== r.remote_rev_uid_at_detect,
      side: (r.side as 'local' | 'remote') ?? 'local',
      held: !!r.held,
    }));
  }

  decideDeletions(req: DecideDeletionsRequest, by: string): { jobIds: number[] } {
    const jobIds: number[] = [];
    const t = Date.now();
    const accounts = new Set<string>();
    const pairs = new Set<number>();
    tx(this.db, () => {
      for (const id of req.ids) {
        const d = this.st
          .get('SELECT * FROM pending_deletions WHERE id = ? AND decision IS NULL AND executed_at IS NULL')
          .get(id) as { id: number; entry_id: number; side: string; held: number } | undefined;
        if (!d) continue;
        const e = getEntry(this.db, d.entry_id);
        if (!e) continue;
        const pair = this.pairRow(e.pair_id)!;
        // which decisions fit the side that deleted the file
        const remoteSide = d.side === 'remote';
        const fits = remoteSide
          ? req.decision === 'trash_local' || req.decision === 'restore_remote'
          : req.decision === 'trash_remote' || req.decision === 'restore_local' || req.decision === 'keep_remote_only';
        if (!fits) continue;
        accounts.add(pair.account_id);
        if (d.held) pairs.add(pair.id);
        this.st
          .get('UPDATE pending_deletions SET decision = ?, decided_at = ?, decided_by = ? WHERE id = ?')
          .run(req.decision, t, by, id);
        const payload: JobPayload = {
          rel: e.rel_path,
          kind: e.kind,
          uid: e.r_uid,
          expectedRevUid: e.r_rev_uid,
          size: e.b_size ?? e.r_size,
          pendingId: id,
          parentRel: parentRel(e.rel_path),
          name: baseName(e.rel_path),
        };
        if (req.decision === 'trash_remote') {
          const j = insertJob(this.db, {
            runId: null,
            accountId: pair.account_id,
            pairId: pair.id,
            entryId: e.id,
            type: 'trash_remote',
            payload,
            bytes: e.r_size,
            dedupeKey: `trash_remote:${pair.id}:${e.rel_path}`,
          });
          this.st.get('UPDATE pending_deletions SET job_id = ? WHERE id = ?').run(j.id, id);
          jobIds.push(j.id);
        } else if (req.decision === 'restore_local') {
          const j = insertJob(this.db, {
            runId: null,
            accountId: pair.account_id,
            pairId: pair.id,
            entryId: e.id,
            type: 'download',
            payload:
              e.kind === 'folder'
                ? { rel: e.rel_path, kind: 'folder', uid: e.r_uid, pendingId: id }
                : { ...payload, replace: false },
            bytes: e.r_size,
            dedupeKey: `download:${pair.id}:${e.rel_path}`,
          });
          this.st.get('UPDATE pending_deletions SET job_id = ? WHERE id = ?').run(j.id, id);
          jobIds.push(j.id);
          this.st.get("UPDATE entries SET state = 'remote_new' WHERE id = ?").run(e.id);
        } else if (req.decision === 'trash_local') {
          // two-way, deleted in Proton: the local copy goes to the trash (pending row marked by the executor)
          const j = insertJob(this.db, {
            runId: null,
            accountId: pair.account_id,
            pairId: pair.id,
            entryId: e.id,
            type: 'trash_local',
            payload:
              e.kind === 'folder'
                ? { rel: e.rel_path, kind: 'folder', twoWay: true, pendingId: id }
                : { ...payload, size: e.l_size, mtimeUs: e.l_mtime_us, sha1: e.l_sha1 },
            bytes: e.l_size,
            dedupeKey: `trash_local:${pair.id}:${e.rel_path}`,
          });
          this.st.get('UPDATE pending_deletions SET job_id = ? WHERE id = ?').run(j.id, id);
          jobIds.push(j.id);
        } else if (req.decision === 'restore_remote') {
          // two-way, deleted in Proton: upload the local file again (as a new file, -f skip)
          const j = insertJob(this.db, {
            runId: null,
            accountId: pair.account_id,
            pairId: pair.id,
            entryId: e.id,
            type: e.kind === 'folder' ? 'mkdir' : 'upload',
            payload:
              e.kind === 'folder'
                ? { rel: e.rel_path, kind: 'folder', parentRel: parentRel(e.rel_path), name: baseName(e.rel_path) }
                : {
                    ...payload,
                    uid: null,
                    expectedRevUid: null,
                    size: e.l_size,
                    mtimeUs: e.l_mtime_us,
                    sha1: e.l_sha1,
                    twoWay: true,
                  },
            bytes: e.l_size,
            dedupeKey: `${e.kind === 'folder' ? 'mkdir' : 'upload'}:${pair.id}:${e.rel_path}`,
          });
          this.st.get('UPDATE pending_deletions SET job_id = ?, executed_at = ? WHERE id = ?').run(j.id, t, id);
          // the base no longer describes a remote file: the upload records a fresh one
          this.st
            .get(
              "UPDATE entries SET synced_at = NULL, b_sha1 = NULL, b_size = NULL, b_l_mtime_us = NULL, b_r_rev_uid = NULL, state = 'local_new' WHERE id = ?",
            )
            .run(e.id);
          jobIds.push(j.id);
        } else {
          this.st.get('UPDATE pending_deletions SET executed_at = ? WHERE id = ?').run(t, id);
          this.st
            .get(`UPDATE entries SET flags = flags | ${FLAG.KEEP_REMOTE_ONLY}, state = 'synced' WHERE id = ?`)
            .run(e.id);
        }
      }
    });
    // held deletions (two-way mass-delete guard) all decided: the pair's brake is released, it runs again
    for (const pairId of pairs) {
      this.heldCache.delete(pairId);
      if (this.heldCount(pairId) === 0) {
        this.st
          .get(
            `INSERT INTO pair_state (pair_id, brake_released_at) VALUES (?, ?)
             ON CONFLICT (pair_id) DO UPDATE SET brake_released_at = excluded.brake_released_at`,
          )
          .run(pairId, Date.now());
        const p = this.pairRow(pairId);
        if (p)
          this.addActivity({
            accountId: p.account_id,
            pairId,
            action: 'info',
            message: msg('activity.heldDecided', { by }),
          });
      }
    }
    for (const a of accounts) this.executor.kick(a);
    this.emitEvent({ type: 'deletions_changed', pending: this.status().pendingDeletions });
    this.emitCountsNow();
    return { jobIds };
  }

  /**
   * two-way mass-delete guard: approve (carry out every held deletion of the pair: Proton trash / local trash) or
   * deny (restore: download what was deleted here, upload what was deleted in Proton). The pair runs again after.
   */
  decideHeld(pairId: number, approve: boolean, by: string): { decided: number; jobIds: number[] } {
    const rows = this.st
      .get(
        `SELECT d.id, d.side FROM pending_deletions d JOIN entries e ON e.id = d.entry_id
         WHERE e.pair_id = ? AND d.held = 1 AND d.decision IS NULL AND d.executed_at IS NULL ORDER BY d.id`,
      )
      .all(pairId) as { id: number; side: string }[];
    const jobIds: number[] = [];
    let decided = 0;
    for (const side of ['local', 'remote'] as const) {
      const ids = rows.filter((r) => (r.side === 'remote' ? 'remote' : 'local') === side).map((r) => r.id);
      if (!ids.length) continue;
      const decision: DecideDeletionsRequest['decision'] =
        side === 'local' ? (approve ? 'trash_remote' : 'restore_local') : approve ? 'trash_local' : 'restore_remote';
      jobIds.push(...this.decideDeletions({ ids, decision }, by).jobIds);
      decided += ids.length;
    }
    if (decided) this.requestSync({ pairId }, 'manual');
    return { decided, jobIds };
  }

  // ================================================================ adoption proposals

  adoptions(): AdoptionProposalDto[] {
    const rows = this.st.get("SELECT * FROM adoption_proposals WHERE state = 'pending' ORDER BY id").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: String(r.account_id),
      pairId: Number(r.pair_id),
      targetRelPath: String(r.target_rel_path),
      sourceRemotePath: String(r.source_remote_path),
      sourceUid: String(r.source_uid),
      size: Number(r.size),
      matchedBy: r.matched_by as AdoptionProposalDto['matchedBy'],
      outsidePair: !!r.outside_pair,
    }));
  }

  decideAdoptions(ids: number[], accept: boolean, by: string): void {
    const t = Date.now();
    const accounts = new Set<string>();
    tx(this.db, () => {
      for (const id of ids) {
        const p = this.st.get("SELECT * FROM adoption_proposals WHERE id = ? AND state = 'pending'").get(id) as
          | {
              id: number;
              entry_id: number;
              pair_id: number;
              account_id: string;
              target_rel_path: string;
              source_uid: string;
              source_section: string;
              source_remote_path: string;
              size: number;
            }
          | undefined;
        if (!p) continue;
        const e = getEntry(this.db, p.entry_id);
        if (!e) continue;
        accounts.add(p.account_id);
        this.st
          .get('UPDATE adoption_proposals SET state = ?, decided_at = ?, decided_by = ? WHERE id = ?')
          .run(accept ? 'accepted' : 'rejected', t, by, id);
        if (accept) {
          const j = insertJob(this.db, {
            runId: null,
            accountId: p.account_id,
            pairId: p.pair_id,
            entryId: e.id,
            type: 'move',
            payload: {
              rel: e.rel_path,
              kind: 'file',
              uid: p.source_uid,
              sourceSection: p.source_section,
              fromRel: p.source_remote_path,
              toRel: p.target_rel_path,
              parentRel: parentRel(p.target_rel_path),
              name: baseName(p.target_rel_path),
              size: e.l_size,
              sha1: e.l_sha1,
              proposalId: p.id,
              ...({ toEntryId: e.id } as object),
            },
            bytes: e.l_size,
            dedupeKey: `move:${p.pair_id}:${p.target_rel_path}`,
          });
          this.st.get('UPDATE adoption_proposals SET job_id = ? WHERE id = ?').run(j.id, id);
        } else if (e.l_exists && !e.r_exists) {
          insertJob(this.db, {
            runId: null,
            accountId: p.account_id,
            pairId: p.pair_id,
            entryId: e.id,
            type: 'upload',
            payload: {
              rel: e.rel_path,
              kind: 'file',
              parentRel: parentRel(e.rel_path),
              name: baseName(e.rel_path),
              size: e.l_size,
              mtimeUs: e.l_mtime_us,
              sha1: e.l_sha1,
            },
            bytes: e.l_size,
            dedupeKey: `upload:${p.pair_id}:${e.rel_path}`,
          });
        }
      }
    });
    for (const a of accounts) this.executor.kick(a);
    this.scheduleStatus();
  }

  // ================================================================ maintenance

  startDigestBackfill(pairId: number, relPrefix?: string, limit?: number): number {
    const pair = this.pairRow(pairId);
    if (!pair) throw new Error(`unknown pair ${pairId}`);
    if (pair.direction === 'two-way')
      throw new Error('adding checksums is not possible for two-way pairs (it replaces without a version check)');
    const res = this.st
      .get(
        "INSERT INTO runs (trigger, mode, account_id, pair_id, started_at, status) VALUES ('manual', 'verify', ?, ?, ?, 'ok')",
      )
      .run(pair.account_id, pairId, Date.now());
    const runId = Number(res.lastInsertRowid);
    const prefix = (relPrefix ?? '').replace(/^\/+|\/+$/g, '').normalize('NFC');
    const [a, b] = prefix ? belowRange(prefix) : ['', '\u{10FFFF}'];
    // the 1,315 duplicate revisions of 2026-10-09 first (reclaimable storage), then by path
    const rows = this.st
      .get(
        `SELECT e.* FROM entries e LEFT JOIN backfill_priority bp ON bp.account_id = ? AND bp.uid = e.r_uid
         WHERE e.pair_id = ? AND e.kind = 'file' AND e.state = 'synced' AND (e.flags & ${FLAG.DIGEST_MISSING}) != 0
           AND e.rel_path >= ? AND e.rel_path < ?
         ORDER BY (bp.uid IS NULL), bp.reclaimable DESC, e.rel_path LIMIT ?`,
      )
      .all(pair.account_id, pairId, a, b, limit ?? 1_000_000) as unknown as EntryRow[];
    tx(this.db, () => {
      for (const e of rows)
        insertJob(this.db, {
          runId,
          accountId: pair.account_id,
          pairId,
          entryId: e.id,
          type: 'digest_backfill',
          payload: { rel: e.rel_path, kind: 'file', size: e.l_size, sha1: e.l_sha1 },
          bytes: e.l_size,
          dedupeKey: `digest_backfill:${pairId}:${e.rel_path}`,
        });
    });
    this.addActivity({
      accountId: pair.account_id,
      pairId,
      runId,
      action: 'info',
      message: msg('activity.backfillPlanned', { count: rows.length }),
    });
    this.executor.kick(pair.account_id);
    return runId;
  }

  async emptyTrash(accountId: string, by: string): Promise<void> {
    const guard = this.writeGuard();
    if (guard) throw new Error(guard);
    const j = insertJob(this.db, {
      runId: null,
      accountId,
      pairId: null,
      entryId: null,
      type: 'empty_trash',
      payload: { rel: '/trash', reason: by },
      dedupeKey: `empty_trash:${accountId}`,
    });
    this.executor.kick(accountId);
    for (;;) {
      const r = this.st.get('SELECT state, last_error FROM jobs WHERE id = ?').get(j.id) as {
        state: string;
        last_error: string | null;
      };
      if (r.state === 'done') return;
      if (['failed', 'cancelled', 'blocked'].includes(r.state))
        throw new Error(decodeMsg(r.last_error).text ?? r.state);
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  /**
   * drop an account's CLI pool (after login/logout, account deletion): running workers are stopped, the next
   * command starts fresh workers that load the current session from the keyring.
   */
  async resetAccount(accountId: string): Promise<void> {
    const p = this.pools.get(accountId);
    this.pools.delete(accountId);
    this.remotes.delete(accountId);
    const h = this.health.get(accountId);
    if (h?.probeTimer) clearTimeout(h.probeTimer);
    this.health.delete(accountId);
    if (p) await p.shutdown();
  }

  /** account status changes made outside the engine (login runner, keyring watcher). */
  setAccountState(id: string, status: AccountDto['status'], err: TextOrMsg | null): void {
    this.setAccountStatus(id, status, err);
  }

  /** kick the executor after an external change (resume timers, released gates). */
  kick(accountId?: string): void {
    this.executor.kick(accountId);
    this.scheduleStatus();
  }

  /** test/diagnostics helper: account pool (created lazily) */
  poolFor(accountId: string): CliPool {
    return this.pool(accountId);
  }

  limiterFor(accountId: string): AccountLimiter {
    return this.limiter(accountId);
  }

  /** diagnostics/tests: live proton-drive processes over all accounts, the highest number seen, the cap */
  processStats(): { alive: number; peak: number; cap: number; commandsInFlight: number } {
    return {
      alive: this.budget.alive(),
      peak: this.budget.peak,
      cap: this.global.size,
      commandsInFlight: this.global.inUse,
    };
  }
}

/** Reads complete new lines of a growing file from offset. */
function readNew(file: string, offset: number, setOffset: (n: number) => void): string[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  if (size < offset) offset = 0; // rotated
  if (size === offset) return [];
  const len = Math.min(size - offset, 4 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return [];
  setOffset(offset + Buffer.byteLength(text.slice(0, lastNl + 1)));
  return text.slice(0, lastNl).split('\n').filter(Boolean);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** AccountDto.lastError (+ lastErrorMsg) from accounts.last_error (plain CLI text or an encoded message). */
export function lastErrorFields(stored: string | null): Pick<AccountDto, 'lastError' | 'lastErrorMsg'> {
  const d = decodeMsg(stored);
  return d.msg ? { lastError: d.text, lastErrorMsg: d.msg } : { lastError: d.text };
}

/** activity.msg column (JSON of a MsgRef) */
function parseRef(json: string): MsgRef | null {
  try {
    const r = JSON.parse(json) as MsgRef;
    return typeof r?.key === 'string' ? r : null;
  } catch {
    return null;
  }
}
