// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Local API: HTTP/1.1 + JSON + SSE over a Unix socket (0600, primary) and optionally TCP 127.0.0.1.
 * Every request needs `Authorization: Bearer <token>`: the UI token (api-token, scope `ui`, every permission) or an
 * agent token (legacy `agent-token` = `default` with read + sync, or a named token with its scopes, api/agentTokens.ts;
 * 403 when a route needs a permission the token lacks). Destructive requests of agents wait for the user's approval. Over TCP additionally:
 * Host must be 127.0.0.1:<port>/localhost:<port> (DNS-rebinding guard) and requests carrying an Origin header are
 * rejected (no browser access, no CORS). Destructive routes use the confirm round-trip (api/confirm.ts).
 * Endpoint table: docs/ARCHITECTURE.md §6 and api/routes.ts.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { ApiError, ApprovalDto, DaemonEvent, RoutePermission, TokenScope } from '@nucleon-sync/shared';

import type { EngineApi } from '../engine/api.ts';
import { HttpError } from '../util/http.ts';
import { log } from '../util/log.ts';
import { tokenMatches } from '../util/token.ts';
import { BarFiles } from './barFile.ts';
import { AgentTokens, UI_PRINCIPAL, type Principal } from './agentTokens.ts';
import { ConfirmManager } from './confirm.ts';
import { buildRoutes, NOT_IMPLEMENTED, type Route, type RouteCtx, type Summary } from './routes.ts';
import type { Services } from './services.ts';

export interface ApiServerOptions {
  engine: EngineApi;
  /** ui = api-token (full), agent = agent-token (limited) */
  tokens: { ui: string; agent: string | null };
  services: Services;
  /** named agent tokens; default: registry next to the token files */
  agentTokens?: AgentTokens;
  socketPath?: string;
  tcpPort?: number | null;
}

export class ApiServer {
  private readonly o: ApiServerOptions;
  private readonly routes: Route[];
  private readonly servers: http.Server[] = [];
  private readonly sseClients = new Map<ServerResponse, Principal>();
  private heartbeat: NodeJS.Timeout | null = null;
  readonly confirm = new ConfirmManager();
  readonly agentTokens: AgentTokens;
  readonly bar: BarFiles;
  private readonly onEvent = (ev: DaemonEvent) => {
    this.broadcast(ev);
    this.bar.onEvent(ev);
  };

  constructor(o: ApiServerOptions) {
    this.o = o;
    this.agentTokens = o.agentTokens ?? new AgentTokens(o.services.ctx.paths, o.tokens.agent);
    this.agentTokens.onRevoke = (id) => {
      this.confirm.dropToken(id);
      for (const [res, p] of this.sseClients) if (p.tokenId === id) res.end();
    };
    this.bar = new BarFiles(
      o.services.ctx.paths.runtimeDir,
      () => ({ ...o.engine.status(), pausedUntil: o.services.pauses.globalUntil() }),
      o.services.ctx.env,
    );
    this.confirm.onApproval = (a: ApprovalDto) => this.broadcast({ type: 'approval', approval: a });
    this.routes = buildRoutes({
      engine: o.engine,
      services: o.services,
      confirm: this.confirm,
      tokens: o.tokens,
      agentTokens: this.agentTokens,
    });
    o.engine.on('event', this.onEvent);
  }

  /** UI token, or an agent token of the registry; null = unauthorized */
  private authenticate(header: string | undefined): Principal | null {
    if (tokenMatches(this.o.tokens.ui, header)) return UI_PRINCIPAL;
    return this.agentTokens.authenticate(header);
  }

  async listen(): Promise<void> {
    if (this.o.socketPath) {
      mkdirSync(path.dirname(this.o.socketPath), { recursive: true, mode: 0o700 });
      rmSync(this.o.socketPath, { force: true });
      const s = http.createServer((req, res) => void this.handle(req, res, 'unix'));
      await new Promise<void>((resolve, reject) => s.listen(this.o.socketPath, resolve).once('error', reject));
      chmodSync(this.o.socketPath, 0o600);
      this.servers.push(s);
      log('info', 'api listening', { socket: this.o.socketPath });
    }
    if (this.o.tcpPort) {
      const s = http.createServer((req, res) => void this.handle(req, res, 'tcp'));
      await new Promise<void>((resolve, reject) =>
        s.listen(this.o.tcpPort!, '127.0.0.1', resolve).once('error', reject),
      );
      this.servers.push(s);
      log('info', 'api listening', { tcp: `127.0.0.1:${this.o.tcpPort}` });
    }
    this.bar.start();
    this.heartbeat = setInterval(() => this.broadcast({ type: 'heartbeat', ts: new Date().toISOString() }), 15_000);
    this.heartbeat.unref();
  }

