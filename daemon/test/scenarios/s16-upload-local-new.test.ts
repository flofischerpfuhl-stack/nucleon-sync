// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * S16 mirror-down + "Neue Dateien vom PC hochladen" (pairs.options.uploadLocalNew): an agent files a document into
 * Sam's mirrored folder on the PC -> it is uploaded once to the same relative path in her Proton device folder.
 * Proton is never overwritten or trashed by such a pair.
 */
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fromPcName } from '../../src/engine/executor.ts';
import { makeHarness, uploadsWith, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const ROOT = '/devices/DESKTOP-6CABT8U';
const LOCAL = 'Sam/Laptop';
const REMOTE_WRITES = ['filesystem move', 'filesystem rename', 'filesystem trash', 'filesystem delete'];

const pair = (options: Record<string, unknown> = { uploadLocalNew: true }) => ({
  account: 'sam',
  name: 'Sam Laptop',
  local: LOCAL,
  remote: ROOT,
  direction: 'mirror-down' as const,
  options,
});

const seed = {
  sam: [
    {
      to: `${ROOT}/Documents`,
      files: { 'Versicherung/Police.pdf': 'police v1', 'brief.txt': 'brief from laptop' },
    },
  ],
};

async function samHarness(extra: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  return makeHarness({
    accounts: [{ id: 'sam', workers: 1, devices: ['DESKTOP-6CABT8U'] }],
    pairs: [pair()],
    seed,
    ...extra,
  });
}

/** non-trashed remote file nodes named `name` below the whole remote */
const remoteFiles = (name: string) =>
  Object.values(h.remoteState('sam').nodes).filter((n) => n.type === 'file' && n.name === name && !n.trashed);

describe('S16 mirror-down: upload new files from the PC', () => {
  it('uploads a new local file once (creating the missing remote folder), sha1 verified, recorded in the state DB', async () => {
    h = await samHarness();
    expect((await h.sync()).status).toBe('ok');
    expect(h.read(`${LOCAL}/Documents/brief.txt`)).toBe('brief from laptop');

    const rel = 'Documents/Rechnungen/2026/2026-10-11 Stadtwerke Rechnung.pdf';
    h.write(`${LOCAL}/${rel}`, 'rechnung pdf');
    const mark = h.mark('sam');
    expect((await h.sync({ pairId: 1 })).status).toBe('ok');

    const node = h.remoteNode('sam', `${ROOT}/${rel}`);
    expect(node?.revisions?.at(-1)?.sha1).toBe(sha1('rechnung pdf'));
    const e = h.entry(1, rel)!;
    expect(e.state).toBe('synced');
    expect(e.b_sha1).toBe(sha1('rechnung pdf'));
    expect(e.r_uid).toBe(node!.uid);
    expect(uploadsWith(h.commands('sam', mark), 'skip')).toHaveLength(1);
    expect(h.commands('sam', mark).filter((c) => c.cmd === 'filesystem create-folder')).toHaveLength(2);
    const act = h.engine.activity(50).find((a) => a.relPath === rel)!;
    expect(act).toMatchObject({ action: 'uploaded', message: 'uploaded from the PC' });

    // idempotent: further runs upload nothing, the file is a normal mirrored file now
    const mark2 = h.mark('sam');
    await h.sync();
    await h.sync({ mode: 'full' });
    expect(h.commands('sam', mark2).filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);
    expect(remoteFiles('2026-10-11 Stadtwerke Rechnung.pdf')).toHaveLength(1);
    // nothing in Proton was moved, renamed or trashed
    expect(h.commands('sam').filter((c) => REMOTE_WRITES.includes(c.cmd))).toHaveLength(0);
  });

  it('only files created after the option was switched on qualify; without the option nothing is uploaded', async () => {
    h = await samHarness({
      pairs: [pair({})],
      localFiles: { [`${LOCAL}/Documents/alt/vorher.txt`]: 'was here before' },
    });
    expect((await h.sync()).status).toBe('ok');
    expect(h.entry(1, 'Documents/alt/vorher.txt')!.state).toBe('local_new');
    expect(h.commands('sam').filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 30));
    h.db
      .prepare('UPDATE pairs SET options = ? WHERE id = 1')
      .run(JSON.stringify({ uploadLocalNew: true, uploadLocalNewSince: Date.now() }));
    await new Promise((r) => setTimeout(r, 30));
    h.write(`${LOCAL}/Documents/neu.txt`, 'filed by an agent');
    expect((await h.sync()).status).toBe('ok');
    expect(h.remoteNode('sam', `${ROOT}/Documents/neu.txt`)).toBeDefined();
    expect(h.remoteNode('sam', `${ROOT}/Documents/alt/vorher.txt`)).toBeUndefined();
    expect(h.remoteNode('sam', `${ROOT}/Documents/alt`)).toBeUndefined();
    expect(h.entry(1, 'Documents/alt/vorher.txt')!.state).toBe('local_new');
  });

  it('a pair-scoped API run waits for a just-filed file instead of postponing it to the next run', async () => {
    h = await samHarness({ engine: { freshMs: 1500 } });
    await h.sync();
    h.write(`${LOCAL}/Documents/gerade.pdf`, 'just filed');
    const t0 = Date.now();
    const id = h.engine.requestSync({ pairId: 1 }, 'api');
    await h.engine.waitIdle();
    expect(h.engine.runs(5).find((r) => r.id === id)!.status).toBe('ok');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(h.remoteNode('sam', `${ROOT}/Documents/gerade.pdf`)).toBeDefined();
    // a scheduled (unscoped) run does not wait: the fresh file is left for the next run
    h.write(`${LOCAL}/Documents/spaeter.pdf`, 'later');
    await h.sync();
    expect(h.remoteNode('sam', `${ROOT}/Documents/spaeter.pdf`)).toBeUndefined();
  });

  it('daemon restart mid-upload (upload done, bookkeeping not): no duplicate node, no second upload', async () => {
    h = await samHarness();
    await h.sync();
    const rel = 'Documents/Steuer/2026-10-11 Steuerbescheid.pdf';
    h.write(`${LOCAL}/${rel}`, 'bescheid');
    await h.sync();
    const done = h.jobs('done').find((j) => j.type === 'upload')!;
    expect(remoteFiles('2026-10-11 Steuerbescheid.pdf')).toHaveLength(1);

    // crash window: the CLI finished the upload, the daemon died before recording it
    const e = h.entry(1, rel)!;
    h.db
      .prepare(
        `UPDATE entries SET r_exists = 0, r_uid = NULL, r_rev_uid = NULL, r_sha1 = NULL, b_sha1 = NULL, b_size = NULL,
         b_l_mtime_us = NULL, b_r_rev_uid = NULL, synced_at = NULL, state = 'local_new' WHERE id = ?`,
      )
      .run(e.id);
    h.db
      .prepare(
        `INSERT INTO jobs (run_id, account_id, pair_id, entry_id, type, payload, priority, state, bytes, dedupe_key, created_at, started_at)
         VALUES (NULL, 'sam', 1, ?, 'upload', ?, 30, 'running', ?, ?, ?, ?)`,
      )
      .run(e.id, done.payload, e.l_size, `upload:1:${rel}`, Date.now(), Date.now());
    const mark = h.mark('sam');
    await h.restart();
    await h.drain();
    await h.sync();

    expect(h.commands('sam', mark).filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);
    expect(remoteFiles('2026-10-11 Steuerbescheid.pdf')).toHaveLength(1);
    expect(h.entry(1, rel)!.state).toBe('synced');
    expect(h.jobs('failed')).toHaveLength(0);
  });

  it('a different file with the same name in Proton: both kept, Proton file untouched', async () => {
    h = await samHarness();
    await h.sync();
    // Sam's laptop uploads a new brief2.txt while an agent files a different brief2.txt on the PC
    h.otherUpload('sam', `${ROOT}/Documents`, 'brief2.txt', 'from the laptop', 'skip');
    h.write(`${LOCAL}/Documents/brief2.txt`, 'filed on the pc');
    const mark = h.mark('sam');
    expect((await h.sync()).status).toBe('ok');
    await h.drain();

    const copy = path.posix.basename(fromPcName('Documents/brief2.txt', new Date()));
    expect(copy).toMatch(/^brief2 \(from PC \d{4}-\d{2}-\d{2}\)\.txt$/);
    // Proton: original untouched (one revision, laptop content) + the PC file under the new name
    const orig = remoteFiles('brief2.txt');
    expect(orig).toHaveLength(1);
    expect(orig[0]!.revisions).toHaveLength(1);
    expect(orig[0]!.revisions![0]!.sha1).toBe(sha1('from the laptop'));
    expect(h.remoteNode('sam', `${ROOT}/Documents/${copy}`)?.revisions?.at(-1)?.sha1).toBe(sha1('filed on the pc'));
    // PC: both files as well
    expect(h.read(`${LOCAL}/Documents/brief2.txt`)).toBe('from the laptop');
    expect(h.read(`${LOCAL}/Documents/${copy}`)).toBe('filed on the pc');
    expect(uploadsWith(h.commands('sam', mark), 'skip')).toHaveLength(1);
    expect(h.commands('sam').filter((c) => REMOTE_WRITES.includes(c.cmd))).toHaveLength(0);
    expect(h.engine.conflicts()).toHaveLength(0);

    // stable afterwards
    const mark2 = h.mark('sam');
    await h.sync();
    expect(h.commands('sam', mark2).filter((c) => c.cmd.startsWith('filesystem upload'))).toHaveLength(0);
    expect(h.entry(1, 'Documents/brief2.txt')!.state).toBe('synced');
    expect(h.entry(1, `Documents/${copy}`)!.state).toBe('synced');
  });

  it('local edit of a file that exists in Proton stays a mirror_local_edit conflict; Proton is not written', async () => {
    h = await samHarness();
    await h.sync();
    h.write(`${LOCAL}/Documents/neu.txt`, 'v1 from pc');
    await h.sync();
    const before = h.remoteState('sam');
    const mark = h.mark('sam');

    h.write(`${LOCAL}/Documents/brief.txt`, 'edited on the pc');
    h.write(`${LOCAL}/Documents/neu.txt`, 'v2 edited on the pc');
    expect((await h.sync()).status).toBe('ok');

    expect(
      h.engine
        .conflicts()
        .map((c) => [c.relPath, c.kind])
        .sort(),
    ).toEqual([
      ['Documents/brief.txt', 'mirror_local_edit'],
      ['Documents/neu.txt', 'mirror_local_edit'],
    ]);
    expect(h.commands('sam', mark).filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);
    expect(h.remoteState('sam').nodes).toEqual(before.nodes);
    expect(h.read(`${LOCAL}/Documents/brief.txt`)).toBe('edited on the pc');

    // "Proton behalten": remote wins, the local edit stays on the PC as a copy and is NOT uploaded
    const c = h.engine.conflicts().find((x) => x.relPath === 'Documents/brief.txt')!;
    h.engine.resolveConflict(c.id, 'keep_remote', 'test');
    await h.drain();
    expect(h.read(`${LOCAL}/Documents/brief.txt`)).toBe('brief from laptop');
    const copies = readdirSync(path.join(h.data, LOCAL, 'Documents')).filter((n) => n.includes('local edit'));
    expect(copies).toHaveLength(1);
    const mark2 = h.mark('sam');
    await h.sync();
    expect(h.commands('sam', mark2).filter((c2) => c2.cmd === 'filesystem upload')).toHaveLength(0);
    expect(h.entry(1, `Documents/${copies[0]}`)!.state).toBe('local_new');
  });

  it('write guard: upload blocked; file deleted before the upload ran -> nothing is uploaded', async () => {
    h = await samHarness({
      engine: { mode: 'production', env: { ...process.env, NUCLEON_SYNC_ALLOW_WRITES: '0' } },
    });
    h.write(`${LOCAL}/Documents/kurz.txt`, 'filed by mistake');
    h.write(`${LOCAL}/Documents/bleibt.txt`, 'stays');
    expect((await h.sync()).status).toBe('ok');
    const blocked = h.jobs('blocked').filter((j) => j.type === 'upload');
    expect(blocked).toHaveLength(2);
    expect(h.commands('sam').filter((c) => c.cmd === 'filesystem upload')).toHaveLength(0);

    rmSync(path.join(h.data, LOCAL, 'Documents/kurz.txt'));
    await h.restart({ env: { ...process.env, NUCLEON_SYNC_ALLOW_WRITES: '1' } });
    await h.drain();
    await h.sync();

    expect(h.remoteNode('sam', `${ROOT}/Documents/kurz.txt`)).toBeUndefined();
    expect(h.remoteNode('sam', `${ROOT}/Documents/bleibt.txt`)).toBeDefined();
    const uploaded = uploadsWith(h.commands('sam'), 'skip').flatMap((c) => c.args);
    expect(uploaded.some((a) => a.endsWith('kurz.txt'))).toBe(false);
    expect(h.entry(1, 'Documents/kurz.txt')).toBeUndefined();
    expect(h.jobs('failed')).toHaveLength(0);
  });
});
