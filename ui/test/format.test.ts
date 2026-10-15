// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import {
  fmtBytes,
  fmtClock,
  fmtCount,
  fmtDateTime,
  fmtDuration,
  fmtRange,
  fmtStamp,
  fmtWhen,
  joinPath,
  niceByteTicks,
  shortPath,
} from '../src/renderer/format.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);

describe('format (German)', () => {
  it('sizes', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(41 * 1024)).toBe('41 KB');
    expect(fmtBytes(3.1 * 1024 ** 2)).toBe('3,1 MB');
    expect(fmtBytes(1.2 * 1024 ** 3)).toBe('1,2 GB');
    expect(fmtBytes(402 * 1024 ** 3)).toBe('402 GB');
    expect(fmtBytes(1000 * 1024 ** 3)).toBe('1.000 GB');
    expect(fmtBytes(9.97 * 1024 ** 2)).toBe('10 MB');
    expect(fmtBytes(null)).toBe('–');
  });
  it('counts and durations', () => {
    expect(fmtCount(1204)).toBe('1.204');
    expect(fmtDuration(800)).toBe('0,8 s');
    expect(fmtDuration(12_000)).toBe('12 s');
    expect(fmtDuration(125_000)).toBe('2 min 5 s');
    expect(fmtDuration(3_780_000)).toBe('1 h 3 min');
  });
  it('dates', () => {
    const now = local(2026, 10, 10, 12, 30);
    expect(fmtClock(local(2026, 10, 10, 12, 1).toISOString())).toBe('12:01');
    expect(fmtDateTime(local(2026, 10, 10, 12, 1).toISOString())).toBe('10.10. 12:01');
    expect(fmtStamp(local(2026, 10, 10, 12, 1, 13).toISOString(), now)).toBe('12:01:13');
    expect(fmtStamp(local(2026, 10, 9, 18, 0).toISOString(), now)).toBe('09.10. 18:00');
    expect(fmtWhen(local(2026, 10, 10, 14, 0).toISOString(), now)).toBe('14:00');
    expect(fmtWhen(local(2026, 10, 11, 3, 0).toISOString(), now)).toBe('morgen 03:00');
    expect(fmtWhen(local(2026, 10, 13, 3, 0).toISOString(), now)).toBe('Di 03:00');
    expect(fmtRange(local(2026, 10, 10, 12, 0).toISOString(), local(2026, 10, 10, 12, 4).toISOString(), now)).toBe(
      '12:00–12:04',
    );
  });
  it('paths', () => {
    expect(shortPath('a/b', 10)).toBe('a/b');
    const p = 'Documents/Work/Project A/Unterordner/Quote.xlsx';
    const s = shortPath(p, 40);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.startsWith('Documents/…/')).toBe(true);
    expect(s.endsWith('Quote.xlsx')).toBe(true);
    expect(joinPath('/srv/sync/Documents/', '/x/y.pdf')).toBe('/srv/sync/Documents/x/y.pdf');
  });
  it('nice axis ticks', () => {
    const GiB = 1024 ** 3;
    expect(niceByteTicks(782 * GiB)).toEqual([0, 200, 400, 600, 800].map((x) => x * GiB));
    expect(niceByteTicks(0)).toEqual([0]);
  });
});
