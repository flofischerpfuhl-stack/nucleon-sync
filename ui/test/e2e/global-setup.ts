// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build main/preload/renderer once before the e2e run. */
export default function globalSetup(): void {
  const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  execFileSync(process.execPath, ['build.mjs'], { cwd: ui, stdio: 'ignore' });
}
