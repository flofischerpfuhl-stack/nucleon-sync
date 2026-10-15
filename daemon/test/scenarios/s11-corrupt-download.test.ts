// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S11 corrupted download', () => {
  it('sha1 mismatch -> integrity error, nothing moved into place', async () => {
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: { alex: [{ to: '/devices/Workstation/Documents', files: { 'nur-proton.pdf': 'precious content' } }] },
      accountEnv: { alex: { MOCK_CORRUPT_DOWNLOAD: '1' } },
    });
    const run = await h.sync();
    expect(run.status).toBe('partial');
    const job = h.jobs().find((j) => j.type === 'download')!;
    expect(job.state).toBe('failed');
    expect(job.error_class).toBe('integrity');
    expect(job.last_error).toMatch(/Integrity verification failed/);
    expect(h.exists('Dokumente/nur-proton.pdf')).toBe(false);
    const staging = path.join(h.data, '.nucleon-sync-staging');
    expect(!existsSync(staging) || readdirSync(staging).length === 0).toBe(true);
    expect(h.entry(1, 'nur-proton.pdf')!.l_exists).toBe(0);
    expect(h.engine.activity(20).some((a) => a.action === 'error' && a.relPath === 'nur-proton.pdf')).toBe(true);
    expect(h.commands().filter((c) => c.cmd === 'filesystem download')).toHaveLength(3); // retried, then given up
  });
});
