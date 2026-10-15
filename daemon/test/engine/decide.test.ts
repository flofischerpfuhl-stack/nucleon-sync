// SPDX-License-Identifier: GPL-3.0-or-later
/** Exhaustive, table-driven check of the decision tables against docs/SYNC-RULES.md–3.4. */
import { describe, expect, it } from 'vitest';

import type { PairDirection } from '@nucleon-sync/shared';

import {
  contentEq,
  decideFile,
  decideFolder,
  localDelta,
  remoteDelta,
  type ContentEq,
  type LDelta,
  type RDelta,
} from '../../src/engine/decide.ts';
import type { EntryRow } from '../../src/db/repo.ts';

const NO_BASE_L: LDelta[] = ['absent', 'new'];
const NO_BASE_R: RDelta[] = ['absent', 'new'];
const BASE_L: LDelta[] = ['unchanged', 'changed', 'deleted'];
const BASE_R: RDelta[] = ['unchanged', 'changed', 'deleted'];
const EQ: ContentEq[] = ['yes', 'size_mtime', 'no'];

/** expected action kind (+ detail) per direction, "L/R" or "L/R/eq" when content matters */
const EXPECTED: Record<PairDirection, Record<string, string>> = {
  backup: {
    'absent/absent': 'forget',
    'new/absent': 'upload', // row 1
    'new/new/yes': 'adopt', // row 2
    'new/new/size_mtime': 'adopt:digest_missing', // row 3
    'new/new/no': 'conflict:initial_mismatch', // row 4
    'absent/new': 'download', // row 12
    'unchanged/unchanged': 'noop:synced',
    'changed/unchanged': 'upload_revision', // row 5
    'unchanged/changed': 'download:replace', // row 6
    'changed/changed/yes': 'adopt',
    'changed/changed/size_mtime': 'conflict:both_changed', // row 7 (no digest = no proof)
    'changed/changed/no': 'conflict:both_changed',
    'deleted/unchanged': 'pending_deletion', // row 8
    'deleted/changed': 'pending_deletion:warn', // row 9
    'unchanged/deleted': 'upload', // row 10 default reupload
    'changed/deleted': 'upload', // row 11
    'deleted/deleted': 'forget',
  },
  'mirror-down': {
    'absent/absent': 'forget',
    'new/absent': 'noop:local_new',
    'new/new/yes': 'adopt',
    'new/new/size_mtime': 'adopt:digest_missing',
    'new/new/no': 'conflict:mirror_local_edit',
    'absent/new': 'download',
    'unchanged/unchanged': 'noop:synced',
    'changed/unchanged': 'conflict:mirror_local_edit',
    'unchanged/changed': 'download:replace',
    'changed/changed/yes': 'adopt',
    'changed/changed/size_mtime': 'conflict:mirror_local_edit',
    'changed/changed/no': 'conflict:mirror_local_edit',
    'deleted/unchanged': 'download',
    'deleted/changed': 'download',
    'unchanged/deleted': 'trash_local',
    'changed/deleted': 'conflict:mirror_local_edit',
    'deleted/deleted': 'forget',
  },
  'upload-only': {
    'absent/absent': 'forget',
    'new/absent': 'upload',
    'new/new/yes': 'adopt',
    'new/new/size_mtime': 'adopt:digest_missing',
    'new/new/no': 'conflict:initial_mismatch',
    'absent/new': 'noop:remote_new',
    'unchanged/unchanged': 'noop:synced',
    'changed/unchanged': 'upload_revision',
    'unchanged/changed': 'accept_remote',
    'changed/changed/yes': 'upload_revision:force',
    'changed/changed/size_mtime': 'upload_revision:force',
    'changed/changed/no': 'upload_revision:force',
    'deleted/unchanged': 'forget',
    'deleted/changed': 'forget',
    'unchanged/deleted': 'noop:remote_deleted',
    'changed/deleted': 'upload',
    'deleted/deleted': 'forget',
  },
  'two-way': {
    'absent/absent': 'forget',
    'new/absent': 'upload',
    'new/new/yes': 'adopt', // adoption: no transfer, no new revision
    'new/new/size_mtime': 'adopt:digest_missing',
    'new/new/no': 'conflict_copy:initial_mismatch', // keep both
    'absent/new': 'download',
    'unchanged/unchanged': 'noop:synced',
    'changed/unchanged': 'upload_revision',
    'unchanged/changed': 'download:replace',
    'unchanged/changed/yes': 'adopt', // new revision, same content as here
    'changed/changed/yes': 'adopt',
    'changed/changed/size_mtime': 'adopt:digest_missing',
    'changed/changed/no': 'conflict_copy:both_changed',
    'deleted/unchanged': 'trash_remote', // Proton trash (mass-delete guard in the planner)
    'deleted/changed': 'restore:local:remote_changed_local_deleted',
    'unchanged/deleted': 'trash_local', // local trash
    'changed/deleted': 'restore:remote:local_changed_remote_deleted',
    'deleted/deleted': 'forget',
  },
};

