// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Route table of the local API (ARCHITECTURE §6, §21). `perm` = minimum permission: `read` (every token), `sync`,
 * `manage`, `destructive` (agent token scopes) or `ui` (UI token only). The UI token has every permission.
 * Destructive routes call `confirm.require(...)` (409 + ConfirmRequiredResponse first); for agent tokens every
 * `destructive` route and every confirm step additionally waits for the user's approval (api/confirm.ts).
 * Confirm summaries are English and carry `kind` + `params` so the dashboard can show them in its own language.
 */
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import { refOf } from '@nucleon-sync/shared';
import type {
  ActivityItem,
  ConflictResolution,
  CreatePairRequest,
  DecideDeletionsRequest,
  DeletionDecision,
  JobDto,
  NotificationConfigDto,
  PatchPairRequest,
  RunMode,
  SyncRequest,
  RoutePermission,
  SyncResponse,
  TokenScope,
  WhoAmIDto,
} from '@nucleon-sync/shared';

import { PLAIN_CLI_SECRET } from '../accounts/context.ts';
import { maintenanceSummary } from '../accounts/maintenance.ts';
import type { ActivityFilter, EngineApi } from '../engine/api.ts';
import { badRequest, conflict, HttpError, notFound } from '../util/http.ts';
import { rotateToken } from '../util/token.ts';
import type { AgentTokens, Principal } from './agentTokens.ts';
import type { ConfirmManager, ConfirmSummary } from './confirm.ts';
import type { Services } from './services.ts';

export const NOT_IMPLEMENTED = Symbol('501');

export interface RouteCtx {
  req: IncomingMessage;
  url: URL;
  body: unknown;
  params: string[];
  scope: TokenScope;
  /** the authenticated caller (UI token or a named agent token) */
  principal: Principal;
  /** set by the server when an agent's destructive request was approved by the user before the handler ran */
  preApproved?: boolean;
  method: string;
  path: string;
}

/** Confirm summary with a stable `kind` + `params` (the dashboard translates known kinds; agents read the text). */
export type Summary = ConfirmSummary & { kind: string; params: Record<string, string | number> };

export interface Route {
  method: string;
  pattern: RegExp;
  perm: RoutePermission;
  handler: (ctx: RouteCtx) => unknown;
  /** what a destructive request does (agents: shown in the approval dialog before the handler runs) */
  summary?: (ctx: RouteCtx) => Summary;
}

const ACTIONS: ActivityItem['action'][] = [
  'uploaded',
  'new_revision',
  'downloaded',
  'moved',
  'renamed',
  'trashed_remote',
  'trashed_local',
  'adopted',
  'skipped',
  'conflict',
  'deletion_pending',
  'error',
  'info',
];
const RESOLUTIONS: ConflictResolution[] = ['keep_local', 'keep_remote', 'keep_both', 'ignore'];
const DECISIONS: DeletionDecision[] = [
  'trash_remote',
  'restore_local',
  'keep_remote_only',
  'trash_local',
  'restore_remote',
];
const MODES: RunMode[] = ['incremental', 'full', 'verify'];
const JOB_STATES: JobDto['state'][] = ['queued', 'running', 'done', 'failed', 'retry_wait', 'blocked', 'cancelled'];
const GB = 1024 ** 3;

const obj = (b: unknown): Record<string, unknown> => {
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw badRequest('body must be a JSON object');
  return b as Record<string, unknown>;
};
const intParam = (v: string | null, def: number, min: number, max: number): number => {
  if (v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw badRequest(`bad number ${v}`);
  return Math.min(n, max);
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const fmtBytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Maps plain engine errors ("unknown pair", "not found or already resolved", refusals) to HTTP errors. */
function engineCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const m = (e as Error).message;
    if (/unknown|not found|no longer exists/i.test(m)) throw notFound(m);
    if (/not possible|already|refused|blocked|disabled/i.test(m)) throw conflict(m);
    throw e;
  }
}

