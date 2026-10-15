// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Notifier: Telegram Bot API against a FAKE endpoint (never api.telegram.org), the notify command, de-dup, digest,
 * token hygiene (the token is stored through the API and never returned or logged).
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Notice } from '@nucleon-sync/shared';

import { looksLikeBotToken, sendTelegram } from '../src/notify/telegram.ts';
import { startMockDaemon, waitFor, type MockDaemon } from './c-helpers.ts';
import { tmp } from './helpers.ts';

const TOKEN = '123456:FAKE-test-token_abcdefghijklmnopqrstuvwxyz';
let cmdOut: string;
let m: MockDaemon;
let server: http.Server;
let base: string;
let received: { url: string; body: { chat_id: string; text: string } }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, result: {} } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // the notify command: a tiny script that appends its environment to a file
  const dir = tmp('notify-cmd-');
  cmdOut = path.join(dir, 'out.txt');
  const script = path.join(dir, 'hook.sh');
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$NUCLEON_SYNC_EVENT" "$NUCLEON_SYNC_SEVERITY" "$NUCLEON_SYNC_KEY" "$NUCLEON_SYNC_ACCOUNT_NAME" >> ${JSON.stringify(cmdOut)}\n`,
  );
  chmodSync(script, 0o755);
  writeFileSync(cmdOut, '');
  m = await startMockDaemon({ startServices: true, config: { telegramApiBase: base } });
});
afterAll(async () => {
  await m.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  received = [];
  reply = { status: 200, body: { ok: true, result: {} } };
});

const notice = (key: string, severity: Notice['severity'] = 'error'): Notice => ({
  key,
  severity,
  title: 'Sign-in required',
  body: 'The account Sam has to sign in again.',
  accountId: 'sam',
});

