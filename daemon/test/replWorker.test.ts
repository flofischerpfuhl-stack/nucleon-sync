// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliError, quoteArg, ReplWorker } from '../src/cli/replWorker.ts';
import { classifyCliError } from '../src/cli/classify.ts';
import { MOCK_BIN, mockAccount, seed, tmp } from './helpers.ts';

describe('quoteArg', () => {
  it('quotes for the CLI REPL parser', () => {
    expect(quoteArg('/my-files/a')).toBe('/my-files/a');
    expect(quoteArg('Kündigung "Müller".docx')).toBe('"Kündigung \\"Müller\\".docx"');
    expect(quoteArg('a\\b c')).toBe('"a\\\\b c"');
    expect(() => quoteArg('a\nb')).toThrow(CliError);
  });
});

describe('classifyCliError', () => {
  it('maps known CLI messages', () => {
    expect(classifyCliError('You need to login first')).toBe('auth');
    expect(classifyCliError('TypeError: fetch failed')).toBe('transient');
    expect(classifyCliError('Path "/x" not supported')).toBe('not_found');
    expect(classifyCliError('Name conflict on "a" (file) already exists')).toBe('conflict');
    expect(classifyCliError('something new')).toBe('fatal');
  });
});

describe('ReplWorker against mock-proton-drive', () => {
  it('runs JSON commands, handles quoting and recoverable errors without dying', async () => {
    const { env } = mockAccount(tmp());
    const w = new ReplWorker({ cliPath: MOCK_BIN, env, name: 't/w0' });
    const list = await w.json<{ name: { value: string } }[]>([
      'filesystem',
      'list',
      '/devices/Workstation/Documents/Ordner mit Leerzeichen',
    ]);
    expect(list[0]!.name.value).toBe('Kündigung "Müller".docx');
    await expect(w.json(['filesystem', 'info', '/nope'])).rejects.toMatchObject({ errorClass: 'not_found' });
    expect(w.alive).toBe(true);
    const again = await w.json<unknown[]>(['filesystem', 'list', '/']);
    expect(again.length).toBeGreaterThan(3);
    await w.stop();
  });

  it('reports a crash and can be restarted', async () => {
    const { env } = mockAccount(tmp());
    const w = new ReplWorker({ cliPath: MOCK_BIN, env, name: 't/w0' });
    await w.start();
    w.kill();
    await new Promise((r) => w.once('exit', r));
    expect(w.alive).toBe(false);
    expect((await w.json<unknown[]>(['filesystem', 'list', '/'])).length).toBeGreaterThan(0); // auto restart
    await w.stop();
  });

  it('survives the refresh-token race between two workers of one account (shim suppresses signOut)', async () => {
    const d = tmp();
    const { env, remote, secrets } = mockAccount(d);
    const a = new ReplWorker({
      cliPath: MOCK_BIN,
      env: { ...env, PROTON_DRIVE_CACHE_DIR: path.join(d, 'w0') },
      name: 'alex/w0',
    });
    const b = new ReplWorker({
      cliPath: MOCK_BIN,
      env: { ...env, PROTON_DRIVE_CACHE_DIR: path.join(d, 'w1') },
      name: 'alex/w1',
    });
    await Promise.all([a.start(), b.start()]); // both loaded the same session at init
    seed(remote, '--expire-access'); // access token expires for everybody
    await a.json(['filesystem', 'list', '/my-files']); // a refreshes, rotates refresh token, saves via shim
    await expect(b.json(['filesystem', 'list', '/my-files'])).rejects.toMatchObject({ errorClass: 'auth' }); // b lost the race
    expect(readFileSync(path.join(secrets, 'alex.json'), 'utf8')).toContain('refreshToken'); // NOT wiped
    expect(readFileSync(path.join(d, 'shim-events.jsonl'), 'utf8')).toContain('"suppressed"');
    b.kill(); // daemon policy: restart the worker on 'auth' -> reloads the fresh session
    await new Promise((r) => b.once('exit', r));
    await expect(b.json(['filesystem', 'list', '/my-files'])).resolves.toBeDefined();
    await Promise.all([a.stop(), b.stop()]);
  });
});