export function buildRoutes(o: {
  engine: EngineApi;
  services: Services;
  confirm: ConfirmManager;
  tokens: { ui: string; agent: string | null };
  agentTokens: AgentTokens;
}): Route[] {
  const { engine: e, services: s, confirm, agentTokens } = o;
  const routes: Route[] = [];
  const add = (
    method: string,
    pattern: RegExp,
    perm: RoutePermission,
    handler: Route['handler'],
    summary?: Route['summary'],
  ) => routes.push({ method, pattern, perm, handler, ...(summary ? { summary } : {}) });
  /** confirm step; agents: user approval (skipped when the server already obtained it for this request) */
  const need = (c: RouteCtx, summary: () => ConfirmSummary) => {
    if (c.preApproved) return;
    confirm.require(c.method, c.path, c.body, summary, c.principal);
  };
  const isAgent = (c: RouteCtx) => c.principal.scope === 'agent';
  /**
   * confirm step of something that trashes or deletes inside a `manage` route (deletion decisions, conflict
   * resolutions, approving held deletions): agents additionally need the `destructive` scope (403 before any approval
   * is created), then the user's approval like every destructive request
   */
  const needDestructive = (c: RouteCtx, summary: () => Summary) => {
    if (isAgent(c) && !c.principal.permissions.includes('destructive'))
      throw new HttpError(
        403,
        'forbidden',
        `the agent token "${c.principal.name}" lacks the scope "destructive" (Settings → Agents → create a token with that scope)`,
        { needs: 'destructive' },
      );
    need(c, summary);
  };
  /** actor recorded in the state DB / activity (schema: 'ui' | 'api:<client>') */
  const by = (c: RouteCtx) => (c.principal.scope === 'agent' ? `api:${c.principal.name}` : 'ui');
  const pairId = (c: RouteCtx) => {
    const id = Number(c.params[0]);
    s.pairs.require(id);
    return id;
  };
  const accountByName = (id: string) => s.accounts.require(id);

  // ------------------------------------------------------------------ status, events, runs, activity
  add('GET', /^\/v1\/health$/, 'read', () => ({ ok: true, apiVersion: 'v1' }));
  add('GET', /^\/v1\/status$/, 'read', () => ({ ...e.status(), pausedUntil: s.pauses.globalUntil() }));
  add('GET', /^\/v1\/whoami$/, 'read', ({ principal }): WhoAmIDto => ({
    scope: principal.scope,
    tokenId: principal.tokenId,
    name: principal.name,
    permissions: principal.permissions,
    approvalRequired: principal.scope === 'agent' ? ['destructive'] : [],
  }));
  add(
    'GET',
    /^\/v1\/runs$/,
    'read',
    ({ url }) => e.runs?.(intParam(url.searchParams.get('limit'), 50, 1, 1000)) ?? NOT_IMPLEMENTED,
  );
  add('GET', /^\/v1\/runs\/(\d+)$/, 'read', ({ params }) => {
    if (!e.runById) return NOT_IMPLEMENTED;
    const r = e.runById(Number(params[0]));
    if (!r) throw notFound(`run ${params[0]} not found`);
    return r;
  });
  add('GET', /^\/v1\/jobs$/, 'read', ({ url }) => {
    const state = url.searchParams.get('state');
    if (state && !JOB_STATES.includes(state as JobDto['state']))
      throw badRequest(`state must be one of ${JOB_STATES.join(', ')}`);
    return e.jobs
      ? e.jobs({
          state: (state as JobDto['state']) || undefined,
          limit: intParam(url.searchParams.get('limit'), 200, 1, 5000),
        })
      : NOT_IMPLEMENTED;
  });
  add('GET', /^\/v1\/activity$/, 'read', ({ url }) => {
    const q = url.searchParams;
    const filter: ActivityFilter = {};
    if (q.get('account')) filter.accountId = q.get('account')!;
    if (q.get('pair')) filter.pairId = intParam(q.get('pair'), 0, 1, Number.MAX_SAFE_INTEGER);
    if (q.get('action')) {
      const acts = q.get('action')!.split(',').filter(Boolean);
      const bad = acts.filter((a) => !ACTIONS.includes(a as ActivityItem['action']));
      if (bad.length) throw badRequest(`unknown action(s): ${bad.join(', ')}`);
      filter.actions = acts as ActivityItem['action'][];
    }
    if (q.get('since')) {
      if (!Number.isFinite(Date.parse(q.get('since')!))) throw badRequest('since must be an ISO timestamp');
      filter.since = q.get('since')!;
    }
    if (q.get('q')) filter.q = q.get('q')!.slice(0, 200);
    const before = q.get('before') ? intParam(q.get('before'), 0, 1, Number.MAX_SAFE_INTEGER) : undefined;
    return e.activity(intParam(q.get('limit'), 100, 1, 5000), before, filter);
  });
  add('POST', /^\/v1\/sync$/, 'sync', ({ body }) => {
    const b = obj(body) as SyncRequest;
    if (b.accountId !== undefined) accountByName(String(b.accountId));
    if (b.pairId !== undefined) s.pairs.require(Number(b.pairId));
    if (b.mode !== undefined && !MODES.includes(b.mode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);
    const notRunnable = e.syncBlocker?.(b) ?? null;
    const writesBlocked = e.writeGuard?.() ?? null;
    const msgs = {
      ...(notRunnable && e.syncBlockerMsg ? { notRunnableMsg: refOf(e.syncBlockerMsg(b)) } : {}),
      ...(writesBlocked && e.writeGuardMsg ? { writesBlockedMsg: refOf(e.writeGuardMsg()) } : {}),
    };
    if (e.requestSyncTicket) {
      // runs of other accounts never delay this request; a busy lane gives a queued run id
      const t = e.requestSyncTicket(b, 'api');
      const res: SyncResponse = {
        runId: t.runIds[0]!,
        followUp: t.followUp,
        runIds: t.runIds,
        queuedBehind: t.queuedBehind,
        notRunnable,
        writesBlocked,
        ...msgs,
      };
      return res;
    }
    const followUp = !!e.status().currentRun;
    const res: SyncResponse = { runId: e.requestSync(b, 'api'), followUp, notRunnable, writesBlocked, ...msgs };
    return res;
  });
  add('POST', /^\/v1\/pause$/, 'sync', ({ body }) => {
    const req = s.pauses.validate(body ?? { scope: 'all' });
    e.pause(req);
    s.pauses.set(req);
    return { ok: true, until: req.until ?? null };
  });
  add('POST', /^\/v1\/resume$/, 'sync', ({ body }) => {
    const req = s.pauses.validate(body ?? { scope: 'all' });
    e.resume(req);
    s.pauses.clear(req);
    return { ok: true };
  });

  // ------------------------------------------------------------------ accounts
  add('GET', /^\/v1\/accounts$/, 'read', () => e.accounts());
  add('GET', /^\/v1\/accounts\/([^/]+)$/, 'read', ({ params }) => s.accounts.dto(params[0]!));
  add('POST', /^\/v1\/accounts$/, 'manage', ({ body }) => s.accounts.create(obj(body) as never));
  add('PATCH', /^\/v1\/accounts\/([^/]+)$/, 'manage', ({ params, body }) => s.accounts.patch(params[0]!, obj(body)));
  const removeAccountSummary = (c: RouteCtx): Summary => {
    const a = accountByName(c.params[0]!);
    return {
      kind: 'account.remove',
      params: { name: a.display_name, id: a.id },
      title: `Remove account "${a.display_name}"`,
      items: 1,
      bytes: 0,
      details: ['The profile is removed from the app. The session in the keyring stays (log out first).'],
    };
  };
  add(
    'DELETE',
    /^\/v1\/accounts\/([^/]+)$/,
    'destructive',
    async (c) => {
      const a = accountByName(c.params[0]!);
      need(c, () => removeAccountSummary(c));
      await s.accounts.remove(a.id);
      return { ok: true };
    },
    removeAccountSummary,
  );
  add('POST', /^\/v1\/accounts\/([^/]+)\/login$/, 'manage', ({ params }) => s.accounts.startLogin(params[0]!));
  add(
    'DELETE',
    /^\/v1\/accounts\/([^/]+)\/login$/,
    'manage',
    ({ params }) => (s.accounts.cancelLogin(params[0]!), { ok: true }),
  );
  const logoutSummary = (c: RouteCtx): Summary => {
    const a = accountByName(c.params[0]!);
    const shared = a.secret_service === PLAIN_CLI_SECRET.service;
    return {
      kind: 'account.logout',
      params: { name: a.display_name, id: a.id, shared: shared ? 1 : 0 },
      title: `Log out ${a.display_name}`,
      items: 1,
      bytes: 0,
      details: [
        'The stored Proton session is deleted; syncing this account stops until the next login.',
        ...(shared
          ? ['Note: the session is shared with the Proton CLI – manual proton-drive calls are logged out as well.']
          : []),
      ],
    };
  };
  add(
    'DELETE',
    /^\/v1\/accounts\/([^/]+)\/session$/,
    'destructive',
    async (c) => {
      const a = accountByName(c.params[0]!);
      need(c, () => logoutSummary(c));
      await s.accounts.logout(a.id);
      return { ok: true };
    },
    logoutSummary,
  );
  add('POST', /^\/v1\/accounts\/([^/]+)\/cli$/, 'sync', ({ params, body, scope }) =>
    s.accounts.cli(params[0]!, obj(body) as never, scope),
  );

  // ------------------------------------------------------------------ storage
  add('GET', /^\/v1\/storage$/, 'read', () => s.storage.pool());
  add('GET', /^\/v1\/storage\/history$/, 'read', ({ url }) =>
    s.storage.history(intParam(url.searchParams.get('days'), 90, 1, 3650)),
  );
  add('POST', /^\/v1\/storage\/measure$/, 'sync', async ({ body }) => {
    const b = obj(body);
    const ids = b.accountId
      ? [String(b.accountId)]
      : s.accounts
          .rows()
          .filter((a) => a.status === 'ok')
          .map((a) => a.id);
    // `wait: false` (UI): start in the background, answer at once; progress via SSE `storage` + `measuring`
    if (b.wait === false)
      return { ...s.storage.pool(), ...s.storage.measureInBackground(ids), measuring: s.storage.measuring() };
    for (const id of ids) await s.storage.measure(id);
    return s.storage.pool();
  });
  add('GET', /^\/v1\/accounts\/([^/]+)\/storage$/, 'read', ({ params }) => s.storage.account(params[0]!));

  // ------------------------------------------------------------------ pairs
  add('GET', /^\/v1\/pairs$/, 'read', () => e.pairs());
  add('POST', /^\/v1\/pairs\/preview$/, 'manage', ({ body }) =>
    s.pairs.preview(obj(body) as unknown as CreatePairRequest),
  );
  add('POST', /^\/v1\/pairs$/, 'manage', ({ body }) => s.pairs.create(obj(body) as unknown as CreatePairRequest));
  add('GET', /^\/v1\/pairs\/(\d+)$/, 'read', (c) => s.pairs.dto(pairId(c)));
  add('PATCH', /^\/v1\/pairs\/(\d+)$/, 'manage', async (c) => {
    const id = pairId(c);
    const b = obj(c.body) as PatchPairRequest;
    const p = s.pairs.require(id);
    if (b.direction !== undefined && b.direction !== p.direction) {
      const st = s.pairs.entryStats(id);
      if (st.entries > 0 || isAgent(c))
        need(c, () => ({
          kind: 'pair.direction',
          params: { name: p.name, from: p.direction, to: String(b.direction) },
          title: `Change the direction of "${p.name}": ${p.direction} → ${b.direction}`,
          items: st.entries,
          bytes: st.bytes,
          details: [
            b.direction === 'mirror-down'
              ? 'Mirror: files deleted in Proton go to the local trash from now on, local edits become conflicts.'
              : b.direction === 'upload-only'
                ? 'Upload only: nothing is downloaded any more, deletions are ignored.'
                : b.direction === 'two-way'
                  ? 'Two-way: changes and deletions go both ways from now on (deletions into the trash of the other side). An adoption run comes first: identical files are only recorded and nothing is deleted.'
                  : b.direction === 'backup'
                    ? 'Backup: local leads, files that only exist in Proton are downloaded.'
                    : `New direction: ${b.direction}.`,
          ],
        }));
    }
    return s.pairs.patch(id, b);
  });
  const removePairSummary = (c: RouteCtx): Summary => {
    const id = pairId(c);
    const p = s.pairs.require(id);
    const st = s.pairs.entryStats(id);
    return {
      kind: 'pair.remove',
      params: { name: p.name, local: p.local_root, remote: p.remote_root },
      title: `Remove pair "${p.name}"`,
      items: st.entries,
      bytes: st.bytes,
      details: [
        `${p.local_root} ⇄ ${p.remote_root}`,
        'Only the sync state is deleted – files stay untouched locally and in Proton.',
      ],
    };
  };
  add(
    'DELETE',
    /^\/v1\/pairs\/(\d+)$/,
    'destructive',
    async (c) => {
      const id = pairId(c);
      need(c, () => removePairSummary(c));
      await s.pairs.remove(id);
      return { ok: true };
    },
    removePairSummary,
  );
  add('GET', /^\/v1\/pairs\/(\d+)\/tree$/, 'read', (c) =>
    e.tree ? engineCall(() => e.tree!(pairId(c), c.url.searchParams.get('path') ?? '')) : NOT_IMPLEMENTED,
  );
  add('GET', /^\/v1\/pairs\/(\d+)\/rules$/, 'read', (c) => s.pairs.rules(pairId(c)));
  add('PUT', /^\/v1\/pairs\/(\d+)\/rules$/, 'manage', (c) => {
    const id = pairId(c);
    const rules = s.pairs.validateRules(id, c.body);
    return e.setRules ? (engineCall(() => e.setRules!(id, rules)), { ok: true }) : NOT_IMPLEMENTED;
  });
  const brakeSummary = (c: RouteCtx): Summary => {
    const id = pairId(c);
    const p = e.pairs().find((x) => x.id === id)!;
    if (!p.brake) throw conflict(`pair ${p.name} has no active safety brake`);
    return {
      kind: 'pair.releaseBrake',
      params: { name: p.name, reason: p.brake.reason },
      title: `Release the safety brake of "${p.name}"`,
      items: 1,
      bytes: 0,
      details: [
        p.brake.reason,
        'The next run treats missing files as deleted (→ pending deletions; nothing is deleted automatically).',
      ],
    };
  };
  add(
    'POST',
    /^\/v1\/pairs\/(\d+)\/release-brake$/,
    'destructive',
    (c) => {
      const id = pairId(c);
      if (!e.releaseBrake) return NOT_IMPLEMENTED;
      brakeSummary(c); // 409 when there is no brake
      need(c, () => brakeSummary(c));
      engineCall(() => e.releaseBrake!(id, by(c)));
      return { ok: true };
    },
    brakeSummary,
  );

  // ------------------------------------------------------------------ remote browser
  add('GET', /^\/v1\/remote\/([^/]+)\/browse$/, 'manage', ({ params, url }) =>
    s.pairs.browse(params[0]!, url.searchParams.get('path') ?? '/'),
  );

  // ------------------------------------------------------------------ conflicts, deletions, adoptions
  add('GET', /^\/v1\/conflicts$/, 'read', () => e.conflicts?.() ?? NOT_IMPLEMENTED);
  add('POST', /^\/v1\/conflicts\/(\d+)\/resolve$/, 'manage', (c) => {
    if (!e.resolveConflict || !e.conflicts) return NOT_IMPLEMENTED;
    const id = Number(c.params[0]);
    const resolution = obj(c.body).resolution as ConflictResolution;
    if (!RESOLUTIONS.includes(resolution)) throw badRequest(`resolution must be one of ${RESOLUTIONS.join(', ')}`);
    const cf = e.conflicts().find((x) => x.id === id);
    if (!cf) throw notFound(`conflict ${id} not found or already resolved`);
    const pair = e.pairs().find((p) => p.id === cf.pairId);
    const mirror = pair?.direction === 'mirror-down';
    // two-way review items: both versions exist already; keep_local / keep_remote put one of them into the trash
    if (cf.keptBoth && (resolution === 'keep_local' || resolution === 'keep_remote')) {
      const copy = cf.keptBoth.copyRelPath;
      const summary: Summary | null = copy
        ? resolution === 'keep_local'
          ? {
              kind: 'conflict.reviewKeepLocal',
              params: { path: cf.relPath, copy },
              title: `Clean up conflict: ${cf.relPath}`,
              items: 1,
              bytes: cf.local?.size ?? 0,
              details: [
                `The local version ("${copy}") replaces "${cf.relPath}"; the Proton version goes to the trash, Proton gets a new revision and the copy is deleted (trash).`,
              ],
            }
          : {
              kind: 'conflict.reviewKeepRemote',
              params: { path: cf.relPath, copy },
              title: `Clean up conflict: ${cf.relPath}`,
              items: 1,
              bytes: cf.local?.size ?? 0,
              details: [`The copy "${copy}" (local version) goes to the trash locally and in Proton.`],
            }
        : (cf.kind === 'remote_changed_local_deleted') === (resolution === 'keep_local')
          ? {
              kind: 'conflict.reviewDelete',
              params: { path: cf.relPath },
              title: `Delete after all: ${cf.relPath}`,
              items: 1,
              bytes: cf.local?.size ?? cf.remote?.size ?? 0,
              details: [`"${cf.relPath}" is deleted after all (into the trash locally and in Proton).`],
            }
          : null;
      if (summary) needDestructive(c, () => summary);
      engineCall(() => e.resolveConflict!(id, resolution, by(c)));
      return { ok: true };
    }
    // destructive: the local file goes to the trash (keep_remote) or the Proton copy goes to the Proton trash (keep_local)
    if (resolution === 'keep_remote' && cf.local && !mirror)
      needDestructive(c, () => ({
        kind: 'conflict.keepRemote',
        params: { path: cf.relPath },
        title: `"Keep Proton version": ${cf.relPath}`,
        items: 1,
        bytes: cf.local!.size,
        details: ['The local file is replaced by the Proton version (old local version → trash).'],
      }));
    if (resolution === 'keep_local' && !cf.local && cf.remote)
      needDestructive(c, () => ({
        kind: 'conflict.keepLocalMissing',
        params: { path: cf.relPath },
        title: `"Keep local version": ${cf.relPath}`,
        items: 1,
        bytes: cf.remote!.size,
        details: ['The file is missing locally: the Proton copy is moved to the Proton trash.'],
      }));
    engineCall(() => e.resolveConflict!(id, resolution, by(c)));
    return { ok: true };
  });
  add('GET', /^\/v1\/deletions$/, 'read', () => e.deletions?.() ?? NOT_IMPLEMENTED);
  add('POST', /^\/v1\/deletions\/decide$/, 'manage', (c) => {
    if (!e.decideDeletions || !e.deletions) return NOT_IMPLEMENTED;
    const b = obj(c.body) as unknown as DecideDeletionsRequest;
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.some((x) => !Number.isInteger(x)))
      throw badRequest('ids must be a non-empty integer array');
    if (!DECISIONS.includes(b.decision)) throw badRequest(`decision must be one of ${DECISIONS.join(', ')}`);
    if (b.decision === 'trash_remote' || b.decision === 'trash_local') {
      const set = new Set(b.ids);
      const sel = e.deletions().filter((d) => set.has(d.id));
      const bytes = sel.reduce((t, d) => t + d.size, 0);
      const remote = b.decision === 'trash_remote';
      // agents: every trashing decision needs the `destructive` scope and the user's approval; the UI only confirms
      // big selections
      if (sel.length > 100 || bytes > GB || isAgent(c))
        needDestructive(c, () => ({
          kind: remote ? 'deletions.trashRemote' : 'deletions.trashLocal',
          params: { count: sel.length, size: fmtBytes(bytes), more: Math.max(0, sel.length - 20) },
          title: remote ? `Delete ${sel.length} files in Proton (trash)` : `Delete ${sel.length} files locally (trash)`,
          items: sel.length,
          bytes,
          details: [
            remote
              ? `${fmtBytes(bytes)} are moved to the Proton trash.`
              : `${fmtBytes(bytes)} are moved to the local trash.`,
            ...sel.slice(0, 20).map((d) => d.relPath),
            ...(sel.length > 20 ? [`… and ${sel.length - 20} more`] : []),
          ],
        }));
    }
    const r = engineCall(() => e.decideDeletions!({ ids: b.ids, decision: b.decision }, by(c)));
    return { ok: true, ...r };
  });
  // two-way mass-delete guard: approve (carry out) or deny (restore) all held deletions of a pair.
  // Deny only restores (manage); approve trashes on both sides: `destructive` scope + the user's approval for agents,
  // a confirm step for the UI.
  const heldSummary = (c: RouteCtx): Summary => {
    const id = pairId(c);
    const p = s.pairs.require(id);
    const held = e.deletions!().filter((d) => d.pairId === id && d.held);
    const local = held.filter((d) => d.side !== 'remote');
    const remote = held.filter((d) => d.side === 'remote');
    return {
      kind: 'pair.heldDeletions',
      params: { name: p.name, count: held.length, local: local.length, remote: remote.length },
      title: `Carry out ${plural(held.length, 'held deletion')} in "${p.name}"`,
      items: held.length,
      bytes: held.reduce((t, d) => t + d.size, 0),
      details: [
        ...(local.length ? [`${plural(local.length, 'file')} deleted here → Proton trash`] : []),
        ...(remote.length ? [`${plural(remote.length, 'file')} deleted in Proton → local trash`] : []),
        ...held.slice(0, 20).map((d) => d.relPath),
        ...(held.length > 20 ? [`… and ${held.length - 20} more`] : []),
      ],
    };
  };
  add('POST', /^\/v1\/pairs\/(\d+)\/held-deletions$/, 'manage', (c) => {
    const id = pairId(c);
    if (!e.decideHeld || !e.deletions) return NOT_IMPLEMENTED;
    const b = obj(c.body) as { approve?: unknown };
    if (typeof b.approve !== 'boolean') throw badRequest('approve must be boolean');
    const p = s.pairs.require(id);
    if (!e.deletions().some((d) => d.pairId === id && d.held)) throw conflict(`pair ${p.name} has no held deletions`);
    if (b.approve) needDestructive(c, () => heldSummary(c));
    const r = engineCall(() => e.decideHeld!(id, b.approve as boolean, by(c)));
    return { ok: true, ...r };
  });
  add('GET', /^\/v1\/adoptions$/, 'read', () => e.adoptions?.() ?? NOT_IMPLEMENTED);
  add('POST', /^\/v1\/adoptions\/decide$/, 'manage', (c) => {
    const b = obj(c.body) as { ids: number[]; accept: boolean };
    if (!Array.isArray(b.ids) || b.ids.some((x) => !Number.isInteger(x)))
      throw badRequest('ids must be an integer array');
    if (typeof b.accept !== 'boolean') throw badRequest('accept must be boolean');
    return e.decideAdoptions ? (e.decideAdoptions(b.ids, b.accept, by(c)), { ok: true }) : NOT_IMPLEMENTED;
  });

  // ------------------------------------------------------------------ settings, doctor, notifications, tokens
  add('GET', /^\/v1\/settings$/, 'read', () => s.settings.get());
  add('PUT', /^\/v1\/settings$/, 'manage', ({ body }) => s.settings.put(body));
  add('GET', /^\/v1\/doctor$/, 'read', () => s.doctor({ reachable: true, detail: 'API reachable' }));
  add('GET', /^\/v1\/notifications$/, 'read', ({ url }) =>
    s.notifier.log(intParam(url.searchParams.get('limit'), 50, 1, 500)),
  );
  add('GET', /^\/v1\/notifications\/config$/, 'read', () => {
    const argv = s.ctx.config.notifyCommand ?? [];
    return {
      command: { configured: argv.length > 0, program: argv[0] ? path.basename(argv[0]) : null },
    } satisfies NotificationConfigDto;
  });
  add('POST', /^\/v1\/notifications\/test$/, 'ui', async ({ body }) => {
    const ch = (obj(body ?? {}) as { channel?: unknown }).channel;
    if (ch !== undefined && ch !== 'command') throw badRequest('channel must be command (or left out)');
    return s.notifier.test(ch);
  });
  add('GET', /^\/v1\/tokens\/agent$/, 'ui', () => ({ file: s.ctx.paths.agentTokenFile, token: o.tokens.agent ?? '' }));
  add('POST', /^\/v1\/tokens\/agent\/rotate$/, 'ui', (c) => {
    need(c, () => ({
      kind: 'token.rotate',
      params: { name: 'default' },
      title: 'Rotate the agent token "default"',
      items: 1,
      bytes: 0,
      details: ['Agents using the old token lose access immediately.'],
    }));
    o.tokens.agent = rotateToken(s.ctx.paths.agentTokenFile);
    agentTokens.setLegacy(o.tokens.agent);
    agentTokens.onRevoke?.('default');
    return { file: s.ctx.paths.agentTokenFile, token: o.tokens.agent };
  });

  // named agent tokens (ARCHITECTURE §7) and approvals of destructive agent requests
  add('GET', /^\/v1\/tokens$/, 'ui', () => agentTokens.list());
  add('POST', /^\/v1\/tokens$/, 'ui', ({ body }) => agentTokens.create(obj(body)));
  add('GET', /^\/v1\/tokens\/([A-Za-z0-9]+)$/, 'ui', ({ params }) => agentTokens.get(params[0]!));
  add('PATCH', /^\/v1\/tokens\/([A-Za-z0-9]+)$/, 'ui', ({ params, body }) => agentTokens.patch(params[0]!, obj(body)));
  add('DELETE', /^\/v1\/tokens\/([A-Za-z0-9]+)$/, 'ui', (c) => {
    const t = agentTokens.get(c.params[0]!);
    if (t.builtin) throw badRequest('the built-in token cannot be deleted; disable or rotate it instead');
    need(c, () => ({
      kind: 'token.revoke',
      params: { name: t.name },
      title: `Revoke the agent token "${t.name}"`,
      items: 1,
      bytes: 0,
      details: ['Agents using this token lose access immediately.', ...(t.file ? [`Deletes ${t.file}`] : [])],
    }));
    agentTokens.revoke(t.id);
    return { ok: true };
  });
  add('GET', /^\/v1\/approvals$/, 'ui', () => confirm.approvals());
  // an agent may look at its own approvals (the UI token at all of them)
  add('GET', /^\/v1\/approvals\/([0-9a-f]+)$/, 'read', ({ params, principal }) => {
    const a = confirm.approval(params[0]!);
    if (principal.scope === 'agent' && a.tokenId !== principal.tokenId)
      throw notFound(`approval ${params[0]} not found`);
    return a;
  });
  add('POST', /^\/v1\/approvals\/([0-9a-f]+)\/approve$/, 'ui', ({ params }) => confirm.decide(params[0]!, true));
  add('POST', /^\/v1\/approvals\/([0-9a-f]+)\/deny$/, 'ui', ({ params }) => confirm.decide(params[0]!, false));

  // ------------------------------------------------------------------ maintenance, import
  add('GET', /^\/v1\/maintenance\/summary$/, 'read', () => maintenanceSummary(s.ctx, s.accounts, s.storage));
  const backfillSummary = (c: RouteCtx): Summary => {
    const b = obj(c.body) as { pairId: number; relPrefix?: string };
    const p = s.pairs.require(Number(b.pairId));
    return {
      kind: 'maintenance.digestBackfill',
      params: { name: p.name, prefix: b.relPrefix ?? '' },
      title: `Add checksums in "${p.name}"${b.relPrefix ? ` / ${b.relPrefix}` : ''}`,
      items: 1,
      bytes: 0,
      details: ['Files without a checksum are uploaded again (replace); replaced versions go to the Proton trash.'],
    };
  };
  add('POST', /^\/v1\/maintenance\/digest-backfill$/, 'destructive', (c) => digestBackfill(c), backfillSummary);
  const digestBackfill = (c: RouteCtx) => {
    const b = obj(c.body) as { pairId: number; relPrefix?: string; limit?: number };
    s.pairs.require(Number(b.pairId));
    if (b.relPrefix !== undefined && typeof b.relPrefix !== 'string') throw badRequest('relPrefix must be a string');
    if (b.limit !== undefined && (!Number.isInteger(b.limit) || b.limit < 1))
      throw badRequest('limit must be a positive integer');
    return e.startDigestBackfill
      ? { runId: engineCall(() => e.startDigestBackfill!(Number(b.pairId), b.relPrefix, b.limit)) }
      : NOT_IMPLEMENTED;
  };
  const emptyTrashSummary = (c: RouteCtx): Summary => {
    const a = accountByName(String(obj(c.body).accountId ?? ''));
    const t = s.storage.trash(a.id);
    return {
      kind: 'maintenance.emptyTrash',
      params: { name: a.display_name, measuredAt: t.measuredAt ?? '' },
      title: `Empty the Proton trash of ${a.display_name}`,
      items: t.items,
      bytes: t.bytes,
      details: [
        'Permanently deletes ALL items in the Proton trash (not only the ones this app put there).',
        t.measuredAt
          ? `Measured: ${new Date(t.measuredAt).toISOString()}`
          : 'Trash not measured yet (Storage → Measure).',
      ],
    };
  };
  add(
    'POST',
    /^\/v1\/maintenance\/empty-trash$/,
    'destructive',
    async (c) => {
      if (!e.emptyTrash) return NOT_IMPLEMENTED;
      const a = accountByName(String(obj(c.body).accountId ?? ''));
      need(c, () => emptyTrashSummary(c));
      try {
        await e.emptyTrash(a.id, by(c));
      } catch (err) {
        throw conflict((err as Error).message);
      }
      return { ok: true };
    },
    emptyTrashSummary,
  );

  return routes;
}
