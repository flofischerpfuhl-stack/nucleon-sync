// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Status-bar snapshot files (Waybar / Omarchy shell, see shared/src/bar.ts):
 * `<runtime>/bar.json` (Waybar JSON) and `<runtime>/bar-omarchy.json` (class `active` = highlight), rewritten at most
 * once per second on status changes and every 15 s otherwise, so a bar can poll them with a plain `cat` and treat a
 * file older than a minute as "service not running" (packaging/omarchy/nucleon-sync-bar). Removed on shutdown.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { barLang, barOutput, type DaemonEvent, type StatusDto } from '@nucleon-sync/shared';

const TRIGGERS = new Set<DaemonEvent['type']>([
  'status',
  'hello',
  'account',
  'conflicts_changed',
  'deletions_changed',
  'run',
]);

export class BarFiles {
  private readonly dir: string;
  private readonly status: () => StatusDto;
  private readonly lang: ReturnType<typeof barLang>;
  private timer: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private last = 0;

  constructor(runtimeDir: string, status: () => StatusDto, env: NodeJS.ProcessEnv = process.env) {
    this.dir = runtimeDir;
    this.status = status;
    this.lang = barLang(env);
  }

  static files(runtimeDir: string): { waybar: string; omarchy: string } {
    return { waybar: path.join(runtimeDir, 'bar.json'), omarchy: path.join(runtimeDir, 'bar-omarchy.json') };
  }

  start(): void {
    this.write();
    this.keepAlive = setInterval(() => this.write(), 15_000);
    this.keepAlive.unref();
  }

  onEvent(ev: DaemonEvent): void {
    if (!TRIGGERS.has(ev.type) || this.timer) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.last));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, wait);
    this.timer.unref();
  }

  write(): void {
    this.last = Date.now();
    try {
      const s = this.status();
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const f = BarFiles.files(this.dir);
      for (const [file, format] of [
        [f.waybar, 'waybar'],
        [f.omarchy, 'omarchy'],
      ] as const) {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(barOutput(s, { format, lang: this.lang })) + '\n', { mode: 0o600 });
        renameSync(tmp, file);
      }
    } catch {
      /* the bar is best effort */
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    const f = BarFiles.files(this.dir);
    rmSync(f.waybar, { force: true });
    rmSync(f.omarchy, { force: true });
  }
}
