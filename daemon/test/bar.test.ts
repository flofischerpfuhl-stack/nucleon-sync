// SPDX-License-Identifier: GPL-3.0-or-later
/** Status-bar output (shared/src/bar.ts): states, icons, tooltip, Omarchy highlight class, language. */
import { describe, expect, it } from 'vitest';

import { BAR_ICONS, barLang, barOutput, barState, type StatusDto } from '@nucleon-sync/shared';

function status(p: Partial<StatusDto> = {}): StatusDto {
  return {
    apiVersion: 'v1',
    daemonVersion: 'test',
    pid: 1,
    startedAt: '2026-10-13T08:00:00.000Z',
    mode: 'mock',
    state: 'idle',
    paused: false,
    currentRun: null,
    lastRun: null,
    nextRuns: [{ mode: 'incremental', at: '2026-10-13T12:00:00.000Z' }],
    accounts: [
      {
        id: 'alice',
        displayName: 'Alice',
        email: null,
        status: 'ok',
        lastError: null,
        lastOkAt: null,
        credentialBackend: 'mock',
        workers: { configured: 1, active: 0 },
        paused: false,
      },
    ],
    pairs: [],
    queue: { queued: 0, running: 0, retryWait: 0, failed: 0, blocked: 0 },
    openConflicts: 0,
    pendingDeletions: 0,
    rate: { uploadBps: 0, downloadBps: 0, metaLatencyMsEwma: null },
    ...p,
  };
}

const NOW = new Date('2026-10-13T10:00:00.000Z');

describe('barOutput', () => {
  it('idle: cloud-check icon, class = state, tooltip with accounts and next run', () => {
    const b = barOutput(status(), { now: NOW });
    expect(b).toMatchObject({ text: BAR_ICONS.idle, alt: 'idle', class: 'idle' });
    expect(b.tooltip).toContain('Nucleon Sync: Up to date');
    expect(b.tooltip).toContain('Alice: OK');
    expect(b.tooltip).toContain('Next run');
  });

  it('priority: stopped › error › conflicts › throttled › paused › syncing › idle', () => {
    expect(barState(null)).toBe('stopped');
    const acc = status().accounts[0]!;
    expect(barState(status({ state: 'syncing', accounts: [{ ...acc, status: 'offline' }] }))).toBe('error');
    expect(barState(status({ paused: true, openConflicts: 2 }))).toBe('conflicts');
    expect(barState(status({ paused: true, accounts: [{ ...acc, status: 'needs_login' }] }))).toBe('conflicts');
    expect(barState(status({ paused: true, accounts: [{ ...acc, status: 'throttled' }] }))).toBe('throttled');
    expect(barState(status({ paused: true, state: 'paused' }))).toBe('paused');
    expect(barState(status({ state: 'syncing' }))).toBe('syncing');
  });

  it('syncing: transfer backlog with rate and ETA, percentage', () => {
    const b = barOutput(
      status({
        state: 'syncing',
        transfers: {
          active: [
            {
              jobIds: [1],
              accountId: 'alice',
              pairId: 1,
              kind: 'upload',
              relPath: 'big.iso',
              files: 1,
              bytesDone: 512 * 1024 ** 2,
              bytesTotal: 1024 ** 3,
              startedAt: NOW.toISOString(),
              rateBps: 4 * 1024 ** 2,
              etaSeconds: 128,
              source: 'fd',
            },
          ],
          upload: {
            files: 3,
            bytes: 2 * 1024 ** 3,
            bytesDone: 512 * 1024 ** 2,
            rateBps: 4 * 1024 ** 2,
            etaSeconds: 400,
            blockedFiles: 0,
            blockedBytes: 0,
          },
          download: {
            files: 0,
            bytes: 0,
            bytesDone: 0,
            rateBps: null,
            etaSeconds: null,
            blockedFiles: 0,
            blockedBytes: 0,
          },
        },
      }),
      { now: NOW },
    );
    expect(b.alt).toBe('syncing');
    expect(b.percentage).toBe(25);
    expect(b.tooltip).toContain('↑ Upload: 3 files, 1.5 GB left at 4.0 MB/s · ETA 7 min');
    expect(b.tooltip).toContain('big.iso 50 %');
  });

  it('conflicts show their count; Omarchy format highlights with class "active"', () => {
    const s = status({ openConflicts: 2, pendingDeletions: 1 });
    expect(barOutput(s).text).toBe(`${BAR_ICONS.conflicts} 3`);
    expect(barOutput(s, { format: 'omarchy' }).class).toBe('active');
    expect(barOutput(status(), { format: 'omarchy' }).class).toBe('idle');
    expect(barOutput(null, { format: 'omarchy' })).toMatchObject({ alt: 'stopped', class: 'active' });
  });

  it('two-way: held mass deletions are an attention state with one tooltip line per pair (not the brake text)', () => {
    const pair = {
      id: 7,
      accountId: 'alice',
      name: 'Zwei',
      localRoot: '/home/a/Zwei',
      remoteRoot: '/my-files/Zwei',
      direction: 'two-way' as const,
      enabled: true,
      paused: false,
      counts: {},
      bytesTracked: 0,
      lastRunAt: null,
      lastFullAt: null,
      brake: { reason: 'Massenlöschung angehalten', at: '2026-10-13T09:00:00.000Z' },
      heldDeletions: 25,
    };
    // held deletions are pending deletions as well; even a status without that count is an attention state
    expect(barState(status({ pairs: [pair] }))).toBe('conflicts');
    const b = barOutput(status({ pairs: [pair], pendingDeletions: 25, openConflicts: 1 }), { now: NOW });
    expect(b).toMatchObject({ text: `${BAR_ICONS.conflicts} 26`, alt: 'conflicts', class: 'conflicts' });
    expect(b.tooltip).toContain(
      'Zwei: 25 deletions held (two-way mass-delete guard) – approve or deny in the dashboard',
    );
    expect(b.tooltip).not.toContain('Massenlöschung angehalten');
    expect(barOutput(status({ pairs: [pair] }), { format: 'omarchy' }).class).toBe('active');
    expect(barOutput(status({ pairs: [pair] }), { lang: 'de' }).tooltip).toContain('Zwei: 25 Löschungen angehalten');
  });

  it('Waybar tooltips are Pango-escaped, German follows LANG', () => {
    const acc = status().accounts[0]!;
    const b = barOutput(status({ accounts: [{ ...acc, displayName: 'A<b>&c' }] }));
    expect(b.tooltip).toContain('A&lt;b&gt;&amp;c');
    expect(barLang({ LANG: 'de_DE.UTF-8' })).toBe('de');
    expect(barLang({ LANG: 'en_US.UTF-8', LC_ALL: '' })).toBe('en');
    expect(barLang({})).toBe('en');
    expect(barOutput(status({ paused: true, state: 'paused' }), { lang: 'de' }).tooltip).toContain('Pausiert');
  });
});
