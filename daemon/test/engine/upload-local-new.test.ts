// SPDX-License-Identifier: GPL-3.0-or-later
/** Planner eligibility for uploads from the PC into mirror-down pairs (uploadLocalNew) and the keep-both name. */
import { describe, expect, it } from 'vitest';

import type { EntryRow } from '../../src/db/repo.ts';
import { fromPcName } from '../../src/engine/executor.ts';
import { uploadsFromPc } from '../../src/engine/planner.ts';

const entry = (rel: string, ctimeMs: number | null, extra: Partial<EntryRow> = {}) =>
  ({
    rel_path: rel,
    kind: 'file',
    l_exists: 1,
    l_ctime_us: ctimeMs === null ? null : ctimeMs * 1e3,
    ...extra,
  }) as EntryRow;

describe('uploadsFromPc', () => {
  const since = Date.parse('2026-10-11T00:00:00Z');
  it('files created after the option was switched on qualify', () => {
    expect(uploadsFromPc(entry('Documents/a.pdf', since + 1), since)).toBe(true);
    expect(uploadsFromPc(entry('Documents/a.pdf', since - 1), since)).toBe(false);
    expect(uploadsFromPc(entry('Documents/a.pdf', null), since)).toBe(false);
    expect(uploadsFromPc(entry('Documents/a.pdf', 1), undefined)).toBe(true);
  });
  it('folders, missing files and the engine’s own conflict copies never qualify', () => {
    expect(uploadsFromPc(entry('Documents', since + 1, { kind: 'folder' }), since)).toBe(false);
    expect(uploadsFromPc(entry('Documents/a.pdf', since + 1, { l_exists: 0 }), since)).toBe(false);
    expect(uploadsFromPc(entry('Documents/brief (local edit 2026-10-11).txt', since + 1), since)).toBe(false);
    // conflict copies written by earlier versions (German label) are still recognised
    expect(uploadsFromPc(entry('Documents/brief (lokal geändert 2026-10-11).txt', since + 1), since)).toBe(false);
    expect(uploadsFromPc(entry('Documents/brief (Proton 2026-10-11 10-00).txt', since + 1), since)).toBe(false);
    expect(uploadsFromPc(entry('Documents/brief (from PC 2026-10-11).txt', since + 1), since)).toBe(true);
  });
});

describe('fromPcName', () => {
  const d = new Date('2026-10-11T08:00:00Z');
  it('adds "(from PC date[ n])" before the extension', () => {
    expect(fromPcName('Documents/brief.txt', d)).toBe('Documents/brief (from PC 2026-10-11).txt');
    expect(fromPcName('brief.txt', d, 2)).toBe('brief (from PC 2026-10-11 2).txt');
    expect(fromPcName('Documents/Makefile', d)).toBe('Documents/Makefile (from PC 2026-10-11)');
    expect(fromPcName('a/b.tar.gz', d)).toBe('a/b.tar (from PC 2026-10-11).gz');
  });
});
