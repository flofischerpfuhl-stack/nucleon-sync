// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named, scoped agent tokens (agent layer, ARCHITECTURE §7).
 *
 * - Registry `<config>/agent-tokens.json` (0600): id, name, scopes, timestamps and the SHA-256 of each secret —
 *   never the secret itself. Optionally the secret is also written to `<config>/agent-tokens/<id>.token` (0600) so
 *   local agents can use `nucleon-sync --agent <name>`; revoking deletes that file.
 * - The legacy `agent-token` file stays valid as the built-in token `default` (read + sync). It can be rotated and
 *   disabled, not deleted (older skills and scripts use it).
 * - Secrets: `nst_` + 32 random bytes (base64url). Lookup compares SHA-256 digests in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  AGENT_PERMISSIONS,
  type AgentPermission,
  type AgentTokenInfoDto,
  type CreateAgentTokenRequest,
  type CreateAgentTokenResponse,
  type PatchAgentTokenRequest,
  type NucleonSyncPaths,
} from '@nucleon-sync/shared';

import { badRequest, HttpError, notFound } from '../util/http.ts';
import { tokenMatches } from '../util/token.ts';

/** The authenticated caller of one API request. */
export type Principal =
  | { scope: 'ui'; tokenId: null; name: 'ui'; permissions: AgentPermission[] }
  | { scope: 'agent'; tokenId: string; name: string; permissions: AgentPermission[] };

export const UI_PRINCIPAL: Principal = { scope: 'ui', tokenId: null, name: 'ui', permissions: [...AGENT_PERMISSIONS] };
export const DEFAULT_AGENT_SCOPES: AgentPermission[] = ['read', 'sync'];

interface StoredToken {
  id: string;
  name: string;
  scopes: AgentPermission[];
  createdAt: string;
  lastUsedAt: string | null;
  sha256: string;
  prefix: string;
  file: string | null;
  disabled: boolean;
}

interface RegistryFile {
  version: 1;
  /** state of the legacy agent-token file */
  builtin: { disabled: boolean; lastUsedAt: string | null; createdAt: string };
  tokens: StoredToken[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function normalizeScopes(v: unknown): AgentPermission[] {
  if (!Array.isArray(v)) throw badRequest(`scopes must be an array of ${AGENT_PERMISSIONS.join(', ')}`);
  const bad = v.filter((x) => !AGENT_PERMISSIONS.includes(x as AgentPermission));
  if (bad.length) throw badRequest(`unknown scope(s): ${bad.join(', ')} (allowed: ${AGENT_PERMISSIONS.join(', ')})`);
  const set = new Set<AgentPermission>(['read', ...(v as AgentPermission[])]);
  return AGENT_PERMISSIONS.filter((p) => set.has(p));
}

export class AgentTokens {
  private readonly paths: Pick<NucleonSyncPaths, 'agentTokenFile' | 'agentTokensFile' | 'agentTokensDir'>;
  private reg: RegistryFile;
  /** the legacy token secret (agent-token file) */
  private legacy: string | null;
  private dirtyTimer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  /** called after a token was revoked/disabled (the API closes its event streams) */
  onRevoke: ((tokenId: string) => void) | null = null;

  constructor(
    paths: Pick<NucleonSyncPaths, 'agentTokenFile' | 'agentTokensFile' | 'agentTokensDir'>,
    legacyToken: string | null,
    o: { now?: () => Date } = {},
  ) {
    this.paths = paths;
    this.legacy = legacyToken;
    this.now = o.now ?? (() => new Date());
    this.reg = this.load();
  }

  private load(): RegistryFile {
    const empty: RegistryFile = {
      version: 1,
      builtin: { disabled: false, lastUsedAt: null, createdAt: this.now().toISOString() },
      tokens: [],
    };
    if (!existsSync(this.paths.agentTokensFile)) return empty;
    try {
      const r = JSON.parse(readFileSync(this.paths.agentTokensFile, 'utf8')) as Partial<RegistryFile>;
      return {
        version: 1,
        builtin: { ...empty.builtin, ...(r.builtin ?? {}) },
        tokens: Array.isArray(r.tokens) ? r.tokens.filter((t) => t && typeof t.sha256 === 'string') : [],
      };
    } catch {
      return empty; // unreadable registry: only the legacy token works until a token is created again
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.paths.agentTokensFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.paths.agentTokensFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.reg, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.paths.agentTokensFile);
  }

  /** lastUsedAt updates are written at most every 30 s */
  private touchLater(): void {
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      try {
        this.save();
      } catch {
        /* best effort */
      }
    }, 30_000);
    this.dirtyTimer.unref();
  }

