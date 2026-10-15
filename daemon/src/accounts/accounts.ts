// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Account profiles (ARCHITECTURE §5.4–5.5): CRUD, login runner (URL/QR via SSE `login`), logout (the only path that
 * sets NUCLEON_SYNC_ALLOW_LOGOUT=1), keyring presence at boot (`needs_keyring` retried every 60 s), the foreign-process
 * gate for the adopted plain-CLI session, and the read-only CLI passthrough.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { cliWorkerDir, encodeMsg, msg, refOf, type AccountDto, type Msg } from '@nucleon-sync/shared';
import type {
  CliPassthroughRequest,
  CliPassthroughResponse,
  CreateAccountRequest,
  PatchAccountRequest,
} from '@nucleon-sync/shared';

import { buildCliEnv, shimBinDir, type AccountCliConfig } from '../cli/env.ts';
import { LoginRunner, runLogout } from '../cli/login.ts';
import { CliError } from '../cli/replWorker.ts';
import type { AccountRow } from '../db/repo.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../util/http.ts';
import { log } from '../util/log.ts';
import { ACCOUNT_ID_RE, PASS_ENTRY, PLAIN_CLI_SECRET, type ServiceContext } from './context.ts';
import { foreignCliProcesses, sessionIdOf, sessionState, type ForeignProcess } from './keyring.ts';

const MOCK_SEED_BIN = new URL('../../../mock-cli/bin/mock-proton-drive-seed', import.meta.url).pathname;

/** Read-only CLI commands allowed through `nucleon-sync cli` without --allow-write. */
export const READ_ONLY_CLI = [
  ['filesystem', 'list'],
  ['filesystem', 'info'],
  ['filesystem', 'size'],
];

/** accounts.last_error of "no stored session" (the German text of earlier versions too) */
const NO_SESSION = [encodeMsg(msg('account.noSession')), 'keine gespeicherte Sitzung'];

export class AccountsService {
  private readonly c: ServiceContext;
  private readonly logins = new Map<string, LoginRunner>();
  private keyringTimer: NodeJS.Timeout | null = null;
  private gateCache: { at: number; procs: ForeignProcess[] } | null = null;
  private gateTimer: NodeJS.Timeout | null = null;
  private gated = new Set<string>();
  private closed = false;

  constructor(c: ServiceContext) {
    this.c = c;
  }

  // ------------------------------------------------------------ rows

  row(id: string): AccountRow | null {
    return (
      (this.c.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined) ?? null
    );
  }

  rows(): AccountRow[] {
    return this.c.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as unknown as AccountRow[];
  }

  require(id: string): AccountRow {
    const r = this.row(id);
    if (!r) throw notFound(`unknown account ${id}`);
    return r;
  }

  dto(id: string): AccountDto {
    const a = this.c.engine.accounts().find((x) => x.id === id);
    if (!a) throw notFound(`unknown account ${id}`);
    return a;
  }

  // ------------------------------------------------------------ CRUD

  create(req: CreateAccountRequest): AccountDto {
    if (!req || typeof req !== 'object') throw badRequest('body must be {id, displayName}');
    const id = String(req.id ?? '');
    const displayName = String(req.displayName ?? '').trim();
    if (!ACCOUNT_ID_RE.test(id)) throw badRequest('id must match [a-z0-9][a-z0-9_-]{0,31}');
    if (!displayName || displayName.length > 64) throw badRequest('displayName required (max 64 chars)');
    const workers = req.workers ?? 1;
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw badRequest('workers must be 1..4');
    if (this.row(id)) throw conflict(`account ${id} already exists`);
    const mock = this.c.mode === 'mock';
    if (mock) this.ensureMockRemote(id);
    // no Secret Service on this desktop (wizard choice, daemon.json secretBackend) -> encrypted file store
    const requested = req.credentialBackend as string | undefined;
    if (requested !== undefined && requested !== 'keyring-shim' && requested !== 'encfile')
      throw badRequest('credentialBackend must be keyring-shim or encfile');
    const backend = mock
      ? 'mock'
      : (requested ?? (this.c.config.secretBackend === 'encfile' ? 'encfile' : 'keyring-shim'));
    const keyring = backend === 'keyring-shim';
    this.c.db
      .prepare(
        `INSERT INTO accounts (id, display_name, email, credential_backend, secret_service, secret_key, secret_schema, workers, status, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, 'needs_login', ?)`,
      )
      .run(id, displayName, backend, keyring ? 'nucleon-sync' : null, keyring ? id : null, workers, Date.now());
    // an existing session (re-created profile, or a mock remote with a stored session) is picked up right away
    const st = sessionState(this.require(id), this.c.env, this.c.secretFileDir, this.c.paths);
    if (st === 'present') this.c.engine.setAccountState(id, 'ok', null);
    void this.c.engine.reload();
    this.c.engine.emitEvent({
      type: 'account',
      accountId: id,
      status: this.require(id).status as AccountDto['status'],
    });
    return this.dto(id);
  }

