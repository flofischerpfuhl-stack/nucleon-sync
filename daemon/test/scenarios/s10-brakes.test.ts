// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonEvent, Notice } from '@nucleon-sync/shared';

import { makeHarness, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

function notices(): Notice[] {
  const list: Notice[] = [];
  h.engine.on('event', (e: DaemonEvent) => e.type === 'notice' && list.push(e.notice));
  return list;
}

describe('S10 safety brakes', () => {
  it('missing or empty pair root: run stopped for the pair, no pending deletions, notice', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`Dokumente/f${i}.txt`] = `f${i}`;
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: files,
    });
    await h.sync();
    const n = notices();
    const root = path.join(h.data, 'Dokumente');
    renameSync(root, `${root}.unmounted`);
    const r1 = await h.sync();
    expect(r1.status).toBe('partial');
    expect(h.engine.deletions()).toHaveLength(0);
    expect(n.some((x) => x.key === 'brake:1' && /is missing/.test(x.body))).toBe(true);
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/f0.txt')).toBeDefined();

    mkdirSync(root); // mounted, but empty
    const r2 = await h.sync();
    expect(r2.status).toBe('partial');
    expect(h.engine.deletions()).toHaveLength(0);
    expect(n.some((x) => x.key === 'brake:1' && /is empty/.test(x.body))).toBe(true);
    expect(h.entry(1, 'f0.txt')!.l_exists).toBe(1); // nothing interpreted as deleted

    rmSync(root, { recursive: true });
    renameSync(`${root}.unmounted`, root);
    expect((await h.sync()).status).toBe('ok');
    expect(h.engine.deletions()).toHaveLength(0);
  });

  it('mass deletion: brake before planning deletions; released by the user -> pending deletions', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`Dokumente/sub${i % 3}/f${i}.txt`] = `f${i}`;
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' }],
      localFiles: files,
    });
    await h.sync();
    const n = notices();
    for (let i = 0; i < 55; i++) rmSync(path.join(h.data, `Dokumente/sub${i % 3}/f${i}.txt`));
    const mark = h.mark();
    const r = await h.sync();
    expect(r.status).toBe('partial');
    expect(h.engine.deletions()).toHaveLength(0);
    expect(n.find((x) => x.key === 'brake:1')?.body).toMatch(/Mass deletion detected: 55 of 60/);
    // message keys for the dashboard: notice title/body, the pair's brake reason (stored encoded) and the activity row
    expect(n.find((x) => x.key === 'brake:1')).toMatchObject({
      titleMsg: { key: 'notice.brake', params: { pair: 'Dokumente' } },
      bodyMsg: { key: 'brake.massDeleteDetected', params: { gone: 55, tracked: 60 } },
    });
    const brake = h.engine.pairs().find((p) => p.id === 1)!.brake!;
    expect(brake.reason).toMatch(/^Mass deletion detected: 55 of 60/);
    expect(brake.reasonMsg).toEqual({ key: 'brake.massDeleteDetected', params: { gone: 55, tracked: 60 } });
    const act = h.engine.activity(50).find((a) => a.msg?.key === 'activity.brake')!;
    expect(act.message).toMatch(/^Safety brake: Mass deletion detected: 55 of 60/);
    expect(
      h.commands('alex', mark).filter((c) => c.cmd !== 'filesystem list' && c.cmd !== 'filesystem info'),
    ).toHaveLength(0);
    expect(h.entry(1, 'sub0/f0.txt')!.l_exists).toBe(1);

    // brake stays on for further runs until released
    await h.sync();
    expect(h.engine.deletions()).toHaveLength(0);
    h.engine.releaseBrake(1, 'test');
    await h.engine.waitIdle();
    expect(h.engine.deletions()).toHaveLength(55);
    expect(h.remoteNode('alex', '/devices/Workstation/Documents/sub0/f0.txt')).toBeDefined();
  });
});
