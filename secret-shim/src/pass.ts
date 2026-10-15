// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `pass`-compatible credential shim for the proton-drive CLI (PROTON_DRIVE_CREDENTIALS_STORE=pass).
 *
 * Why: the CLI's keychain store uses ONE fixed libsecret item (service "ch.proton.drive/drive-sdk-cli",
 * account "auth-session") -> only one Proton account per desktop session. With the `pass` store the CLI
 * spawns `pass` from PATH; nucleon-sync puts this shim first in PATH and selects the account via env, so
 * every account gets its own keyring item while secrets never touch the disk in plaintext.
 *
 * Second purpose: the CLI calls `pass rm` (credentials.signOut) whenever a token refresh fails with 4xx —
 * which happens when two parallel CLI processes of the same account race on the rotating refresh token.
 * The shim turns `rm` into a no-op unless NUCLEON_SYNC_ALLOW_LOGOUT=1, so one losing worker cannot wipe
 * the session for everybody; the daemon restarts that worker, which then reloads the fresh session.
 *
 * Supported subset (exactly what cli/src/credentials/passCredentialsStore.ts uses):
 *   pass show <path>            -> secret on stdout | stderr "Error: <path> is not in the password store." exit 1
 *   pass insert -f -m <path>    -> secret from stdin
 *   pass rm -f <path>
 *   pass has <path>             -> nucleon-sync extension, prints nothing (presence check for daemon/UI/doctor):
 *                                  exit 0 present, 1 missing, 3 Secret Service unavailable, 4 present but locked.
 *                                  The libsecret backend answers via D-Bus SearchItems (busctl) and NEVER reads the
 *                                  secret value.
 *
 * Env:
 *   NUCLEON_SYNC_ACCOUNT          account id (required), e.g. "alex", "sam"
 *   NUCLEON_SYNC_SECRET_BACKEND   "libsecret" (default) | "encfile" (no Secret Service: AES-256-GCM file, key in
 *                                NUCLEON_SYNC_SECRET_KEYFILE) | "file" (tests/dev only, plaintext)
 *   NUCLEON_SYNC_SECRET_SERVICE   libsecret attribute "service" (default "nucleon-sync")
 *   NUCLEON_SYNC_SECRET_KEY       libsecret attribute "account" (default = NUCLEON_SYNC_ACCOUNT)
 *   NUCLEON_SYNC_SECRET_SCHEMA    optional xdg:schema attribute (e.g. "com.oven-sh.bun.Secret" to share the
 *                                item with the plain CLI's keychain store)
 *   NUCLEON_SYNC_SECRET_FILE_DIR  dir for the file/encfile backends
 *   NUCLEON_SYNC_SECRET_KEYFILE   encfile: 32-byte key file (0600, created on first insert)
 *   NUCLEON_SYNC_ALLOW_LOGOUT     "1" to let `rm` really delete (explicit logout from the UI)
 *   NUCLEON_SYNC_SHIM_EVENTS      optional JSONL file; the shim appends {ts,account,op,result} (never secrets)
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const env = process.env;

function event(op: string, result: string): void {
  const f = env.NUCLEON_SYNC_SHIM_EVENTS;
  if (!f) return;
  try {
    appendFileSync(
      f,
      JSON.stringify({ ts: new Date().toISOString(), account: env.NUCLEON_SYNC_ACCOUNT, op, result }) + '\n',
    );
  } catch {
    /* ignore */
  }
}

interface Backend {
  get(): string | null;
  set(secret: string): void;
  remove(): void;
  /** presence without reading the secret */
  has(): 'present' | 'missing' | 'locked' | 'unavailable';
}

export class ShimError extends Error {}

function fileBackend(account: string): Backend {
  const dir = env.NUCLEON_SYNC_SECRET_FILE_DIR;
  if (!dir) throw new Error('NUCLEON_SYNC_SECRET_FILE_DIR is required for the file backend');
  const f = path.join(dir, `${account}.json`);
  return {
    get: () => (existsSync(f) ? readFileSync(f, 'utf8') : null),
    set: (s) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, s, { mode: 0o600 });
      renameSync(tmp, f);
    },
    remove: () => rmSync(f, { force: true }),
    has: () => (existsSync(f) ? 'present' : 'missing'),
  };
}

