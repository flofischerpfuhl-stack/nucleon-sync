// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Defensive normalisation of GET /v1/status (and SSE `hello`/`status`): every screen can rely on arrays and numbers
 * being present even when a daemon version, a fixture or a half-written profile delivers less. Pure; unit-tested.
 */
import type {
  AccountDto,
  MaintenanceSummaryDto,
  MsgRef,
  PairDto,
  RunDto,
  SettingsDto,
  StatusDto,
} from '@nucleon-sync/shared';

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** list answers: anything but an array becomes [] */
export function asArray<T>(v: readonly T[] | null | undefined): T[];
export function asArray<T = unknown>(v: unknown): T[];
export function asArray<T>(v: unknown): T[] {
  return arr<T>(v);
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
/** a message reference of the service (key + params), or null when malformed */
export function msgRef(v: unknown): MsgRef | null {
  const o = obj(v);
  if (typeof o.key !== 'string') return null;
  const p = obj(o.params);
  const params = Object.fromEntries(
    Object.entries(p).filter(([, x]) => typeof x === 'string' || typeof x === 'number'),
  ) as MsgRef['params'];
  return o.params !== undefined ? { key: o.key, params } : { key: o.key };
}

function account(raw: unknown): AccountDto | null {
  const a = obj(raw);
  if (typeof a.id !== 'string') return null;
  const w = obj(a.workers);
  return {
    id: a.id,
    displayName: str(a.displayName, a.id),
    email: strOrNull(a.email),
    status: (str(a.status, 'error') as AccountDto['status']) || 'error',
    lastError: strOrNull(a.lastError),
    ...(msgRef(a.lastErrorMsg) ? { lastErrorMsg: msgRef(a.lastErrorMsg) } : {}),
    lastOkAt: strOrNull(a.lastOkAt),
    credentialBackend: str(a.credentialBackend, 'keyring-shim') as AccountDto['credentialBackend'],
    workers: { configured: num(w.configured), active: num(w.active) },
    paused: !!a.paused,
    ...(Array.isArray(a.activeRunIds)
      ? { activeRunIds: arr<number>(a.activeRunIds).filter((x) => typeof x === 'number') }
      : {}),
    ...(Array.isArray(a.queuedRunIds)
      ? { queuedRunIds: arr<number>(a.queuedRunIds).filter((x) => typeof x === 'number') }
      : {}),
  };
}

function pair(raw: unknown): PairDto | null {
  const p = obj(raw);
  if (typeof p.id !== 'number' || typeof p.accountId !== 'string') return null;
  const brake = obj(p.brake);
  return {
    id: p.id,
    accountId: p.accountId,
    name: str(p.name, `#${p.id}`),
    localRoot: str(p.localRoot),
    remoteRoot: str(p.remoteRoot),
    direction: str(p.direction, 'backup') as PairDto['direction'],
    enabled: p.enabled !== false,
    paused: !!p.paused,
    counts: obj(p.counts) as PairDto['counts'],
    bytesTracked: num(p.bytesTracked),
    lastRunAt: strOrNull(p.lastRunAt),
    lastFullAt: strOrNull(p.lastFullAt),
    brake:
      typeof brake.reason === 'string'
        ? {
            reason: brake.reason,
            at: str(brake.at),
            ...(msgRef(brake.reasonMsg) ? { reasonMsg: msgRef(brake.reasonMsg) } : {}),
          }
        : null,
    options: pairOpts(p.options),
    // two-way (additive; absent from older daemons)
    lastRemoteCheckAt: strOrNull(p.lastRemoteCheckAt),
    heldDeletions: num(p.heldDeletions),
    ownedElsewhere: arr<Record<string, unknown>>(p.ownedElsewhere)
      .map(obj)
      .filter((o) => typeof o.relPath === 'string' && typeof o.pairId === 'number')
      .map((o) => ({ relPath: o.relPath as string, pairId: o.pairId as number, pairName: str(o.pairName) })),
  };
}

function pairOpts(raw: unknown): NonNullable<PairDto['options']> {
  const o = obj(raw);
  const out: NonNullable<PairDto['options']> = {};
  if (o.remoteChanges === 'download' || o.remoteChanges === 'conflict') out.remoteChanges = o.remoteChanges;
  if (o.remoteDeletions === 'reupload' || o.remoteDeletions === 'ask') out.remoteDeletions = o.remoteDeletions;
  if (o.uploadLocalNew === true) out.uploadLocalNew = true;
  if (typeof o.uploadLocalNewSince === 'number') out.uploadLocalNewSince = o.uploadLocalNewSince;
  for (const k of ['remoteCheckMinutes', 'massDeleteMaxFiles', 'massDeletePercent'] as const)
    if (typeof o[k] === 'number') out[k] = o[k];
  if (o.twoWayAdoption === true) out.twoWayAdoption = true;
  return out;
}

function run(raw: unknown): RunDto | null {
  const r = obj(raw);
  if (typeof r.id !== 'number' || typeof r.startedAt !== 'string') return null;
  const c = obj(r.counters);
  return {
    ...(r as unknown as RunDto),
    counters: {
      scannedLocal: num(c.scannedLocal),
      listedRemoteFolders: num(c.listedRemoteFolders),
      uploaded: num(c.uploaded),
      uploadedBytes: num(c.uploadedBytes),
      downloaded: num(c.downloaded),
      downloadedBytes: num(c.downloadedBytes),
      moved: num(c.moved),
      adopted: num(c.adopted),
      conflicts: num(c.conflicts),
      pendingDeletions: num(c.pendingDeletions),
      errors: num(c.errors),
    },
  };
}

export function normalizeStatus(raw: unknown): StatusDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const q = obj(s.queue);
  const rate = obj(s.rate);
  return {
    apiVersion: 'v1',
    daemonVersion: str(s.daemonVersion, '?'),
    pid: num(s.pid),
    startedAt: str(s.startedAt),
    mode: s.mode === 'mock' ? 'mock' : 'production',
    state: (str(s.state, 'idle') as StatusDto['state']) || 'idle',
    paused: !!s.paused,
    currentRun: run(s.currentRun),
    // several active runs; older daemons only report currentRun
    activeRuns: Array.isArray(s.activeRuns)
      ? arr(s.activeRuns)
          .map(run)
          .filter((x): x is RunDto => x !== null)
      : run(s.currentRun)
        ? [run(s.currentRun)!]
        : [],
    queuedRuns: arr(s.queuedRuns)
      .map(run)
      .filter((x): x is RunDto => x !== null),
    lastRun: run(s.lastRun),
    nextRuns: arr<{ mode: StatusDto['nextRuns'][number]['mode']; at: unknown }>(s.nextRuns)
      .filter((r) => r && typeof r.at === 'string')
      .map((r) => ({
        mode: r.mode === 'full' ? 'full' : r.mode === 'verify' ? 'verify' : 'incremental',
        at: r.at as string,
      })),
    accounts: arr(s.accounts)
      .map(account)
      .filter((x): x is AccountDto => x !== null),
    pairs: arr(s.pairs)
      .map(pair)
      .filter((x): x is PairDto => x !== null),
    queue: {
      queued: num(q.queued),
      running: num(q.running),
      retryWait: num(q.retryWait),
      failed: num(q.failed),
      blocked: num(q.blocked),
    },
    openConflicts: num(s.openConflicts),
    pendingDeletions: num(s.pendingDeletions),
    rate: {
      uploadBps: num(rate.uploadBps),
      downloadBps: num(rate.downloadBps),
      metaLatencyMsEwma: typeof rate.metaLatencyMsEwma === 'number' ? rate.metaLatencyMsEwma : null,
    },
    ...(s.pausedUntil !== undefined ? { pausedUntil: strOrNull(s.pausedUntil) } : {}),
    ...(transfers(s.transfers) ? { transfers: transfers(s.transfers)! } : {}),
  };
}