function describeAction(a: ReturnType<typeof decideFile>): string {
  switch (a.kind) {
    case 'noop':
      return `noop:${a.state}`;
    case 'adopt':
      return a.digestMissing ? 'adopt:digest_missing' : 'adopt';
    case 'conflict':
      return `conflict:${a.conflict}`;
    case 'download':
      return a.replace ? 'download:replace' : 'download';
    case 'pending_deletion':
      return a.remoteChanged ? 'pending_deletion:warn' : 'pending_deletion';
    case 'upload_revision':
      return a.force ? 'upload_revision:force' : 'upload_revision';
    case 'conflict_copy':
      return `conflict_copy:${a.conflict}`;
    case 'restore':
      return `restore:${a.to}${a.review ? `:${a.review}` : ''}`;
    default:
      return a.kind;
  }
}

describe('decision tables (exhaustive)', () => {
  for (const dir of ['backup', 'mirror-down', 'upload-only', 'two-way'] as PairDirection[]) {
    it(`${dir}: every reachable (L, R, content) combination`, () => {
      let checked = 0;
      for (const [Ls, Rs] of [
        [NO_BASE_L, NO_BASE_R],
        [BASE_L, BASE_R],
      ] as [LDelta[], RDelta[]][]) {
        for (const L of Ls)
          for (const R of Rs)
            for (const eq of EQ) {
              const exp = EXPECTED[dir][`${L}/${R}/${eq}`] ?? EXPECTED[dir][`${L}/${R}`];
              expect(exp, `${dir} ${L}/${R}/${eq} missing in expectation table`).toBeDefined();
              expect(describeAction(decideFile(dir, L, R, eq)), `${dir} ${L}/${R}/${eq}`).toBe(exp);
              checked++;
            }
      }
      expect(checked).toBe((2 * 2 + 3 * 3) * 3);
    });
    it(`${dir}: unreachable combinations (base mixed with no-base deltas) are flagged`, () => {
      for (const L of NO_BASE_L)
        for (const R of BASE_R) expect(decideFile(dir, L, R, 'no')).toEqual({ kind: 'noop', state: 'error' });
      for (const L of BASE_L)
        for (const R of NO_BASE_R) expect(decideFile(dir, L, R, 'no')).toEqual({ kind: 'noop', state: 'error' });
    });
  }

  it('two-way: unproven digest-less match is verified; the adoption run never deletes', () => {
    expect(decideFile('two-way', 'new', 'new', 'no', {}, { digestlessSameSize: true })).toEqual({ kind: 'verify' });
    expect(decideFile('two-way', 'deleted', 'unchanged', 'no', {}, { adopting: true })).toEqual({
      kind: 'restore',
      to: 'local',
      review: null,
    });
    expect(decideFile('two-way', 'unchanged', 'deleted', 'no', {}, { adopting: true })).toEqual({
      kind: 'restore',
      to: 'remote',
      review: null,
    });
    const f = (l: boolean, r: boolean, b: boolean, adopting = false) =>
      decideFolder('two-way', l, r, b, { adopting }).kind;
    expect(f(true, false, false)).toBe('mkdir');
    expect(f(false, true, false)).toBe('mkdir_local');
    expect(f(true, false, true)).toBe('trash_local');
    expect(f(false, true, true)).toBe('trash_remote');
    expect(f(true, false, true, true)).toBe('mkdir');
    expect(f(false, true, true, true)).toBe('mkdir_local');
    expect(f(true, true, false)).toBe('adopt');
  });

  it('backup options: remoteChanges=conflict, remoteDeletions=ask', () => {
    expect(decideFile('backup', 'unchanged', 'changed', 'no', { remoteChanges: 'conflict' })).toEqual({
      kind: 'conflict',
      conflict: 'both_changed',
    });
    expect(decideFile('backup', 'unchanged', 'deleted', 'no', { remoteDeletions: 'ask' })).toEqual({
      kind: 'conflict',
      conflict: 'local_present_remote_deleted',
    });
  });

  it('folders', () => {
    const t = (dir: PairDirection, l: boolean, r: boolean, b: boolean) => decideFolder(dir, l, r, b).kind;
    expect(t('backup', true, false, false)).toBe('mkdir');
    expect(t('backup', true, false, true)).toBe('mkdir'); // remote folder deleted, local is master
    expect(t('backup', false, true, false)).toBe('mkdir_local');
    expect(t('backup', false, true, true)).toBe('pending_deletion');
    expect(t('backup', true, true, false)).toBe('adopt');
    expect(t('backup', false, false, true)).toBe('forget');
    expect(t('mirror-down', false, true, true)).toBe('mkdir_local');
    expect(t('mirror-down', true, false, false)).toBe('noop');
    expect(t('upload-only', true, false, false)).toBe('mkdir');
    expect(t('upload-only', false, true, false)).toBe('forget');
  });
});

