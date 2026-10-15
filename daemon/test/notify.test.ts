// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Notifier: the notify command (daemon.json `notifyCommand`, the only channel beyond the desktop), de-dup, digest,
 * failures and retries; the API/settings without the removed Telegram channel; the one-time clean-up of a bot token
 * left behind by 0.3.x (mock files and a FAKE secret-tool on PATH only, never the real keyring).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Notice, NucleonSyncPaths, SettingsDto } from '@nucleon-sync/shared';

import type { ServiceContext } from '../src/accounts/context.ts';
import { openDb } from '../src/db/db.ts';
import { LEGACY_TOKEN_DONE_KEY, removeLegacyBotToken } from '../src/notify/legacyToken.ts';
import { startMockDaemon, waitFor, type MockDaemon } from './c-helpers.ts';
import { tmp } from './helpers.ts';

let m: MockDaemon;
let hook: string;
let out: string;
let rcFile: string;

beforeAll(async () => {
  // the notify command: a tiny script that appends its environment to a file and exits with the code in rcFile
  const dir = tmp('notify-cmd-');
  out = path.join(dir, 'out.txt');
  rcFile = path.join(dir, 'rc');
  hook = path.join(dir, 'hook.sh');
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' "$NUCLEON_SYNC_EVENT" "$NUCLEON_SYNC_SEVERITY" "$NUCLEON_SYNC_KEY" "$NUCLEON_SYNC_ACCOUNT_NAME" "$NUCLEON_SYNC_TITLE" >> ${JSON.stringify(out)}\nrc=$(cat ${JSON.stringify(rcFile)})\nif [ "$rc" != 0 ]; then echo "hook failed on purpose" >&2; fi\nexit "$rc"\n`,
  );
  chmodSync(hook, 0o755);
  m = await startMockDaemon({ startServices: true });
});
afterAll(async () => {
  await m.close();
});
beforeEach(() => {
  writeFileSync(out, '');
  writeFileSync(rcFile, '0');
});

const lines = () => readFileSync(out, 'utf8').split('\n').filter(Boolean);
const on = () => (m.d.services.ctx.config.notifyCommand = [hook]);

const notice = (key: string, severity: Notice['severity'] = 'error'): Notice => ({
  key,
  severity,
  title: 'Sign-in required',
  body: 'The account Sam has to sign in again.',
  accountId: 'sam',
});

