// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHIM_DIR, tmp } from '../../daemon/test/helpers.ts';

const PASS = path.join(SHIM_DIR, 'pass');
const ENTRY = 'ch.proton.drive/drive-sdk-cli/auth-session';

function shim(dir: string, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(PASS, args, {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      NUCLEON_SYNC_ACCOUNT: 'sam',
      NUCLEON_SYNC_SECRET_BACKEND: 'file',
      NUCLEON_SYNC_SECRET_FILE_DIR: dir,
      NUCLEON_SYNC_SHIM_EVENTS: path.join(dir, 'ev.jsonl'),
      ...extra,
    },
  });
}

describe('secret-shim (pass compatible)', () => {
  it('reports a missing entry exactly like pass', () => {
    const r = shim(tmp(), ['show', ENTRY]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not in the password store');
  });

  it('insert/show roundtrip, per account isolation', () => {
    const d = tmp();
    expect(shim(d, ['insert', '-f', '-m', ENTRY], '{"s":1}').status).toBe(0);
    expect(shim(d, ['show', ENTRY]).stdout).toBe('{"s":1}');
    expect(shim(d, ['show', ENTRY], undefined, { NUCLEON_SYNC_ACCOUNT: 'alex' }).status).toBe(1);
  });

  it('suppresses rm (CLI signOut after lost refresh race) unless logout is explicit', () => {
    const d = tmp();
    shim(d, ['insert', '-f', '-m', ENTRY], '{"s":1}');
    expect(shim(d, ['rm', '-f', ENTRY]).status).toBe(0);
    expect(existsSync(path.join(d, 'sam.json'))).toBe(true);
    expect(readFileSync(path.join(d, 'ev.jsonl'), 'utf8')).toContain('"suppressed"');
    shim(d, ['rm', '-f', ENTRY], undefined, { NUCLEON_SYNC_ALLOW_LOGOUT: '1' });
    expect(existsSync(path.join(d, 'sam.json'))).toBe(false);
  });

  it('never writes secrets into the events file', () => {
    const d = tmp();
    shim(d, ['insert', '-f', '-m', ENTRY], '{"refreshToken":"SECRET123"}');
    shim(d, ['show', ENTRY]);
    expect(readFileSync(path.join(d, 'ev.jsonl'), 'utf8')).not.toContain('SECRET123');
  });
});