describe('deltas from entry snapshots', () => {
  const base: EntryRow = {
    id: 1,
    pair_id: 1,
    rel_path: 'a',
    kind: 'file',
    l_exists: 1,
    l_size: 5,
    l_mtime_us: 1_000_000_000,
    l_ctime_us: null,
    l_inode: 7,
    l_dev: 1,
    l_sha1: 'aa',
    l_hashed_at: 1,
    l_seen_scan: 1,
    r_exists: 1,
    r_uid: 'u',
    r_parent_uid: 'p',
    r_rev_uid: 'rev1',
    r_size: 5,
    r_mtime_ms: 1_000_000,
    r_sha1: 'aa',
    r_storage: null,
    r_rev_storage: null,
    r_media_type: null,
    r_seen_crawl: 1,
    b_sha1: 'aa',
    b_size: 5,
    b_l_mtime_us: 1_000_000_000,
    b_r_rev_uid: 'rev1',
    synced_at: 1,
    state: 'synced',
    flags: 0,
    last_error: null,
    updated_at: 1,
  };
  it('local: sha1 decides; touch-only is unchanged', () => {
    expect(localDelta(base)).toBe('unchanged');
    expect(localDelta({ ...base, l_mtime_us: 2_000_000_000 })).toBe('unchanged');
    expect(localDelta({ ...base, l_sha1: 'bb' })).toBe('changed');
    expect(localDelta({ ...base, l_exists: 0 })).toBe('deleted');
    expect(localDelta({ ...base, synced_at: null })).toBe('new');
    expect(localDelta({ ...base, synced_at: null, l_exists: 0 })).toBe('absent');
  });
  it('remote: active revision uid decides', () => {
    expect(remoteDelta(base)).toBe('unchanged');
    expect(remoteDelta({ ...base, r_rev_uid: 'rev2' })).toBe('changed');
    expect(remoteDelta({ ...base, r_exists: 0 })).toBe('deleted');
  });
  it('content: sha1, else digest-less size + mtime within 2 s', () => {
    expect(contentEq(base)).toBe('yes');
    expect(contentEq({ ...base, r_sha1: 'cc' })).toBe('no');
    expect(contentEq({ ...base, r_sha1: null })).toBe('size_mtime');
    expect(contentEq({ ...base, r_sha1: null, r_mtime_ms: 1_000_000 + 2500 })).toBe('no');
    expect(contentEq({ ...base, r_sha1: null, r_size: 6 })).toBe('no');
  });
});

describe('mirror-down with uploadLocalNew ("Neue Dateien vom PC hochladen")', () => {
  const opts = { uploadLocalNew: true };
  it('new local files are uploaded (also when Proton has a different same-named file: executor keeps both)', () => {
    expect(describeAction(decideFile('mirror-down', 'new', 'absent', 'no', opts))).toBe('upload');
    expect(describeAction(decideFile('mirror-down', 'new', 'new', 'no', opts))).toBe('upload');
    expect(describeAction(decideFile('mirror-down', 'new', 'new', 'yes', opts))).toBe('adopt');
  });
  it('everything with a base keeps the mirror rules: local edits conflict, Proton is never written', () => {
    for (const L of BASE_L)
      for (const R of BASE_R)
        for (const eq of EQ)
          expect(decideFile('mirror-down', L, R, eq, opts), `${L}/${R}/${eq}`).toEqual(
            decideFile('mirror-down', L, R, eq),
          );
    expect(describeAction(decideFile('mirror-down', 'changed', 'unchanged', 'no', opts))).toBe(
      'conflict:mirror_local_edit',
    );
  });
  it('other directions ignore the option', () => {
    expect(describeAction(decideFile('backup', 'new', 'new', 'no', opts))).toBe('conflict:initial_mismatch');
  });
});