describe('telegram helpers', () => {
  it('checks the bot token shape', () => {
    expect(looksLikeBotToken(TOKEN)).toBe(true);
    expect(looksLikeBotToken('not a token')).toBe(false);
    expect(looksLikeBotToken('123:short')).toBe(false);
  });

  it('scrubs the token from transport errors', async () => {
    const r = await sendTelegram({
      apiBase: 'http://127.0.0.1:1',
      token: TOKEN,
      chatId: '1',
      text: 'x',
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(TOKEN);
  });
});

describe('notifier', () => {
  it('is disabled by default', async () => {
    expect(await m.d.services.notifier.handle(notice('error:auth:sam'))).toBe('disabled');
    expect(received).toHaveLength(0);
  });

  it('stores the bot token only through the UI token and never returns it', async () => {
    expect((await m.req('PUT', '/v1/notifications/telegram-token', { token: 'nope' })).status).toBe(400);
    expect((await m.req('PUT', '/v1/notifications/telegram-token', { token: TOKEN })).status).toBe(200);
    const cfg = await m.req<{ telegram: { tokenSet: boolean } }>('GET', '/v1/notifications/config');
    expect(cfg.body.telegram.tokenSet).toBe(true);
    expect(JSON.stringify(cfg.body)).not.toContain(TOKEN);
    const agent = await m.req('PUT', '/v1/notifications/telegram-token', { token: TOKEN }, 'agent');
    expect(agent.status).toBe(403);
    // enabling Telegram needs a chat id
    expect((await m.req('PUT', '/v1/settings', { notifications: { telegram: { enabled: true } } })).status).toBe(400);
  });

  it('sends warn/error notices via the Bot API and de-duplicates per key', async () => {
    expect(
      (
        await m.req('PUT', '/v1/settings', {
          notifications: { telegram: { enabled: true, chatId: '424242' }, minIntervalMinutes: 60 },
        })
      ).status,
    ).toBe(200);
    expect(await m.d.services.notifier.handle(notice('error:auth:sam'))).toBe('sent');
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe(`/bot${TOKEN}/sendMessage`);
    expect(received[0]!.body.chat_id).toBe('424242');
    expect(received[0]!.body.text).toContain('Sign-in required (Sam)');
    expect(await m.d.services.notifier.handle(notice('error:auth:sam'))).toBe('duplicate');
    expect(await m.d.services.notifier.handle(notice('quota:sam'))).toBe('sent');
    expect(received).toHaveLength(2);
  });

  it('routine and decision notices are not sent immediately', async () => {
    expect(await m.d.services.notifier.handle(notice('conflicts:new', 'warn'))).toBe('digest');
    expect(await m.d.services.notifier.handle(notice('deletions:pending', 'info'))).toBe('digest');
    expect(await m.d.services.notifier.handle(notice('adoption:3', 'info'))).toBe('digest');
    expect(await m.d.services.notifier.handle(notice('misc', 'info'))).toBe('skipped');
    expect(received).toHaveLength(0);
  });

  it('records failures (HTTP error, ok:false) without the token and retries later', async () => {
    reply = { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } };
    expect(await m.d.services.notifier.handle(notice('brake:1'))).toBe('failed');
    reply = { status: 200, body: { ok: false } };
    expect(await m.d.services.notifier.handle(notice('disk:full'))).toBe('failed');
    const rows = m.d.db.prepare('SELECT dedupe_key, ok, detail, message FROM notifications WHERE ok = 0').all() as {
      dedupe_key: string;
      detail: string;
      message: string;
    }[];
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(['brake:1', 'disk:full']);
    expect(rows[0]!.detail).toContain('chat not found');
    for (const r of rows) expect(`${r.detail}${r.message}`).not.toContain(TOKEN);
    // a failed attempt is retried after the short back-off, not blocked for minIntervalMinutes
    expect(await m.d.services.notifier.handle(notice('brake:1'))).toBe('duplicate');
    m.d.db.prepare("UPDATE notifications SET ts = ts - 600000 WHERE dedupe_key = 'brake:1'").run();
    reply = { status: 200, body: { ok: true } };
    expect(await m.d.services.notifier.handle(notice('brake:1'))).toBe('sent');
  });

  it('relays engine notice events', async () => {
    m.d.engine.emitEvent({ type: 'notice', notice: notice('offline:alex', 'warn') });
    await waitFor(() => received.length === 1);
    expect(received[0]!.body.text).toContain('Nucleon Sync');
    const log = await m.req<{ key: string; ok: boolean }[]>('GET', '/v1/notifications');
    expect(log.body[0]).toMatchObject({ key: 'offline:alex', ok: true });
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
    expect(received[0]!.body.text).toContain('1 conflict');
    expect(await m.d.services.notifier.dailyDigest(at10)).toBe('duplicate');
  });

  it('runs the notify command with the event in its environment', async () => {
    m.d.services.ctx.config.notifyCommand = [path.join(path.dirname(cmdOut), 'hook.sh')];
    try {
      expect(await m.d.services.notifier.handle(notice('error:auth:alex'))).toBe('sent');
      expect(readFileSync(cmdOut, 'utf8')).toContain('notice|error|error:auth:alex|');
      const res = await m.req<{ channel: string; ok: boolean }[]>('POST', '/v1/notifications/test', {
        channel: 'command',
      });
      expect(res.body).toEqual([{ channel: 'command', ok: true, detail: 'command exited 0' }]);
      expect(readFileSync(cmdOut, 'utf8')).toContain('test|info|test|');
      m.d.services.ctx.config.notifyCommand = ['/nonexistent/hook'];
      const bad = await m.req<{ ok: boolean; detail: string }[]>('POST', '/v1/notifications/test', {
        channel: 'command',
      });
      expect(bad.body[0]!.ok).toBe(false);
    } finally {
      delete m.d.services.ctx.config.notifyCommand;
    }
  });

  it('never logs the token', async () => {
    const all = m.d.db.prepare('SELECT message, detail FROM notifications').all() as {
      message: string;
      detail: string;
    }[];
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
