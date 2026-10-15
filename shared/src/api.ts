// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Local API contract between daemon (server) and UI / `nucleon-sync` CLI / agents (clients).
 * Versioned under /v1. All timestamps are ISO-8601 UTC strings, all sizes are bytes (number).
 * This file is the single source of truth for DTOs; see docs/ARCHITECTURE.md §6 for the endpoint table.
 */

import type { MsgRef } from './messages.ts';

export const API_VERSION = 'v1';
export const DEFAULT_TCP_PORT = 47821;

// ---------------------------------------------------------------- enums (string unions, erasable)

export type AccountStatus =
  | 'ok' // logged in, last CLI call fine
  | 'needs_login' // CLI reports "You need to login first" after worker restart
  | 'login_pending' // `auth login` running, waiting for browser confirmation
  | 'needs_keyring' // Secret Service / KWallet not available yet (boot) -> retried every 60 s
  | 'offline' // network unreachable (probe failing)
  | 'throttled' // adaptive limiter detected Proton tarpit, cooling down
  | 'error' // other persistent error (see lastError)
  | 'disabled';

export type PairDirection =
  /** Local is master (Alex's /data). Local new/changed -> upload; remote-only -> download; local deletions -> pending list. */
  | 'backup'
  /** Remote is master (Sam's shared backup -> /srv/sync/Sam). Remote new/changed -> download; local edits -> conflict; remote deletions -> local trash. */
  | 'mirror-down'
  /** Outbox: local new/changed -> upload; never downloads; deletions never propagated. */
  | 'upload-only'
  /**
   * Two-way: changes on either side are applied to the other, three-way against the base. Both
   * sides changed -> both versions kept (local one renamed "Name (conflict <host> YYYY-MM-DD).ext" and uploaded);
   * deletions go to a trash on the other side (XDG trash / Proton trash); mass deletions are held for approval.
   */
  | 'two-way';

export type EntryState =
  | 'synced'
  | 'local_new'
  | 'local_changed'
  | 'remote_new'
  | 'remote_changed'
  | 'moved' // local move detected, remote move pending
  | 'conflict'
  | 'pending_remote_delete' // local file gone, waiting for user decision
  | 'remote_deleted' // remote file gone, local present
  | 'excluded'
  | 'unsupported' // e.g. Proton Docs/Sheets, undecryptable names
  | 'error';

export type JobType =
  | 'mkdir'
  | 'upload' // new file, CLI strategy -f skip
  | 'upload_revision' // changed file, CLI strategy -f create-new-revision
  | 'download'
  | 'move'
  | 'rename'
  | 'trash_remote'
  | 'trash_local' // freedesktop trash on /data (mirror-down remote deletions, keep-remote conflict resolution)
  | 'list' // remote folder listing (crawl)
  | 'digest_backfill' // maintenance: -f replace to give a remote file a sha1 digest
  | 'empty_trash' // maintenance, always user-confirmed
  | 'conflict_copy' // two-way: local version renamed to a conflict copy (then uploaded), remote version downloaded
  | 'verify_content' // two-way adoption: digest-less remote file downloaded to staging and hashed (nothing written)
  | 'move_local'; // two-way: a remote move/rename (same node uid) applied to the local file

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'retry_wait' | 'blocked' | 'cancelled';

export type ErrorClass =
  | 'transient' // network drop, 5xx, timeouts -> retry with backoff
  | 'rate_limited' // 429 / tarpit -> global cool-down
  | 'auth' // "You need to login first" -> restart worker, then needs_login
  | 'not_found'
  | 'conflict' // name conflict
  | 'quota' // insufficient quota/space
  | 'local_io' // ENOENT/EACCES/ENOSPC on /data
  | 'integrity' // sha1 mismatch after download
  | 'fatal'; // CLI crash / unknown -> job failed, surfaced

export type RunMode = 'incremental' | 'full' | 'verify';
export type RunTrigger = 'schedule' | 'manual' | 'api' | 'startup' | 'resume';
export type ActivityAction =
  | 'uploaded'
  | 'new_revision'
  | 'downloaded'
  | 'moved'
  | 'renamed'
  | 'trashed_remote'
  | 'trashed_local'
  | 'adopted' // existing identical remote file linked into state DB without transfer
  | 'skipped'
  | 'conflict'
  | 'deletion_pending'
  | 'error'
  | 'info';

