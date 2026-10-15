// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Storage measurement : `filesystem size` per area (my-files, every device root) + the Proton trash listing,
 * stored as one batch of `storage_samples` rows per measurement; daily and on demand. The CLI has no quota API, the shared
 * pool size is a setting. Reads only.
 */
import {
  msg,
  refOf,
  type Msg,
  type StorageDto,
  type StorageHistoryPoint,
  type StoragePoolDto,
} from '@nucleon-sync/shared';

import { readSettings } from '../engine/settings.ts';
import { conflict, HttpError } from '../util/http.ts';
import { log } from '../util/log.ts';
import type { AccountsService } from './accounts.ts';
import type { ServiceContext } from './context.ts';

export const TRASH_AREA = '/trash';

interface Sample {
  area: string;
  bytes: number;
  files: number | null;
  measured_at: number;
}

export function areaLabel(area: string): string {
  return areaLabelMsg(area)?.text ?? (area.startsWith('/devices/') ? area.slice('/devices/'.length) : area);
}

/** translatable labels of the fixed areas (devices are labelled with their name) */
function areaLabelMsg(area: string): Msg | null {
  if (area === '/my-files') return msg('storage.myFiles');
  if (area === TRASH_AREA) return msg('storage.trash');
  return null;
}

export class StorageService {
  private readonly c: ServiceContext;
  private readonly accounts: AccountsService;
  private readonly running = new Map<string, Promise<StorageDto>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(c: ServiceContext, accounts: AccountsService) {
    this.c = c;
    this.accounts = accounts;
  }

