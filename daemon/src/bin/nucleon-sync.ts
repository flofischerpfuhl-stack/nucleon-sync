// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `nucleon-sync` — command-line client for humans and agents (Claude Code, Codex, other agents, scripts).
 * Talks to the daemon over the local API (Unix socket). Agent contract: docs/CLI-JSON.md and agent-skill/SKILL.md.
 *
 * Token: by default the legacy agent token `default` (~/.config/nucleon-sync/agent-token: read + sync). `--agent NAME`
 * (or NUCLEON_SYNC_AGENT) uses a named agent token created in Settings → Agents with its scopes; NUCLEON_SYNC_TOKEN /
 * NUCLEON_SYNC_TOKEN_FILE pass a token directly. `--ui-token` uses the dashboard's full-access token (humans only).
 * Destructive requests: a confirmation (`--yes`/`--confirm`, or an interactive prompt); with an agent token the
 * user must additionally approve the request in the dashboard — the CLI waits for that (`--approval-timeout S`,
 * default 300; `--no-wait` returns at once with exit 7 and the confirm token for `--confirm-token`).
 *
 * `--json`: stdout carries exactly one JSON document (the API DTOs of shared/src/api.ts, or an error object
 * `{ ok:false, exitCode, code, error, ... }`), never prompts. Exit codes: see EXIT below.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import {
  ApiRequestError,
  barLang,
  barOutput,
  defaultCliPath,
  msg,
  NucleonSyncClient,
  refOf,
  resolvePaths,
  type AccountDto,
  type ActivityItem,
  type AdoptionProposalDto,
  type AgentTokenInfoDto,
  type ApprovalDto,
  type ApprovalRequiredResponse,
  type BarFormat,
  type ConfirmRequiredResponse,
  type ConflictDto,
  type CreateAgentTokenResponse,
  type DaemonEvent,
  type DoctorCheck,
  type JobDto,
  type PairDirection,
  type PairDto,
  type PendingDeletionDto,
  type RunDto,
  type SettingsDto,
  type StatusDto,
  type StoragePoolDto,
  type SyncResponse,
  type WhoAmIDto,
} from '@nucleon-sync/shared';
import type {
  CliPassthroughResponse,
  NotificationConfigDto,
  NotificationLogItem,
  NotificationTestResult,
  PairPreviewDto,
} from '@nucleon-sync/shared';

import { doctorFailed, runDoctor } from '../accounts/doctor.ts';
import { AgentTokens } from '../api/agentTokens.ts';
import { fmtBytes, transferLines } from './format.ts';

/** Exit codes (stable, documented in docs/CLI-JSON.md) */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  daemonDown: 3,
  notRunnable: 4,
  confirmationRequired: 5,
  forbidden: 6,
  approvalPending: 7,
} as const;

const PAIR_DIRECTIONS: PairDirection[] = ['backup', 'mirror-down', 'upload-only', 'two-way'];

const USAGE = `nucleon-sync — client for the nucleon-sync daemon

Status and sync (agent token "default" is enough):
  status [--json]                    whoami [--json]              paused   (exit 0 = paused, 1 = running)
  sync [--account ID] [--pair N] [--full|--verify] [--wait [--timeout S]]
  pause [--account ID | --pair N] [--for 30m|2h|1d|tomorrow] [--now] [--toggle]
  resume [--account ID | --pair N]
  activity [--since ISO] [--account ID] [--pair N] [--action a,b] [--q TEXT] [--limit N]
  runs [--limit N]                   jobs [--state S] [--limit N]
  conflicts | deletions | adoptions | accounts | pairs [show N | rules N] | storage [--history]
  storage --measure                  settings                     doctor
  notifications [config]             log and channel configuration
  cli --account ID -- <proton-drive args>   read-only: filesystem list|info|size
  bar [--format waybar|omarchy] [--watch]   status-bar JSON (Waybar / Omarchy shell)
  open [SCREEN]                      open the dashboard (overview, activity, folders, issues, storage, ...)

Manage (scope "manage"):
  pairs preview|add --account ID --local DIR --remote PATH [--name N] [--direction D] [--disabled]
  pairs set N name=..|enabled=true|paused=false|direction=..|options.KEY=..
  accounts add ID NAME | accounts login ID [--no-wait] | accounts cancel-login ID | accounts set ID name=..|workers=N
  conflicts resolve ID keep_local|keep_remote|keep_both|ignore   (+ "destructive" when the resolution trashes)
  deletions decide restore_local|keep_remote_only|restore_remote ID...
  deletions deny PAIR                held deletions of a two-way pair: restore them all
  adoptions accept|reject ID...      settings set section.key=<json> ...
  (D = backup|mirror-down|upload-only|two-way; a direction change needs the user's approval for agents)

Destructive (scope "destructive"; agents: the user approves each request in the dashboard):
  pairs remove N | accounts logout ID | accounts remove ID | deletions decide trash_remote|trash_local ID...
  deletions approve PAIR (carry out held two-way deletions) | release-brake N | empty-trash --account ID
  digest-backfill --pair N [--prefix P]

User only (--ui-token):
  tokens [list] | tokens create NAME --scopes sync,manage[,destructive] [--no-file]
  tokens revoke ID | tokens enable|disable ID | tokens set ID scopes=a,b name=..   token [--rotate]
  approvals [list] | approvals approve|deny ID
  notifications test [command]

Global: --json (one JSON document on stdout, never prompts), --yes/--confirm (confirm destructive actions),
        --confirm-token T, --approval-timeout S (default 300), --no-wait, --agent NAME, --ui-token
Exit codes: 0 ok, 1 error, 2 usage, 3 daemon not running, 4 sync scope not runnable, 5 confirmation required,
            6 forbidden (missing scope / denied by the user), 7 approval pending`;

/** 409 body of a confirm step: ConfirmRequiredResponse, or ApprovalRequiredResponse for agent tokens */
type ConfirmStep = Omit<ConfirmRequiredResponse, 'error'> & {
  error: ConfirmRequiredResponse['error'] | ApprovalRequiredResponse['error'];
  approval?: ApprovalDto;
};

class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(exitCode: number, code: string, message: string, extra: Record<string, unknown> = {}, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.exitCode = exitCode;
    this.code = code;
    this.extra = extra;
  }
}
const usage = (msg: string) => new CliError(EXIT.usage, 'usage', msg);
const daemonDown = (msg: string, cause?: unknown) => new CliError(EXIT.daemonDown, 'daemon_down', msg, {}, cause);

type Values = Record<string, string | boolean | undefined>;

function parseDuration(s: string, now = new Date()): Date {
  if (s === 'tomorrow') {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(7, 0, 0, 0);
    return t;
  }
  const m = /^(\d+)\s*(m|min|h|d)$/.exec(s.trim());
  if (!m) throw usage(`bad duration "${s}" (e.g. 30m, 2h, 1d, tomorrow)`);
  const n = Number(m[1]);
  const ms = m[2] === 'd' ? n * 86400_000 : m[2] === 'h' ? n * 3600_000 : n * 60_000;
  return new Date(now.getTime() + ms);
}

