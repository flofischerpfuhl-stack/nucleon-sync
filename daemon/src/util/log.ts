// SPDX-License-Identifier: GPL-3.0-or-later
/** JSON-lines logger on stdout (journald captures it under the systemd user service). Never log secrets. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.NUCLEON_SYNC_LOG_LEVEL as Level) ?? 'info'] ?? 20;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < min) return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}
