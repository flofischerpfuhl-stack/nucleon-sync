// SPDX-License-Identifier: GPL-3.0-or-later
import { statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FLAG } from '../../src/db/repo.ts';
import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const T = new Date('2025-03-01T10:00:00Z');

describe('S1 first contact (backup)', () => {
  it('adopts identical and digest-less files, uploads new, downloads remote-only, conflicts on different content', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: {
        alex: [
          { to: '/devices/Workstation/Documents', files: { 'same.txt': 'same content', 'diff.txt': 'remote version' } },
          {
            to: '/devices/Workstation/Documents',
            noDigest: true,
            files: { 'old/windows.docx': 'uploaded by windows' },
          },
          { to: '/devices/Workstation/Documents', files: { 'remote-only/r.pdf': 'only in proton' } },
        ],
      },
      localFiles: {
        'Dokumente/same.txt': 'same content',
        'Dokumente/diff.txt': 'local version!',
        'Dokumente/old/windows.docx': 'uploaded by windows',
        'Dokumente/new/n.md': 'brand new',
        'Dokumente/node_modules/x/index.js': 'cache',
        'Dokumente/~$lock.docx': 'junk',
      },
      mtime: T,
    });
    const run = await h.sync();
    expect(run.status).toBe('ok');
    expect(run.counters).toMatchObject({ adopted: 2, uploaded: 1, downloaded: 1, conflicts: 1, errors: 0 });

    const same = h.entry(1, 'same.txt')!;
    expect(same.state).toBe('synced');
    expect(same.flags & FLAG.DIGEST_MISSING).toBe(0);
    const win = h.entry(1, 'old/windows.docx')!;
    expect(win.state).toBe('synced');
    expect(win.flags & FLAG.DIGEST_MISSING).toBeTruthy();
    expect(win.flags & FLAG.MATCHED_BY_SIZE_MTIME).toBeTruthy();

    const up = h.remoteNode('alex', '/devices/Workstation/Documents/new/n.md');
    expect(up?.revisions?.[0]?.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(h.entry(1, 'new/n.md')!.state).toBe('synced');

    expect(h.read('Dokumente/remote-only/r.pdf')).toBe('only in proton');
    expect(statSync(path.join(h.data, 'Dokumente/remote-only/r.pdf')).mtimeMs).toBe(T.getTime()); // mtime = claimed
    expect(h.entry(1, 'remote-only/r.pdf')!.state).toBe('synced');

    expect(h.entry(1, 'diff.txt')!.state).toBe('conflict');
    expect(h.read('Dokumente/diff.txt')).toBe('local version!');
    const conflicts = h.engine.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ relPath: 'diff.txt', kind: 'initial_mismatch' });

    // lesson 2026-10-09: never a create-new-revision upload for unchanged/identical files
    expect(uploadsWith(h.commands(), 'create-new-revision')).toHaveLength(0);
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/node_modules')).toBeUndefined();
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/~$lock.docx')).toBeUndefined();
    const acts = h.engine.activity(100).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['adopted', 'uploaded', 'downloaded', 'conflict']));
  });
});