export type ConflictKind =
  | 'both_changed'
  | 'initial_mismatch' // first contact: same path on both sides, different content, no base
  | 'local_changed_remote_deleted'
  | 'remote_changed_local_deleted'
  | 'local_present_remote_deleted' // backup pair with remoteDeletions='ask'
  | 'mirror_local_edit' // mirror-down pair: local copy was edited
  | 'duplicate_remote_name' // two remote nodes with the same name in one folder
  | 'case_clash' // names differing only by case
  | 'needs_check'; // two-way adoption: remote file without sha1, same size, different mtime, too big to verify cheaply

export type ConflictResolution = 'keep_local' | 'keep_remote' | 'keep_both' | 'ignore';

export type DeletionDecision =
  | 'trash_remote' // propagate: move remote file to Proton trash
  | 'restore_local' // download it back
  | 'keep_remote_only' // keep in Proton, stop tracking/downloading (archived)
  | 'trash_local' // two-way, deleted in Proton (held by the mass-delete guard): move the local file to the trash
  | 'restore_remote'; // two-way, deleted in Proton (held): upload the local file again

// ---------------------------------------------------------------- DTOs

export interface AccountDto {
  id: string; // slug: "alex", "sam"
  displayName: string;
  email: string | null;
  status: AccountStatus;
  /** English text (CLI error or daemon message) */
  lastError: string | null;
  /** message key + params of lastError when the daemon produced it (shared/src/messages.ts; additive) */
  lastErrorMsg?: MsgRef | null;
  lastOkAt: string | null;
  /** how the CLI session is stored; see ARCHITECTURE §5 */
  credentialBackend: 'keyring-shim' | 'keychain-direct' | 'mock' | 'encfile';
  workers: { configured: number; active: number };
  paused: boolean;
  /** runs working on this account right now (its background run + priority runs of its pairs) */
  activeRunIds?: number[];
  /** runs of this account waiting for its background lane (or for a pair's priority lane) */
  queuedRunIds?: number[];
}

export interface PairDto {
  id: number;
  accountId: string;
  name: string;
  localRoot: string;
  remoteRoot: string; // display path, e.g. /devices/Workstation/Documents
  direction: PairDirection;
  enabled: boolean;
  paused: boolean;
  counts: Partial<Record<EntryState, number>>;
  bytesTracked: number;
  lastRunAt: string | null;
  lastFullAt: string | null;
  /** active safety brake (mass deletion, missing root, ...): the pair does not run until released (POST /v1/pairs/:id/release-brake) */
  brake?: { reason: string; at: string; /** key + params of reason (additive) */ reasonMsg?: MsgRef | null } | null;
  /** behaviour options (see PairOptionsDto in ext-c.ts) */
  options?: {
    remoteChanges?: 'download' | 'conflict';
    remoteDeletions?: 'reupload' | 'ask';
    uploadLocalNew?: boolean;
    uploadLocalNewSince?: number;
    /** two-way pairs (see TwoWayPairOptions in ext-twoway.ts) */
    remoteCheckMinutes?: number;
    massDeleteMaxFiles?: number;
    massDeletePercent?: number;
    twoWayAdoption?: boolean;
  };
  /** two-way (additive): end of the last complete remote listing of the pair */
  lastRemoteCheckAt?: string | null;
  /** two-way (additive): deletions held by the mass-delete guard, waiting for approval */
  heldDeletions?: number;
  /** nested pairs (additive): sub folders owned by another pair, excluded here */
  ownedElsewhere?: { relPath: string; pairId: number; pairName: string }[];
}

export type RunLane = 'background' | 'priority';

