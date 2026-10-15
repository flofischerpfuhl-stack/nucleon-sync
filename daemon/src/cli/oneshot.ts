// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One-shot fallback worker (NUCLEON_SYNC_CLI_ONESHOT=1, ARCHITECTURE §5.3 item 7): every command runs as its own
 * `proton-drive <args>` process. Same interface and error semantics as ReplWorker, much slower (>= 1.5 s + ~8 API
 * requests per call with the real CLI). Useful for debugging or if a future CLI breaks REPL mode.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { classifyCliError } from './classify.ts';
import { CliError, CliTimeoutError, logCliTimeout, quoteArg, type CliResult } from './replWorker.ts';

export interface OneShotWorkerOptions {
  cliPath: string;
  env: NodeJS.ProcessEnv;
  name: string;
  defaultTimeoutMs?: number;
}

export class OneShotWorker extends EventEmitter {
  readonly name: string;
  private readonly opts: OneShotWorkerOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private current: ReturnType<typeof spawn> | null = null;
  commandsRun = 0;
  readonly startedAt = Date.now();

  constructor(opts: OneShotWorkerOptions) {
    super();
    this.opts = opts;
    this.name = opts.name;
  }

  get alive(): boolean {
    return true;
  }

  get pid(): number | null {
    return this.current?.pid ?? null;
  }

  get busy(): boolean {
    return !!this.current;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  run(args: string[], timeoutMs?: number): Promise<CliResult> {
    const task = this.queue.then(() => this.runNow(args, timeoutMs ?? this.opts.defaultTimeoutMs ?? 15 * 60_000));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async json<T>(args: string[], timeoutMs?: number): Promise<T> {
    const r = await this.run([...args, '-j'], timeoutMs);
    const text = r.stdout.trim();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`${this.name}: non-JSON output: ${text.slice(0, 200)}`, 'fatal', r.stdout, r.stderr);
    }
  }

  private runNow(args: string[], timeoutMs: number): Promise<CliResult> {
    for (const a of args) quoteArg(a); // same newline rule as the REPL
    this.commandsRun++;
    const started = Date.now();
    return new Promise<CliResult>((resolve, reject) => {
      const p = spawn(this.opts.cliPath, args, { env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.current = p;
      let out = '';
      let err = '';
      p.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
      p.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
      const timer = setTimeout(() => {
        logCliTimeout(this.name, args, timeoutMs, p.pid ?? null);
        p.kill('SIGKILL');
        reject(new CliTimeoutError(this.name, args, timeoutMs, out, err));
      }, timeoutMs);
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(new CliError(`${this.name}: spawn failed: ${e.message}`, 'fatal'));
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        this.current = null;
        const durationMs = Date.now() - started;
        this.emit('command', { durationMs, ok: code === 0 && !err.trim(), args });
        if (code !== 0 || err.trim())
          reject(new CliError(err.trim().slice(0, 2000) || `exit code ${code}`, classifyCliError(err), out, err));
        else resolve({ stdout: out, stderr: err, durationMs });
      });
    });
  }

  kill(): void {
    this.current?.kill('SIGTERM');
  }

  async stop(): Promise<void> {
    this.kill();
  }
}
