// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { seed } from '../helpers.ts';
import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S9 refresh-token race with a pool of 2', () => {
  it('access tokens expire mid-run: the run succeeds and the stored session stays intact', async () => {
    const files: Record<string, string> = {};
    const local: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      files[`r${i}/f.txt`] = `remote ${i}`;
      local[`Dokumente/l${i}/g.txt`] = `local ${i}`;
    }
    h = await makeHarness({
      accounts: [{ id: 'alex', workers: 2 }],
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: { alex: [{ to: '/devices/Workstation/Documents', files }] },
      localFiles: local,
      accountEnv: { alex: { MOCK_LATENCY_MS: '30' } },
    });
    const id = h.engine.requestSync({}, 'manual');
    for (let i = 0; i < 200 && h.mark() < 6; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.engine.poolFor('alex').configuredSize).toBe(2);
    seed(h.remotes.alex!, '--expire-access');
    await h.engine.waitIdle();
    const run = h.engine.runs(5).find((r) => r.id === id)!;
    expect(run.status).toBe('ok');
    expect(h.jobs('failed')).toHaveLength(0);
    expect(h.engine.accounts()[0]!.status).toBe('ok');
    const session = JSON.parse(readFileSync(path.join(h.secrets, 'alex.json'), 'utf8')) as { refreshToken: string };
    expect(session.refreshToken).toMatch(/^[0-9a-f]{32}$/); // not wiped by the losing worker
    const shim = readFileSync(path.join(h.dir, 'home/state/shim-events.jsonl'), 'utf8');
    expect(shim).toContain('"op":"insert","result":"saved"'); // the winner stored the rotated token
    expect(shim).toContain('"op":"rm","result":"suppressed"'); // the loser's signOut was suppressed
    for (let i = 0; i < 12; i++) {
      expect(h.exists(`Dokumente/r${i}/f.txt`)).toBe(true);
      expect(h.remoteNode('alex', `/devices/Workstation/Documents/l${i}/g.txt`)).toBeDefined();
    }
  });
});