  patch(id: string, req: PatchAccountRequest): AccountDto {
    this.require(id);
    if (!req || typeof req !== 'object') throw badRequest('body must be an object');
    if (req.displayName !== undefined) {
      const n = String(req.displayName).trim();
      if (!n || n.length > 64) throw badRequest('displayName required (max 64 chars)');
      this.c.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(n, id);
    }
    if (req.workers !== undefined) {
      if (!Number.isInteger(req.workers) || req.workers < 1 || req.workers > 4)
        throw badRequest('workers must be 1..4');
      this.c.db.prepare('UPDATE accounts SET workers = ? WHERE id = ?').run(req.workers, id);
    }
    if (req.enabled !== undefined) {
      if (typeof req.enabled !== 'boolean') throw badRequest('enabled must be boolean');
      this.c.db.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(req.enabled ? 1 : 0, id);
    }
    void this.c.engine.reload();
    return this.dto(id);
  }

  /** Removes the profile (not the keyring item — log out first). Refused while pairs exist. */
  async remove(id: string): Promise<void> {
    this.require(id);
    const pairs = (this.c.db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE account_id = ?').get(id) as { n: number })
      .n;
    if (pairs) throw conflict(`account ${id} still has ${pairs} pair(s); delete them first`);
    this.logins.get(id)?.cancel();
    await this.c.engine.resetAccount(id);
    const db = this.c.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM jobs WHERE account_id = ?').run(id);
      db.prepare('UPDATE runs SET account_id = NULL WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM storage_samples WHERE account_id = ?').run(id);
      db.prepare("DELETE FROM pause_timers WHERE scope = 'account' AND target = ?").run(id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    await this.c.engine.reload();
  }

  // ------------------------------------------------------------ CLI env for one-shot processes (login/logout)

  private cliConfig(r: AccountRow): AccountCliConfig {
    return {
      accountId: r.id,
      credentialBackend: r.credential_backend,
      secretService: r.secret_service,
      secretKey: r.secret_key,
      secretSchema: r.secret_schema,
      extraEnv: this.c.accountEnv[r.id] ?? {},
    };
  }

  private oneShotEnv(r: AccountRow, dirName: string): NodeJS.ProcessEnv {
    const dir = path.join(path.dirname(cliWorkerDir(this.c.paths, r.id, 0)), dirName);
    return buildCliEnv(this.c.env, this.cliConfig(r), dir, {
      shimEventsFile: path.join(this.c.paths.stateDir, 'shim-events.jsonl'),
      secretFileDir: this.c.secretFileDir,
      encFile: { dir: this.c.paths.secretsDir, keyFile: this.c.paths.secretKeyFile },
    });
  }

  // ------------------------------------------------------------ login / logout

  /** Starts `auth login -j` for the account and resolves with the sign-in URL (SSE `login` url/done/failed follow). */
  async startLogin(id: string): Promise<{ accountId: string; signInUrl: string }> {
    const r = this.require(id);
    if (r.credential_backend === 'keychain-direct')
      throw badRequest('keychain-direct accounts log in with the plain CLI');
    const running = this.logins.get(id);
    if (running?.running && running.signInUrl) return { accountId: id, signInUrl: running.signInUrl };
    const gate = this.gate(id);
    if (gate) throw conflict(gate);
    const before = r.status as AccountDto['status'];
    await this.c.engine.resetAccount(id); // workers hold the old (or no) session
    this.c.engine.setAccountState(id, 'login_pending', null);
    const runner = new LoginRunner({
      cliPath: this.c.cliPath,
      env: this.oneShotEnv(r, 'login'),
      timeoutMs: Number(this.c.env.NUCLEON_SYNC_LOGIN_TIMEOUT_MS) || undefined,
    });
    this.logins.set(id, runner);
    runner.on('url', (signInUrl: string) =>
      this.c.engine.emitEvent({ type: 'login', accountId: id, phase: 'url', signInUrl }),
    );
    runner.on('failed', (message: string, m: Msg | null) => {
      log('warn', 'login failed', { account: id, message });
      this.c.engine.emitEvent({
        type: 'login',
        accountId: id,
        phase: 'failed',
        message,
        ...(m ? { msg: refOf(m) } : {}),
      });
      const st = sessionState(this.require(id), this.c.env, this.c.secretFileDir);
      this.c.engine.setAccountState(
        id,
        st === 'present' && before === 'ok' ? 'ok' : 'needs_login',
        st === 'present' ? null : (m ?? message),
      );
    });
    runner.on('done', () => void this.afterLogin(id));
    try {
      const signInUrl = await runner.start();
      return { accountId: id, signInUrl };
    } catch (e) {
      throw new HttpError(502, 'internal', `login could not start: ${(e as Error).message}`);
    }
  }

  cancelLogin(id: string): void {
    this.require(id);
    const r = this.logins.get(id);
    if (!r?.running) throw conflict('no login running');
    r.cancel();
  }

  private async afterLogin(id: string): Promise<void> {
    log('info', 'login done', { account: id });
    await this.c.engine.resetAccount(id);
    this.c.engine.setAccountState(id, 'ok', null);
    this.c.engine.emitEvent({ type: 'login', accountId: id, phase: 'done' });
    try {
      // fill the account card: cheap probe + owner e-mail from the my-files root
      const info = await this.c.engine
        .poolFor(id)
        .withWorker((w) => w.json<{ ownedBy?: { email?: string } }>(['filesystem', 'info', '/my-files']), {
          priority: 10,
        });
      const email = info?.ownedBy?.email;
      if (email) this.c.db.prepare('UPDATE accounts SET email = ? WHERE id = ?').run(email, id);
      this.c.engine.setAccountState(id, 'ok', null);
      this.c.engine.kick(id);
    } catch (e) {
      log('warn', 'post-login probe failed', { account: id, err: (e as Error).message });
    }
  }

  /** Explicit logout (confirmed by the caller): CLI `auth logout` + shim removal with NUCLEON_SYNC_ALLOW_LOGOUT=1. */
  async logout(id: string): Promise<void> {
    const r = this.require(id);
    if (r.credential_backend === 'keychain-direct')
      throw badRequest('keychain-direct accounts log out with the plain CLI');
    this.logins.get(id)?.cancel();
    await this.c.engine.resetAccount(id);
    const env = this.oneShotEnv(r, 'logout');
    const res = await runLogout(this.c.cliPath, env);
    if (res.code !== 0)
      log('warn', 'cli logout failed, removing the stored session anyway', { account: id, err: res.stderr });
    // the CLI only removes the session when it could reach the server; make sure the keyring item is gone
    const rm = spawnSync(path.join(shimBinDir(this.c.env), 'pass'), ['rm', '-f', PASS_ENTRY], {
      env: { ...env, NUCLEON_SYNC_ALLOW_LOGOUT: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (rm.status !== 0)
      throw new HttpError(500, 'internal', `could not remove the session: ${(rm.stderr || '').trim()}`);
    this.c.engine.setAccountState(id, 'needs_login', 'abgemeldet');
  }

  // ------------------------------------------------------------ keyring presence (boot, every 60 s while waiting)

  /** Boot check: needs_keyring while the Secret Service is unavailable/locked, needs_login when the item is missing. */
  checkKeyrings(): void {
    let waiting = false;
    for (const r of this.rows()) {
      if (r.credential_backend === 'keychain-direct' || this.logins.get(r.id)?.running) continue;
      const st = sessionState(r, this.c.env, this.c.secretFileDir, this.c.paths);
      if (st === 'unavailable' || st === 'locked') {
        waiting = true;
        this.c.engine.setAccountState(
          r.id,
          'needs_keyring',
          msg(st === 'locked' ? 'account.keyringLocked' : 'account.keyringUnavailable'),
        );
      } else if (st === 'missing') {
        if (r.status !== 'needs_login') this.c.engine.setAccountState(r.id, 'needs_login', msg('account.noSession'));
      } else if (
        r.status === 'needs_keyring' ||
        (r.status === 'needs_login' && NO_SESSION.includes(r.last_error ?? ''))
      ) {
        this.c.engine.setAccountState(r.id, 'ok', null);
        this.c.engine.kick(r.id);
      }
    }
    if (this.keyringTimer) clearTimeout(this.keyringTimer);
    this.keyringTimer = null;
    if (waiting && !this.closed) {
      this.keyringTimer = setTimeout(() => this.checkKeyrings(), 60_000);
      this.keyringTimer.unref();
    }
  }

  // ------------------------------------------------------------ foreign-process gate (adopted plain-CLI session)

  /** True for accounts that share the plain CLI's keychain item (legacy: an account that shares the session of a manual `proton-drive` login). */
  sharesPlainCliSession(r: AccountRow): boolean {
    return r.credential_backend === 'keychain-direct' || r.secret_service === PLAIN_CLI_SECRET.service;
  }

  /** Session identity of an account as foreign processes would show it (keyring.ts sessionIdOf). */
  sessionId(r: AccountRow): string {
    if (this.sharesPlainCliSession(r)) return 'keychain';
    if (r.credential_backend === 'mock')
      return sessionIdOf({
        PROTON_DRIVE_CREDENTIALS_STORE: 'pass',
        NUCLEON_SYNC_SECRET_BACKEND: 'file',
        NUCLEON_SYNC_SECRET_FILE_DIR: this.c.secretFileDir,
        NUCLEON_SYNC_ACCOUNT: r.id,
      });
    return sessionIdOf({
      PROTON_DRIVE_CREDENTIALS_STORE: 'pass',
      NUCLEON_SYNC_SECRET_BACKEND: r.credential_backend === 'encfile' ? 'encfile' : 'libsecret',
      NUCLEON_SYNC_SECRET_FILE_DIR: this.c.secretFileDir,
      NUCLEON_SYNC_SECRET_SERVICE: r.secret_service ?? undefined,
      NUCLEON_SYNC_SECRET_KEY: r.secret_key ?? undefined,
      NUCLEON_SYNC_ACCOUNT: r.id,
    });
  }

  /**
   * Engine gate: an account does not run (and keeps no CLI process) while another proton-drive process uses the same
   * stored session — a script or a manual call on the plain CLI session (adopted account), another
   * nucleon-sync instance, or a worker left over from a crashed daemon. Parallel token refreshes can make one of them
   * delete the session. Processes whose environment is not readable are treated as using the plain CLI session.
   * Off in mock mode unless NUCLEON_SYNC_FOREIGN_GATE=1 (tests); NUCLEON_SYNC_IGNORE_FOREIGN_CLI=1 disables it.
   */
  gate(accountId: string): string | null {
    return this.gateMsg(accountId)?.text ?? null;
  }

  /** gate() as a message (key + params for the dashboard) */
  gateMsg(accountId: string): Msg | null {
    if (this.c.env.NUCLEON_SYNC_IGNORE_FOREIGN_CLI === '1') return null;
    if (this.c.mode === 'mock' && this.c.env.NUCLEON_SYNC_FOREIGN_GATE !== '1') return null;
    const r = this.row(accountId);
    if (!r) return null;
    const now = Date.now();
    if (!this.gateCache || now - this.gateCache.at > this.gateCacheMs())
      this.gateCache = { at: now, procs: foreignCliProcesses(this.c.cliPath) };
    const mine = this.sessionId(r);
    const procs = this.gateCache.procs.filter((p) => (p.session ?? 'keychain') === mine);
    if (!procs.length) {
      if (this.gated.delete(accountId)) {
        log('info', 'foreign proton-drive processes gone, account released', { account: accountId });
        this.c.engine.setAccountState(accountId, 'ok', null);
        this.c.engine.kick(accountId);
      }
      return null;
    }
    const m = msg('account.foreignCli', { pids: procs.map((p) => p.pid).join(', ') });
    if (!this.gated.has(accountId)) {
      this.gated.add(accountId);
      log('warn', 'foreign proton-drive processes, account gated', {
        account: accountId,
        pids: procs.map((p) => p.pid),
      });
      this.c.engine.setAccountState(accountId, 'error', m);
      // our own workers must not keep running next to it (kill even in the middle of a command)
      setImmediate(() => this.c.engine.enforceGates(accountId, true));
      this.scheduleGateRecheck();
    }
    return m;
  }

  private gateCacheMs(): number {
    return Number(this.c.env.NUCLEON_SYNC_FOREIGN_GATE_CACHE_MS ?? 30_000);
  }

  private scheduleGateRecheck(): void {
    if (this.gateTimer || this.closed) return;
    this.gateTimer = setTimeout(
      () => {
        this.gateTimer = null;
        this.gateCache = null;
        for (const id of [...this.gated]) this.gate(id);
        if (this.gated.size) this.scheduleGateRecheck();
      },
      Math.min(60_000, this.gateCacheMs() * 2),
    );
    this.gateTimer.unref();
  }

  // ------------------------------------------------------------ CLI passthrough

  async cli(id: string, req: CliPassthroughRequest, scope: 'ui' | 'agent'): Promise<CliPassthroughResponse> {
    this.require(id);
    const args = req?.args;
    if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string' || /[\n\r\0]/.test(a)))
      throw badRequest('args must be a non-empty string array without newlines');
    const clean = args.filter((a) => a !== '-j' && a !== '--json');
    const readOnly = READ_ONLY_CLI.some(([g, c]) => clean[0] === g && clean[1] === c);
    if (!readOnly) {
      if (!req.allowWrite)
        throw forbidden(`only ${READ_ONLY_CLI.map((x) => x.join(' ')).join(', ')} without --allow-write`);
      if (scope !== 'ui') throw forbidden('--allow-write needs the UI token');
      if (clean[0] === 'auth') throw forbidden('auth commands are not allowed here (use login/logout)');
      const guard = this.c.engine.writeGuard();
      if (guard) throw forbidden(guard);
    }
    const gate = this.gate(id);
    if (gate) throw conflict(gate);
    try {
      const r = await this.c.engine.poolFor(id).withWorker((w) => w.run(args, 5 * 60_000), { priority: 20 });
      return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      if (e instanceof CliError) return { exitCode: 1, stdout: e.stdout, stderr: e.stderr || e.message };
      throw e;
    }
  }

  // ------------------------------------------------------------ mock helpers

  private ensureMockRemote(id: string): void {
    if (!this.c.mockDir) throw badRequest('mock mode without mock dir');
    const remote = path.join(this.c.mockDir, `remote-${id}`);
    if (!existsSync(remote)) execFileSync(MOCK_SEED_BIN, ['--remote', remote, '--email', `${id}@mock.test`]);
    this.c.accountEnv[id] = {
      MOCK_PROTON_REMOTE: remote,
      MOCK_LATENCY_MS: this.c.env.MOCK_LATENCY_MS ?? '50',
      ...(this.c.env.MOCK_LOGIN_AUTO_APPROVE_MS
        ? { MOCK_LOGIN_AUTO_APPROVE_MS: this.c.env.MOCK_LOGIN_AUTO_APPROVE_MS }
        : {}),
    };
  }

  close(): void {
    this.closed = true;
    for (const r of this.logins.values()) r.cancel(msg('gate.shuttingDown'));
    if (this.keyringTimer) clearTimeout(this.keyringTimer);
    if (this.gateTimer) clearTimeout(this.gateTimer);
  }
}