function intArg(v: string | undefined, what: string): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n < 0) throw usage(`${what} must be a number`);
  return n;
}

/** `sync` without --wait: which runs started, which wait for a busy lane */
function syncStartedText(r: SyncResponse): string {
  const ids = r.runIds?.length ? r.runIds : [r.runId];
  if (!r.followUp) return ids.map((id) => `run #${id} started`).join('\n');
  if (!r.runIds?.length) return `queued after run #${r.runId}`; // older daemon
  const behind = [...new Set(r.queuedBehind ?? [])];
  return `queued after run #${behind.join(', #')} (as run #${ids.join(', #')})`;
}

function runLine(r: RunDto): string {
  const scope = r.pairId !== null ? `pair #${r.pairId}` : (r.accountId ?? 'all accounts');
  const who = r.pairId !== null && r.accountId ? ` (${r.accountId})` : '';
  const lane = r.lane === 'priority' ? ' [priority]' : '';
  if (r.status === 'queued')
    return `#${r.id} ${r.mode} ${scope}${who}${lane} queued${r.waitingFor?.length ? ` after #${r.waitingFor.join(', #')}` : ''}`;
  return `#${r.id} ${r.mode} ${scope}${who}${lane} since ${r.startedAt}`;
}

function human(s: StatusDto): string {
  const pausedUntil = s.pausedUntil;
  const lines = [
    `nucleon-syncd ${s.daemonVersion} (${s.mode}) — ${s.state}${s.paused ? ` [paused${pausedUntil ? ` until ${pausedUntil}` : ''}]` : ''}`,
    `current run: ${s.currentRun ? `#${s.currentRun.id} ${s.currentRun.mode} since ${s.currentRun.startedAt}` : '—'}`,
    // several runs at once (accounts run independently, pair runs in the priority lane)
    ...((s.activeRuns?.length ?? 0) > 1 || (s.queuedRuns?.length ?? 0) > 0
      ? [
          'active runs:',
          ...(s.activeRuns ?? []).map((r) => `  ${runLine(r)}`),
          ...(s.queuedRuns ?? []).map((r) => `  ${runLine(r)}`),
        ]
      : []),
    `last run: ${s.lastRun ? `#${s.lastRun.id} ${s.lastRun.status} ${s.lastRun.finishedAt ?? ''}` : '—'}`,
    `next: ${s.nextRuns.map((r) => `${r.mode} ${r.at}`).join(', ') || '—'}`,
    `queue: ${s.queue.queued} queued, ${s.queue.running} running, ${s.queue.retryWait} retry, ${s.queue.failed} failed, ${s.queue.blocked} blocked · conflicts ${s.openConflicts} · pending deletions ${s.pendingDeletions}`,
    ...transferLines(s),
    'accounts:',
    ...s.accounts.map(
      (a) =>
        `  ${a.id.padEnd(10)} ${a.status.padEnd(13)} ${(a.email ?? '').padEnd(24)} workers ${a.workers.active}/${a.workers.configured}${a.paused ? ' [paused]' : ''}${a.lastError ? `  (${a.lastError.slice(0, 80)})` : ''}`,
    ),
    'pairs:',
    ...s.pairs.map(
      (p) =>
        `  #${p.id} ${p.accountId}: ${p.localRoot} ⇄ ${p.remoteRoot} [${p.direction}${p.enabled ? '' : ', disabled'}${p.paused ? ', paused' : ''}]${p.heldDeletions ? `  HELD: ${p.heldDeletions} deletions` : ''}${p.brake ? `  BRAKE: ${p.brake.reason}` : ''}`,
    ),
  ];
  return lines.join('\n');
}

function pairLine(p: PairDto): string {
  return (
    `#${p.id} ${p.accountId}: ${p.name} — ${p.localRoot} ⇄ ${p.remoteRoot} [${p.direction}${p.enabled ? '' : ', disabled'}${p.paused ? ', paused' : ''}${p.options?.uploadLocalNew ? ', uploads new local files' : ''}${p.options?.twoWayAdoption ? ', adoption pending' : ''}]` +
    `${p.direction === 'two-way' && p.lastRemoteCheckAt ? `  remote checked ${p.lastRemoteCheckAt}` : ''}` +
    `${p.heldDeletions ? `  HELD: ${p.heldDeletions} deletions (deletions approve|deny ${p.id})` : ''}` +
    `${p.ownedElsewhere?.length ? `  excludes ${p.ownedElsewhere.map((o) => `${o.relPath} (pair #${o.pairId})`).join(', ')}` : ''}` +
    `${p.brake ? `  BRAKE: ${p.brake.reason}` : ''}`
  );
}

function tokenLine(t: AgentTokenInfoDto): string {
  return `${t.id.padEnd(9)} ${t.name.padEnd(16)} ${t.scopes.join(',').padEnd(30)} ${t.disabled ? 'DISABLED ' : ''}last used ${t.lastUsedAt ?? 'never'}${t.file ? `  ${t.file}` : ''}`;
}

function approvalLine(a: ApprovalDto): string {
  return `${a.id} ${a.state.padEnd(8)} ${a.tokenName.padEnd(14)} ${a.summary.title}  (${a.method} ${a.path}, until ${a.expiresAt})`;
}

