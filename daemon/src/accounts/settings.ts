// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Settings GET/PUT. Storage layout as reads it (engine/settings.ts): one `settings` row per section —
 * 'schedule' | 'transfer' | 'notifications' | 'storagePoolBytes' | 'globalExcludes' (JSON each). PUT takes a partial
 * SettingsDto (sections may be partial too), validates the merged result and calls engine.reload().
 */
import type { SettingsDto } from '@nucleon-sync/shared';

import { readSettings, writeEngineSetting } from '../engine/settings.ts';
import { badRequest } from '../util/http.ts';
import type { ServiceContext } from './context.ts';
import { validateRule } from './pairs.ts';

const SECTIONS = ['schedule', 'transfer', 'notifications', 'storagePoolBytes', 'globalExcludes'] as const;

const int = (v: unknown, min: number, max: number, where: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw badRequest(`${where} must be an integer ${min}..${max}`);
  return v;
};
const bool = (v: unknown, where: string): boolean => {
  if (typeof v !== 'boolean') throw badRequest(`${where} must be boolean`);
  return v;
};
const nullablePos = (v: unknown, where: string, max = Number.MAX_SAFE_INTEGER): number | null => {
  if (v === null) return null;
  return int(v, 1, max, where);
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateSettings(s: SettingsDto): SettingsDto {
  const sc = s.schedule;
  int(sc.incrementalEveryMinutes, 15, 7 * 24 * 60, 'schedule.incrementalEveryMinutes');
  if (!sc.fullWeekly || typeof sc.fullWeekly !== 'object') throw badRequest('schedule.fullWeekly required');
  int(sc.fullWeekly.weekday, 0, 6, 'schedule.fullWeekly.weekday');
  int(sc.fullWeekly.hour, 0, 23, 'schedule.fullWeekly.hour');
  int(sc.fullEveryWeeks, 1, 8, 'schedule.fullEveryWeeks');
  int(sc.runOnStartupDelayMinutes, 0, 240, 'schedule.runOnStartupDelayMinutes');
  const t = s.transfer;
  int(t.maxWorkersTotal, 1, 6, 'transfer.maxWorkersTotal');
  int(t.maxWorkersPerAccount, 1, 4, 'transfer.maxWorkersPerAccount');
  if (t.maxWorkersPerAccount > t.maxWorkersTotal)
    throw badRequest('transfer.maxWorkersPerAccount must not exceed transfer.maxWorkersTotal');
  nullablePos(t.bandwidthLimitKBps, 'transfer.bandwidthLimitKBps', 10_000_000);
  if (t.quietHours !== null) {
    const q = t.quietHours;
    if (!q || typeof q !== 'object')
      throw badRequest('transfer.quietHours must be null or {from, to, bandwidthLimitKBps}');
    if (!HHMM.test(String(q.from)) || !HHMM.test(String(q.to)))
      throw badRequest('transfer.quietHours.from/to must be HH:MM');
    nullablePos(q.bandwidthLimitKBps, 'transfer.quietHours.bandwidthLimitKBps', 10_000_000);
  }
  bool(t.thumbnails, 'transfer.thumbnails');
  nullablePos(t.maxFileBytes, 'transfer.maxFileBytes');
  const n = s.notifications;
  bool(n.desktop, 'notifications.desktop');
  if (!n.telegram || typeof n.telegram !== 'object') throw badRequest('notifications.telegram required');
  bool(n.telegram.enabled, 'notifications.telegram.enabled');
  if (typeof n.telegram.chatId !== 'string' || !/^(-?\d{1,20})?$/.test(n.telegram.chatId.trim()))
    throw badRequest('notifications.telegram.chatId must be a numeric chat id (or empty)');
  n.telegram = { enabled: n.telegram.enabled, chatId: n.telegram.chatId.trim() };
  if (n.telegram.enabled && !n.telegram.chatId)
    throw badRequest('notifications.telegram.chatId is required when Telegram is enabled');
  int(n.minIntervalMinutes, 1, 7 * 24 * 60, 'notifications.minIntervalMinutes');
  nullablePos(s.storagePoolBytes, 'storagePoolBytes');
  if (!Array.isArray(s.globalExcludes)) throw badRequest('globalExcludes must be an array');
  if (s.globalExcludes.length > 1000) throw badRequest('too many globalExcludes');
  s.globalExcludes = s.globalExcludes.map((r, i) => validateRule(r, `globalExcludes[${i}]`));
  return s;
}

export class SettingsService {
  private readonly c: ServiceContext;
  constructor(c: ServiceContext) {
    this.c = c;
  }

  get(): SettingsDto {
    return readSettings(this.c.db);
  }

  async put(patch: unknown): Promise<SettingsDto> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw badRequest('body must be a (partial) SettingsDto');
    const p = { ...(patch as Record<string, unknown>) };
    delete p.confirmToken;
    const unknown = Object.keys(p).filter((k) => !(SECTIONS as readonly string[]).includes(k));
    if (unknown.length) throw badRequest(`unknown settings: ${unknown.join(', ')}`);
    const cur = readSettings(this.c.db);
    const merged: SettingsDto = {
      schedule: { ...cur.schedule, ...((p.schedule as object) ?? {}) },
      transfer: { ...cur.transfer, ...((p.transfer as object) ?? {}) },
      notifications: { ...cur.notifications, ...((p.notifications as object) ?? {}) },
      storagePoolBytes: 'storagePoolBytes' in p ? (p.storagePoolBytes as number | null) : cur.storagePoolBytes,
      globalExcludes: 'globalExcludes' in p ? (p.globalExcludes as SettingsDto['globalExcludes']) : cur.globalExcludes,
    };
    if ('schedule' in p && (p.schedule as { fullWeekly?: object }).fullWeekly)
      merged.schedule.fullWeekly = { ...cur.schedule.fullWeekly, ...(p.schedule as { fullWeekly: object }).fullWeekly };
    if ('notifications' in p && (p.notifications as { telegram?: object }).telegram)
      merged.notifications.telegram = {
        ...cur.notifications.telegram,
        ...(p.notifications as { telegram: object }).telegram,
      };
    validateSettings(merged);
    this.c.db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of SECTIONS) if (k in p) writeEngineSetting(this.c.db, k, merged[k]);
      this.c.db.exec('COMMIT');
    } catch (e) {
      this.c.db.exec('ROLLBACK');
      throw e;
    }
    await this.c.engine.reload();
    return this.get();
  }
}
