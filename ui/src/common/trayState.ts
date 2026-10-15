// SPDX-License-Identifier: GPL-3.0-or-later
import type { StatusDto } from '@nucleon-sync/shared';

import type { ConnectionState } from './ipc.ts';

/** Tray icon states: teal idle (nucleus), blue syncing, grey paused, amber attention, red error/offline. */
export type TrayState = 'idle' | 'syncing' | 'paused' | 'attention' | 'error';

const ATTENTION_ACCOUNT = new Set(['needs_login', 'needs_keyring', 'login_pending', 'throttled']);
const ERROR_ACCOUNT = new Set(['error', 'offline']);

export function deriveTrayState(status: StatusDto | null, connection: ConnectionState): TrayState {
  if (connection === 'disconnected' || !status) return 'error';
  if (status.state === 'error' || status.state === 'offline') return 'error';
  if (status.accounts.some((a) => ERROR_ACCOUNT.has(a.status))) return 'error';
  if (status.paused || status.state === 'paused') return 'paused';
  if (status.state === 'syncing') return 'syncing';
  if (
    status.openConflicts > 0 ||
    status.pendingDeletions > 0 ||
    status.queue.failed > 0 ||
    status.accounts.some((a) => ATTENTION_ACCOUNT.has(a.status))
  )
    return 'attention';
  return 'idle';
}

/** RGB colours per state, shared by the tray rasteriser and the renderer's status dot. */
export const TRAY_COLORS: Record<TrayState, [number, number, number]> = {
  idle: [14, 135, 145],
  syncing: [52, 140, 255],
  paused: [140, 136, 150],
  attention: [245, 165, 36],
  error: [232, 64, 80],
};
