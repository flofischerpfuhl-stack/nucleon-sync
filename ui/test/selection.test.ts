// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import type { SelectionRule } from '@nucleon-sync/shared';

import {
  applyChanges,
  effectiveSelection,
  rulesFromTree,
  summarizeChanges,
  toggle,
  type Change,
  type NodeLike,
} from '../src/renderer/logic/selection.ts';
import { setLocale } from '../src/renderer/i18n/index.ts';

// these expectations are German (the UI's second language); English is covered by i18n.test.ts
setLocale('de');

const node = (
  relPath: string,
  selection: NodeLike['selection'] = 'included',
  excludedBy: NodeLike['excludedBy'] = null,
): NodeLike => ({
  relPath,
  selection,
  excludedBy,
});
const ex = (pattern: string): SelectionRule => ({ kind: 'exclude', patternType: 'prefix', pattern, source: 'user' });
const inc = (pattern: string): SelectionRule => ({ kind: 'include', patternType: 'prefix', pattern, source: 'user' });

describe('folder selection', () => {
  it('toggling an included folder excludes it and the children inherit', () => {
    const c = toggle(new Map(), node('A'));
    expect(effectiveSelection(node('A'), c)).toBe('excluded');
    expect(effectiveSelection(node('A/b'), c)).toBe('excluded');
    expect(applyChanges([], c)).toEqual([ex('A')]);
  });

  it('a changed child makes the parent partial; re-toggling the parent overrides children', () => {
    let c = toggle(new Map(), node('A/b'));
    expect(effectiveSelection(node('A'), c)).toBe('partial');
    c = toggle(c, node('A')); // partial -> exclude whole folder
    expect([...c.keys()]).toEqual(['A']);
    expect(applyChanges([], c)).toEqual([ex('A')]);
  });

  it('toggling back to the original state removes the change', () => {
    const c = toggle(toggle(new Map(), node('A')), node('A'));
    expect(c.size).toBe(0);
  });

  it('including a folder under an excluded parent writes an include rule', () => {
    const base = [ex('Archiv')];
    const c = toggle(new Map(), node('Archiv/2016', 'excluded', 'user'));
    expect(applyChanges(base, c)).toEqual([ex('Archiv'), inc('Archiv/2016')]);
  });

  it('including a default-excluded folder forces an explicit include', () => {
    const nm = node('Projekte/x/node_modules', 'excluded', 'default');
    const c = toggle(new Map(), nm);
    expect(c.get(nm.relPath)).toEqual({ value: 'include', force: true } satisfies Change);
    expect(applyChanges([], c)).toEqual([inc('Projekte/x/node_modules')]);
  });

  it('hard-excluded folders cannot be toggled', () => {
    const h = node('Sicherung', 'excluded', 'hard');
    expect(toggle(new Map(), h).size).toBe(0);
    expect(effectiveSelection(h, new Map([['Sicherung', { value: 'include', force: false }]]))).toBe('excluded');
  });

  it('re-including an excluded folder drops its rule and the rules below it', () => {
    const base = [ex('Alt'), inc('Alt/Behalten'), ex('Other')];
    const c = toggle(new Map(), node('Alt', 'partial', 'user'));
    // partial -> exclude first; toggle again -> include
    const c2 = toggle(c, node('Alt', 'partial', 'user'));
    expect(applyChanges(base, c)).toEqual([ex('Alt'), ex('Other')]);
    expect(applyChanges(base, c2)).toEqual([ex('Other')]);
  });

  it('keeps glob rules and processes parents before children', () => {
    const glob: SelectionRule = { kind: 'exclude', patternType: 'glob', pattern: '*.bak', source: 'user' };
    const c = new Map<string, Change>([
      ['A/b', { value: 'include', force: false }],
      ['A', { value: 'exclude', force: false }],
    ]);
    expect(applyChanges([glob], c)).toEqual([glob, ex('A'), inc('A/b')]);
    expect(summarizeChanges(c)).toEqual({ excluded: 1, included: 1 });
  });

  it('reconstructs rules from loaded tree nodes', () => {
    const nodes = [
      node('A', 'excluded', 'user'),
      node('A/x', 'excluded', 'user'),
      node('A/y', 'included'),
      node('B', 'included'),
      node('B/node_modules', 'excluded', 'default'),
    ];
    expect(rulesFromTree(nodes)).toEqual([ex('A'), inc('A/y')]);
  });
});
