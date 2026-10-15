// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { TokenScope } from '@nucleon-sync/shared';

/** API bearer token: 32 random bytes, file mode 0600 in the config dir. Generated on first start. */
export function ensureToken(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return readFileSync(file, 'utf8').trim();
}

/** Replaces the token file atomically (agent token rotation) and returns the new token. */
export function rotateToken(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tmp, token + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return token;
}

export function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Scope of the presented bearer token: 'ui' (api-token), 'agent' (agent-token) or null (unauthorized). */
export function scopeOf(tokens: { ui: string; agent?: string | null }, header: string | undefined): TokenScope | null {
  if (tokenMatches(tokens.ui, header)) return 'ui';
  if (tokens.agent && tokenMatches(tokens.agent, header)) return 'agent';
  return null;
}