export interface RunDto {
  id: number;
  trigger: RunTrigger;
  mode: RunMode;
  accountId: string | null;
  pairId: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** 'queued': requested while the lane was busy; it starts when the run ahead of it released the lane */
  status: 'queued' | 'running' | 'ok' | 'partial' | 'failed' | 'cancelled';
  /**
   * 'priority' = pair-scoped incremental run (agent `sync --pair N`, UI pair sync); it
   * runs next to the account's long background run and its jobs jump the queue. 'background' = everything else
   * (scheduled, global, account-scoped, full/verify): at most one per account at a time.
   */
  lane?: RunLane;
  /** live runs only: accounts this run is still working on (a global run releases each account when it is done) */
  activeAccounts?: string[];
  /** queued runs only: the runs that hold the lane this one waits for */
  waitingFor?: number[];
  counters: {
    scannedLocal: number;
    listedRemoteFolders: number;
    uploaded: number;
    uploadedBytes: number;
    downloaded: number;
    downloadedBytes: number;
    moved: number;
    adopted: number;
    conflicts: number;
    pendingDeletions: number;
    errors: number;
  };
}

export interface JobDto {
  id: number;
  runId: number | null;
  accountId: string;
  pairId: number | null;
  type: JobType;
  state: JobState;
  relPath: string | null;
  bytes: number | null;
  attempts: number;
  notBefore: string | null;
  errorClass: ErrorClass | null;
  lastError: string | null;
  /** key + params of lastError when the daemon produced it (waiting, blocked, …; additive) */
  lastErrorMsg?: MsgRef | null;
  progress: number | null; // 0..1 when known (CLI gives no per-file progress in -j mode; estimated from elapsed/expected)
  startedAt: string | null;
  /** running transfers: bytes done so far and the estimated time left */
  bytesDone?: number | null;
  etaSeconds?: number | null;
}

/** A transfer command in flight (one file or a batch of small files). */
export interface TransferProgressDto {
  jobIds: number[];
  accountId: string;
  pairId: number | null;
  kind: 'upload' | 'download';
  /** first file of the batch */
  relPath: string | null;
  files: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: string;
  /** observed throughput of this transfer (bytes/s), null until measurable */
  rateBps: number | null;
  etaSeconds: number | null;
  /** fd = read offset of the CLI process, io = bytes it read (pread), staging = bytes written, estimate = time x rate */
  source: 'fd' | 'io' | 'staging' | 'estimate';
}

/** Open work of one direction: queued + running + retrying transfer jobs. */
export interface TransferBacklogDto {
  files: number;
  bytes: number;
  /** bytes already transferred of the running jobs */
  bytesDone: number;
  /** throughput used for the ETA (EWMA of finished transfers and live progress), null = unknown yet */
  rateBps: number | null;
  etaSeconds: number | null;
  /** jobs blocked by the write guard (not part of the ETA) */
  blockedFiles: number;
  blockedBytes: number;
}

export interface ActivityItem {
  id: number;
  ts: string;
  accountId: string;
  pairId: number | null;
  action: ActivityAction;
  relPath: string | null;
  bytes: number | null;
  durationMs: number | null;
  /** English text */
  message: string | null;
  /** message key + params for the dashboard's translation (absent for plain CLI texts and older rows; additive) */
  msg?: MsgRef | null;
  /** run the item belongs to (null for actions outside a run, e.g. user decisions); added by /integration */
  runId?: number | null;
}

export interface ConflictDto {
  id: number;
  pairId: number;
  accountId: string;
  relPath: string;
  kind: ConflictKind;
  detectedAt: string;
  local: FileSnapshot | null;
  remote: FileSnapshot | null;
  base: FileSnapshot | null;
  /**
   * two-way (additive): the engine already kept both versions — the remote one under relPath, the local one as
   * copyRelPath (uploaded as well). The conflict stays listed for review; resolving it only cleans up.
   */
  keptBoth?: { copyRelPath: string | null } | null;
  /** direction of the pair (additive; the UI offers only the resolutions that make sense) */
  direction?: PairDirection;
}

export interface FileSnapshot {
  size: number;
  mtime: string;
  sha1: string | null;
  revisionUid?: string | null;
}

