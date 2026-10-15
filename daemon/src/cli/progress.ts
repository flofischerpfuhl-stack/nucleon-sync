// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Transfer progress for `filesystem upload|download` (the CLI prints nothing until the end in JSON mode).
 *
 *  - uploads: the read offset of the local file in the CLI process (`/proc/<pid>/fd` + `fdinfo` "pos:"); the CLI reads
 *    the file sequentially while encrypting/uploading, so the offset is a close upper bound of the bytes sent. If the
 *    file is read with pread (offset stays 0), the growth of `rchar` in `/proc/<pid>/io` since the start is used.
 *  - downloads: bytes written into the staging directory of the job
 *  - fallback: elapsed time x expected rate, capped at 95 % (until the command returns)
 */
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ProgressSample {
  bytesDone: number;
  bytesTotal: number;
  source: 'fd' | 'io' | 'staging' | 'estimate';
}

/** Bytes read by a process so far (`rchar` of /proc/<pid>/io, counts read() and pread()). */
export function readRchar(pid: number, procDir = '/proc'): number | null {
  try {
    const m = /^rchar:\s+(\d+)/m.exec(readFileSync(path.join(procDir, String(pid), 'io'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Read offsets of the given files currently open in process `pid` (path -> max offset). */
export function readFdPositions(pid: number, files: Set<string>, procDir = '/proc'): Map<string, number> {
  const out = new Map<string, number>();
  let fds: string[];
  try {
    fds = readdirSync(path.join(procDir, String(pid), 'fd'));
  } catch {
    return out;
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(path.join(procDir, String(pid), 'fd', fd));
    } catch {
      continue;
    }
    if (!files.has(target)) continue;
    try {
      const info = readFileSync(path.join(procDir, String(pid), 'fdinfo', fd), 'utf8');
      const m = /^pos:\s+(\d+)/m.exec(info);
      if (m) out.set(target, Math.max(out.get(target) ?? 0, Number(m[1])));
    } catch {
      /* fd closed meanwhile */
    }
  }
  return out;
}

/** Sum of file sizes below dir (download staging). */
export function dirBytes(dir: string): number {
  let n = 0;
  let list: string[];
  try {
    list = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of list) {
    const p = path.join(dir, name);
    try {
      const s = statSync(p);
      if (s.isDirectory()) n += dirBytes(p);
      else n += s.size;
    } catch {
      /* vanished */
    }
  }
  return n;
}

export interface MonitorOptions {
  kind: 'upload' | 'download';
  /** upload: local files (as passed to the CLI) with their sizes, in command order */
  files?: { path: string; size: number }[];
  /** download: staging dir the CLI writes into */
  stagingDir?: string;
  bytesTotal: number;
  /** expected throughput for the fallback estimate (bytes/s) */
  expectedBps: number;
  pid: () => number | null;
  onProgress: (p: ProgressSample) => void;
  intervalMs?: number;
  procDir?: string;
}

/** Polls progress while a transfer command runs; call stop() when it returns. */
export class TransferMonitor {
  private readonly o: MonitorOptions;
  private readonly started = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private readonly maxPos = new Map<string, number>();
  private readonly seen = new Set<string>();
  private lastDone = 0;
  private rchar0: { pid: number; v: number } | null = null;

  constructor(o: MonitorOptions) {
    this.o = o;
    this.timer = setInterval(() => this.poll(), o.intervalMs ?? 2000);
    this.timer.unref();
    this.baseline();
  }

  private baseline(): void {
    const pid = this.o.pid();
    if (pid && !this.rchar0) {
      const v = readRchar(pid, this.o.procDir);
      if (v !== null) this.rchar0 = { pid, v };
    }
  }

  sample(): ProgressSample {
    const total = this.o.bytesTotal;
    let done = 0;
    let source: ProgressSample['source'] = 'estimate';
    if (this.o.kind === 'download' && this.o.stagingDir) {
      const b = dirBytes(this.o.stagingDir);
      if (b > 0) {
        done = b;
        source = 'staging';
      }
    } else if (this.o.kind === 'upload' && this.o.files?.length) {
      const pid = this.o.pid();
      if (pid) {
        const pos = readFdPositions(pid, new Set(this.o.files.map((f) => f.path)), this.o.procDir);
        for (const [p, v] of pos) {
          this.seen.add(p);
          this.maxPos.set(p, Math.max(this.maxPos.get(p) ?? 0, v));
        }
        const anyPos = [...this.maxPos.values()].some((v) => v > 0);
        if (this.seen.size && anyPos) {
          source = 'fd';
          // files are processed in order: everything before the last file seen is complete
          let lastSeen = -1;
          this.o.files.forEach((f, i) => this.seen.has(f.path) && (lastSeen = i));
          this.o.files.forEach((f, i) => {
            if (i < lastSeen || (this.seen.has(f.path) && !pos.has(f.path))) done += f.size;
            else if (pos.has(f.path)) done += Math.min(f.size, this.maxPos.get(f.path) ?? 0);
          });
        } else {
          // offset stays 0 (pread): bytes the process has read since the command started
          this.baseline();
          const v = this.rchar0 && this.rchar0.pid === pid ? readRchar(pid, this.o.procDir) : null;
          if (v !== null && this.rchar0 && v > this.rchar0.v) {
            done = v - this.rchar0.v;
            source = 'io';
          }
        }
      }
    }
    if (source === 'estimate') {
      const elapsed = (Date.now() - this.started) / 1000;
      done = Math.min(total * 0.95, elapsed * this.o.expectedBps);
    }
    done = Math.max(this.lastDone, Math.min(done, total));
    this.lastDone = done;
    return { bytesDone: Math.round(done), bytesTotal: total, source };
  }

  private poll(): void {
    try {
      this.o.onProgress(this.sample());
    } catch {
      /* progress is best effort */
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
