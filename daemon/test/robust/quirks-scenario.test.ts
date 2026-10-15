// SPDX-License-Identifier: GPL-3.0-or-later
/** CLI quirks end to end: engine + REPL workers against the mock, which emulates the real CLI's quirks. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { TEMP_REMOTE_RE } from '../../src/cli/quirks.ts';
import { makeHarness, type Harness } from '../scenarios/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const PAIR = { account: 'alex', name: 'Dokumente', local: 'Dokumente', remote: '/devices/Workstation/Documents' };

describe('CLI quirks against the quirk-emulating mock', () => {
  it('uploads names with [ ] * ? { } and leading "-", TIFF and big files; idempotent; revisions keep the node', async () => {
    const files: Record<string, string> = {
      'Dokumente/Fotos [2020]/bild [1].jpg': 'jpeg in a bracket folder',
      'Dokumente/Fotos [2020]/plain.txt': 'plain name, bracket folder',
      'Dokumente/Fotos [2020]/plain2.txt': 'second plain name, bracket folder',
      'Dokumente/what?.txt': 'question',
      'Dokumente/star*.txt': 'star',
      'Dokumente/{draft}.txt': 'plain braces',
      'Dokumente/{a,b}.txt': 'brace list',
      'Dokumente/-4 Ordner/-minus.txt': 'dash names',
      'Dokumente/scan.tif': 'tiff without thumbnail',
      'Dokumente/big.bin': 'x'.repeat(5000), // > MOCK_THUMBNAIL_MAX_BYTES -> thumbnail failure -> retry with -t
      'Dokumente/normal.txt': 'normal',
    };
    h = await makeHarness({
      pairs: [PAIR],
      localFiles: files,
      accountEnv: { alex: { MOCK_THUMBNAIL_MAX_BYTES: '4000' } },
    });
    const run = await h.sync();
    await h.drain();
    expect(h.jobs('failed')).toEqual([]);
    expect(run.status).toBe('ok');
    for (const [rel, content] of Object.entries(files)) {
      const node = h.remoteNode('alex', `/devices/Workstation/Documents/${rel.slice('Dokumente/'.length)}`);
      expect(node, rel).toBeDefined();
      expect(node!.revisions!.at(-1)!.sha1, rel).toBe(sha1(content));
    }
    const st = h.remoteState('alex');
    expect(Object.values(st.nodes).filter((n) => TEMP_REMOTE_RE.test(n.name))).toEqual([]);
    // the commands used: -- for dash names, --skip-thumbnails for the TIFF, never a "No paths matched"
    const cmds = h.commands();
    expect(cmds.filter((c) => !c.ok).map((c) => c.error ?? '')).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/No paths matched|unknown option/)]),
    );
    expect(cmds.some((c) => c.cmd === 'filesystem create-folder' && c.args.includes('--'))).toBe(true);
    // files that only sit in a bracket folder are batched through one temp dir (one command)
    const plain = cmds.filter((c) => c.cmd === 'filesystem upload' && c.args.some((a) => a.endsWith('/plain.txt')));
    expect(plain).toHaveLength(1);
    expect(plain[0]!.args.some((a) => a.endsWith('/plain2.txt'))).toBe(true);
    const tif = cmds.find((c) => c.cmd === 'filesystem upload' && c.args.some((a) => a.endsWith('scan.tif')))!;
    expect(tif.args).toContain('--skip-thumbnails');

    // idempotent: nothing is uploaded again
    const mark = h.mark();
    await h.sync();
    await h.drain();
    expect(h.commands('alex', mark).filter((c) => c.cmd === 'filesystem upload')).toEqual([]);

    // a revision of a file with glob characters in its name stays on the same node
    const before = h.remoteNode('alex', '/devices/Workstation/Documents/Fotos [2020]/bild [1].jpg')!;
    h.write('Dokumente/Fotos [2020]/bild [1].jpg', 'jpeg v2', new Date('2025-04-01T10:00:00Z'));
    await h.sync();
    await h.drain();
    const after = h.remoteNode('alex', '/devices/Workstation/Documents/Fotos [2020]/bild [1].jpg')!;
    expect(after.uid).toBe(before.uid);
    expect(after.revisions!.map((r) => r.sha1)).toEqual([sha1('jpeg in a bracket folder'), sha1('jpeg v2')]);
    expect(Object.values(h.remoteState('alex').nodes).filter((n) => TEMP_REMOTE_RE.test(n.name))).toEqual([]);
  });

  it('mirror-down: remote names with glob characters download fine (mtime set by the engine)', async () => {
    const mtime = new Date('2024-05-06T07:08:09Z');
    h = await makeHarness({
      pairs: [{ account: 'alex', name: 'Sam', local: 'Sam', remote: '/my-files/Sam', direction: 'mirror-down' }],
      seed: { alex: [{ files: { 'x [1].txt': 'bracket', '-y.txt': 'dash' }, to: '/my-files/Sam', mtime }] },
    });
    await h.sync();
    await h.drain();
    expect(h.read('Sam/x [1].txt')).toBe('bracket');
    expect(h.read('Sam/-y.txt')).toBe('dash');
    const { mtimeMs } = await import('node:fs').then((fs) => fs.statSync(`${h.data}/Sam/x [1].txt`));
    expect(Math.abs(mtimeMs - mtime.getTime())).toBeLessThan(1000);
    expect(readFileSync(`${h.data}/Sam/x [1].txt`, 'utf8')).toBe('bracket');
  });
});
