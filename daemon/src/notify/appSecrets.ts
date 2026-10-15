// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Secrets of the app itself (today: the Telegram bot token), kept next to the Proton sessions:
 *
 *  - `libsecret` (default): Secret Service item with the attributes service=nucleon-sync, kind=<name>, written and read
 *    with `secret-tool` (the value goes through stdin/stdout, never through argv or the environment);
 *  - `encfile` (daemon.json secretBackend, no Secret Service): AES-256-GCM file `<state>/secrets/_<name>.enc` with the
 *    same key file as the encrypted session store (the leading underscore cannot collide with an account id);
 *  - mock mode: a plain file below the mock secrets dir (tests and the demo only).
 *
 * Values are never logged or returned by the API; the API only reports whether a value is set.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ServiceContext } from '../accounts/context.ts';

export type AppSecretName = 'telegram-bot-token';

const SERVICE = 'nucleon-sync';

interface Store {
  get(): string | null;
  set(v: string): void;
  remove(): void;
}

function secretTool(args: string[], input?: string) {
  const r = spawnSync('secret-tool', args, { input, encoding: 'utf8', timeout: 20_000 });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'ENOENT' ? 'secret-tool not found (install libsecret)' : `secret-tool: ${r.error.message}`,
    );
  }
  return r;
}

function libsecretStore(name: AppSecretName): Store {
  const attrs = ['service', SERVICE, 'kind', name];
  return {
    get: () => {
      const r = secretTool(['lookup', ...attrs]);
      return r.status === 0 && r.stdout ? r.stdout : null;
    },
    set: (v) => {
      const r = secretTool(['store', `--label=${SERVICE} ${name}`, ...attrs], v);
      if (r.status !== 0) throw new Error(`secret-tool store failed: ${(r.stderr || '').trim().slice(0, 200)}`);
    },
    remove: () => {
      secretTool(['clear', ...attrs]);
    },
  };
}

function encFileStore(c: ServiceContext, name: AppSecretName): Store {
  const f = path.join(c.paths.secretsDir, `_${name}.enc`);
  const keyFile = c.paths.secretKeyFile;
  const aad = Buffer.from(`${SERVICE}:app:${name}`);
  const key = (create: boolean): Buffer | null => {
    if (existsSync(keyFile)) {
      const k = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (k.length !== 32) throw new Error('encfile key file is damaged');
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
      if (!k) return null;
      const o = JSON.parse(readFileSync(f, 'utf8')) as { iv: string; tag: string; data: string };
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(o.iv, 'base64'));
      d.setAAD(aad);
      d.setAuthTag(Buffer.from(o.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
    },
    set: (v) => {
      const k = key(true)!;
      const iv = randomBytes(12);
      const ci = createCipheriv('aes-256-gcm', k, iv);
      ci.setAAD(aad);
      const data = Buffer.concat([ci.update(v, 'utf8'), ci.final()]);
      mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          v: 1,
          iv: iv.toString('base64'),
          tag: ci.getAuthTag().toString('base64'),
          data: data.toString('base64'),
        }),
        { mode: 0o600 },
      );
      renameSync(tmp, f);
    },
    remove: () => rmSync(f, { force: true }),
  };
}

function plainFileStore(dir: string, name: AppSecretName): Store {
  const f = path.join(dir, `_${name}`);
  return {
    get: () => (existsSync(f) ? readFileSync(f, 'utf8') : null),
    set: (v) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(f, v, { mode: 0o600 });
    },
    remove: () => rmSync(f, { force: true }),
  };
}

export function appSecret(c: ServiceContext, name: AppSecretName): Store {
  if (c.mode === 'mock') return plainFileStore(c.secretFileDir ?? path.join(c.paths.stateDir, 'mock-secrets'), name);
  return c.config.secretBackend === 'encfile' ? encFileStore(c, name) : libsecretStore(name);
}
