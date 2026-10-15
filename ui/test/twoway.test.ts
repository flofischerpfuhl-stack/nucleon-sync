// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * UI logic of the two-way block: nested pair validation, pair state texts, nested-pair tree nodes. The texts are
 * checked in German (the wording of the two-way block) and in English (the default language).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PairDto } from '@nucleon-sync/shared';

import { de } from '../src/renderer/i18n/de.ts';
import { en } from '../src/renderer/i18n/en.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';
import { nestingHint, validateLocalRoot } from '../src/renderer/logic/paths.ts';
import { effectiveSelection, toggle } from '../src/renderer/logic/selection.ts';
import { DIRECTION_ICON, pairStateText, remoteCheckText } from '../src/renderer/logic/status.ts';

const pairs = [
  {
    name: 'Documents',
    localRoot: '/srv/sync/Documents',
    remoteRoot: '/devices/Workstation/Documents',
    accountId: 'alex',
  },
];

beforeAll(() => setLocale('de'));
afterAll(() => setLocale('en'));

describe('pair wizard: nested pairs', () => {
  it('a sub folder with the matching Proton sub folder is fine and explained', () => {
    const target = { accountId: 'alex', remoteRoot: '/devices/Workstation/Documents/Home' };
    expect(validateLocalRoot('/srv/sync/Documents/Home', pairs, target)).toBeNull();
    expect(nestingHint('/srv/sync/Documents/Home', pairs)).toMatch(
      /Liegt im Paar „Documents“: „Home“ wird dort automatisch ausgeschlossen/,
    );
    // another account's Proton folders never collide
    expect(
      validateLocalRoot('/srv/sync/Documents/x', pairs, { accountId: 'sam', remoteRoot: '/my-files/x' }),
    ).toBeNull();
    // the folder around an existing pair
    expect(nestingHint('/srv/sync', [{ name: 'Bilder', localRoot: '/srv/sync/Pictures' }])).toMatch(
      /Enthält das Paar „Bilder“/,
    );
  });
  it('refuses the same folder, different sub paths and Proton-only nesting', () => {
    expect(validateLocalRoot('/srv/sync/Documents', pairs)).toMatch(/gehört schon zum Paar „Documents“/);
    expect(
      validateLocalRoot('/srv/sync/Documents/Home', pairs, {
        accountId: 'alex',
        remoteRoot: '/devices/Workstation/Documents/anders',
      }),
    ).toMatch(/denselben Unterordner/);
    expect(
      validateLocalRoot('/home/alex/House', pairs, {
        accountId: 'alex',
        remoteRoot: '/devices/Workstation/Documents/Home',
      }),
    ).toMatch(/Überschneidet/);
    expect(
      validateLocalRoot('/srv/sync/Neu', pairs, { accountId: 'alex', remoteRoot: '/devices/Workstation/Documents' }),
    ).toMatch(/Überschneidet/);
    expect(nestingHint('/srv/sync/Pictures', pairs)).toBeNull();
  });
});

describe('two-way pair states', () => {
  const base: PairDto = {
    id: 3,
    accountId: 'alex',
    name: 'Haus',
    localRoot: '/srv/sync/Documents/Home',
    remoteRoot: '/devices/Workstation/Documents/Home',
    direction: 'two-way',
    enabled: true,
    paused: false,
    counts: { synced: 10 },
    bytesTracked: 0,
    lastRunAt: '2026-10-13T10:00:00Z',
    lastFullAt: null,
  };
  it('held deletions and the adoption run are visible on the pair row', () => {
    expect(pairStateText({ ...base, heldDeletions: 25 })).toEqual({ text: '25 Löschungen angehalten', tone: 'warn' });
    expect(pairStateText({ ...base, options: { twoWayAdoption: true } }).text).toBe(de.pair.adopting);
    expect(pairStateText(base).text).toBe(de.pair.upToDate);
  });
  it('last remote check text only for two-way pairs', () => {
    const now = new Date('2026-10-13T10:10:00Z');
    expect(remoteCheckText({ ...base, lastRemoteCheckAt: '2026-10-13T10:06:00Z' }, now)).toMatch(
      /^Proton zuletzt geprüft vor 4 min/,
    );
    expect(remoteCheckText({ ...base, lastRemoteCheckAt: null }, now)).toBe(de.pair.remoteNeverChecked);
    expect(remoteCheckText({ ...base, direction: 'backup' }, now)).toBeNull();
  });
  it('every direction has a label, a help text and an icon', () => {
    for (const d of ['backup', 'mirror-down', 'upload-only', 'two-way'] as const) {
      expect(de.pair.direction[d]).toBeTruthy();
      expect(de.wizard.directionHelp[d]).toBeTruthy();
      expect(DIRECTION_ICON[d]).toBeTruthy();
    }
    expect(de.wizard.directionHelp['two-way']).toMatch(/beide Versionen/);
    expect(de.issues.kind.needs_check).toBeTruthy();
  });
});

describe('English (default language)', () => {
  beforeAll(() => setLocale('en'));
  afterAll(() => setLocale('de'));
  it('nesting hints, pair states and direction texts', () => {
    expect(nestingHint('/srv/sync/Documents/Home', pairs)).toBe(en.wizard.nestedIn('Documents', 'Home'));
    expect(validateLocalRoot('/srv/sync/Documents', pairs)).toBe(
      'This folder already belongs to the pair "Documents".',
    );
    const p: PairDto = {
      id: 3,
      accountId: 'alex',
      name: 'Haus',
      localRoot: '/x',
      remoteRoot: '/y',
      direction: 'two-way',
      enabled: true,
      paused: false,
      counts: {},
      bytesTracked: 0,
      lastRunAt: '2026-10-13T10:00:00Z',
      lastFullAt: null,
      heldDeletions: 1,
    };
    expect(pairStateText(p)).toEqual({ text: '1 deletion held', tone: 'warn' });
    expect(remoteCheckText({ ...p, lastRemoteCheckAt: null })).toBe('Proton not checked yet');
    expect(en.pair.directionShort['two-way']).toBe('Two-way');
    expect(en.wizard.directionHelp['two-way']).toMatch(/both versions are kept/);
    expect(en.issues.kind.needs_check).toBeTruthy();
  });
});

describe('tree: a sub folder owned by a nested pair', () => {
  it('is always excluded and cannot be toggled', () => {
    const node = { relPath: 'Home', selection: 'excluded' as const, excludedBy: 'pair' as const };
    expect(effectiveSelection(node, new Map())).toBe('excluded');
    expect(toggle(new Map(), node).size).toBe(0);
  });
});