/**
 * Fallback when no Secret Service exists (e.g. a Hyprland desktop without gnome-keyring/KWallet): the session is
 * stored AES-256-GCM encrypted in <dir>/<account>.enc; the 32-byte key lives in a separate 0600 file. This protects
 * against copies of the state dir (backups, sync folders) without the key file — not against programs running as the
 * same user (the plain CLI's own fallback `unsafe_file` stores the session unencrypted).
 */
export function encFileBackend(account: string): Backend {
  const dir = env.NUCLEON_SYNC_SECRET_FILE_DIR;
  const keyFile = env.NUCLEON_SYNC_SECRET_KEYFILE;
  if (!dir || !keyFile)
    throw new ShimError('encfile backend needs NUCLEON_SYNC_SECRET_FILE_DIR and NUCLEON_SYNC_SECRET_KEYFILE');
  const f = path.join(dir, `${account}.enc`);
  const key = (create: boolean): Buffer | null => {
    if (existsSync(keyFile)) {
      const k = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (k.length !== 32) throw new ShimError('encfile key file is damaged (expected 32 bytes, base64)');
      return k;
    }
    if (!create) return null;
    mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const k = randomBytes(32);
    writeFileSync(keyFile, k.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    return k;
  };
  return {
    get: () => {
      if (!existsSync(f)) return null;
      const k = key(false);
      if (!k) throw new ShimError('encfile key file missing – session cannot be decrypted (log in again)');
      const o = JSON.parse(readFileSync(f, 'utf8')) as { v: number; iv: string; tag: string; data: string };
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(o.iv, 'base64'));
      d.setAAD(Buffer.from(`nucleon-sync:${account}`));
      d.setAuthTag(Buffer.from(o.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
    },
    set: (secret) => {
      const k = key(true)!;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', k, iv);
      c.setAAD(Buffer.from(`nucleon-sync:${account}`));
      const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          v: 1,
          iv: iv.toString('base64'),
          tag: c.getAuthTag().toString('base64'),
          data: data.toString('base64'),
        }),
        { mode: 0o600 },
      );
      renameSync(tmp, f);
    },
    remove: () => rmSync(f, { force: true }),
    has: () => (existsSync(f) ? 'present' : 'missing'),
  };
}

/**
 * Secret Service SearchItems via busctl: returns unlocked/locked object paths for the attributes, no secret.
 * Exported for tests (parser) and the daemon's doctor.
 */
export function parseSearchItems(json: string): { unlocked: number; locked: number } {
  const o = JSON.parse(json) as { type?: string; data?: unknown };
  if (o.type !== 'aoao' || !Array.isArray(o.data) || o.data.length !== 2) throw new ShimError('unexpected D-Bus reply');
  const [u, l] = o.data as unknown[][];
  return { unlocked: Array.isArray(u) ? u.length : 0, locked: Array.isArray(l) ? l.length : 0 };
}

