// SPDX-License-Identifier: GPL-3.0-or-later
/** CLI quirks handled centrally (cli/quirks.ts) + timeouts + progress helpers + status formatting (unit level). */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultGlobalExcludes, type StatusDto } from '@nucleon-sync/shared';

import { fmtEta, transferLines } from '../../src/bin/format.ts';
import { parseVersionOutput } from '../../src/cli/compat.ts';
import { classifyCliError } from '../../src/cli/classify.ts';
import { readFdPositions, TransferMonitor } from '../../src/cli/progress.ts';
import { globUnsafe, needsSkipThumbnails, tempRemoteName, TEMP_REMOTE_RE, withNames } from '../../src/cli/quirks.ts';
import { DEFAULT_CLI_TIMEOUTS, transferTimeoutMs } from '../../src/engine/remote.ts';
import { RuleMatcher } from '../../src/engine/rules.ts';
import { tmp } from '../helpers.ts';

describe('local path globbing (quirk 1)', () => {
  it('flags [ ] * ? and brace lists, not plain braces', () => {
    expect(globUnsafe('/srv/sync/Fotos [2020]/a.jpg')).toBe(true);
    expect(globUnsafe('/srv/sync/a]b.txt')).toBe(true);
    expect(globUnsafe('/srv/sync/what?.txt')).toBe(true);
    expect(globUnsafe('/srv/sync/star*.txt')).toBe(true);
    expect(globUnsafe('/srv/sync/{a,b}.txt')).toBe(true);
    expect(globUnsafe('/srv/sync/{draft}.txt')).toBe(false); // must be passed unescaped
    expect(globUnsafe('/srv/sync/Kündigung "Müller" (1).docx')).toBe(false);
  });

  it('temporary remote names are stable, glob-free, and excluded by the default junk rules', () => {
    const t = tempRemoteName('bild [1].jpg');
    expect(t).toBe(tempRemoteName('bild [1].jpg'));
    expect(t).not.toBe(tempRemoteName('bild [2].jpg'));
    expect(globUnsafe(t)).toBe(false);
    expect(TEMP_REMOTE_RE.test(t)).toBe(true);
    expect(tempRemoteName('-x [1]').startsWith('-')).toBe(false);
    const m = new RuleMatcher({ rules: defaultGlobalExcludes(), localRoot: '/x' });
    expect(m.match(`a/${t}`).excluded).toBe(true);
  });
});

describe('names starting with "-" (quirk 2)', () => {
  it('go after "--", -j before the positionals', () => {
    expect(withNames(['filesystem', 'rename'], ['/my-files/U'], ['normal'])).toEqual([
      'filesystem',
      'rename',
      '-j',
      '/my-files/U',
      'normal',
    ]);
    expect(withNames(['filesystem', 'create-folder'], ['/my-files/U'], ['-4 Ordner'])).toEqual([
      'filesystem',
      'create-folder',
      '-j',
      '/my-files/U',
      '--',
      '-4 Ordner',
    ]);
    expect(classifyCliError("error: unknown option '-4 Ordner'")).toBe('fatal');
    expect(classifyCliError('No paths matched: /x/[1].txt')).toBe('local_io');
  });
});

describe('thumbnails (quirk 3)', () => {
  it('TIFF/RAW and files > 100 MB skip thumbnails', () => {
    expect(needsSkipThumbnails('/a/scan.TIF', 1000)).toBe(true);
    expect(needsSkipThumbnails('/a/x.cr2', 10)).toBe(true);
    expect(needsSkipThumbnails('/a/orthophoto.las', 12_500_000_000)).toBe(true);
    expect(needsSkipThumbnails('/a/photo.jpg', 5_000_000)).toBe(false);
  });
});

describe('version string (quirk 5)', () => {
  it('parses cli-drive@0.9.0+hash', () => {
    const v = parseVersionOutput('Proton Drive CLI cli-drive@0.9.0+75612299\nProton Drive SDK js@0.22.2+75612299\n');
    expect(v.cliVersion).toBe('0.9.0+75612299');
    expect(v.compatible).toBe(true);
  });
});