  /** Measures one account now (one batch of samples). Concurrent calls for the same account share the run. */
  measure(accountId: string): Promise<StorageDto> {
    this.accounts.require(accountId); // 404 for unknown ids
    const cur = this.running.get(accountId);
    if (cur) return cur;
    const blocked = this.blockedReason(accountId);
    if (blocked) return Promise.reject(conflict(blocked));
    this.c.engine.emitEvent({ type: 'storage', accountId, phase: 'start' });
    const p = this.doMeasure(accountId)
      .then(
        (dto) => {
          this.c.engine.emitEvent({ type: 'storage', accountId, phase: 'done' });
          return dto;
        },
        (e: unknown) => {
          this.c.engine.emitEvent({
            type: 'storage',
            accountId,
            phase: 'failed',
            message: (e as Error).message.slice(0, 300),
          });
          throw e;
        },
      )
      .finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  /** why an account cannot be measured right now (null = it can) */
  private blockedReason(accountId: string): string | null {
    const acc = this.accounts.require(accountId);
    if (acc.status !== 'ok') return msg('account.notReady', { account: acc.display_name, status: acc.status }).text;
    return this.accounts.gate(accountId);
  }

  /**
   * Starts measurements in the background (UI "Aktualisieren": the API answers at once, progress and results arrive
   * as SSE `storage` events and via `measuring` in GET /v1/storage). Accounts that cannot be measured right now are
   * reported in `skipped` instead of failing the whole request.
   */
  measureInBackground(ids: string[]): { started: string[]; skipped: { accountId: string; reason: string }[] } {
    const started: string[] = [];
    const skipped: { accountId: string; reason: string }[] = [];
    for (const id of ids) {
      const blocked = this.running.has(id) ? null : this.blockedReason(id);
      if (blocked) {
        skipped.push({ accountId: id, reason: blocked });
        continue;
      }
      this.measure(id).catch((e: unknown) =>
        log('warn', 'storage measurement failed', { account: id, err: (e as Error).message }),
      );
      started.push(id);
    }
    return { started, skipped };
  }

  /** account ids with a measurement in progress */
  measuring(): string[] {
    return [...this.running.keys()];
  }

  private async doMeasure(accountId: string): Promise<StorageDto> {
    const remote = this.c.engine.remote(accountId);
    const at = Date.now();
    const rows: { area: string; bytes: number; files: number | null }[] = [];
    try {
      const areas = ['/my-files'];
      for (const d of await remote.listDevices()) if (d.name) areas.push(`/devices/${d.name}`);
      for (const area of areas) {
        const s = await remote.size({ path: area });
        rows.push({ area, bytes: s.size, files: s.numberOfDescendants });
      }
      const trash = await remote.list({ path: TRASH_AREA }).catch(() => null);
      if (trash)
        rows.push({
          area: TRASH_AREA,
          bytes: trash.reduce((s, n) => s + (n.totalStorageSize ?? n.rev?.storageSize ?? 0), 0),
          files: trash.length,
        });
    } catch (e) {
      throw new HttpError(502, 'internal', `storage measurement failed: ${(e as Error).message.slice(0, 200)}`);
    }
    const ins = this.c.db.prepare(
      'INSERT INTO storage_samples (account_id, area, bytes, files, measured_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.c.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) ins.run(accountId, r.area, r.bytes, r.files, at);
      this.c.db.exec('COMMIT');
    } catch (e) {
      this.c.db.exec('ROLLBACK');
      throw e;
    }
    log('info', 'storage measured', { account: accountId, areas: rows.length });
    return this.account(accountId);
  }

  private latest(accountId: string): Sample[] {
    return this.c.db
      .prepare(
        `SELECT area, bytes, files, measured_at FROM storage_samples
         WHERE account_id = ? AND measured_at = (SELECT MAX(measured_at) FROM storage_samples WHERE account_id = ?)
         ORDER BY area`,
      )
      .all(accountId, accountId) as unknown as Sample[];
  }

  account(accountId: string): StorageDto {
    this.accounts.require(accountId);
    const samples = this.latest(accountId);
    const st = this.c.db
      .prepare(
        `SELECT COALESCE(SUM(e.r_rev_storage), 0) AS active,
                COALESCE(SUM(CASE WHEN e.r_storage > e.r_rev_storage THEN e.r_storage - e.r_rev_storage ELSE 0 END), 0) AS old
         FROM entries e JOIN pairs p ON p.id = e.pair_id WHERE p.account_id = ? AND e.r_exists = 1 AND e.kind = 'file'`,
      )
      .get(accountId) as { active: number; old: number };
    const areas = samples.filter((s) => s.area !== TRASH_AREA);
    return {
      accountId,
      measuredAt: samples[0] ? new Date(samples[0].measured_at).toISOString() : null,
      areas: areas.map((s) => ({
        path: s.area,
        label: areaLabel(s.area),
        ...(areaLabelMsg(s.area) ? { labelMsg: refOf(areaLabelMsg(s.area)) } : {}),
        bytes: s.bytes,
        files: s.files ?? 0,
      })),
      activeBytes: st.active,
      totalBytes: areas.reduce((s, a) => s + a.bytes, 0),
      reclaimableOldRevisionsBytes: st.old,
      trashBytes: samples.find((s) => s.area === TRASH_AREA)?.bytes ?? 0,
    };
  }

  /** Latest trash sample (items, bytes) — used by the empty-trash confirm summary and the maintenance summary. */
  trash(accountId: string): { items: number; bytes: number; measuredAt: number | null } {
    const r = this.c.db
      .prepare(
        'SELECT bytes, files, measured_at FROM storage_samples WHERE account_id = ? AND area = ? ORDER BY measured_at DESC LIMIT 1',
      )
      .get(accountId, TRASH_AREA) as { bytes: number; files: number | null; measured_at: number } | undefined;
    return { items: r?.files ?? 0, bytes: r?.bytes ?? 0, measuredAt: r?.measured_at ?? null };
  }

  pool(): StoragePoolDto {
    return {
      poolBytes: readSettings(this.c.db).storagePoolBytes,
      accounts: this.accounts.rows().map((a) => this.account(a.id)),
      measuring: this.measuring(),
    };
  }

  /** One point per account and day (latest measurement of the day, trash excluded). */
  history(days: number): StorageHistoryPoint[] {
    const since = Date.now() - Math.max(1, Math.min(days, 3650)) * 86400_000;
    const rows = this.c.db
      .prepare(
        `SELECT account_id, measured_at, SUM(bytes) AS bytes FROM storage_samples
         WHERE measured_at >= ? AND area != ? GROUP BY account_id, measured_at ORDER BY measured_at`,
      )
      .all(since, TRASH_AREA) as { account_id: string; measured_at: number; bytes: number }[];
    const perDay = new Map<string, StorageHistoryPoint>();
    for (const r of rows) {
      const day = new Date(r.measured_at).toISOString().slice(0, 10);
      perDay.set(`${r.account_id}|${day}`, {
        accountId: r.account_id,
        at: new Date(r.measured_at).toISOString(),
        bytes: r.bytes,
      });
    }
    return [...perDay.values()];
  }

  /**
   * Daily measurement: the first check runs soon after start (default 60 s, `NUCLEON_SYNC_STORAGE_FIRST_MS`) so that
   * accounts that were never measured get their first numbers right away; then hourly. Already measured accounts are
   * measured again once per day at/after `dailyHour`.
   */
  start(): void {
    const tick = () => {
      this.timer = setTimeout(tick, 3600_000);
      this.timer.unref();
      void this.daily();
    };
    const raw = this.c.env.NUCLEON_SYNC_STORAGE_FIRST_MS;
    const first = raw ? Number(raw) : NaN;
    this.timer = setTimeout(tick, Number.isFinite(first) && first >= 0 ? first : 60_000);
    this.timer.unref();
  }

  async daily(now = new Date()): Promise<void> {
    const paused = this.c.engine.status().paused;
    if (paused) return;
    const afterDailyHour = now.getHours() >= (this.c.config.dailyHour ?? 9);
    for (const a of this.accounts.rows()) {
      if (a.status !== 'ok' || a.paused || !a.enabled) continue;
      const last = this.latest(a.id)[0]?.measured_at ?? null;
      // never measured: measure now (any hour); otherwise once per day after dailyHour
      if (last !== null && (!afterDailyHour || now.getTime() - last < 20 * 3600_000)) continue;
      try {
        await this.measure(a.id);
      } catch (e) {
        log('warn', 'daily storage measurement failed', { account: a.id, err: (e as Error).message });
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