/** key=value pairs of `pairs set` / `accounts set` / `tokens set`: true/false/numbers parsed, options.X nested */
function kvPatch(args: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const kv of args) {
    const i = kv.indexOf('=');
    if (i < 1) throw usage(`bad assignment "${kv}" (key=value)`);
    const k = kv.slice(0, i);
    const s = kv.slice(i + 1);
    const v = s === 'true' ? true : s === 'false' ? false : /^\d+$/.test(s) ? Number(s) : s;
    if (k.startsWith('options.')) {
      // e.g. options.uploadLocalNew=true ("upload new files from this PC", mirror-down pairs)
      const o = (patch.options ??= {}) as Record<string, unknown>;
      o[k.slice('options.'.length)] = v;
    } else patch[k] = v;
  }
  return patch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cli {
  private readonly v: Values;
  private readonly env: NodeJS.ProcessEnv;
  private clientCache: NucleonSyncClient | null = null;

  constructor(v: Values, env: NodeJS.ProcessEnv) {
    this.v = v;
    this.env = env;
  }

  private get json(): boolean {
    return !!this.v.json;
  }

  private get yes(): boolean {
    return !!(this.v.yes || this.v.confirm);
  }

  /** the token this invocation uses (see header) */
  private token(): { token: string; label: string } {
    const paths = resolvePaths(this.env);
    const read = (file: string) => readFileSync(file, 'utf8').trim();
    if (this.v['ui-token']) return { token: read(paths.tokenFile), label: 'ui' };
    if (this.env.NUCLEON_SYNC_TOKEN) return { token: this.env.NUCLEON_SYNC_TOKEN.trim(), label: 'env' };
    if (this.env.NUCLEON_SYNC_TOKEN_FILE) return { token: read(this.env.NUCLEON_SYNC_TOKEN_FILE), label: 'file' };
    const agent = (this.v.agent as string | undefined) ?? this.env.NUCLEON_SYNC_AGENT;
    if (agent && agent !== 'default') {
      const file = AgentTokens.fileFor(paths, agent);
      if (!file) throw usage(`no agent token named "${agent}" with a token file (Settings → Agents)`);
      return { token: read(file), label: agent };
    }
    return { token: read(paths.agentTokenFile), label: 'default' };
  }

  private client(): NucleonSyncClient {
    if (this.clientCache) return this.clientCache;
    let token: string;
    try {
      token = this.token().token;
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw daemonDown('daemon not configured (no API token). Is nucleon-sync.service running?', e);
    }
    const paths = resolvePaths(this.env);
    this.clientCache = this.env.NUCLEON_SYNC_API_PORT
      ? new NucleonSyncClient({ host: '127.0.0.1', port: Number(this.env.NUCLEON_SYNC_API_PORT), token })
      : new NucleonSyncClient({ socketPath: paths.socketFile, token });
    return this.clientCache;
  }

  private async raw<T>(method: string, p: string, body?: unknown): Promise<T> {
    try {
      return await this.client().request<T>(method, p, body);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') throw daemonDown('daemon not running', e);
      throw e;
    }
  }

  /** API call with the confirm round-trip and, for agent tokens, the user-approval wait. */
  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const withToken = (t: string) => ({ ...((body as object) ?? {}), confirmToken: t });
    const preset = this.v['confirm-token'] as string | undefined;
    try {
      return await this.raw<T>(method, p, preset ? withToken(preset) : body);
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
      let parsed: ConfirmStep | null = null;
      let msg = e.body;
      try {
        const j = JSON.parse(e.body) as { error?: string; confirmToken?: string };
        msg = j.error ?? e.body;
        if (e.status === 409 && j.confirmToken) parsed = j as unknown as ConfirmStep;
      } catch {
        /* raw body */
      }
      if (parsed) return this.confirmFlow<T>(method, p, parsed, withToken);
      throw this.apiError(e.status, msg, e.body);
    }
  }

  private apiError(status: number, msg: string, rawBody: string): CliError {
    if (status === 403) {
      let approval: unknown;
      try {
        approval = (JSON.parse(rawBody) as { approval?: unknown }).approval;
      } catch {
        /* ignore */
      }
      if (approval) return new CliError(EXIT.forbidden, 'approval_denied', msg, { status, approval });
      const hint = /lacks the scope|UI token/.test(msg) ? ' (or --ui-token, for humans only)' : '';
      return new CliError(EXIT.forbidden, 'forbidden', `${msg}${hint}`, { status });
    }
    return new CliError(EXIT.error, 'api_error', `${status}: ${msg}`, { status });
  }

  private async confirmFlow<T>(
    method: string,
    p: string,
    first: ConfirmStep,
    withToken: (t: string) => object,
  ): Promise<T> {
    const s = first.summary;
    if (!this.json) {
      process.stderr.write(`\n${s.title}\n`);
      if (s.items || s.bytes)
        process.stderr.write(
          `  ${s.items} item${s.items === 1 ? '' : 's'}${s.bytes ? `, ${fmtBytes(s.bytes)}` : ''}\n`,
        );
      for (const d of s.details) process.stderr.write(`  ${d}\n`);
    }
    // 1. the caller's own confirmation
    if (first.error === 'confirmation required' || first.error === 'approval required') {
      let ok = this.yes;
      if (!ok && !this.json && process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const a = (await rl.question('Confirm? [y/N] ')).trim().toLowerCase();
        rl.close();
        ok = a === 'y' || a === 'yes' || a === 'j' || a === 'ja';
      }
      if (!ok)
        throw new CliError(
          EXIT.confirmationRequired,
          'confirmation_required',
          'confirmation required: re-run with --yes (or --confirm)',
          { confirm: { summary: s, expiresAt: first.expiresAt } },
        );
    }
    if (!first.approval) return this.raw<T>(method, p, withToken(first.confirmToken));
    // 2. agent token: confirming hands the request to the user (state pending), who approves it in the dashboard
    //    (or with `nucleon-sync approvals approve <id> --ui-token`)
    let approval = first.approval;
    if (approval.state === 'requested') {
      try {
        return await this.raw<T>(method, p, withToken(first.confirmToken)); // only when approved meanwhile
      } catch (e) {
        if (!(e instanceof ApiRequestError)) throw e;
        let j: Partial<ApprovalRequiredResponse> = {};
        try {
          j = JSON.parse(e.body) as Partial<ApprovalRequiredResponse>;
        } catch {
          /* raw */
        }
        if (e.status !== 409 || !j.approval)
          throw this.apiError(e.status, (j as { error?: string }).error ?? e.body, e.body);
        approval = j.approval;
      }
    }
    const pending = (a: ApprovalDto) =>
      new CliError(
        EXIT.approvalPending,
        'approval_pending',
        `waiting for the user's approval (${a.id}) – re-run with --confirm-token ${first.confirmToken} once approved`,
        { approval: a, confirmToken: first.confirmToken },
      );
    if (this.v['no-wait']) throw pending(approval);
    if (!this.json)
      process.stderr.write(
        `Waiting for approval ${approval.id} in the dashboard (Settings → Agents shows open requests) …\n`,
      );
    const timeoutS = Number(this.v['approval-timeout'] ?? 300);
    const end = Date.now() + (Number.isFinite(timeoutS) ? timeoutS : 300) * 1000;
    let a = approval;
    for (;;) {
      if (a.state === 'approved') break;
      if (a.state === 'denied')
        throw new CliError(EXIT.forbidden, 'approval_denied', 'the user denied this request', { approval: a });
      if (a.state === 'expired' || a.state === 'used')
        throw new CliError(EXIT.error, 'approval_expired', `approval ${a.id} is ${a.state}`, { approval: a });
      if (Date.now() >= end) throw pending(a);
      await sleep(1000);
      try {
        a = await this.raw<ApprovalDto>('GET', `/v1/approvals/${a.id}`);
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 404)
          throw new CliError(EXIT.error, 'approval_expired', `approval ${a.id} expired`, { approval: a });
        throw e;
      }
    }
    try {
      return await this.raw<T>(method, p, withToken(first.confirmToken));
    } catch (e) {
      if (e instanceof ApiRequestError) {
        let msg = e.body;
        try {
          msg = (JSON.parse(e.body) as { error?: string }).error ?? e.body;
        } catch {
          /* raw */
        }
        throw this.apiError(e.status, msg, e.body);
      }
      throw e;
    }
  }

  private out(v: unknown, h: () => string): void {
    console.log(this.json ? JSON.stringify(v, null, 2) : h());
  }

  async run(cmd: string, args: string[]): Promise<number> {
    const v = this.v;
    switch (cmd) {
      case 'status': {
        const s = await this.call<StatusDto>('GET', '/v1/status');
        this.out(s, () => human(s));
        return EXIT.ok;
      }
      case 'whoami': {
        const w = await this.call<WhoAmIDto>('GET', '/v1/whoami');
        this.out(
          w,
          () =>
            `${w.scope === 'ui' ? 'UI token (full access)' : `agent token "${w.name}" (${w.tokenId})`}: ${w.permissions.join(', ')}` +
            (w.approvalRequired.length ? `\nneeds the user's approval: ${w.approvalRequired.join(', ')}` : ''),
        );
        return EXIT.ok;
      }
      case 'paused': {
        const s = await this.call<StatusDto>('GET', '/v1/status');
        this.out({ paused: s.paused, pausedUntil: s.pausedUntil ?? null }, () => (s.paused ? 'paused' : 'running'));
        return s.paused ? EXIT.ok : EXIT.error;
      }
      case 'sync':
        return this.sync();
      case 'pause':
      case 'resume': {
        let verb: 'pause' | 'resume' = cmd;
        if (cmd === 'pause' && v.toggle) {
          const s = await this.call<StatusDto>('GET', '/v1/status');
          const paused = v.account
            ? s.accounts.find((a) => a.id === v.account)?.paused
            : v.pair
              ? s.pairs.find((p) => p.id === Number(v.pair))?.paused
              : s.paused;
          if (paused) verb = 'resume';
        }
        const body = {
          scope: v.account ? 'account' : v.pair ? 'pair' : 'all',
          ...(v.account ? { id: v.account } : v.pair ? { id: intArg(v.pair as string, '--pair') } : {}),
          ...(verb === 'pause' && v.for ? { until: parseDuration(String(v.for)).toISOString() } : {}),
          ...(verb === 'pause' && v.now ? { immediate: true } : {}),
        };
        const r = await this.call<{ ok: true; until?: string | null }>('POST', `/v1/${verb}`, body);
        this.out({ ...r, action: verb }, () =>
          verb === 'pause' ? `paused${r.until ? ` until ${r.until}` : ''}` : 'resumed',
        );
        return EXIT.ok;
      }
      case 'activity': {
        const q = new URLSearchParams({ limit: String(Number(v.limit ?? 30)) });
        if (v.since) q.set('since', String(v.since));
        if (v.account) q.set('account', String(v.account));
        if (v.pair) q.set('pair', String(v.pair));
        if (v.action) q.set('action', String(v.action));
        if (v.q) q.set('q', String(v.q));
        const items = await this.call<ActivityItem[]>('GET', `/v1/activity?${q}`);
        this.out(items, () =>
          items
            .map((i) =>
              `${i.ts}  ${i.accountId.padEnd(8)} ${i.action.padEnd(15)} ${i.relPath ?? ''} ${fmtBytes(i.bytes)} ${i.message ?? ''}`.trimEnd(),
            )
            .join('\n'),
        );
        return EXIT.ok;
      }
      case 'runs': {
        const runs = await this.call<RunDto[]>('GET', `/v1/runs?limit=${Number(v.limit ?? 20)}`);
        this.out(runs, () =>
          runs
            .map(
              (r) =>
                `#${r.id} ${r.mode.padEnd(11)} ${r.trigger.padEnd(8)} ${r.status.padEnd(9)} ${r.startedAt} ↑${r.counters.uploaded} ↓${r.counters.downloaded} ⇄${r.counters.moved} ✕${r.counters.errors}`,
            )
            .join('\n'),
        );
        return EXIT.ok;
      }
      case 'jobs': {
        const jobs = await this.call<JobDto[]>(
          'GET',
          `/v1/jobs?limit=${Number(v.limit ?? 50)}${v.state ? `&state=${v.state}` : ''}`,
        );
        this.out(jobs, () =>
          jobs
            .map((j) =>
              `#${j.id} ${j.type.padEnd(15)} ${j.state.padEnd(10)} ${j.relPath ?? ''} ${j.lastError ?? ''}`.trimEnd(),
            )
            .join('\n'),
        );
        return EXIT.ok;
      }
      case 'conflicts': {
        if (args[0] === 'resolve') {
          const [, id, resolution] = args;
          if (!id || !resolution) throw usage('conflicts resolve <id> <resolution>');
          const r = await this.call('POST', `/v1/conflicts/${intArg(id, 'id')}/resolve`, { resolution });
          this.out(r, () => `conflict ${id}: ${resolution}`);
          return EXIT.ok;
        }
        const list = await this.call<ConflictDto[]>('GET', '/v1/conflicts');
        this.out(
          list,
          () =>
            list
              .map(
                (c) =>
                  `#${c.id} ${c.accountId} ${c.kind.padEnd(22)} ${c.relPath}` +
                  (c.keptBoth
                    ? c.keptBoth.copyRelPath
                      ? `  [kept both: ${c.keptBoth.copyRelPath}]`
                      : '  [restored automatically]'
                    : ''),
              )
              .join('\n') || 'no conflicts',
        );
        return EXIT.ok;
      }
      case 'deletions': {
        if (args[0] === 'approve' || args[0] === 'deny') {
          if (!args[1] || args.length > 2) throw usage(`deletions ${args[0]} <pairId>`);
          const r = await this.call<{ decided: number }>(
            'POST',
            `/v1/pairs/${intArg(args[1], 'pair id')}/held-deletions`,
            { approve: args[0] === 'approve' },
          );
          this.out(r, () => `${r.decided} held deletions ${args[0] === 'approve' ? 'approved' : 'denied (restored)'}`);
          return EXIT.ok;
        }
        if (args[0] === 'decide') {
          const [, decision, ...ids] = args;
          if (!decision || !ids.length) throw usage('deletions decide <decision> <id>...');
          const r = await this.call('POST', '/v1/deletions/decide', {
            decision,
            ids: ids.map((x) => intArg(x, 'id')),
          });
          this.out(r, () => `${ids.length} decided: ${decision}`);
          return EXIT.ok;
        }
        const list = await this.call<PendingDeletionDto[]>('GET', '/v1/deletions');
        this.out(
          list,
          () =>
            list
              .map(
                (d) =>
                  `#${d.id} ${d.accountId} ${d.relPath} ${fmtBytes(d.size)}${d.remoteChangedSinceDelete ? ' ⚠ remote changed' : ''}` +
                  `${d.side === 'remote' ? ' (deleted in Proton)' : ''}${d.held ? ` [held, pair ${d.pairId}]` : ''}`,
              )
              .join('\n') || 'no pending deletions',
        );
        return EXIT.ok;
      }
      case 'adoptions': {
        if (args[0] === 'accept' || args[0] === 'reject') {
          const ids = args.slice(1).map((x) => intArg(x, 'id'));
          if (!ids.length) throw usage(`adoptions ${args[0]} <id>...`);
          const r = await this.call('POST', '/v1/adoptions/decide', { ids, accept: args[0] === 'accept' });
          this.out(r, () => `${ids.length} ${args[0]}ed`);
          return EXIT.ok;
        }
        const list = await this.call<AdoptionProposalDto[]>('GET', '/v1/adoptions');
        this.out(
          list,
          () =>
            list.map((a) => `#${a.id} ${a.sourceRemotePath} → ${a.targetRelPath} ${fmtBytes(a.size)}`).join('\n') ||
            'no proposals',
        );
        return EXIT.ok;
      }
      case 'accounts':
        return this.accounts(args);
      case 'pairs':
        return this.pairs(args);
      case 'release-brake': {
        if (!args[0]) throw usage('release-brake <pairId>');
        const r = await this.call('POST', `/v1/pairs/${intArg(args[0], 'pairId')}/release-brake`, {});
        this.out(r, () => `brake released for pair ${args[0]} (next run proceeds)`);
        return EXIT.ok;
      }
      case 'empty-trash': {
        if (!v.account) throw usage('empty-trash --account ID');
        const r = await this.call('POST', '/v1/maintenance/empty-trash', { accountId: String(v.account) });
        this.out(r, () => `emptying the Proton trash of ${v.account}`);
        return EXIT.ok;
      }
      case 'digest-backfill': {
        if (!v.pair) throw usage('digest-backfill --pair N [--prefix P] [--limit N]');
        const r = await this.call<{ runId: number }>('POST', '/v1/maintenance/digest-backfill', {
          pairId: intArg(v.pair as string, '--pair'),
          ...(v.prefix ? { relPrefix: String(v.prefix) } : {}),
          ...(v.limit ? { limit: intArg(v.limit as string, '--limit') } : {}),
        });
        this.out(r, () => `digest backfill started as run #${r.runId}`);
        return EXIT.ok;
      }
      case 'storage': {
        if (v.history) {
          const h = await this.call<unknown[]>('GET', '/v1/storage/history?days=90');
          this.out(h, () => JSON.stringify(h, null, 2));
          return EXIT.ok;
        }
        const s = v.measure
          ? await this.call<StoragePoolDto>('POST', '/v1/storage/measure', v.account ? { accountId: v.account } : {})
          : await this.call<StoragePoolDto>('GET', '/v1/storage');
        this.out(s, () =>
          [
            `pool: ${s.poolBytes ? fmtBytes(s.poolBytes) : 'not configured'}`,
            ...s.accounts.flatMap((a) => [
              `${a.accountId}: ${fmtBytes(a.totalBytes)} (measured ${a.measuredAt ?? 'never'}) · trash ${fmtBytes(a.trashBytes)} · old versions ${fmtBytes(a.reclaimableOldRevisionsBytes)}`,
              ...a.areas.map((x) => `    ${x.label.padEnd(24)} ${fmtBytes(x.bytes)}`),
            ]),
          ].join('\n'),
        );
        return EXIT.ok;
      }
      case 'settings': {
        if (args[0] === 'set') {
          const patch: Record<string, Record<string, unknown> | unknown> = {};
          for (const kv of args.slice(1)) {
            const m = /^([a-zA-Z]+)(?:\.([a-zA-Z]+))?=(.*)$/.exec(kv);
            if (!m) throw usage(`bad setting ${kv} (section.key=<json>)`);
            let val: unknown;
            try {
              val = JSON.parse(m[3]!);
            } catch {
              val = m[3];
            }
            if (m[2]) patch[m[1]!] = { ...((patch[m[1]!] as object) ?? {}), [m[2]]: val };
            else patch[m[1]!] = val;
          }
          if (!Object.keys(patch).length) throw usage('settings set section.key=<json> ...');
          const s = await this.call<SettingsDto>('PUT', '/v1/settings', patch);
          this.out(s, () => JSON.stringify(s, null, 2));
          return EXIT.ok;
        }
        const s = await this.call<SettingsDto>('GET', '/v1/settings');
        this.out(s, () => JSON.stringify(s, null, 2));
        return EXIT.ok;
      }
      case 'doctor':
        return this.doctor();
      case 'cli': {
        if (!v.account) throw usage('cli --account ID -- <args>');
        if (!args.length) throw usage('cli --account ID -- <proton-drive args>');
        if (v['allow-write'] && !v['ui-token'])
          throw new CliError(
            EXIT.forbidden,
            'forbidden',
            '--allow-write needs the UI token: add --ui-token (not for agents)',
          );
        const r = await this.call<CliPassthroughResponse>(
          'POST',
          `/v1/accounts/${encodeURIComponent(String(v.account))}/cli`,
          { args, ...(v['allow-write'] ? { allowWrite: true } : {}) },
        );
        if (this.json) console.log(JSON.stringify(r, null, 2));
        else {
          process.stdout.write(r.stdout);
          if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n');
        }
        return r.exitCode === 0 ? EXIT.ok : EXIT.error;
      }
      case 'notifications': {
        if (args[0] === 'test') {
          const ch = args[1];
          if (ch !== undefined && ch !== 'command') throw usage('notifications test [command]');
          const r = await this.call<NotificationTestResult[]>(
            'POST',
            '/v1/notifications/test',
            ch ? { channel: ch } : {},
          );
          this.out(
            r,
            () =>
              r.map((x) => `${x.channel}: ${x.ok ? 'sent' : `failed (${x.detail})`}`).join('\n') || 'no channel is on',
          );
          return r.every((x) => x.ok) ? EXIT.ok : EXIT.error;
        }
        if (args[0] === 'config') {
          const c = await this.call<NotificationConfigDto>('GET', '/v1/notifications/config');
          this.out(
            c,
            () =>
              `notify command: ${c.command.configured ? c.command.program : 'none (set "notifyCommand" in daemon.json)'}`,
          );
          return EXIT.ok;
        }
        if (args[0] !== undefined)
          throw usage('notifications [--limit N] | notifications config | notifications test [command]');
        const l = await this.call<NotificationLogItem[]>('GET', `/v1/notifications?limit=${Number(v.limit ?? 50)}`);
        this.out(
          l,
          () =>
            l.map((n) => `${n.ts} ${n.channel} ${n.ok ? 'ok ' : 'ERR'} ${n.key} ${n.detail ?? ''}`).join('\n') ||
            'none',
        );
        return EXIT.ok;
      }
      case 'token': {
        const r = v.rotate
          ? await this.call<{ file: string; token: string }>('POST', '/v1/tokens/agent/rotate', {})
          : await this.call<{ file: string; token: string }>('GET', '/v1/tokens/agent');
        this.out(r, () => `agent token file: ${r.file}${v.rotate ? ' (rotated)' : ''}`);
        return EXIT.ok;
      }
      case 'tokens':
        return this.tokens(args);
      case 'approvals':
        return this.approvals(args);
      case 'bar':
        return this.bar();
      case 'open':
        return this.open(args[0]);
      case 'help':
        console.log(USAGE);
        return EXIT.ok;
      default:
        throw usage(`unknown command "${cmd}"`);
    }
  }

  private async sync(): Promise<number> {
    const v = this.v;
    const req = {
      ...(v.account ? { accountId: String(v.account) } : {}),
      ...(v.pair ? { pairId: intArg(v.pair as string, '--pair') } : {}),
      mode: (v.full ? 'full' : v.verify ? 'verify' : 'incremental') as RunDto['mode'],
    };
    const r = await this.call<SyncResponse>('POST', '/v1/sync', req);
    if (r.notRunnable) {
      // nothing will be synced for this scope (pair disabled/paused, account paused, ...): exit 4
      this.out(r, () => `not synced: ${r.notRunnable}`);
      return EXIT.notRunnable;
    }
    if (!v.wait) {
      this.out(r, () => syncStartedText(r));
      return EXIT.ok;
    }
    const runs = r.runIds?.length ? await this.waitForRuns(r.runIds) : [await this.waitForRun(r, req)];
    // the run that covers the request (for a global request split per account: the first one)
    const run = runs[0]!;
    const allOk = runs.every((x) => x.status === 'ok');
    const blocked = r.writesBlocked
      ? (await this.call<JobDto[]>('GET', `/v1/jobs?state=blocked&limit=500`)).filter(
          (j) => !req.pairId || j.pairId === req.pairId,
        ).length
      : 0;
    this.out(
      // JSON stays the RunDto (as before) plus request details
      {
        ...run,
        followUp: !!r.followUp,
        requestedRunId: r.runId,
        runIds: runs.map((x) => x.id),
        runs,
        notRunnable: r.notRunnable ?? null,
        writesBlocked: r.writesBlocked ?? null,
        blockedJobs: blocked,
      },
      () =>
        [
          ...runs.map(
            (x) =>
              `run #${x.id} finished: ${x.status} (↑ ${x.counters.uploaded} ↓ ${x.counters.downloaded}` +
              ` · conflicts ${x.counters.conflicts} · errors ${x.counters.errors})`,
          ),
          ...(blocked ? [`${blocked} jobs blocked: ${r.writesBlocked}`] : []),
        ].join('\n'),
    );
    return allOk ? EXIT.ok : EXIT.error;
  }

  private async accounts(args: string[]): Promise<number> {
    const [sub, id, ...rest] = args;
    if (!sub) {
      const list = await this.call<AccountDto[]>('GET', '/v1/accounts');
      this.out(list, () =>
        list
          .map(
            (a) =>
              `${a.id.padEnd(10)} ${a.displayName.padEnd(12)} ${a.status.padEnd(13)} ${a.email ?? ''}${a.lastError ? `  (${a.lastError})` : ''}`,
          )
          .join('\n'),
      );
      return EXIT.ok;
    }
    if (!id) throw usage(`accounts ${sub} <id>`);
    const enc = encodeURIComponent(id);
    if (sub === 'show') {
      const a = await this.call<AccountDto>('GET', `/v1/accounts/${enc}`);
      this.out(a, () => JSON.stringify(a, null, 2));
      return EXIT.ok;
    }
    if (sub === 'add') {
      const name = rest.join(' ') || id;
      const a = await this.call<AccountDto>('POST', '/v1/accounts', { id, displayName: name });
      this.out(a, () => `account ${a.id} created (${a.status}); next: nucleon-sync accounts login ${a.id}`);
      return EXIT.ok;
    }
    if (sub === 'set') {
      const patch = kvPatch(rest);
      if ('name' in patch) {
        patch.displayName = patch.name;
        delete patch.name;
      }
      const a = await this.call<AccountDto>('PATCH', `/v1/accounts/${enc}`, patch);
      this.out(a, () => `account ${a.id} updated`);
      return EXIT.ok;
    }
    if (sub === 'login') {
      const c = this.client();
      // subscribe first so the 'done' event cannot be missed
      const done = new Promise<{ ok: boolean; message?: string }>((resolve) => {
        const unsub = c.subscribe((e: DaemonEvent) => {
          if (e.type === 'login' && e.accountId === id && (e.phase === 'done' || e.phase === 'failed')) {
            unsub();
            resolve({ ok: e.phase === 'done', message: e.message });
          }
        });
      });
      const r = await this.call<{ accountId: string; signInUrl: string }>('POST', `/v1/accounts/${enc}/login`, {});
      if (this.v['no-wait']) {
        this.out(r, () => `Open the sign-in link on any device:\n  ${r.signInUrl}`);
        return EXIT.ok;
      }
      if (!this.json) console.log(`Open the sign-in link on any device:\n  ${r.signInUrl}\nWaiting for confirmation …`);
      const res = await done;
      this.out({ ...r, ok: res.ok, message: res.message ?? null }, () =>
        res.ok ? 'login successful' : `login failed: ${res.message ?? ''}`,
      );
      return res.ok ? EXIT.ok : EXIT.error;
    }
    if (sub === 'cancel-login') {
      const r = await this.call('DELETE', `/v1/accounts/${enc}/login`);
      this.out(r, () => `login of ${id} cancelled`);
      return EXIT.ok;
    }
    if (sub === 'logout') {
      const r = await this.call('DELETE', `/v1/accounts/${enc}/session`, {});
      this.out(r, () => `${id} logged out`);
      return EXIT.ok;
    }
    if (sub === 'remove') {
      const r = await this.call('DELETE', `/v1/accounts/${enc}`, {});
      this.out(r, () => `${id} removed`);
      return EXIT.ok;
    }
    throw usage(`unknown accounts subcommand ${sub}`);
  }

  private async pairs(args: string[]): Promise<number> {
    const v = this.v;
    const [sub, id, ...rest] = args;
    if (!sub) {
      const list = await this.call<PairDto[]>('GET', '/v1/pairs');
      this.out(list, () => list.map(pairLine).join('\n'));
      return EXIT.ok;
    }
    if (sub === 'show') {
      const p = await this.call<PairDto>('GET', `/v1/pairs/${intArg(id, 'pair id')}`);
      this.out(p, () => pairLine(p));
      return EXIT.ok;
    }
    if (sub === 'rules') {
      const r = await this.call('GET', `/v1/pairs/${intArg(id, 'pair id')}/rules`);
      this.out(r, () => JSON.stringify(r, null, 2));
      return EXIT.ok;
    }
    if (sub === 'add' || sub === 'preview') {
      if (!v.account || !v.local || !v.remote)
        throw usage('pairs add --account ID --local DIR --remote PATH [--name N] [--direction D]');
      if (v.direction !== undefined && !PAIR_DIRECTIONS.includes(v.direction as PairDirection))
        throw usage(`--direction must be one of ${PAIR_DIRECTIONS.join(', ')}`);
      const body = {
        accountId: v.account,
        name: v.name ?? String(v.remote).split('/').pop(),
        localRoot: path.resolve(String(v.local)),
        remoteRoot: v.remote,
        direction: v.direction ?? 'backup',
        enabled: !v.disabled,
      };
      if (sub === 'preview') {
        const p = await this.call<PairPreviewDto>('POST', '/v1/pairs/preview', body);
        this.out(
          p,
          () =>
            `adopt ${p.adopt} · upload ${p.upload} (${fmtBytes(p.uploadBytes)}) · download ${p.download} (${fmtBytes(p.downloadBytes)}) · conflicts ${p.conflicts} · excluded ${p.excluded}${p.warnings.map((w) => `\n⚠ ${w}`).join('')}`,
        );
        return EXIT.ok;
      }
      const p = await this.call<PairDto>('POST', '/v1/pairs', body);
      this.out(p, () => `pair #${p.id} created`);
      return EXIT.ok;
    }
    if (sub === 'remove') {
      const r = await this.call('DELETE', `/v1/pairs/${intArg(id, 'pair id')}`, {});
      this.out(r, () => `pair ${id} removed (files untouched)`);
      return EXIT.ok;
    }
    if (sub === 'set') {
      const patch = kvPatch(rest);
      if (!Object.keys(patch).length) throw usage('pairs set N key=value ...');
      const p = await this.call<PairDto>('PATCH', `/v1/pairs/${intArg(id, 'pair id')}`, patch);
      this.out(p, () => `pair #${p.id} updated`);
      return EXIT.ok;
    }
    throw usage(`unknown pairs subcommand ${sub}`);
  }

  private async tokens(args: string[]): Promise<number> {
    const [sub = 'list', id, ...rest] = args;
    if (sub === 'list') {
      const l = await this.call<AgentTokenInfoDto[]>('GET', '/v1/tokens');
      this.out(l, () => l.map(tokenLine).join('\n'));
      return EXIT.ok;
    }
    if (sub === 'create') {
      if (!id) throw usage('tokens create NAME --scopes sync,manage[,destructive] [--no-file]');
      const scopes = String(this.v.scopes ?? 'read')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const t = await this.call<CreateAgentTokenResponse>('POST', '/v1/tokens', {
        name: [id, ...rest].join(' '),
        scopes,
        writeFile: !this.v['no-file'],
      });
      this.out(
        t,
        () =>
          `token ${t.id} "${t.name}" (${t.scopes.join(', ')})\n` +
          (t.file ? `stored in ${t.file} — agents use: nucleon-sync --agent "${t.name}" ...\n` : '') +
          `secret (shown once): ${t.token}`,
      );
      return EXIT.ok;
    }
    if (!id) throw usage(`tokens ${sub} ID`);
    if (sub === 'revoke' || sub === 'delete') {
      const r = await this.call('DELETE', `/v1/tokens/${encodeURIComponent(id)}`, {});
      this.out(r, () => `token ${id} revoked`);
      return EXIT.ok;
    }
    if (sub === 'enable' || sub === 'disable' || sub === 'set') {
      const patch: Record<string, unknown> = sub === 'set' ? kvPatch(rest) : { disabled: sub === 'disable' };
      if (typeof patch.scopes === 'string') patch.scopes = patch.scopes.split(',').filter(Boolean);
      const t = await this.call<AgentTokenInfoDto>('PATCH', `/v1/tokens/${encodeURIComponent(id)}`, patch);
      this.out(t, () => tokenLine(t));
      return EXIT.ok;
    }
    throw usage(`unknown tokens subcommand ${sub}`);
  }

  private async approvals(args: string[]): Promise<number> {
    const [sub = 'list', id] = args;
    if (sub === 'list') {
      const l = await this.call<ApprovalDto[]>('GET', '/v1/approvals');
      this.out(l, () => l.map(approvalLine).join('\n') || 'no approvals');
      return EXIT.ok;
    }
    if (sub === 'show') {
      if (!id) throw usage('approvals show ID');
      const a = await this.call<ApprovalDto>('GET', `/v1/approvals/${encodeURIComponent(id)}`);
      this.out(a, () => approvalLine(a));
      return EXIT.ok;
    }
    if (sub === 'approve' || sub === 'deny') {
      if (!id) throw usage(`approvals ${sub} ID`);
      const a = await this.call<ApprovalDto>('POST', `/v1/approvals/${encodeURIComponent(id)}/${sub}`, {});
      this.out(a, () => approvalLine(a));
      return EXIT.ok;
    }
    throw usage(`unknown approvals subcommand ${sub}`);
  }

  /** status-bar JSON: once, or (`--watch`) one line per change for Waybar's continuous mode */
  private async bar(): Promise<number> {
    const format = (this.v.format === 'omarchy' ? 'omarchy' : 'waybar') as BarFormat;
    const lang = barLang(this.env);
    const print = (s: StatusDto | null, detail?: string) =>
      process.stdout.write(JSON.stringify(barOutput(s, { format, lang, detail })) + '\n');
    if (!this.v.watch) {
      try {
        print(await this.raw<StatusDto>('GET', '/v1/status'));
      } catch (e) {
        print(null, (e as Error).message);
      }
      return EXIT.ok; // a bar module must never fail
    }
    let last = '';
    let timer: NodeJS.Timeout | null = null;
    const emit = (s: StatusDto | null) => {
      const line = JSON.stringify(barOutput(s, { format, lang }));
      if (line !== last) process.stdout.write(line + '\n');
      last = line;
    };
    for (;;) {
      try {
        const c = this.client();
        await new Promise<void>((resolve) => {
          // anything but the coalesced status: re-read the status at most once per second
          const refresh = () => {
            if (timer) return;
            timer = setTimeout(() => {
              timer = null;
              void this.raw<StatusDto>('GET', '/v1/status')
                .then(emit)
                .catch(() => undefined);
            }, 1000);
          };
          c.subscribe(
            (ev) => {
              if (ev.type === 'hello' || ev.type === 'status') emit(ev.status);
              else if (ev.type !== 'heartbeat' && ev.type !== 'activity' && ev.type !== 'job') refresh();
            },
            () => resolve(),
          );
        });
      } catch {
        /* not configured yet */
      }
      this.clientCache = null;
      emit(null);
      await sleep(5000);
    }
  }

  /** open the dashboard (packaged launcher `nucleon-sync-gui`, or NUCLEON_SYNC_GUI) on a screen */
  private async open(screen?: string): Promise<number> {
    const gui = this.env.NUCLEON_SYNC_GUI || 'nucleon-sync-gui';
    const args = screen ? [`--open=${screen}`] : ['--open'];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(gui, args, { detached: true, stdio: 'ignore', env: this.env });
      p.once('error', (e) =>
        reject(new CliError(EXIT.error, 'gui_missing', `cannot start ${gui}: ${e.message} (set NUCLEON_SYNC_GUI)`)),
      );
      p.once('spawn', () => {
        p.unref();
        resolve();
      });
    });
    this.out({ ok: true, screen: screen ?? null }, () => 'dashboard opened');
    return EXIT.ok;
  }

  /** --wait (daemon >= 0.2): the exact runs covering the request, in order, once all finished */
  private async waitForRuns(ids: number[]): Promise<RunDto[]> {
    const timeoutMs = Number(this.v.timeout ?? 0) * 1000 || 6 * 3600_000;
    const end = Date.now() + timeoutMs;
    const done = new Map<number, RunDto>();
    for (;;) {
      for (const id of ids) {
        if (done.has(id)) continue;
        const x = await this.call<RunDto>('GET', `/v1/runs/${id}`);
        if (x.finishedAt && x.status !== 'running' && x.status !== 'queued') done.set(id, x);
      }
      if (done.size === ids.length) return ids.map((id) => done.get(id)!);
      if (Date.now() > end)
        throw new CliError(EXIT.error, 'timeout', `timeout waiting for the run (${timeoutMs / 1000} s)`);
      await sleep(1000);
    }
  }

  /**
   * --wait against an older daemon (no `runIds`): returns the finished run that covers the request. When a run was already active the request was merged
   * into a follow-up run (id > runId) — that one is awaited, not the run that started before the request.
   */
  private async waitForRun(r: SyncResponse, req: { accountId?: string; pairId?: number }): Promise<RunDto> {
    // conservative: an account-scoped run does not count for a pair request (the follow-up carries the pair id)
    const covers = (x: RunDto) =>
      (x.pairId === null || x.pairId === req.pairId) &&
      (x.accountId === null || x.accountId === req.accountId || (req.pairId !== undefined && x.pairId === req.pairId));
    const timeoutMs = Number(this.v.timeout ?? 0) * 1000 || 6 * 3600_000;
    const end = Date.now() + timeoutMs;
    for (;;) {
      await sleep(1000);
      const runs = await this.call<RunDto[]>('GET', '/v1/runs?limit=50');
      const hit = runs
        .filter((x) => (r.followUp ? x.id > r.runId : x.id === r.runId) && x.finishedAt && covers(x))
        .sort((a, b) => a.id - b.id)[0];
      if (hit) return hit;
      if (Date.now() > end)
        throw new CliError(EXIT.error, 'timeout', `timeout waiting for the run (${timeoutMs / 1000} s)`);
    }
  }

  /** doctor via the API, or in-process (read-only) when the daemon is not running. */
  private async doctor(): Promise<number> {
    let checks: DoctorCheck[];
    try {
      checks = await this.call<DoctorCheck[]>('GET', '/v1/doctor');
    } catch (e) {
      if (!(e instanceof CliError) || e.exitCode !== EXIT.daemonDown) throw e;
      checks = localDoctor(this.env, e.message);
    }
    this.out(checks, () =>
      checks
        .map(
          (c) =>
            `${c.ok ? '✓' : c.severity === 'error' ? '✗' : c.severity === 'warn' ? '!' : '·'} ${c.id.padEnd(22)} ${c.message}`,
        )
        .join('\n'),
    );
    return doctorFailed(checks) ? EXIT.error : EXIT.ok;
  }
}

