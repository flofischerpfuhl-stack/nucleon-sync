// SPDX-License-Identifier: GPL-3.0-or-later
/** Read-only view of daemon settings for the engine (owns writing them via PUT /v1/settings). */
import type { DatabaseSync } from 'node:sqlite';

import { DEFAULT_SETTINGS, type SelectionRule, type SettingsDto } from '@nucleon-sync/shared';

export interface BrakeSettings {
  massDeletionAbsolute: number;
  massDeletionPercent: number;
  massDeletionMinFiles: number;
}

export const DEFAULT_BRAKES: BrakeSettings = {
  massDeletionAbsolute: 500,
  massDeletionPercent: 2,
  massDeletionMinFiles: 50,
};

function readJson(db: DatabaseSync, key: string): unknown {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value);
  } catch {
    return undefined;
  }
}

/**
 * Settings = DEFAULT_SETTINGS overlaid with either one 'settings' row (whole SettingsDto, partial allowed) or the
 * per-section rows 'schedule' | 'transfer' | 'notifications' | 'storagePoolBytes' | 'globalExcludes'.
 */
export function readSettings(db: DatabaseSync): SettingsDto {
  const whole = (readJson(db, 'settings') ?? {}) as Partial<SettingsDto>;
  const pick = <K extends keyof SettingsDto>(k: K): SettingsDto[K] | undefined =>
    (readJson(db, k) as SettingsDto[K] | undefined) ?? whole[k];
  const schedule = pick('schedule');
  const transfer = pick('transfer');
  const notifications = pick('notifications');
  return {
    schedule: { ...DEFAULT_SETTINGS.schedule, ...(schedule ?? {}) },
    transfer: { ...DEFAULT_SETTINGS.transfer, ...(transfer ?? {}) },
    notifications: {
      desktop: notifications?.desktop ?? DEFAULT_SETTINGS.notifications.desktop,
      telegram: { ...DEFAULT_SETTINGS.notifications.telegram, ...(notifications?.telegram ?? {}) },
      minIntervalMinutes: notifications?.minIntervalMinutes ?? DEFAULT_SETTINGS.notifications.minIntervalMinutes,
    },
    storagePoolBytes: pick('storagePoolBytes') ?? DEFAULT_SETTINGS.storagePoolBytes,
    globalExcludes: (pick('globalExcludes') as SelectionRule[] | undefined) ?? DEFAULT_SETTINGS.globalExcludes,
  };
}

export function readBrakes(db: DatabaseSync): BrakeSettings {
  return { ...DEFAULT_BRAKES, ...((readJson(db, 'brakes') as Partial<BrakeSettings> | undefined) ?? {}) };
}

export function writeEngineSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

export function readEngineSetting<T>(db: DatabaseSync, key: string): T | undefined {
  return readJson(db, key) as T | undefined;
}
