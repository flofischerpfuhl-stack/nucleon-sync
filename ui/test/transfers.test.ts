// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { fmtEta } from '../src/renderer/format.ts';
import { normalizeStatus, transfers } from '../src/renderer/logic/normalize.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

describe('transfers in the status', () => {
  it('normalises live transfers and backlog; absent in older daemons', () => {
    expect(normalizeStatus({ accounts: [], pairs: [] })!.transfers).toBeUndefined();
    const t = transfers({
      active: [{ kind: 'upload', bytesTotal: 10, bytesDone: 4, jobIds: [3], relPath: 'a.las', source: 'fd' }, { x: 1 }],
      upload: { files: 3, bytes: 30, etaSeconds: 100 },
    })!;
    expect(t.active).toHaveLength(1);
    expect(t.active[0]).toMatchObject({ kind: 'upload', bytesDone: 4, files: 1, rateBps: null, source: 'fd' });
    expect(t.upload).toMatchObject({ files: 3, bytes: 30, etaSeconds: 100, rateBps: null, blockedFiles: 0 });
    expect(t.download).toMatchObject({ files: 0, etaSeconds: null });
  });

  it('formats ETAs', () => {
    expect(fmtEta(null)).toBeNull();
    expect(fmtEta(30)).toBe('30 s');
    expect(fmtEta(3 * 3600 + 300)).toBe('3 h 5 min');
    expect(fmtEta(3 * 86400 + 4 * 3600)).toBe('3 Tage 4 h');
  });
});