  async close(): Promise<void> {
    this.o.engine.off('event', this.onEvent);
    this.agentTokens.flush();
    this.bar.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.sseClients.keys()) c.end();
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => r());
            s.closeAllConnections();
          }),
      ),
    );
    if (this.o.socketPath) rmSync(this.o.socketPath, { force: true });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  private fail(
    res: ServerResponse,
    status: number,
    code: ApiError['code'],
    error: string,
    extra?: object | null,
  ): void {
    this.send(res, status, { ...(extra ?? {}), error, code });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, transport: 'unix' | 'tcp'): Promise<void> {
    try {
      if (transport === 'tcp') {
        const host = req.headers.host ?? '';
        const okHosts = [`127.0.0.1:${this.o.tcpPort}`, `localhost:${this.o.tcpPort}`];
        if (!okHosts.includes(host)) return this.fail(res, 403, 'forbidden', 'bad host');
        if (req.headers.origin) return this.fail(res, 403, 'forbidden', 'browser origins are not allowed');
      }
      const principal = this.authenticate(req.headers.authorization);
      if (!principal) return this.fail(res, 401, 'unauthorized', 'missing, bad, revoked or disabled token');
      const scope: TokenScope = principal.scope;
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/v1/events') return this.openSse(res, principal);
      const candidates = this.routes.filter((r) => r.pattern.test(url.pathname));
      const route = candidates.find((r) => r.method === req.method);
      if (!route) {
        if (candidates.length) return this.fail(res, 405, 'bad_request', `method ${req.method} not allowed here`);
        return this.fail(res, 404, 'not_found', `no route ${req.method} ${url.pathname}`);
      }
      const denied = permissionError(route.perm, principal);
      if (denied) return this.fail(res, 403, 'forbidden', denied, { needs: route.perm });
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        return this.fail(res, 400, 'bad_request', (e as Error).message);
      }
      const params = (url.pathname.match(route.pattern)?.slice(1) ?? []).map((p) => decodeURIComponent(p));
      const ctx: RouteCtx = {
        req,
        url,
        body,
        params,
        scope,
        principal,
        method: req.method ?? 'GET',
        path: url.pathname,
      };
      // agents: every destructive route waits for the user's approval before it runs (409 approval required/pending)
      if (route.perm === 'destructive' && principal.scope === 'agent') {
        this.confirm.require(ctx.method, ctx.path, body, () => route.summary?.(ctx) ?? genericSummary(ctx), principal);
        ctx.preApproved = true;
      }
      const out = await route.handler(ctx);
      if (out === NOT_IMPLEMENTED) return this.fail(res, 501, 'internal', 'not implemented yet ');
      this.send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return this.fail(res, e.status, e.code, e.message, e.body);
      log('error', 'api handler failed', { err: (e as Error).message });
      this.fail(res, 500, 'internal', (e as Error).message);
    }
  }

  private openSse(res: ServerResponse, principal: Principal): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    this.sseClients.set(res, principal);
    res.on('close', () => this.sseClients.delete(res));
    this.write(res, { type: 'hello', status: this.o.engine.status() });
  }

  private write(res: ServerResponse, ev: DaemonEvent): void {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }

  broadcast(ev: DaemonEvent): void {
    for (const c of this.sseClients.keys()) this.write(c, ev);
  }
}

/** null when the principal may call a route with this permission, else the 403 message */
export function permissionError(perm: RoutePermission, p: Principal): string | null {
  if (p.scope === 'ui') return null;
  if (perm === 'ui') return 'this endpoint needs the UI token (token management and approvals are for the user only)';
  if (p.permissions.includes(perm)) return null;
  return `the agent token "${p.name}" lacks the scope "${perm}" (Settings → Agents → create a token with that scope)`;
}

function genericSummary(c: RouteCtx): Summary {
  return {
    kind: 'generic',
    params: { method: c.method, path: c.path },
    title: `${c.method} ${c.path}`,
    items: 1,
    bytes: 0,
    details:
      c.body && typeof c.body === 'object'
        ? [JSON.stringify({ ...(c.body as object), confirmToken: undefined }).slice(0, 300)]
        : [],
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('body is not valid JSON');
  }
}