describe('per-command timeouts', () => {
  it('transfer timeout = base + size at 1 MB/s', () => {
    expect(transferTimeoutMs(0)).toBe(120_000);
    expect(transferTimeoutMs(12_500_000_000)).toBe(120_000 + Math.ceil((12_500_000_000 / 1048576) * 1000));
    expect(DEFAULT_CLI_TIMEOUTS.listMs).toBeLessThanOrEqual(120_000);
    expect(DEFAULT_CLI_TIMEOUTS.mutateMs).toBe(120_000);
  });
});

describe('progress sources', () => {
  it('reads fd offsets from a /proc-like tree', () => {
    const proc = tmp('fakeproc-');
    const dir = path.join(proc, '77');
    mkdirSync(path.join(dir, 'fd'), { recursive: true });
    mkdirSync(path.join(dir, 'fdinfo'));
    symlinkSync('/srv/sync/big.las', path.join(dir, 'fd', '9'));
    writeFileSync(path.join(dir, 'fdinfo', '9'), 'pos:\t5242880\nflags:\t0100000\n');
    symlinkSync('/dev/null', path.join(dir, 'fd', '1'));
    writeFileSync(path.join(dir, 'fdinfo', '1'), 'pos:\t0\n');
    const pos = readFdPositions(77, new Set(['/srv/sync/big.las']), proc);
    expect(pos.get('/srv/sync/big.las')).toBe(5242880);
    const samples: number[] = [];
    const m = new TransferMonitor({
      kind: 'upload',
      files: [{ path: '/srv/sync/big.las', size: 10 * 1048576 }],
      bytesTotal: 10 * 1048576,
      expectedBps: 1,
      pid: () => 77,
      procDir: proc,
      onProgress: (p) => samples.push(p.bytesDone),
    });
    const s = m.sample();
    m.stop();
    expect(s).toMatchObject({ bytesDone: 5242880, source: 'fd' });
  });

  it('download progress = bytes in the staging dir, estimate never reaches 100 %', () => {
    const st = tmp('staging-');
    writeFileSync(path.join(st, 'part'), Buffer.alloc(3000));
    const m = new TransferMonitor({
      kind: 'download',
      stagingDir: st,
      bytesTotal: 10_000,
      expectedBps: 1,
      pid: () => null,
      onProgress: () => undefined,
    });
    expect(m.sample()).toMatchObject({ bytesDone: 3000, source: 'staging' });
    m.stop();
    const e = new TransferMonitor({
      kind: 'upload',
      bytesTotal: 1000,
      expectedBps: 1e9,
      pid: () => null,
      onProgress: () => undefined,
    });
    expect(e.sample().bytesDone).toBeLessThanOrEqual(950);
    e.stop();
  });
});

describe('nucleon-sync status: transfer lines', () => {
  it('shows the overall upload ETA and running transfers', () => {
    const s = {
      transfers: {
        active: [
          {
            jobIds: [5],
            accountId: 'alex',
            pairId: 1,
            kind: 'upload',
            relPath: 'Geo/Orthophoto.las',
            files: 1,
            bytesDone: 2 * 1024 ** 3,
            bytesTotal: 8 * 1024 ** 3,
            startedAt: new Date().toISOString(),
            rateBps: 4 * 1024 ** 2,
            etaSeconds: 1536,
            source: 'fd',
          },
        ],
        upload: {
          files: 7020,
          bytes: 480 * 1024 ** 3,
          bytesDone: 2 * 1024 ** 3,
          rateBps: 4 * 1024 ** 2,
          etaSeconds: 125_000,
          blockedFiles: 0,
          blockedBytes: 0,
        },
        download: {
          files: 0,
          bytes: 0,
          bytesDone: 0,
          rateBps: null,
          etaSeconds: 0,
          blockedFiles: 0,
          blockedBytes: 0,
        },
      },
    } as unknown as StatusDto;
    const lines = transferLines(s);
    expect(lines[0]).toMatch(/^upload: 7020 files \/ 478\.0 GB left at 4\.0 MB\/s · ETA 1 d 10 h$/);
    expect(lines[1]).toMatch(/Orthophoto\.las {2}25 % {2}2\.0 GB\/8\.0 GB {2}4\.0 MB\/s {2}ETA 26 min/);
    expect(fmtEta(null)).toBe('unknown');
  });
});
