// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('S8 tarpit', () => {
  it('limiter drops to 1 worker, then cools down; visible in status()', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 16; i++) files[`d${i}/f.txt`] = `f${i}`;
    h = await makeHarness({
      accounts: [{ id: 'alex', workers: 2 }],
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      seed: { alex: [{ to: '/devices/Workstation/Documents', files }] },
      accountEnv: { alex: { MOCK_TARPIT_RPM: '4', MOCK_TARPIT_LATENCY_MS: '500' } },
      engine: { limiter: { highLatencyMs: 200, sustainMs: 400, cooldownMs: 1200 } },
    });
    const seen = new Set<string>();
    let ewma = 0;
    let stop = false;
    const poll = (async () => {
      while (!stop) {
        const s = h.engine.status();
        const a = s.accounts[0]!;
        seen.add(`${a.status}:${a.workers.active}${a.lastError?.includes('paused until') ? ':pause' : ''}`);
        ewma = Math.max(ewma, s.rate.metaLatencyMsEwma ?? 0);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const run = await h.sync();
    stop = true;
    await poll;
    expect(run.status).toBe('ok');
    expect(seen.has('ok:2')).toBe(true);
    expect(seen.has('throttled:1')).toBe(true); // reduced to one worker
    expect(seen.has('throttled:0:pause')).toBe(true); // cooldown ("Proton is throttling – paused until …")
    expect(ewma).toBeGreaterThan(200);
    expect(h.engine.activity(200).some((a) => a.message?.startsWith('Proton is throttling'))).toBe(true);
    expect(h.exists('Dokumente/d15/f.txt')).toBe(true); // finished after the cool-down
  }, 90_000);
});
