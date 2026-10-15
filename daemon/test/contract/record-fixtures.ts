// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Manual recorder for CLI contract fixtures (NEVER run by tests). Read-only commands only:
 *   NUCLEON_SYNC_RECORD_FIXTURES=1 node daemon/test/contract/record-fixtures.ts <remote folder> <remote file>
 * Uses the plain CLI (~/.local/bin/proton-drive or NUCLEON_SYNC_CLI) one command at a time with INFO logging.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

if (process.env.NUCLEON_SYNC_RECORD_FIXTURES !== '1') {
  console.error('refusing: set NUCLEON_SYNC_RECORD_FIXTURES=1 (read-only calls against the REAL account)');
  process.exit(2);
}
const [folder, file] = process.argv.slice(2);
if (!folder || !file) throw new Error('usage: record-fixtures.ts <remote folder> <remote file>');
const cli = process.env.NUCLEON_SYNC_CLI ?? path.join(homedir(), '.local/bin/proton-drive');
const env = { ...process.env, PROTON_DRIVE_LOG_LEVEL: 'INFO', BROWSER: 'true' };
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const run = (args: string[]) => execFileSync(cli, args, { env, encoding: 'utf8' });
writeFileSync(path.join(out, 'list-folder.json'), run(['filesystem', 'list', '-j', folder]));
writeFileSync(path.join(out, 'list-devices.json'), run(['filesystem', 'list', '-j', '/devices']));
writeFileSync(path.join(out, 'info-file.json'), run(['filesystem', 'info', '-j', file]));
writeFileSync(path.join(out, 'size.json'), run(['filesystem', 'size', '-j', folder]));
console.log('recorded into', out, '- update README.md provenance');
