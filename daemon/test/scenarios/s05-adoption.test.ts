// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const T = new Date('2024-05-01T08:00:00Z');

describe('S5 adoption across remote roots (Archiv -> Dokumente)', () => {
  it('proposes moves for identical content outside the pair; approve -> move, reject -> upload', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: {
        alex: [
          {
            to: '/devices/Workstation/Archiv/004_Studium',
            files: { 'report.pdf': 'the report', 'notes.txt': 'some notes' },
          },
          {
            to: '/devices/Workstation/Archiv/004_Studium',
            noDigest: true,
            files: { 'legacy.doc': 'old windows upload' },
          },
        ],
      },
      localFiles: {
        'Dokumente/04_Studies/report.pdf': 'the report',
        'Dokumente/04_Studies/notes.txt': 'some notes',
        'Dokumente/04_Studies/legacy.doc': 'old windows upload',
        'Dokumente/other.txt': 'unrelated',
      },
      mtime: T,
    });
    h.db
      .prepare(
        "INSERT INTO adoption_sources (account_id, remote_path, remote_section) VALUES ('alex', '/devices/Workstation/Archiv', '/devices/Workstation')",
      )
      .run();
    const run = await h.sync();
    expect(run.status).toBe('ok');
    const props = h.engine.adoptions();
    expect(props).toHaveLength(3);
    const byName = Object.fromEntries(props.map((p) => [p.targetRelPath.split('/').pop(), p]));
    expect(byName['report.pdf']).toMatchObject({
      sourceRemotePath: '/devices/Workstation/Archiv/004_Studium/report.pdf',
      matchedBy: 'sha1',
      outsidePair: true,
    });
    expect(byName['legacy.doc']!.matchedBy).toBe('name_size_mtime');
    // nothing uploaded for proposed files while the decision is open
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/04_Studies/report.pdf')).toBeUndefined();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/other.txt')).toBeDefined();

    const reportUid = h.remoteNode('alex', '/devices/Workstation/Archiv/004_Studium/report.pdf')!.uid;
    const mark = h.mark();
    h.engine.decideAdoptions([byName['report.pdf']!.id, byName['legacy.doc']!.id], true, 'test');
    h.engine.decideAdoptions([byName['notes.txt']!.id], false, 'test');
    await h.drain();
    const cmds = h.commands('alex', mark);
    expect(cmds.filter((c) => c.cmd === 'filesystem move')).toHaveLength(2);
    expect(uploadsWith(cmds, 'skip')).toHaveLength(1); // only notes.txt (rejected)
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/04_Studies/report.pdf')!.uid).toBe(reportUid);
    expect(h.remoteNode('alex', '/devices/Workstation/Archiv/004_Studium/report.pdf')).toBeUndefined();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/04_Studies/notes.txt')).toBeDefined();
    expect(h.remoteNode('alex', '/devices/Workstation/Archiv/004_Studium/notes.txt')).toBeDefined(); // untouched
    expect(h.entry(1, '04_Studies/report.pdf')!.state).toBe('synced');
    expect(h.entry(1, '04_Studies/legacy.doc')!.state).toBe('synced');
    expect(h.entry(1, '04_Studies/notes.txt')!.state).toBe('synced');
    expect(h.engine.adoptions()).toHaveLength(0);

    const mark2 = h.mark();
    await h.sync();
    expect(h.commands('alex', mark2).every((c) => c.cmd === 'filesystem list')).toBe(true);
  });

  it('relocates first-contact files inside the pair automatically (remote at old path, local at new path)', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: {
        alex: [
          {
            to: '/devices/Workstation/Documents/01_Haushalt/Kolpingstr',
            files: { 'a.pdf': 'A', 'b.pdf': 'B', 'c/d.pdf': 'D' },
          },
        ],
      },
      localFiles: {
        'Dokumente/01_Haushalt/05_Wohnen/01_Kolpingstr/a.pdf': 'A',
        'Dokumente/01_Haushalt/05_Wohnen/01_Kolpingstr/b.pdf': 'B',
        'Dokumente/01_Haushalt/05_Wohnen/01_Kolpingstr/c/d.pdf': 'D',
      },
      mtime: T,
    });
    const uid = h.remoteNode('alex', '/devices/Workstation/Documents/01_Haushalt/Kolpingstr')!.uid;
    const run = await h.sync();
    expect(run.status).toBe('ok');
    const cmds = h.commands();
    expect(cmds.filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);
    expect(cmds.filter((c) => c.cmd === 'filesystem download')).toHaveLength(0);
    expect(cmds.filter((c) => c.cmd === 'filesystem move')).toHaveLength(1); // one folder move
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/01_Haushalt/05_Wohnen/01_Kolpingstr')!.uid).toBe(uid);
    expect(h.entry(1, '01_Haushalt/05_Wohnen/01_Kolpingstr/c/d.pdf')!.state).toBe('synced');
    expect(h.exists('Dokumente/01_Haushalt/Kolpingstr')).toBe(false); // nothing downloaded to the old path
  });
});
