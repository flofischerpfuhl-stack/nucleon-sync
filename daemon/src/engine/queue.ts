// SPDX-License-Identifier: GPL-3.0-or-later
/** Persistent job queue helpers (jobs table, ARCHITECTURE §4.4, §7). */
import type { DatabaseSync } from 'node:sqlite';

import { decodeMsg, type ConflictKind, type JobDto, type JobType } from '@nucleon-sync/shared';

import { Stmts, type JobRow } from '../db/repo.ts';

export const OPEN_STATES = ['queued', 'running', 'retry_wait', 'blocked'] as const;
export const OPEN_SQL = "('queued','running','retry_wait','blocked')";

export interface JobPayload {
  rel: string;
  kind?: 'file' | 'folder';
  parentRel?: string;
  name?: string;
  /** planned local snapshot (pre-check: the file must still look like this) */
  size?: number | null;
  mtimeUs?: number | null;
  sha1?: string | null;
  /** planned remote state */
  uid?: string | null;
  expectedRevUid?: string | null;
  remoteSha1?: string | null;
  remoteMtimeMs?: number | null;
  /** download replaces an existing local file (old one goes to the freedesktop trash) */
  replace?: boolean;
  /** upload_revision regardless of the remote revision (conflict resolution keep_local, upload-only pairs) */
  force?: boolean;
  /** move/rename */
  fromRel?: string;
  toRel?: string;
  folderMove?: boolean;
  /** move across sections (adoption) */
  sourceSection?: string;
  proposalId?: number;
  /** download into a different local name (conflict "keep both") */
  targetRel?: string;
  pendingId?: number;
  conflictId?: number;
  /** follow-up job created after success */
  then?: { type: JobType; payload: JobPayload; priority?: number };
  /** upload of a file new on the PC in a mirror-down pair (uploadLocalNew): same-named remote file -> keep both */
  fromPc?: boolean;
  /** fromPc upload renamed because Proton has a different file with this (original) name */
  keptBothOf?: string;
  /** keep_remote conflict resolution / mirror edits: old local file goes to the trash before replacing */
  reason?: string;
  /** two-way pair: list before writing, keep both on a same-named different remote file, verify revisions */
  twoWay?: boolean;
  /** two-way conflict_copy: the conflict kind recorded for review */
  conflictKind?: ConflictKind;
  /** two-way move_local of a conflict review ("keep local"): the copy replaces the target (target -> trash) */
  review?: boolean;
  /** the target's local snapshot at the decision (checked before it goes to the trash), null = no local file */
  replaceTarget?: { size: number | null; mtimeUs: number | null } | null;
}

export const PRIORITY: Record<string, number> = {
  mkdir: 10,
  move: 20,
  rename: 20,
  move_local: 20,
  conflict_copy: 25,
  verify_content: 35,
  upload_small: 30,
  download: 40,
  upload: 50,
  upload_revision: 50,
  trash_remote: 80,
  trash_local: 85,
  digest_backfill: 90,
  empty_trash: 95,
};

export const SMALL_FILE = 8 * 1024 * 1024;

/** two-way: a folder is removed after the files below it (executor re-checks that it is empty) */
export const PRIORITY_FOLDER_DELETE = { trash_remote: 82, trash_local: 87 } as const;

/**
 * Priority lane: jobs of a pair-scoped interactive run get `priorityFor() - PRIORITY_LANE`, i.e. a
 * negative priority, so the executor (ORDER BY priority, id) picks them before the backlog of a long background run
 * of the same account. Jobs derived from a lane job (follow-ups, self-healing mkdir) stay in the lane.
 */
export const PRIORITY_LANE = 1000;

export const isLanePriority = (priority: number): boolean => priority < 0;

/** priority for a job derived from `parent` (follow-up, parent mkdir, keep-both download): inherits the lane */
export function derivedPriority(parent: { priority: number }, type: JobType, bytes: number | null): number | undefined {
  return isLanePriority(parent.priority) ? priorityFor(type, bytes) - PRIORITY_LANE : undefined;
}

/** moves open (not running) jobs into the priority lane; returns how many changed */
export function boostJobs(db: DatabaseSync, ids: number[]): number {
  let n = 0;
  const st = new Stmts(db).get(
    `UPDATE jobs SET priority = priority - ${PRIORITY_LANE} WHERE id = ? AND priority >= 0 AND state IN ('queued','retry_wait','blocked')`,
  );
  for (const id of ids) n += Number(st.run(id).changes);
  return n;
}

export function priorityFor(type: JobType, bytes: number | null): number {
  if ((type === 'upload' || type === 'upload_revision') && (bytes ?? 0) <= SMALL_FILE) return PRIORITY.upload_small!;
  return PRIORITY[type] ?? 100;
}

export interface NewJob {
  runId: number | null;
  accountId: string;
  pairId: number | null;
  entryId: number | null;
  type: JobType;
  payload: JobPayload | Record<string, unknown>;
  priority?: number;
  bytes?: number | null;
  dedupeKey?: string | null;
  state?: 'queued' | 'blocked';
  maxAttempts?: number;
}

/** Inserts a job unless an open job with the same dedupe key exists. Returns the (new or existing) job id. */
export function insertJob(db: DatabaseSync, j: NewJob, now = Date.now()): { id: number; created: boolean } {
  const st = new Stmts(db);
  const r = st
    .get(
      `INSERT OR IGNORE INTO jobs (run_id, account_id, pair_id, entry_id, type, payload, priority, state, bytes, dedupe_key, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      j.runId,
      j.accountId,
      j.pairId,
      j.entryId,
      j.type,
      JSON.stringify(j.payload),
      j.priority ?? priorityFor(j.type, j.bytes ?? null),
      j.state ?? 'queued',
      j.bytes ?? null,
      j.dedupeKey ?? null,
      j.maxAttempts ?? 8,
      now,
    );
  if (Number(r.changes) > 0) return { id: Number(r.lastInsertRowid), created: true };
  const ex = st.get(`SELECT id FROM jobs WHERE dedupe_key = ? AND state IN ${OPEN_SQL}`).get(j.dedupeKey ?? null) as
    { id: number } | undefined;
  return { id: ex?.id ?? 0, created: false };
}

export function jobDto(r: JobRow): JobDto {
  const iso = (v: number | null) => (v ? new Date(v).toISOString() : null);
  let rel: string | null = null;
  try {
    rel = (JSON.parse(r.payload) as JobPayload).rel ?? null;
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    runId: r.run_id,
    accountId: r.account_id,
    pairId: r.pair_id,
    type: r.type as JobDto['type'],
    state: r.state as JobDto['state'],
    relPath: rel,
    bytes: r.bytes,
    attempts: r.attempts,
    notBefore: iso(r.not_before),
    errorClass: r.error_class as JobDto['errorClass'],
    ...lastError(r.last_error),
    progress: r.state === 'done' ? 1 : null,
    startedAt: iso(r.started_at),
  };
}

/** jobs.last_error: plain text (CLI error) or an encoded daemon message */
function lastError(stored: string | null): Pick<JobDto, 'lastError' | 'lastErrorMsg'> {
  const d = decodeMsg(stored);
  return d.msg ? { lastError: d.text, lastErrorMsg: d.msg } : { lastError: d.text };
}

export function payloadOf(r: JobRow): JobPayload {
  return JSON.parse(r.payload) as JobPayload;
}