export interface PendingDeletionDto {
  id: number;
  pairId: number;
  accountId: string;
  relPath: string;
  size: number;
  detectedAt: string;
  /** set when the remote changed after the local deletion -> UI shows a warning */
  remoteChangedSinceDelete: boolean;
  /**
   * two-way (additive): which side deleted the file. 'local' = deleted on this computer (approve -> Proton trash),
   * 'remote' = deleted in Proton (approve -> local trash). Absent = 'local'.
   */
  side?: 'local' | 'remote';
  /** two-way (additive): held by the mass-delete guard (the pair is paused until approved or denied) */
  held?: boolean;
}

export interface StorageDto {
  accountId: string;
  measuredAt: string | null;
  /** from `filesystem size` per area (includes trashed descendants) */
  areas: { path: string; label: string; bytes: number; files: number; labelMsg?: MsgRef | null }[];
  /** active revisions only vs. all revisions (from state DB / crawl totals) */
  activeBytes: number;
  totalBytes: number;
  reclaimableOldRevisionsBytes: number;
  trashBytes: number;
}

export interface StoragePoolDto {
  /** shared storage pool size of the plan (configured; the CLI exposes no quota API) */
  poolBytes: number | null;
  accounts: StorageDto[];
  /** account ids with a measurement in progress (fix-ui-round1; additive, absent in older daemons) */
  measuring?: string[];
}

export interface TreeNodeDto {
  name: string;
  relPath: string;
  kind: 'folder' | 'file';
  /** tri-state selection derived from rules */
  selection: 'included' | 'excluded' | 'partial';
  /** excluded by a default/global rule (node_modules, .venv, ...); 'pair' = owned by a nested pair */
  excludedBy: 'user' | 'default' | 'hard' | 'pair' | null;
  localBytes: number | null;
  remoteBytes: number | null;
  localFiles: number | null;
  states: Partial<Record<EntryState, number>>;
  hasChildren: boolean;
}

export interface SelectionRule {
  id?: number;
  kind: 'include' | 'exclude';
  /** 'prefix' = relPath prefix (folder), 'glob' = name glob applied anywhere */
  patternType: 'prefix' | 'glob';
  pattern: string;
  source: 'user' | 'default';
}

export interface ScheduleSettings {
  incrementalEveryMinutes: number; // default 360 (6 h): the CLI has no change feed, every run lists folders
  fullWeekly: { weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; hour: number }; // day + hour of the full run, default Sunday 03:00
  /** full run every N weeks on fullWeekly's day (1 = weekly, 4 ≈ monthly; default 4) */
  fullEveryWeeks: number;
  runOnStartupDelayMinutes: number; // catch-up after boot/resume
}

export interface TransferSettings {
  maxWorkersTotal: number; // default 3 (Proton tarpits at 4 sustained)
  maxWorkersPerAccount: number; // default 2
  bandwidthLimitKBps: number | null; // average-rate pacing, null = unlimited
  quietHours: { from: string; to: string; bandwidthLimitKBps: number | null } | null;
  thumbnails: boolean; // false => always pass -t
  maxFileBytes: number | null; // skip/flag bigger files
}

export interface NotificationSettings {
  /** desktop notifications from the dashboard (tray app) */
  desktop: boolean;
  /**
   * Telegram bot of your own: problems right away, pending decisions in a daily digest. The bot token is stored in the
   * keyring (PUT /v1/notifications/telegram-token), never in the settings; chatId is the numeric chat id.
   */
  telegram: { enabled: boolean; chatId: string };
  /** de-dup window per problem (minutes) for Telegram and the notify command */
  minIntervalMinutes: number;
}

export interface SettingsDto {
  schedule: ScheduleSettings;
  transfer: TransferSettings;
  notifications: NotificationSettings;
  storagePoolBytes: number | null;
  globalExcludes: SelectionRule[];
}

