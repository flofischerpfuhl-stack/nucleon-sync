// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import http from 'node:http';

import type { StatusDto, SyncRequest, SyncResponse, PauseRequest } from './api.ts';
import type { DaemonEvent } from './events.ts';
import { resolvePaths } from './paths.ts';

/**
 * Minimal API client used by the Electron main process and the `nucleon-sync` CLI.
 * Transport: Unix socket (default) or TCP 127.0.0.1:<port>. Always sends the bearer token.
 */
export interface ClientOptions {
  socketPath?: string;
  host?: string;
  port?: number;
  token: string;
  timeoutMs?: number;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class NucleonSyncClient {
  private readonly opts: ClientOptions;
  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  /**
   * Client for the local daemon using the standard paths (socket + token file). `scope: 'agent'` uses the limited
   * agent token (~/.config/nucleon-sync/agent-token), default is the UI token (api-token).
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, o: { scope?: 'ui' | 'agent' } = {}): NucleonSyncClient {
    const paths = resolvePaths(env);
    const token = readFileSync(o.scope === 'agent' ? paths.agentTokenFile : paths.tokenFile, 'utf8').trim();
    if (env.NUCLEON_SYNC_API_PORT) {
      return new NucleonSyncClient({ host: '127.0.0.1', port: Number(env.NUCLEON_SYNC_API_PORT), token });
    }
    return new NucleonSyncClient({ socketPath: paths.socketFile, token });
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          ...this.target(),
          method,
          path,
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          },
          timeout: this.opts.timeoutMs ?? 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 400) {
              reject(new ApiRequestError(res.statusCode ?? 500, text));
              return;
            }
            try {
              resolve((text ? JSON.parse(text) : undefined) as T);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('API request timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  status(): Promise<StatusDto> {
    return this.request<StatusDto>('GET', '/v1/status');
  }

  sync(body: SyncRequest = {}): Promise<SyncResponse> {
    return this.request('POST', '/v1/sync', body);
  }

  pause(body: PauseRequest): Promise<{ ok: true }> {
    return this.request('POST', '/v1/pause', body);
  }

  resume(body: PauseRequest): Promise<{ ok: true }> {
    return this.request('POST', '/v1/resume', body);
  }

  /** Subscribe to SSE events; returns an unsubscribe function. Reconnect is the caller's job. */
  subscribe(onEvent: (e: DaemonEvent) => void, onClose?: (err?: Error) => void): () => void {
    const req = http.request(
      {
        ...this.target(),
        method: 'GET',
        path: '/v1/events',
        headers: { authorization: `Bearer ${this.opts.token}`, accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          onClose?.(new ApiRequestError(res.statusCode ?? 500, 'SSE rejected'));
          res.resume();
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as DaemonEvent);
            } catch {
              /* ignore malformed event */
            }
          }
        });
        res.on('end', () => onClose?.());
      },
    );
    req.on('error', (err) => onClose?.(err));
    req.end();
    return () => req.destroy();
  }

  private target(): { socketPath: string } | { host: string; port: number } {
    if (this.opts.socketPath) return { socketPath: this.opts.socketPath };
    return { host: this.opts.host ?? '127.0.0.1', port: this.opts.port ?? 47821 };
  }
}
