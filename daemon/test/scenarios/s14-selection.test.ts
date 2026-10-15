// SPDX-License-Identifier: GPL-3.0-or-later
import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S14 selection', () => {
  it('excluding a folder stops its sync without remote deletion; re-including triggers a mini-run', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: {
        'Dokumente/keep/k.txt': 'k',
        'Dokumente/skip/a.txt': 'a',
        'Dokumente/skip/b.txt': 'b',
        'Dokumente/proj/node_modules/x.js': 'cache',
        'Dokumente/proj/main.js': 'main',
      },
    });
    await h.sync();
    h.engine.setRules(1, [{ kind: 'exclude', patternType: 'prefix', pattern: 'skip', source: 'user' }]);
    await h.engine.waitIdle();
    expect(h.entry(1, 'skip/a.txt')!.state).toBe('excluded');

    h.write('Dokumente/skip/a.txt', 'a changed');
    h.write('Dokumente/skip/new.txt', 'new');
    rmSync(path.join(h.data, 'Dokumente/skip/b.txt'));
    const mark = h.mark();
    await h.sync();
    const cmds = h.commands('alex', mark);
    expect(cmds.filter((c) => c.cmd !== 'filesystem list')).toHaveLength(0);
    expect(h.engine.deletions()).toHaveLength(0);
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/skip/b.txt')).toBeDefined(); // remote copy kept

    const tree = await h.engine.tree(1, '');
    const byName = Object.fromEntries(tree.map((n) => [n.name, n]));
    expect(byName.skip).toMatchObject({ selection: 'excluded', excludedBy: 'user', kind: 'folder' });
    expect(byName.keep!.selection).toBe('included');
    expect(byName.proj!.selection).toBe('partial'); // node_modules below is default-excluded
    const proj = await h.engine.tree(1, 'proj');
    expect(proj.find((n) => n.name === 'node_modules')).toMatchObject({ selection: 'excluded', excludedBy: 'default' });

    // re-include -> mini-run for the pair
    const mark2 = h.mark();
    h.engine.setRules(1, []);
    await h.engine.waitIdle();
    const cmds2 = h.commands('alex', mark2);
    expect(uploadsWith(cmds2, 'create-new-revision')).toHaveLength(1); // a.txt
    expect(uploadsWith(cmds2, 'skip')).toHaveLength(1); // new.txt
    expect(h.engine.deletions().map((d) => d.relPath)).toEqual(['skip/b.txt']);
    expect(h.entry(1, 'skip/a.txt')!.state).toBe('synced');
  });
});
