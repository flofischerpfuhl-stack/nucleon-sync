// SPDX-License-Identifier: GPL-3.0-or-later
import type { StatusDto } from '@nucleon-sync/shared';

/** Minimal StatusDto for unit tests. */
export function status(patch: Partial<StatusDto> = {}): StatusDto {
  return {
    apiVersion: 'v1',
    daemonVersion: 't',
    pid: 1,
    startedAt: '2026-10-10T00:00:00Z',
    mode: 'mock',
    state: 'idle',
    paused: false,
    currentRun: null,
    lastRun: null,
    nextRuns: [],
    accounts: [
      {
        id: 'alex',
        displayName: 'Alex',
        email: null,
        status: 'ok',
        lastError: null,
        lastOkAt: null,
        credentialBackend: 'mock',
        workers: { configured: 2, active: 1 },
        paused: false,
      },
    ],
    pairs: [],
    queue: { queued: 0, running: 0, retryWait: 0, failed: 0, blocked: 0 },
    openConflicts: 0,
    pendingDeletions: 0,
    rate: { uploadBps: 0, downloadBps: 0, metaLatencyMsEwma: null },
    ...patch,
  };
}