describe('notifier (notify command)', () => {
  it('is disabled without a notify command', async () => {
    expect(await m.d.services.notifier.handle(notice('error:auth:sam'))).toBe('disabled');
    expect(lines()).toHaveLength(0);
    const cfg = await m.req('GET', '/v1/notifications/config');
    expect(cfg.body).toEqual({ command: { configured: false, program: null } });
  });

  it('sends warn/error notices through the command and de-duplicates per key', async () => {
    on();
    expect((await m.req('PUT', '/v1/settings', { notifications: { minIntervalMinutes: 60 } })).status).toBe(200);
    expect(await m.d.services.notifier.handle(notice('error:auth:sam'))).toBe('sent');
    expect(lines()).toEqual(['notice|error|error:auth:sam|Sam|Sign-in required']);
    expect(await m.d.services.notifier.handle(notice('error:auth:sam'))).toBe('duplicate');
    expect(await m.d.services.notifier.handle(notice('quota:sam', 'warn'))).toBe('sent');
    expect(lines()).toHaveLength(2);
    const cfg = await m.req('GET', '/v1/notifications/config');
    expect(cfg.body).toEqual({ command: { configured: true, program: 'hook.sh' } });
  });

  it('routine and decision notices are not sent immediately', async () => {
    expect(await m.d.services.notifier.handle(notice('conflicts:new', 'warn'))).toBe('digest');
    expect(await m.d.services.notifier.handle(notice('deletions:pending', 'info'))).toBe('digest');
    expect(await m.d.services.notifier.handle(notice('adoption:3', 'info'))).toBe('digest');
    expect(await m.d.services.notifier.handle(notice('misc', 'info'))).toBe('skipped');
    expect(lines()).toHaveLength(0);
  });

  it('records failures (non-zero exit with stderr) and retries after the short back-off', async () => {
    writeFileSync(rcFile, '3');
    expect(await m.d.services.notifier.handle(notice('brake:1'))).toBe('failed');
    const row = m.d.db
      .prepare("SELECT channel, ok, detail FROM notifications WHERE dedupe_key = 'brake:1' ORDER BY id DESC")
      .get() as { channel: string; ok: number; detail: string };
    expect(row).toMatchObject({ channel: 'command', ok: 0 });
    expect(row.detail).toBe('command exited 3: hook failed on purpose');
    // a failed attempt is retried after the short back-off, not blocked for minIntervalMinutes
    writeFileSync(rcFile, '0');
    expect(await m.d.services.notifier.handle(notice('brake:1'))).toBe('duplicate');
    m.d.db.prepare("UPDATE notifications SET ts = ts - 600000 WHERE dedupe_key = 'brake:1'").run();
    expect(await m.d.services.notifier.handle(notice('brake:1'))).toBe('sent');
  });

  it('relays engine notice events and logs them', async () => {
    m.d.engine.emitEvent({ type: 'notice', notice: notice('offline:alex', 'warn') });
    await waitFor(() => lines().length === 1);
    expect(lines()[0]).toContain('notice|warn|offline:alex|');
    const last = () => m.req<{ key: string; ok: boolean; channel: string }[]>('GET', '/v1/notifications');
    await waitFor(async () => (await last()).body[0]?.key === 'offline:alex');
    expect((await last()).body[0]).toMatchObject({ key: 'offline:alex', ok: true, channel: 'command' });
  });

  it('sends one daily digest of pending decisions', async () => {
    const e = Number(
      m.d.db
        .prepare(
          "INSERT INTO entries (pair_id, rel_path, kind, state, updated_at) VALUES (1, 'x/y.txt', 'file', 'conflict', ?)",
        )
        .run(Date.now()).lastInsertRowid,
    );
    m.d.db
      .prepare("INSERT INTO conflicts (entry_id, kind, detected_at) VALUES (?, 'both_changed', ?)")
      .run(e, Date.now());
    const at10 = new Date();
    at10.setHours(10, 0, 0, 0);
    const at6 = new Date(at10);
    at6.setHours(6);
    expect(await m.d.services.notifier.dailyDigest(at6)).toBe('skipped');
    expect(await m.d.services.notifier.dailyDigest(at10)).toBe('sent');
    expect(lines()).toEqual(['digest|info|digest:daily||Pending decisions']);
    expect(await m.d.services.notifier.dailyDigest(at10)).toBe('duplicate');
  });

  it('test route: runs the command (UI token only) and reports failures', async () => {
    const res = await m.req<{ channel: string; ok: boolean }[]>('POST', '/v1/notifications/test', {
      channel: 'command',
    });
    expect(res.body).toEqual([{ channel: 'command', ok: true, detail: 'command exited 0' }]);
    expect(lines()).toEqual(['test|info|test||Test notification']);
    const all = await m.req<{ channel: string; ok: boolean }[]>('POST', '/v1/notifications/test', {});
    expect(all.body).toEqual([{ channel: 'command', ok: true, detail: 'command exited 0' }]);
    expect((await m.req('POST', '/v1/notifications/test', {}, 'agent')).status).toBe(403);
    m.d.services.ctx.config.notifyCommand = ['/nonexistent/hook'];
    const bad = await m.req<{ ok: boolean; detail: string }[]>('POST', '/v1/notifications/test', {});
    expect(bad.body[0]!.ok).toBe(false);
    expect(bad.body[0]!.detail).toContain('notifyCommand');
    on();
  });
});

