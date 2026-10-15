// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S22 nested pairs: a backup pair of the whole Dokumente folder and a two-way pair of its sub folder
 * 01_Haushalt (Alex's PC). The outer pair excludes the sub folder; two pairs never act on the same file.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { insertJob } from '../../src/engine/queue.ts';
import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const R = '/devices/Workstation/Documents';
const T = new Date('2025-03-01T10:00:00Z');

describe('S22 nested pairs', () => {
  it('the parent backup pair skips the folder owned by the child two-way pair', async () => {
    h = await makeHarness({
      pairs: [
        { account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: R },
        {
          account: 'alex',
          name: 'Household',
          local: 'Dokumente/01_Haushalt',
          remote: `${R}/01_Haushalt`,
          direction: 'two-way',
          options: { twoWayAdoption: true },
        },
      ],
      seed: { alex: [{ to: `${R}/01_Haushalt`, files: { 'remote-only.pdf': 'from the laptop' } }] },
      localFiles: {
        'Dokumente/102_Geschaeft/angebot.xlsx': 'angebot',
        'Dokumente/01_Haushalt/steuer.pdf': 'steuer',
      },
      mtime: T,
    });
    await h.sync();
    // each file belongs to exactly one pair
    const owners = (rel: string) =>
      (
        h.db
          .prepare("SELECT pair_id FROM entries WHERE kind = 'file' AND rel_path LIKE ? AND state != 'excluded'")
          .all(`%${rel}`) as { pair_id: number }[]
      ).map((r) => r.pair_id);
    expect(owners('angebot.xlsx')).toEqual([1]);
    expect(owners('steuer.pdf')).toEqual([2]);
    expect(owners('remote-only.pdf')).toEqual([2]);
    expect(h.entry(1, '01_Haushalt')?.state).toBe('excluded');
    expect(h.read('Dokumente/01_Haushalt/remote-only.pdf')).toBe('from the laptop'); // by the child pair
    expect(h.remoteNode('alex', `${R}/01_Haushalt/steuer.pdf`)).toBeDefined();
    const dto = h.engine.pairs().find((p) => p.id === 1)!;
    expect(dto.ownedElsewhere).toEqual([{ relPath: '01_Haushalt', pairId: 2, pairName: 'Household' }]);
    expect(h.engine.pairs().find((p) => p.id === 2)!.ownedElsewhere).toEqual([]);

    // a deletion inside the child folder: two-way semantics (Proton trash), never a backup "pending deletion"
    (await import('node:fs')).rmSync(`${h.data}/Dokumente/01_Haushalt/steuer.pdf`);
    await h.sync();
    expect(h.remoteNode('alex', `${R}/01_Haushalt/steuer.pdf`)).toBeUndefined();
    expect(h.engine.deletions()).toHaveLength(0);

    // the tree of the parent shows the sub folder as owned by the other pair
    const tree = await h.engine.tree(1, '');
    expect(tree.find((n) => n.name === '01_Haushalt')).toMatchObject({ excludedBy: 'pair' });

    // a stale job of the parent on the child's path (planned before the child existed) is refused
    insertJob(h.db, {
      runId: null,
      accountId: 'alex',
      pairId: 1,
      entryId: null,
      type: 'upload',
      payload: { rel: '01_Haushalt/x.pdf', kind: 'file', parentRel: '01_Haushalt', name: 'x.pdf' },
      bytes: 1,
      dedupeKey: 'upload:1:01_Haushalt/x.pdf',
    });
    h.engine.kick('alex');
    await h.drain();
    const j = h.jobs().find((x) => x.payload.includes('x.pdf'))!;
    expect(j.state).toBe('cancelled');
    expect(j.last_error).toMatch(/belongs to pair "Household"/);
  });

  it('creating the child later turns the parent entries into exclusions without touching any file', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: R }],
      localFiles: { 'Dokumente/01_Haushalt/a.pdf': 'a', 'Dokumente/other.txt': 'o' },
      mtime: T,
    });
    await h.sync();
    expect(h.entry(1, '01_Haushalt/a.pdf')!.state).toBe('synced');
    h.db
      .prepare(
        `INSERT INTO pairs (account_id, name, local_root, remote_root, remote_section, direction, options, created_at)
         VALUES ('alex', 'Haus', ?, ?, '/devices/Workstation', 'two-way', '{"twoWayAdoption":true}', ?)`,
      )
      .run(`${h.data}/Dokumente/01_Haushalt`, `${R}/01_Haushalt`, Date.now());
    const mark = h.mark();
    await h.sync();
    const writes = h
      .commands('alex', mark)
      .filter((c) =>
        ['filesystem upload', 'filesystem trash', 'filesystem move', 'filesystem download'].includes(c.cmd),
      );
    expect(writes).toEqual([]); // the child adopts a.pdf (identical), the parent just excludes it
    expect(h.entry(1, '01_Haushalt/a.pdf')!.state).toBe('excluded');
    expect(h.entry(2, 'a.pdf')!.state).toBe('synced');
    expect(h.remoteNode('alex', `${R}/01_Haushalt/a.pdf`)!.revisions).toHaveLength(1);
  });
});
