// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import type { PairDto, PendingDeletionDto } from '@nucleon-sync/shared';

import { groupDeletions } from '../src/renderer/logic/deletions.ts';
import { hardExclusion, slugify } from '../src/renderer/logic/paths.ts';
import { globalStatus, pairStateText } from '../src/renderer/logic/status.ts';
import { status } from './helpers.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

const pair = (p: Partial<PairDto> = {}): PairDto => ({
  id: 1,
  accountId: 'alex',
  name: 'Documents',
  localRoot: '/srv/sync/Documents',
  remoteRoot: '/devices/Workstation/Documents',
  direction: 'backup',
  enabled: true,
  paused: false,
  counts: {},
  bytesTracked: 0,
  lastRunAt: '2026-10-10T10:00:00Z',
  lastFullAt: null,
  ...p,
});

describe('status texts', () => {
  it('global status line', () => {
    const now = new Date(2026, 9, 10, 12, 0);
    const next = new Date(2026, 9, 10, 14, 0).toISOString();
    expect(
      globalStatus(status({ nextRuns: [{ mode: 'incremental', at: next }] }), 'connected', null, now),
    ).toMatchObject({
      tone: 'ok',
      title: 'Alles synchronisiert',
      detail: 'nächster Lauf 14:00',
    });
    expect(globalStatus(status(), 'disconnected', null).title).toBe('Dienst nicht erreichbar');
    expect(globalStatus(status({ paused: true, state: 'paused' }), 'connected', next, now).title).toBe(
      'Pausiert bis 14:00',
    );
    expect(globalStatus(status({ openConflicts: 3, pendingDeletions: 12 }), 'connected', null).detail).toBe(
      '3 Konflikte · 12 Löschungen',
    );
  });
  it('pair state', () => {
    expect(pairStateText(pair()).text).toBe('aktuell');
    expect(pairStateText(pair({ enabled: false })).text).toBe('deaktiviert');
    expect(pairStateText(pair({ counts: { local_new: 129 } })).text).toBe('↑ 129 ausstehend');
    expect(pairStateText(pair({ counts: { remote_new: 2 } })).text).toBe('↓ 2 neu');
    expect(pairStateText(pair({ counts: { conflict: 1 } })).tone).toBe('warn');
  });
});

describe('paths', () => {
  it('hard exclusions (inside or containing)', () => {
    const hard = ['/srv/sync/Scratch', '/srv/sync/Backup'];
    expect(hardExclusion('/srv/sync/Backup/x', hard)).toBe('/srv/sync/Backup');
    expect(hardExclusion('/srv/sync', hard)).toBe('/srv/sync/Scratch');
    expect(hardExclusion('/srv/sync/Documents', hard)).toBeNull();
    expect(hardExclusion('/srv/sync/Backupen', hard)).toBeNull();
    expect(hardExclusion('/srv/sync/Backup/x')).toBeNull(); // no built-in protected paths
  });
  it('account ids', () => {
    expect(slugify('Grandpa Joe')).toBe('grandpa-joe');
    expect(slugify('Jörg Groß')).toBe('jorg-gross');
  });
});

describe('deletions grouping', () => {
  const del = (id: number, relPath: string, size = 1): PendingDeletionDto => ({
    id,
    pairId: 1,
    accountId: 'alex',
    relPath,
    size,
    detectedAt: '2026-10-10T10:00:00Z',
    remoteChangedSinceDelete: false,
  });
  it('folders with ≥3 deleted files become one group', () => {
    const list = [
      del(1, 'alt/a', 5),
      del(2, 'alt/b', 5),
      del(3, 'alt/c', 5),
      del(4, 'x.pdf', 100),
      del(5, 'y/z.pdf', 1),
    ];
    const g = groupDeletions(list, () => pair(), 'size');
    expect(g.map((x) => [x.folder, x.rows.map((r) => r.id)])).toEqual([
      [null, [4]],
      ['alt', [1, 2, 3]],
      [null, [5]],
    ]);
  });
});