describe('the removed Telegram channel', () => {
  it('has no settings, routes or test channel any more', async () => {
    const s = await m.req<SettingsDto>('GET', '/v1/settings');
    expect(Object.keys(s.body.notifications).sort()).toEqual(['desktop', 'minIntervalMinutes']);
    const put = await m.req<{ error: string }>('PUT', '/v1/settings', {
      notifications: { telegram: { enabled: true, chatId: '424242' } },
    });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain('notifyCommand');
    expect((await m.req('PUT', '/v1/notifications/telegram-token', { token: null })).status).toBe(404);
    expect((await m.req('POST', '/v1/notifications/test', { channel: 'telegram' })).status).toBe(400);
    // a full settings object as the dashboard sends it is still accepted
    const full = await m.req<SettingsDto>('PUT', '/v1/settings', { notifications: s.body.notifications });
    expect(full.status).toBe(200);
    const row = m.d.db.prepare("SELECT value FROM settings WHERE key = 'notifications'").get() as { value: string };
    expect(Object.keys(JSON.parse(row.value)).sort()).toEqual(['desktop', 'minIntervalMinutes']);
  });
});

describe('legacy bot token clean-up (once, best effort)', () => {
  it('runs at service start and removes the mock token file only once', async () => {
    await waitFor(() => !!m.d.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_TOKEN_DONE_KEY));
    const f = path.join(m.mockDir, 'secrets', '_telegram-bot-token');
    writeFileSync(f, 'old-token');
    expect(await removeLegacyBotToken(m.d.services.ctx)).toEqual([]); // already done
    expect(existsSync(f)).toBe(true);
    m.d.db.prepare('DELETE FROM meta WHERE key = ?').run(LEGACY_TOKEN_DONE_KEY);
    expect(await removeLegacyBotToken(m.d.services.ctx)).toEqual(['file: _telegram-bot-token']);
    expect(existsSync(f)).toBe(false);
  });

  const prodCtx = (config: ServiceContext['config'], pathDir: string) => {
    const state = tmp('legacy-token-');
    const secretsDir = path.join(state, 'secrets');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(path.join(secretsDir, '_telegram-bot-token.enc'), '{"v":1}');
    const ctx = {
      db: openDb(':memory:'),
      mode: 'production',
      paths: { stateDir: state, secretsDir } as NucleonSyncPaths,
      env: { PATH: pathDir },
      config,
    } as unknown as ServiceContext;
    return { ctx, enc: path.join(secretsDir, '_telegram-bot-token.enc') };
  };

  it('production: deletes the encrypted file and clears the keyring item through secret-tool', async () => {
    const bin = tmp('fake-secret-tool-');
    const calls = path.join(bin, 'calls.txt');
    writeFileSync(path.join(bin, 'secret-tool'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexit 1\n`);
    chmodSync(path.join(bin, 'secret-tool'), 0o755);
    const { ctx, enc } = prodCtx({}, bin);
    const r = await removeLegacyBotToken(ctx);
    expect(r).toEqual(['file: _telegram-bot-token.enc', 'keyring: secret-tool exited 1']);
    expect(existsSync(enc)).toBe(false);
    expect(readFileSync(calls, 'utf8')).toBe('clear service nucleon-sync kind telegram-bot-token\n');
    expect(await removeLegacyBotToken(ctx)).toEqual([]); // once
    // encfile backend: no Secret Service, secret-tool is not started
    const e = prodCtx({ secretBackend: 'encfile' }, bin);
    expect(await removeLegacyBotToken(e.ctx)).toEqual(['file: _telegram-bot-token.enc']);
    expect(readFileSync(calls, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('never fails: no secret-tool, closed database', async () => {
    const { ctx } = prodCtx({}, tmp('empty-path-'));
    expect(await removeLegacyBotToken(ctx)).toEqual([
      'file: _telegram-bot-token.enc',
      'keyring: secret-tool not found',
    ]);
    const closed = prodCtx({}, tmp('empty-path-'));
    closed.ctx.db.close();
    const r = await removeLegacyBotToken(closed.ctx);
    expect(r[0]).toMatch(/^error: /);
  });
});
