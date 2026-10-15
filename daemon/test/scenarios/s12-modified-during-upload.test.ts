// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S12 file modified during upload', () => {
  it('base is not advanced to the new local state; entry local_changed; next run uploads a revision', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: { 'Dokumente/growing.log': 'first lines', 'Dokumente/calm.txt': 'calm' },
      accountEnv: { alex: { MOCK_MODIFY_DURING_UPLOAD: 'growing' } },
    });
    const run = await h.sync();
    expect(run.status).toBe('ok');
    const e = h.entry(1, 'growing.log')!;
    expect(e.state).toBe('local_changed');
    expect(h.read('Dokumente/growing.log')).toBe('first lines\nmodified during upload');
    expect(e.b_size).toBe('first lines'.length); // base = what was uploaded
    expect(e.l_size).toBe('first lines\nmodified during upload'.length); // local = what is on disk now
    expect(e.l_sha1).toBeNull(); // re-hashed by the next scan
    expect(h.entry(1, 'calm.txt')!.state).toBe('synced');

    const mark = h.mark();
    await h.sync();
    expect(uploadsWith(h.commands('alex', mark), 'create-new-revision')).toHaveLength(1);
    // the hook fires again on the revision upload: still not advanced to the newest local state
    expect(h.entry(1, 'growing.log')!.state).toBe('local_changed');
  });
});