  flush(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
      try {
        this.save();
      } catch {
        /* best effort */
      }
    }
  }

  /** the legacy token changed (rotation) */
  setLegacy(token: string): void {
    this.legacy = token;
  }

  /** Principal of an agent bearer header, or null (unknown, disabled). The UI token is checked by the caller. */
  authenticate(header: string | undefined): Principal | null {
    if (!header?.startsWith('Bearer ')) return null;
    const ts = this.now().toISOString();
    if (this.legacy && tokenMatches(this.legacy, header)) {
      if (this.reg.builtin.disabled) return null;
      this.reg.builtin.lastUsedAt = ts;
      this.touchLater();
      return { scope: 'agent', tokenId: 'default', name: 'default', permissions: [...DEFAULT_AGENT_SCOPES] };
    }
    const digest = sha256(header.slice(7));
    for (const t of this.reg.tokens) {
      const want = Buffer.from(t.sha256, 'hex');
      if (want.length !== digest.length || !timingSafeEqual(want, digest)) continue;
      if (t.disabled) return null;
      t.lastUsedAt = ts;
      this.touchLater();
      return { scope: 'agent', tokenId: t.id, name: t.name, permissions: normalizeScopes(t.scopes) };
    }
    return null;
  }

  list(): AgentTokenInfoDto[] {
    const builtin: AgentTokenInfoDto = {
      id: 'default',
      name: 'default',
      scopes: [...DEFAULT_AGENT_SCOPES],
      createdAt: this.reg.builtin.createdAt,
      lastUsedAt: this.reg.builtin.lastUsedAt,
      builtin: true,
      disabled: this.reg.builtin.disabled,
      file: this.paths.agentTokenFile,
      prefix: this.legacy ? `${this.legacy.slice(0, 6)}…` : '',
    };
    return [builtin, ...this.reg.tokens.map((t) => this.dto(t))];
  }

  private dto(t: StoredToken): AgentTokenInfoDto {
    return {
      id: t.id,
      name: t.name,
      scopes: normalizeScopes(t.scopes),
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      builtin: false,
      disabled: t.disabled,
      file: t.file,
      prefix: t.prefix,
    };
  }

  private find(id: string): StoredToken {
    const t = this.reg.tokens.find((x) => x.id === id);
    if (!t) throw notFound(`agent token ${id} not found`);
    return t;
  }

  get(id: string): AgentTokenInfoDto {
    if (id === 'default') return this.list()[0]!;
    return this.dto(this.find(id));
  }

  create(body: unknown): CreateAgentTokenResponse {
    const b = (body ?? {}) as Partial<CreateAgentTokenRequest>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!NAME_RE.test(name)) throw badRequest('name: 1–40 characters (letters, digits, space, . _ -)');
    if (name === 'default' || name === 'ui' || this.reg.tokens.some((t) => t.name === name))
      throw new HttpError(409, 'conflict', `a token named "${name}" already exists`);
    const scopes = normalizeScopes(b.scopes ?? []);
    let id = randomBytes(4).toString('hex');
    while (this.reg.tokens.some((t) => t.id === id)) id = randomBytes(4).toString('hex');
    const token = `nst_${randomBytes(32).toString('base64url')}`;
    let file: string | null = null;
    if (b.writeFile !== false) {
      mkdirSync(this.paths.agentTokensDir, { recursive: true, mode: 0o700 });
      chmodSync(this.paths.agentTokensDir, 0o700);
      file = path.join(this.paths.agentTokensDir, `${id}.token`);
      writeFileSync(file, token + '\n', { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    const t: StoredToken = {
      id,
      name,
      scopes,
      createdAt: this.now().toISOString(),
      lastUsedAt: null,
      sha256: sha256(token).toString('hex'),
      prefix: `${token.slice(0, 8)}…`,
      file,
      disabled: false,
    };
    this.reg.tokens.push(t);
    this.save();
    return { ...this.dto(t), token };
  }

  patch(id: string, body: unknown): AgentTokenInfoDto {
    const b = (body ?? {}) as PatchAgentTokenRequest;
    if (id === 'default') {
      if (b.name !== undefined || b.scopes !== undefined)
        throw badRequest('the built-in token keeps its name and scopes (read, sync); create a new token instead');
      if (typeof b.disabled === 'boolean') {
        this.reg.builtin.disabled = b.disabled;
        this.save();
        if (b.disabled) this.onRevoke?.('default');
      }
      return this.get('default');
    }
    const t = this.find(id);
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!NAME_RE.test(name)) throw badRequest('name: 1–40 characters (letters, digits, space, . _ -)');
      if (this.reg.tokens.some((x) => x !== t && x.name === name) || name === 'default')
        throw new HttpError(409, 'conflict', `a token named "${name}" already exists`);
      t.name = name;
    }
    const narrowed = b.scopes !== undefined && normalizeScopes(b.scopes).length < t.scopes.length;
    if (b.scopes !== undefined) t.scopes = normalizeScopes(b.scopes);
    if (typeof b.disabled === 'boolean') t.disabled = b.disabled;
    this.save();
    if (t.disabled || narrowed) this.onRevoke?.(t.id);
    return this.dto(t);
  }

  /** Deletes a named token and its secret file. The built-in token can only be disabled. */
  revoke(id: string): void {
    if (id === 'default') throw badRequest('the built-in token cannot be deleted; disable or rotate it instead');
    const t = this.find(id);
    this.reg.tokens = this.reg.tokens.filter((x) => x !== t);
    if (t.file) rmSync(t.file, { force: true });
    this.save();
    this.onRevoke?.(id);
  }

  /** Token secret file of a named token (CLI `--agent <name|id>`), read from the registry file without a daemon. */
  static fileFor(paths: Pick<NucleonSyncPaths, 'agentTokensFile'>, nameOrId: string): string | null {
    try {
      const r = JSON.parse(readFileSync(paths.agentTokensFile, 'utf8')) as RegistryFile;
      const t = r.tokens.find((x) => x.id === nameOrId || x.name === nameOrId);
      return t?.file ?? null;
    } catch {
      return null;
    }
  }
}