export function searchItems(attrs: Record<string, string>): 'present' | 'missing' | 'locked' | 'unavailable' {
  const flat = Object.entries(attrs).flat();
  const r = spawnSync(
    'busctl',
    [
      '--user',
      '--json=short',
      '--timeout=10',
      'call',
      'org.freedesktop.secrets',
      '/org/freedesktop/secrets',
      'org.freedesktop.Secret.Service',
      'SearchItems',
      'a{ss}',
      String(flat.length / 2),
      ...flat,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (r.error || r.status !== 0) return 'unavailable';
  try {
    const { unlocked, locked } = parseSearchItems(r.stdout);
    return unlocked > 0 ? 'present' : locked > 0 ? 'locked' : 'missing';
  } catch {
    return 'unavailable';
  }
}

function libsecretBackend(account: string): Backend {
  const attrs = [
    'service',
    env.NUCLEON_SYNC_SECRET_SERVICE || 'nucleon-sync',
    'account',
    env.NUCLEON_SYNC_SECRET_KEY || account,
  ];
  const schemaAttrs = env.NUCLEON_SYNC_SECRET_SCHEMA ? ['xdg:schema', env.NUCLEON_SYNC_SECRET_SCHEMA] : [];
  const run = (args: string[], input?: string) => {
    const r = spawnSync('secret-tool', args, { input, encoding: 'utf8', timeout: 20_000 });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      throw new ShimError(
        code === 'ENOENT'
          ? 'secret-tool not found (install libsecret)'
          : code === 'ETIMEDOUT'
            ? 'secret-tool timed out (KDE wallet locked or Secret Service not answering)'
            : `secret-tool failed: ${r.error.message}`,
      );
    }
    return r;
  };
  return {
    get: () => {
      const r = run(['lookup', ...attrs]);
      if (r.status !== 0 || !r.stdout) return null; // secret-tool exits 1 with empty output when not found
      return r.stdout;
    },
    set: (s) => {
      // an adopted plain-CLI item keeps Bun's label ("<service>/<account>") so it looks unchanged in KWallet
      const label = env.NUCLEON_SYNC_SECRET_SCHEMA
        ? `${attrs[1]}/${attrs[3]}`
        : `nucleon-sync ${account} (proton-drive CLI session)`;
      const r = run(['store', `--label=${label}`, ...attrs, ...schemaAttrs], s);
      // stderr of secret-tool never contains the secret (it is passed on stdin)
      if (r.status !== 0) throw new ShimError(`secret-tool store failed: ${(r.stderr || '').trim().slice(0, 200)}`);
    },
    remove: () => {
      run(['clear', ...attrs]);
    },
    has: () => searchItems({ service: attrs[1]!, account: attrs[3]! }),
  };
}

function main(argv: string[]): number {
  const account = env.NUCLEON_SYNC_ACCOUNT;
  if (!account || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(account)) {
    process.stderr.write('nucleon-sync pass shim: NUCLEON_SYNC_ACCOUNT missing or invalid\n');
    return 2;
  }
  const kind = env.NUCLEON_SYNC_SECRET_BACKEND || 'libsecret';
  let backend: Backend;
  try {
    backend =
      kind === 'file' ? fileBackend(account) : kind === 'encfile' ? encFileBackend(account) : libsecretBackend(account);
  } catch (e) {
    process.stderr.write(`nucleon-sync pass shim: ${(e as Error).message}\n`);
    return 2;
  }
  const [cmd, ...rest] = argv;
  const entry = rest.filter((a) => !a.startsWith('-')).pop() ?? '';
  try {
    switch (cmd) {
      case 'show': {
        const s = backend.get();
        if (s === null) {
          process.stderr.write(`Error: ${entry} is not in the password store.\n`);
          event('show', 'missing');
          return 1;
        }
        process.stdout.write(s);
        event('show', 'ok');
        return 0;
      }
      case 'insert': {
        const input = readFileSync(0, 'utf8');
        if (!input.trim()) {
          process.stderr.write('Error: empty secret\n');
          return 1;
        }
        if (backend.get() === input) {
          event('insert', 'unchanged');
          return 0;
        }
        backend.set(input);
        event('insert', 'saved');
        return 0;
      }
      case 'has': {
        // nucleon-sync extension (not part of pass): presence check without reading the secret (doctor/UI/boot check)
        const state = backend.has();
        event('has', state);
        if (state === 'unavailable') process.stderr.write('nucleon-sync pass shim: Secret Service not available\n');
        return { present: 0, missing: 1, unavailable: 3, locked: 4 }[state];
      }
      case 'rm': {
        if (env.NUCLEON_SYNC_ALLOW_LOGOUT === '1') {
          backend.remove();
          event('rm', 'removed');
        } else {
          event('rm', 'suppressed'); // daemon reacts: restart the worker so it reloads the current session
        }
        return 0;
      }
      default:
        process.stderr.write(`nucleon-sync pass shim: unsupported command "${cmd ?? ''}"\n`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`nucleon-sync pass shim: ${(e as Error).message}\n`);
    event(cmd ?? '?', 'error');
    return 1;
  }
}

// run only as the `pass` executable (the module is also imported by tests for parseSearchItems)
if (process.argv[1] && /(^|\/)pass(\.ts|\.mjs)?$/.test(process.argv[1])) process.exitCode = main(process.argv.slice(2));
