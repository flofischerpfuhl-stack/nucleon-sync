// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One-time clean-up after the removal of the built-in Telegram channel (0.4.0; migration 009 drops its settings).
 * Versions up to 0.3.x could store a bot token outside the DB; it is deleted here once per installation, best effort:
 *
 *  - `libsecret` (default secretBackend): `secret-tool clear service nucleon-sync kind telegram-bot-token`;
 *  - `encfile`: the file `<state>/secrets/_telegram-bot-token.enc` (removed whatever the backend, it is only a file);
 *  - mock mode: the plain file below the mock secrets dir.
 *
 * Nothing here may fail or delay the startup: errors are logged and swallowed, `secret-tool` runs asynchronously with
 * a timeout. The attempt is recorded in meta ('cleanup:legacy-bot-token') so it runs only once.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

import type { ServiceContext } from '../accounts/context.ts';
import { log } from '../util/log.ts';

export const LEGACY_TOKEN_DONE_KEY = 'cleanup:legacy-bot-token';
const KIND = 'telegram-bot-token';

function clearKeyringItem(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: string) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = spawn('secret-tool', ['clear', 'service', 'nucleon-sync', 'kind', KIND], {
        stdio: 'ignore',
        env,
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done('keyring: timed out');
      }, 20_000);
      timer.unref();
      child.on('error', (e) => {
        clearTimeout(timer);
        done(`keyring: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'secret-tool not found' : e.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(`keyring: secret-tool exited ${code}`);
      });
    } catch (e) {
      done(`keyring: ${(e as Error).message}`);
    }
  });
}

/** Deletes a bot token left behind by an older version (once; never throws). Returns what was done, for tests. */
export async function removeLegacyBotToken(c: ServiceContext): Promise<string[]> {
  const out: string[] = [];
  try {
    if (c.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_TOKEN_DONE_KEY)) return out;
    const rm = (f: string) => {
      try {
        rmSync(f, { force: true });
        out.push(`file: ${path.basename(f)}`);
      } catch (e) {
        out.push(`file: ${(e as Error).message}`);
      }
    };
    if (c.mode === 'mock') {
      rm(path.join(c.secretFileDir ?? path.join(c.paths.stateDir, 'mock-secrets'), `_${KIND}`));
    } else {
      rm(path.join(c.paths.secretsDir, `_${KIND}.enc`));
      if (c.config.secretBackend !== 'encfile') out.push(await clearKeyringItem(c.env));
    }
    c.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run(LEGACY_TOKEN_DONE_KEY, new Date().toISOString());
  } catch (e) {
    out.push(`error: ${(e as Error).message}`);
    log('warn', 'legacy bot token clean-up failed (ignored)', { error: (e as Error).message.slice(0, 200) });
  }
  return out;
}
