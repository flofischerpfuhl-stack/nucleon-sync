// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Driver for one long-lived `proton-drive` process in REPL mode.
 *
 * Verified against the real CLI 0.9.0 (2026-10-10, read-only commands): starting the binary without
 * arguments opens a REPL that prints the prompt "proton-drive> " on stdout, reads one command per line
 * (POSIX-like quoting, see cli/src/cli/splitQuotedLine.ts), prints JSON results on stdout and recoverable
 * errors on stderr, then prints the prompt again. Measured: `filesystem list -j` 0.13–0.5 s per call in
 * REPL mode vs. >= 1.5 s process start + ~8 extra API requests per one-shot invocation.
 *
 * Rules: send exactly ONE command and wait for the prompt before sending the next (the CLI re-creates its
 * readline interface per line; pipelining may drop buffered lines). Always pass -j and explicit conflict
 * strategies (interactive prompts are disabled in JSON mode, they fail instead).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { ErrorClass } from '@nucleon-sync/shared';

import { classifyCliError } from './classify.ts';
import { log } from '../util/log.ts';

export const PROMPT = 'proton-drive> ';

export interface CliResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class CliError extends Error {
  readonly errorClass: ErrorClass;
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, errorClass: ErrorClass, stdout = '', stderr = '') {
    super(message);
    this.errorClass = errorClass;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * A command did not answer within its timeout (hung server call, stalled transfer). The worker process was killed
 * (its REPL state is unknown); the caller retries with backoff. Logged as `cli_timeout`.
 */
export class CliTimeoutError extends CliError {
  readonly timedOut = true;
  readonly timeoutMs: number;
  constructor(worker: string, args: string[], timeoutMs: number, stdout = '', stderr = '') {
    super(
      `cli_timeout: ${worker}: "${args.slice(0, 2).join(' ')}" gave no answer within ${Math.round(timeoutMs / 1000)} s`,
      'transient',
      stdout,
      stderr,
    );
    this.timeoutMs = timeoutMs;
  }
}

export function isCliTimeout(e: unknown): e is CliTimeoutError {
  return e instanceof CliTimeoutError;
}

/** Log line for a command timeout (one place, so the event name stays greppable: `cli_timeout`). */
export function logCliTimeout(worker: string, args: string[], timeoutMs: number, pid: number | null): void {
  log('warn', 'cli_timeout', { worker, cmd: args.slice(0, 2).join(' '), timeoutMs, pid });
}

/** Quote one argument for the CLI REPL line parser. */
export function quoteArg(arg: string): string {
  if (/[\r\n]/.test(arg)) throw new CliError(`argument contains a newline: ${JSON.stringify(arg)}`, 'fatal');
  if (/^[A-Za-z0-9_\-./=~:@+,]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface ReplWorkerOptions {
  cliPath: string;
  env: NodeJS.ProcessEnv;
  name: string; // e.g. "alex/w0"
  startTimeoutMs?: number;
  defaultTimeoutMs?: number;
}

type Pending = {
  args: string[];
  resolve: (r: CliResult) => void;
  reject: (e: Error) => void;
  started: number;
  timer: NodeJS.Timeout;
};

export class ReplWorker extends EventEmitter {
  readonly name: string;
  private readonly opts: ReplWorkerOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private out = '';
  private err = '';
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private dead = false;
  commandsRun = 0;
  /** when the current process was started (pool recycles workers after 6 h) */
  startedAt = 0;

  constructor(opts: ReplWorkerOptions) {
    super();
    this.opts = opts;
    this.name = opts.name;
  }

  get alive(): boolean {
    return !!this.proc && !this.dead;
  }

  /** pid of the running CLI process (progress monitoring via /proc), null when not running */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** true while a command is in flight */
  get busy(): boolean {
    return !!this.pending;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.dead = false;
    this.startedAt = Date.now();
    this.commandsRun = 0;
    this.ready = new Promise<void>((resolve, reject) => {
      const proc = spawn(this.opts.cliPath, [], { env: this.opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      // EPIPE / write after end when the REPL died: handled by the 'exit' path; without a listener it would be an
      // uncaught exception that takes the whole daemon down
      proc.stdin.on('error', () => undefined);
      const startTimer = setTimeout(() => {
        reject(new CliError(`${this.name}: no prompt within start timeout`, 'transient', this.out, this.err));
        this.kill();
      }, this.opts.startTimeoutMs ?? 60_000);
      let started = false;
      proc.stdout.on('data', (chunk: string) => {
        this.out += chunk;
        if (!this.out.endsWith(PROMPT)) return;
        const text = this.out.slice(0, -PROMPT.length);
        this.out = '';
        if (!started) {
          started = true;
          clearTimeout(startTimer);
          this.err = '';
          resolve();
          return;
        }
        this.complete(text);
      });
      proc.stderr.on('data', (chunk: string) => {
        this.err += chunk;
      });
      proc.on('error', (e) => {
        clearTimeout(startTimer);
        this.dead = true;
        reject(new CliError(`${this.name}: spawn failed: ${e.message}`, 'fatal'));
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(startTimer);
        this.dead = true;
        this.proc = null;
        this.ready = null;
        const msg = `${this.name}: CLI exited (code=${code}, signal=${signal}) ${this.err.slice(-500)}`;
        if (!started) reject(new CliError(msg, classifyCliError(this.err), this.out, this.err));
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          p.reject(new CliError(msg, classifyCliError(this.err), this.out, this.err));
        }
        this.emit('exit', { code, signal });
      });
    });
    return this.ready;
  }

  /** Run one CLI command (args without the binary). Rejects with CliError when stderr is non-empty. */
  run(args: string[], timeoutMs?: number): Promise<CliResult> {
    const task = this.queue.then(() => this.runNow(args, timeoutMs ?? this.opts.defaultTimeoutMs ?? 15 * 60_000));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Convenience: run with -j and parse stdout as JSON. */
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

  private async runNow(args: string[], timeoutMs: number): Promise<CliResult> {
    await this.start();
    if (!this.proc) throw new CliError(`${this.name}: not running`, 'transient');
    const line = args.map(quoteArg).join(' ') + '\n';
    this.err = '';
    this.commandsRun++;
    return new Promise<CliResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        logCliTimeout(this.name, args, timeoutMs, this.proc?.pid ?? null);
        reject(new CliTimeoutError(this.name, args, timeoutMs, this.out, this.err));
        this.kill(); // state of the REPL is unknown now -> kill; the pool starts a fresh worker
      }, timeoutMs);
      this.pending = { args, resolve, reject, started: Date.now(), timer };
      this.proc!.stdin.write(line);
    });
  }

  private complete(stdout: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    // stderr of the command is written before the next prompt; give the pipe one tick to drain.
    setTimeout(() => {
      const stderr = this.err;
      this.err = '';
      const durationMs = Date.now() - p.started;
      this.emit('command', { durationMs, ok: !stderr.trim(), args: p.args });
      if (stderr.trim()) p.reject(new CliError(stderr.trim().slice(0, 2000), classifyCliError(stderr), stdout, stderr));
      else p.resolve({ stdout, stderr, durationMs });
    }, 15);
  }

  kill(): void {
    if (this.proc) {
      const proc = this.proc;
      this.dead = true; // never send another command to this process
      proc.kill('SIGTERM');
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref();
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      if (proc.stdin.writable) proc.stdin.end('exit\n');
      setTimeout(() => this.kill(), 5000).unref();
    });
  }
}