/** Doctor without a daemon: reads the state DB read-only if it exists, otherwise checks the first-start defaults. */
export function localDoctor(env: NodeJS.ProcessEnv, apiDetail: string): DoctorCheck[] {
  const paths = resolvePaths(env);
  const mock = env.NUCLEON_SYNC_MOCK === '1';
  let cfg: { cliPath?: string; stagingDir?: string; requiredMounts?: string[] } = {};
  try {
    if (existsSync(paths.daemonConfigFile))
      cfg = JSON.parse(readFileSync(paths.daemonConfigFile, 'utf8')) as typeof cfg;
  } catch {
    /* ignore */
  }
  const cliPath =
    env.NUCLEON_SYNC_CLI ??
    (mock
      ? new URL('../../../mock-cli/bin/mock-proton-drive', import.meta.url).pathname
      : (cfg.cliPath ?? defaultCliPath(env)));
  type Acc = Parameters<typeof runDoctor>[0]['accounts'][number];
  type Pr = Parameters<typeof runDoctor>[0]['pairs'][number];
  let accounts: Acc[] = [];
  let pairs: Pr[] = [];
  let fromDb = false;
  if (existsSync(paths.dbFile)) {
    try {
      const db = new DatabaseSync(paths.dbFile, { readOnly: true });
      accounts = db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as unknown as Acc[];
      pairs = db.prepare('SELECT * FROM pairs ORDER BY id').all() as unknown as Pr[];
      db.close();
      fromDb = true;
    } catch {
      /* no readable database: first-start checks only */
    }
  }
  const checks = runDoctor({
    env,
    paths,
    cliPath,
    mode: mock ? 'mock' : 'production',
    accounts,
    pairs,
    stagingDir: cfg.stagingDir ?? path.join(paths.stateDir, 'staging'),
    requiredMounts: cfg.requiredMounts,
    secretFileDir:
      mock && env.NUCLEON_SYNC_HOME ? path.join(path.resolve(env.NUCLEON_SYNC_HOME), 'mock', 'secrets') : undefined,
    api: { reachable: false, detail: apiDetail },
  });
  if (!fromDb) {
    const m = msg('doctor.noDatabase');
    checks.unshift({ id: 'config', ok: true, severity: 'info', message: m.text, msg: refOf(m)! });
  }
  return checks;
}

