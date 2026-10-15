// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Telegram Bot API transport. The bot token comes from the app secret store at send time; it is never logged or put
 * into error messages (transport errors are scrubbed). Success only on HTTP 200 with `{"ok": true}`.
 */

/** Rough shape check of a bot token (`<bot id>:<secret>`), so typos are caught when it is stored. */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token.trim());
}

export interface TelegramSendOptions {
  apiBase: string;
  token: string;
  chatId: string;
  text: string;
  timeoutMs?: number;
}

export async function sendTelegram(o: TelegramSendOptions): Promise<{ ok: boolean; detail: string }> {
  const scrub = (s: string) => s.split(o.token).join('<token>');
  try {
    const res = await fetch(`${o.apiBase.replace(/\/+$/, '')}/bot${o.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: o.chatId, text: o.text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
    const body = await res.text();
    let ok = false;
    let desc = '';
    try {
      const j = JSON.parse(body) as { ok?: boolean; description?: string };
      ok = j.ok === true;
      desc = j.description ?? '';
    } catch {
      desc = body.slice(0, 200);
    }
    if (res.status === 200 && ok) return { ok: true, detail: 'sent' };
    return { ok: false, detail: scrub(`HTTP ${res.status}${desc ? `: ${desc}` : ''}`).slice(0, 300) };
  } catch (e) {
    return { ok: false, detail: scrub((e as Error).message).slice(0, 300) };
  }
}
