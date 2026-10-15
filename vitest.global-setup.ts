// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** One temp root per test run (all mock remotes, caches, secrets), removed afterwards unless KEEP_TEST_TMP=1. */
/** PATH without directories that hold a real `proton-drive`: tests must never find (and run) the real CLI. */
export function pathWithoutProtonDrive(p = process.env.PATH ?? ''): string {
  return p
    .split(':')
    .filter((d) => d && !existsSync(path.join(d, 'proton-drive')))
    .join(':');
}

export default function setup(): () => void {
  process.env.PATH = pathWithoutProtonDrive();
  const dir = mkdtempSync(path.join(tmpdir(), 'nucleon-sync-tests-'));
  process.env.NUCLEON_SYNC_TEST_TMP = dir;
  return () => {
    if (!process.env.KEEP_TEST_TMP) rmSync(dir, { recursive: true, force: true });
  };
}
