// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S2 idempotence', () => {
  it('a second run without changes only lists; a local edit gives exactly one upload_revision', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: {
        alex: [{ to: '/devices/Workstation/Documents', noDigest: true, files: { 'a/x.txt': 'x', 'b.txt': 'b' } }],
      },
      localFiles: { 'Dokumente/a/x.txt': 'x', 'Dokumente/b.txt': 'b', 'Dokumente/c/new.txt': 'new' },
    });
    expect((await h.sync()).status).toBe('ok');
    const jobsAfterFirst = h.jobs().length;
    const mark = h.mark();
    const second = await h.sync();
    expect(second.status).toBe('ok');
    const cmds = h.commands('alex', mark);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every((c) => c.cmd === 'filesystem list')).toBe(true);
    expect(h.jobs().length).toBe(jobsAfterFirst);

    h.write('Dokumente/b.txt', 'b edited locally');
    const mark2 = h.mark();
    const third = await h.sync();
    expect(third.status).toBe('ok');
    const revs = uploadsWith(h.commands('alex', mark2), 'create-new-revision');
    expect(revs).toHaveLength(1);
    expect(h.jobs().filter((j) => j.type === 'upload_revision')).toHaveLength(1);
    expect(h.entry(1, 'b.txt')!.state).toBe('synced');
    const node = h.remoteNode('alex', '/devices/Workstation/Documents/b.txt')!;
    expect(node.revisions).toHaveLength(2);
  });
});