export interface StatusDto {
  apiVersion: typeof API_VERSION;
  daemonVersion: string;
  pid: number;
  startedAt: string;
  mode: 'production' | 'mock';
  state: 'idle' | 'syncing' | 'paused' | 'offline' | 'error';
  paused: boolean;
  /** the most recently started active run (kept for older clients; see activeRuns) */
  currentRun: RunDto | null;
  /** every active run, oldest first (runs of different accounts and pair priority runs run in parallel) */
  activeRuns?: RunDto[];
  /** requested runs waiting for a busy lane, oldest first */
  queuedRuns?: RunDto[];
  lastRun: RunDto | null;
  nextRuns: { mode: RunMode; at: string }[];
  accounts: AccountDto[];
  pairs: PairDto[];
  queue: { queued: number; running: number; retryWait: number; failed: number; blocked: number };
  openConflicts: number;
  pendingDeletions: number;
  rate: { uploadBps: number; downloadBps: number; metaLatencyMsEwma: number | null };
  /** end of a timed global pause (POST /v1/pause with `until`), null = unlimited / not paused */
  pausedUntil?: string | null;
  /** live transfers and the open upload/download backlog with ETA */
  transfers?: {
    active: TransferProgressDto[];
    upload: TransferBacklogDto;
    download: TransferBacklogDto;
  };
}

// ---------------------------------------------------------------- request bodies

export interface SyncRequest {
  accountId?: string;
  pairId?: number;
  mode?: RunMode;
}
/**
 * POST /v1/sync answer. `followUp`: (part of) the request waits behind an active run of the same lane. The
 * queued run already has its id: `runIds` lists every run that together covers the request
 * (a global request while one account is busy = one run per account); `runId` is the first of them.
 */
export interface SyncResponse {
  runId: number;
  followUp?: boolean;
  /** every run covering the request (started or queued); `sync --wait` waits for all of them */
  runIds?: number[];
  /** active runs a queued part waits for */
  queuedBehind?: number[];
  /** why the requested pair/account will not be synced by this run (disabled, paused, needs login, ...) */
  notRunnable?: string | null;
  notRunnableMsg?: MsgRef | null;
  /** write guard reason: the run plans, but uploads/downloads stay blocked */
  writesBlocked?: string | null;
  writesBlockedMsg?: MsgRef | null;
}
export interface PauseRequest {
  scope: 'all' | 'account' | 'pair';
  id?: string | number;
  /** abort running transfers immediately instead of letting the current file finish */
  immediate?: boolean;
  /** pause only: resume automatically at this ISO time (daemon-side timer, survives UI restarts) */
  until?: string;
}
export interface ResolveConflictRequest {
  resolution: ConflictResolution;
}
export interface DecideDeletionsRequest {
  ids: number[];
  decision: DeletionDecision;
}
export interface LoginStartResponse {
  accountId: string;
  signInUrl: string;
}

export interface ApiError {
  error: string;
  code: 'unauthorized' | 'forbidden' | 'not_found' | 'bad_request' | 'conflict' | 'internal';
}

// ---------------------------------------------------------------- further DTOs (frozen interface for )

/** Proposed remote move instead of an upload (content found elsewhere in Proton), docs/SYNC-RULES.md */
export interface AdoptionProposalDto {
  id: number;
  accountId: string;
  pairId: number;
  targetRelPath: string; // where the file belongs (local path relative to the pair root)
  sourceRemotePath: string; // where the identical content currently is in Proton
  sourceUid: string;
  size: number;
  matchedBy: 'sha1' | 'name_size_mtime';
  outsidePair: boolean; // needs explicit approval
}

export interface DoctorCheck {
  id: string; // 'cli_version' | 'keyring:<id>' | 'mount:<path>' | 'disk_space' | 'staging_dir' | 'api' | ...
  ok: boolean;
  severity: 'info' | 'warn' | 'error';
  /** English text */
  message: string;
  /** message key + params for the dashboard's translation (shared/src/messages.ts) */
  msg?: MsgRef;
}

/** 409 body of destructive endpoints called without confirmToken (ARCHITECTURE §6 confirm round-trip) */
export interface ConfirmRequiredResponse {
  code: 'conflict';
  error: 'confirmation required';
  confirmToken: string;
  expiresAt: string;
  summary: { title: string; items: number; bytes: number; details: string[] };
}

export interface Notice {
  key: string; // de-dup key, e.g. 'error:auth:sam'
  severity: 'info' | 'warn' | 'error';
  title: string; // English, short
  body: string; // English
  /** key + params of title/body for the dashboard's translation (additive) */
  titleMsg?: MsgRef | null;
  bodyMsg?: MsgRef | null;
  accountId?: string;
}
