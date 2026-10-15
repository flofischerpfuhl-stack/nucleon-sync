// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Login/logout runner.
 *
 * Login: one-shot `proton-drive auth login -j` with the account's isolated env (own cache dir, secret-shim, BROWSER=true).
 * The CLI prints `{"signInUrl": "..."}` and waits until the user approved the URL (on any device); it then stores the
 * session through `pass insert` (-> shim -> keyring item of that account) and exits 0.
 *
 * Logout: one-shot `proton-drive auth logout` with NUCLEON_SYNC_ALLOW_LOGOUT=1 — the ONLY place that sets it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { msg, textOf, type TextOrMsg } from '@nucleon-sync/shared';

export interface LoginRunnerOptions {
  cliPath: string;
  env: NodeJS.ProcessEnv;
  /** total time to wait for the approval (default 10 min) */
  timeoutMs?: number;
  /** time to wait for the sign-in URL (default 60 s) */
  urlTimeoutMs?: number;
}

/** Emits 'url' (signInUrl), then exactly one of 'done' | 'failed' (English message, Msg | null). */
export class LoginRunner extends EventEmitter {
  private readonly o: LoginRunnerOptions;
  private proc: ChildProcess | null = null;
  private finished = false;
  private timer: NodeJS.Timeout | null = null;
  signInUrl: string | null = null;
  readonly startedAt = Date.now();
  /** resolves when the login finished (true = success) */
  readonly result: Promise<boolean>;
  private settle!: (ok: boolean) => void;

  constructor(o: LoginRunnerOptions) {
    super();
    this.o = o;
    this.result = new Promise((r) => (this.settle = r));
  }

  /** Starts the CLI and resolves with the sign-in URL (rejects if none arrives). */
  start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let out = '';
      let err = '';
      const proc = spawn(this.o.cliPath, ['auth', 'login', '-j'], {
        env: this.o.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;
      const urlTimer = setTimeout(() => {
        if (!this.signInUrl) {
          this.fail(msg('login.noUrl'));
          reject(new Error('no sign-in URL from the CLI'));
        }
      }, this.o.urlTimeoutMs ?? 60_000);
      this.timer = setTimeout(() => this.fail(msg('login.notConfirmed')), this.o.timeoutMs ?? 10 * 60_000);
      proc.stdout!.setEncoding('utf8');
      proc.stderr!.setEncoding('utf8');
      proc.stdout!.on('data', (d: string) => {
        out += d;
        let nl: number;
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          const url = parseSignInUrl(line);
          if (url && !this.signInUrl) {
            this.signInUrl = url;
            clearTimeout(urlTimer);
            this.emit('url', url);
            resolve(url);
          }
        }
      });
      proc.stderr!.on('data', (d: string) => {
        err = (err + d).slice(-2000);
      });
      proc.on('error', (e) => {
        clearTimeout(urlTimer);
        this.fail(msg('login.cliStartFailed', { error: e.message }));
        reject(e);
      });
      proc.on('exit', (code, sig) => {
        clearTimeout(urlTimer);
        if (this.finished) return;
        if (code === 0 && this.signInUrl) {
          this.finish();
          this.emit('done');
          this.settle(true);
        } else {
          const m =
            lastLine(err) ||
            (sig ? msg('login.cliAborted', { signal: sig }) : msg('login.cliExited', { code: String(code) }));
          this.fail(m);
          if (!this.signInUrl) reject(new Error(textOf(m)));
        }
      });
    });
  }

  cancel(reason: TextOrMsg = msg('login.cancelled')): void {
    this.fail(reason);
  }

  get running(): boolean {
    return !this.finished;
  }

  private finish(): void {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private fail(message: TextOrMsg): void {
    if (this.finished) return;
    this.finish();
    const p = this.proc;
    if (p && p.exitCode === null) {
      p.kill('SIGTERM');
      setTimeout(() => p.exitCode === null && p.kill('SIGKILL'), 3000).unref();
    }
    this.emit('failed', textOf(message), typeof message === 'string' ? null : message);
    this.settle(false);
  }
}

export function parseSignInUrl(line: string): string | null {
  if (!line.startsWith('{')) return null;
  try {
    const o = JSON.parse(line) as { signInUrl?: unknown };
    return typeof o.signInUrl === 'string' && /^https:\/\//.test(o.signInUrl) ? o.signInUrl : null;
  } catch {
    return null;
  }
}

function lastLine(s: string): string {
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  ).slice(0, 300);
}

/** `auth logout` with the explicit logout permission for the shim. Resolves with the exit code. */
export function runLogout(
  cliPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cliPath, ['auth', 'logout'], {
      env: { ...env, NUCLEON_SYNC_ALLOW_LOGOUT: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => (err = (err + d).slice(-2000)));
    const t = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 127, stderr: e.message });
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stderr: lastLine(err) });
    });
  });
}
