// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MOCK_BIN, mockAccount, tmp } from '../../daemon/test/helpers.ts';

const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(MOCK_BIN, args, { env, encoding: 'utf8' });
const json = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  JSON.parse(execFileSync(MOCK_BIN, [...args, '-j'], { env, encoding: 'utf8' }));

describe('mock-proton-drive', () => {
  it('lists with real JSON shape and resolves uid path segments', () => {
    const { env } = mockAccount(tmp());
    const items = json(env, 'filesystem', 'list', '/devices/Workstation/Documents');
    const file = items.find((i: { type: string }) => i.type === 'file');
    expect(file.name).toEqual({ ok: true, value: 'a.txt' });
    expect(file.activeRevision.claimedDigests.sha1).toMatch(/^[0-9a-f]{40}$/);
    const folder = items.find((i: { type: string }) => i.type === 'folder');
    const viaUid = json(env, 'fs', 'list', `/devices/Workstation/${folder.uid}`);
    expect(viaUid[0].name.value).toBe('Kündigung "Müller".docx');
  });

  it('reproduces the duplicate-revision trap: no digest => create-new-revision uploads identical content again', () => {
    const { env, local } = mockAccount(tmp(), 'alex', { noDigest: true });
    const r1 = json(
      env,
      'fs',
      'upload',
      '-f',
      'create-new-revision',
      path.join(local, 'a.txt'),
      '/devices/Workstation/Documents',
    );
    expect(r1.transferredItems).toBe(1); // identical content, but remote had no sha1 -> new revision (31 GB lesson)
    const r2 = json(
      env,
      'fs',
      'upload',
      '-f',
      'create-new-revision',
      path.join(local, 'a.txt'),
      '/devices/Workstation/Documents',
    );
    expect(r2.skippedItems).toBe(1); // now the CLI-written sha1 exists -> skipped
    const info = json(env, 'fs', 'info', '/devices/Workstation/Documents/a.txt');
    expect(info.totalStorageSize).toBeGreaterThan(info.activeRevision.storageSize);
  });

  it('fails instead of prompting on conflicts in JSON mode', () => {
    const { env, local } = mockAccount(tmp(), 'alex', { noDigest: true });
    const r = run(env, 'fs', 'upload', '-j', path.join(local, 'a.txt'), '/devices/Workstation/Documents');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('item(s) failed to upload');
    expect(JSON.parse(r.stdout).failures[0].error).toContain('Name conflict');
  });

  it('REPL: prompt-delimited output, recoverable errors on stderr', () => {
    const { env } = mockAccount(tmp());
    const r = spawnSync(MOCK_BIN, [], { env, input: 'fs list -j /\nfs info -j /nope\nexit\n', encoding: 'utf8' });
    expect(r.stdout.startsWith('proton-drive> [')).toBe(true);
    expect(r.stdout.split('proton-drive> ').length).toBe(4);
    expect(r.stderr).toContain('Path "/nope" not supported');
    expect(r.status).toBe(2);
  });

  it('requires login: missing session -> "You need to login first"', () => {
    const d = tmp();
    const { env, secrets } = mockAccount(d);
    writeFileSync(path.join(secrets, 'alex.json'), '');
    const r = run({ ...env, NUCLEON_SYNC_ACCOUNT: 'nobody' }, 'fs', 'list', '-j', '/my-files');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('You need to login first');
  });
});
