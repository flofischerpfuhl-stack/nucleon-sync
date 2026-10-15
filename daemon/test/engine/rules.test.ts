// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { defaultGlobalExcludes } from '@nucleon-sync/shared';

import { globToRegExp, RuleMatcher } from '../../src/engine/rules.ts';

const sib = (map: Record<string, string[]>) => (folder: string) => (map[folder] ? new Set(map[folder]) : undefined);

describe('rule matcher', () => {
  const m = new RuleMatcher({ rules: defaultGlobalExcludes(), localRoot: '/srv/sync/Documents' });

  it('junk and dev-cache globs anywhere in the path', () => {
    expect(m.match('a/~$Angebot.docx')).toMatchObject({ excluded: true, by: 'default' });
    expect(m.match('a/.~lock.x.odt#')).toMatchObject({ excluded: true });
    expect(m.match('Thumbs.db').excluded).toBe(true);
    expect(m.match('p/node_modules/x/index.js')).toMatchObject({ excluded: true, by: 'default', depth: 2 });
    expect(m.match('p/.venv')).toMatchObject({ excluded: true });
    expect(m.match('p/.git/HEAD').excluded).toBe(false); // .git is included (Alex, 2026-10-10)
    expect(m.match('p/report.pdf').excluded).toBe(false);
    expect(m.match('x.tmp.pdf').excluded).toBe(false);
    expect(m.match('x.tmp').excluded).toBe(true);
  });

  it('heuristics: Unity Library and build/target only next to markers', () => {
    const s = sib({
      unity: ['Assets', 'ProjectSettings', 'Library'],
      app: ['package.json', 'build'],
      plain: ['build'],
      rust: ['Cargo.toml', 'target'],
    });
    expect(m.match('unity/Library/x', s).excluded).toBe(true);
    expect(m.match('app/build/out.js', s).excluded).toBe(true);
    expect(m.match('rust/target/debug', s).excluded).toBe(true);
    expect(m.match('plain/build/keep.txt', s).excluded).toBe(false);
    expect(m.match('other/Library/book.pdf', s).excluded).toBe(false); // no siblings known -> not excluded
  });

  it('user prefix rules: deepest wins, user include re-enables a default-excluded cache', () => {
    const u = new RuleMatcher({
      rules: [
        ...defaultGlobalExcludes(),
        { kind: 'exclude', patternType: 'prefix', pattern: '09_Scratch/00_Inbox', source: 'user' },
        { kind: 'include', patternType: 'prefix', pattern: '09_Scratch/00_Inbox/wichtig', source: 'user' },
        { kind: 'include', patternType: 'prefix', pattern: '03_Projects/X/node_modules', source: 'user' },
      ],
    });
    expect(u.match('09_Scratch/00_Inbox/a.pdf')).toMatchObject({ excluded: true, by: 'user' });
    expect(u.match('09_Scratch/00_Inbox').excluded).toBe(true);
    expect(u.match('09_Scratch/00_Inboxx/a.pdf').excluded).toBe(false); // prefix = whole segments
    expect(u.match('09_Scratch/00_Inbox/wichtig/b.pdf').excluded).toBe(false);
    expect(u.match('03_Projects/X/node_modules/lib.js').excluded).toBe(false);
    expect(u.match('03_Projects/Y/node_modules/lib.js').excluded).toBe(true);
    expect(u.match('03_Projects/X/node_modules/a/node_modules/b.js').excluded).toBe(true); // deeper glob wins again
    expect(u.hasRulesBelow('09_Scratch')).toBe(true);
    expect(u.hasRulesBelow('01_Haushalt')).toBe(false);
  });

  it('hard exclusions always win', () => {
    const hard = ['/srv/sync/Scratch', '/srv/sync/Backup']; // daemon.json protectedPaths
    const h = new RuleMatcher({
      rules: [{ kind: 'include', patternType: 'prefix', pattern: 'Scratch', source: 'user' }],
      localRoot: '/srv/sync',
      hardExcluded: hard,
    });
    expect(h.match('Scratch/x')).toMatchObject({ excluded: true, by: 'hard' });
    expect(h.match('Backup')).toMatchObject({ excluded: true, by: 'hard' });
    expect(h.match('Documents/x').excluded).toBe(false);
    const whole = new RuleMatcher({ rules: [], localRoot: '/srv/sync/Backup/Windows', hardExcluded: hard });
    expect(whole.match('a.txt')).toMatchObject({ excluded: true, by: 'hard' });
    // nothing is protected by default
    expect(new RuleMatcher({ rules: [], localRoot: '/srv/sync/Backup' }).match('a.txt').excluded).toBe(false);
  });

  it('NFC normalisation of rule paths and globs', () => {
    const nfd = 'Käse';
    const u = new RuleMatcher({ rules: [{ kind: 'exclude', patternType: 'prefix', pattern: nfd, source: 'user' }] });
    expect(u.match('Käse/x').excluded).toBe(true);
    expect(globToRegExp('*.p?f').test('a.pdf')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});