function backlog(raw: unknown): NonNullable<StatusDto['transfers']>['upload'] {
  const b = obj(raw);
  return {
    files: num(b.files),
    bytes: num(b.bytes),
    bytesDone: num(b.bytesDone),
    rateBps: typeof b.rateBps === 'number' ? b.rateBps : null,
    etaSeconds: typeof b.etaSeconds === 'number' ? b.etaSeconds : null,
    blockedFiles: num(b.blockedFiles),
    blockedBytes: num(b.blockedBytes),
  };
}

/** live transfers + backlog/ETA (daemons >= 0.2); absent in older daemons */
export function transfers(raw: unknown): StatusDto['transfers'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  return {
    active: arr<Record<string, unknown>>(t.active)
      .filter((a) => a && typeof a.bytesTotal === 'number' && (a.kind === 'upload' || a.kind === 'download'))
      .map((a) => ({
        jobIds: arr<number>(a.jobIds),
        accountId: str(a.accountId),
        pairId: typeof a.pairId === 'number' ? a.pairId : null,
        kind: a.kind as 'upload' | 'download',
        relPath: strOrNull(a.relPath),
        files: num(a.files, 1),
        bytesDone: num(a.bytesDone),
        bytesTotal: num(a.bytesTotal),
        startedAt: str(a.startedAt),
        rateBps: typeof a.rateBps === 'number' ? a.rateBps : null,
        etaSeconds: typeof a.etaSeconds === 'number' ? a.etaSeconds : null,
        source: (['fd', 'io', 'staging'].includes(str(a.source)) ? a.source : 'estimate') as 'fd',
      })),
    upload: backlog(t.upload),
    download: backlog(t.download),
  };
}

