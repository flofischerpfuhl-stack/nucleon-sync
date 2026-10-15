// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared types of the dashboard (additive).
 * Put NEW shared types here instead of editing api.ts/events.ts, so parallel packages never edit the same file.
 * Everything here is optional for the daemon: the UI works without it (fixtures / graceful fallbacks).
 * Requests to /are listed in docs/CHANGELOG-.md.
 */
import type { ActivityItem, PairDirection, PauseRequest } from './api.ts';
import type { MsgRef } from './messages.ts';

/** Body of destructive endpoints in the confirm round-trip (second call carries the token). */
export type WithConfirm<T> = T & { confirmToken?: string };

/** Pause with an end time (tray "1 Stunde" / "bis morgen"). Daemons that ignore `until` are resumed by the UI. */
export interface TimedPauseRequest extends PauseRequest {
  until?: string;
}

/** Activity row with the run it belongs to (UI groups by run; falls back to time ranges when absent). */
export type ActivityItemWithRun = ActivityItem & { runId?: number | null };

/** GET /v1/remote/:accountId/browse?path= entry (pair wizard). */
export interface RemoteBrowseEntry {
  name: string;
  uid: string;
  type: 'folder' | 'file';
}

/** POST /v1/pairs body (create). */
export interface CreatePairRequest {
  accountId: string;
  name: string;
  localRoot: string;
  remoteRoot: string;
  direction: PairDirection;
  enabled: boolean;
  /** create the Proton folder (and missing parents below /my-files or a device root) if it does not exist (setup wizard) */
  createRemote?: boolean;
}

/** POST /v1/pairs/preview: dry-run of the first contact for a new pair (counts only, nothing is written). */
export interface PairPreviewDto {
  adopt: number;
  upload: number;
  uploadBytes: number;
  download: number;
  downloadBytes: number;
  conflicts: number;
  excluded: number;
  /** English texts */
  warnings: string[];
  /** key + params of each warning, same order as `warnings` (additive) */
  warningMsgs?: MsgRef[];
}

/** GET /v1/storage/history?days=90 */
export interface StorageHistoryPoint {
  accountId: string;
  at: string;
  bytes: number;
}

/** GET /v1/maintenance/summary (Wartung screen). */
export interface MaintenanceSummaryDto {
  digestMissing: { accountId: string; files: number; bytes: number; duplicateFiles: number; duplicateBytes: number }[];
  trash: { accountId: string; items: number; bytes: number; ownItems: number }[];
  backfill: { runId: number; pairId: number; relPrefix: string | null; done: number; total: number } | null;
}