async function main(argv: string[]): Promise<number> {
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  const json = own.includes('--json');
  const fail = (e: CliError): number => {
    if (json)
      console.log(
        JSON.stringify({ ok: false, exitCode: e.exitCode, code: e.code, error: e.message, ...e.extra }, null, 2),
      );
    console.error(`nucleon-sync: ${e.message}${e.exitCode === EXIT.usage && !json ? `\n\n${USAGE}` : ''}`);
    return e.exitCode;
  };
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        'ui-token': { type: 'boolean', default: false },
        agent: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        confirm: { type: 'boolean', default: false },
        'confirm-token': { type: 'string' },
        'approval-timeout': { type: 'string' },
        account: { type: 'string' },
        pair: { type: 'string' },
        full: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: false },
        timeout: { type: 'string' },
        'no-wait': { type: 'boolean', default: false },
        limit: { type: 'string' },
        since: { type: 'string' },
        action: { type: 'string' },
        q: { type: 'string' },
        state: { type: 'string' },
        for: { type: 'string' },
        now: { type: 'boolean', default: false },
        toggle: { type: 'boolean', default: false },
        measure: { type: 'boolean', default: false },
        history: { type: 'boolean', default: false },
        'allow-write': { type: 'boolean', default: false },
        name: { type: 'string' },
        local: { type: 'string' },
        remote: { type: 'string' },
        direction: { type: 'string' },
        disabled: { type: 'boolean', default: false },
        rotate: { type: 'boolean', default: false },
        scopes: { type: 'string' },
        'no-file': { type: 'boolean', default: false },
        prefix: { type: 'string' },
        format: { type: 'string' },
        watch: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (e) {
    return fail(usage((e as Error).message));
  }
  if (values.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const [cmd = 'status', ...rest] = positionals;
  const cli = new Cli(values, process.env);
  try {
    return await cli.run(cmd, cmd === 'cli' ? passthrough : rest);
  } catch (e) {
    if (e instanceof CliError) return fail(e);
    return fail(new CliError(EXIT.error, 'error', (e as Error).message));
  }
}

process.exitCode = await main(process.argv.slice(2));