/** GET /v1/settings merged over the defaults (missing sections/fields of older daemons or partial answers). */
export function normalizeSettings(raw: unknown, defaults: SettingsDto): SettingsDto {
  const s = obj(raw);
  const sched = obj(s.schedule);
  const fw = obj(sched.fullWeekly);
  return {
    schedule: {
      ...defaults.schedule,
      ...(sched as Partial<SettingsDto['schedule']>),
      fullWeekly: { ...defaults.schedule.fullWeekly, ...(fw as Partial<SettingsDto['schedule']['fullWeekly']>) },
    } as SettingsDto['schedule'],
    transfer: { ...defaults.transfer, ...(obj(s.transfer) as Partial<SettingsDto['transfer']>) },
    notifications: {
      ...defaults.notifications,
      ...(obj(s.notifications) as Partial<SettingsDto['notifications']>),
      telegram: {
        ...defaults.notifications.telegram,
        ...(obj(obj(s.notifications).telegram) as Partial<SettingsDto['notifications']['telegram']>),
      },
    },
    storagePoolBytes: typeof s.storagePoolBytes === 'number' ? s.storagePoolBytes : null,
    globalExcludes: Array.isArray(s.globalExcludes)
      ? (s.globalExcludes as SettingsDto['globalExcludes'])
      : defaults.globalExcludes,
  };
}

/** GET /v1/maintenance/summary with missing lists/backfill tolerated */
export function normalizeMaintenance(raw: unknown): MaintenanceSummaryDto {
  const m = obj(raw);
  const bf = obj(m.backfill);
  return {
    digestMissing: arr<MaintenanceSummaryDto['digestMissing'][number]>(m.digestMissing).filter(
      (x) => x && typeof x.accountId === 'string',
    ),
    trash: arr<MaintenanceSummaryDto['trash'][number]>(m.trash).filter((x) => x && typeof x.accountId === 'string'),
    backfill:
      typeof bf.runId === 'number'
        ? {
            runId: bf.runId,
            pairId: num(bf.pairId),
            relPrefix: strOrNull(bf.relPrefix),
            done: num(bf.done),
            total: num(bf.total),
          }
        : null,
  };
}
