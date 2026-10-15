// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S23 two computers with independent daemons on one remote folder (PC: /srv/sync/Documents/01_Haushalt,
 * laptop: ~/Dokumente/01_Haushalt, both ⇄ /devices/Workstation/Documents/01_Haushalt).
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { twoWayConflictName } from '@nucleon-sync/shared';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents/01_Haushalt';
const T = new Date('2025-03-01T10:00:00Z');

describe('S23 two devices, one remote folder', () => {
  it('edits, conflicts and deletions travel between PC and laptop without loss or duplicates', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Haus', local: 'PC/Haus', remote: R, direction: 'two-way' }],
      localFiles: { 'PC/Haus/steuer.pdf': 'steuer v1', 'PC/Haus/sub/miete.pdf': 'miete v1' },
      mtime: T,
    });
    const laptop = await h.secondDevice({
      pairs: [{ account: 'alex', name: 'Haus', local: 'Haus', remote: R, direction: 'two-way' }],
      hostname: 'laptop',
    });
    await h.sync();
    await laptop.sync();
    expect(laptop.read('Haus/steuer.pdf')).toBe('steuer v1');
    expect(laptop.read('Haus/sub/miete.pdf')).toBe('miete v1');

    // edit on the laptop -> new revision -> downloaded on the PC
    laptop.write('Haus/steuer.pdf', 'steuer v2 (laptop)', new Date('2025-04-01T10:00:00Z'));
    await laptop.sync();
    await h.sync();
    expect(h.read('PC/Haus/steuer.pdf')).toBe('steuer v2 (laptop)');
    expect(h.remoteNode('alex', `${R}/steuer.pdf`)!.revisions).toHaveLength(2);

    // both edit the same file before syncing: the second one to sync keeps both
    h.write('PC/Haus/sub/miete.pdf', 'miete v2 (pc)', new Date('2025-05-01T10:00:00Z'));
    laptop.write('Haus/sub/miete.pdf', 'miete v2 (laptop)', new Date('2025-05-01T11:00:00Z'));
    await h.sync(); // PC first: plain new revision
    await laptop.sync(); // laptop: remote changed since its base -> conflict copy of the laptop version
    const copy = twoWayConflictName('sub/miete.pdf', 'laptop', new Date());
    expect(laptop.read('Haus/sub/miete.pdf')).toBe('miete v2 (pc)');
    expect(laptop.read(`Haus/${copy}`)).toBe('miete v2 (laptop)');
    await h.sync();
    expect(h.read(`PC/Haus/${copy}`)).toBe('miete v2 (laptop)');
    expect(h.read('PC/Haus/sub/miete.pdf')).toBe('miete v2 (pc)');
    expect(laptop.engine.conflicts()).toHaveLength(1);
    expect(h.engine.conflicts()).toHaveLength(0); // the PC did nothing wrong

    // deletion on the PC -> Proton trash -> laptop moves its copy to its trash
    rmSync(path.join(h.data, 'PC/Haus/steuer.pdf'));
    await h.sync();
    await laptop.sync();
    expect(laptop.exists('Haus/steuer.pdf')).toBe(false);
    expect(readFileSync(path.join(laptop.dir, 'trash/files/steuer.pdf'), 'utf8')).toBe('steuer v2 (laptop)');

    // both converge: another round on both sides changes nothing
    const mark = h.mark();
    await h.sync();
    await laptop.sync();
    await h.sync();
    expect(h.commands('alex', mark).every((c) => c.cmd === 'filesystem list')).toBe(true);
    // no duplicate nodes in the remote folder, no "name (1)" copies, every file once
    const nodes = Object.values(h.remoteState().nodes).filter((n) => !n.trashed);
    const seen = new Map<string, number>();
    for (const n of nodes.filter((x) => x.parentUid))
      seen.set(`${n.parentUid}/${n.name}`, (seen.get(`${n.parentUid}/${n.name}`) ?? 0) + 1);
    expect([...seen.entries()].filter(([, k]) => k > 1)).toEqual([]);
    expect(nodes.filter((n) => / \(\d+\)/.test(n.name))).toEqual([]);
    expect(uploadsWith(h.commands('alex'), 'replace')).toHaveLength(0);
  });

  it('the laptop starts with older copies of the same files: adoption, no new revisions', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Haus', local: 'PC/Haus', remote: R, direction: 'two-way' }],
      localFiles: { 'PC/Haus/a.pdf': 'a', 'PC/Haus/b.pdf': 'b' },
      mtime: T,
    });
    await h.sync();
    const laptop = await h.secondDevice({
      pairs: [
        {
          account: 'alex',
          name: 'Haus',
          local: 'Haus',
          remote: R,
          direction: 'two-way',
          options: { twoWayAdoption: true },
        },
      ],
    });
    laptop.write('Haus/a.pdf', 'a', T); // identical copy
    laptop.write('Haus/b.pdf', 'b changed on the laptop before the pair existed', T);
    await laptop.sync();
    expect(h.remoteNode('alex', `${R}/a.pdf`)!.revisions).toHaveLength(1);
    expect(h.remoteNode('alex', `${R}/b.pdf`)!.revisions).toHaveLength(1);
    expect(laptop.read('Haus/b.pdf')).toBe('b');
    expect(laptop.read(`Haus/${twoWayConflictName('b.pdf', 'laptop', new Date())}`)).toMatch(/changed on the laptop/);
  });
});
