// SPDX-License-Identifier: GPL-3.0-or-later
import type { ErrorClass } from '@nucleon-sync/shared';

/**
 * Maps proton-drive CLI stderr/stdout text to an ErrorClass. Patterns come from CLI 0.9.0 source
 * (cli/src/cli/errors.ts, credentials/*, transferSummary.ts) and observed messages.
 * Unknown messages are 'fatal' so they surface instead of looping.
 */
const RULES: [RegExp, ErrorClass][] = [
  [/You need to login first|Failed to refresh session|session in pass|Failed to load session/i, 'auth'],
  // Proton also throttles with "Too many server errors, please try again later" (seen 2026-10 during bulk uploads)
  [/\b429\b|Too many requests|rate.?limit|Too many server errors|try again later/i, 'rate_limited'],
  [
    /insufficient (storage |volume |device )?(quota|space)|run out of storage|quota exceeded|storage (quota|limit)/i,
    'quota',
  ],
  [/Integrity verification failed|sha1 mismatch/i, 'integrity'],
  [/Name conflict on|already exists/i, 'conflict'],
  [/not found|not supported|Device not found|does not exist/i, 'not_found'],
  // the CLI treats local paths as glob patterns: a name with [ ] * ? matches nothing (RemoteOps uploads such files
  // under a temporary name, so this only surfaces if a new special character shows up)
  [/ENOSPC|EACCES|EPERM|EROFS|Local folder does not exist|No paths matched/i, 'local_io'],
  // a name starting with "-" was parsed as an option (RemoteOps passes such names after "--")
  [/unknown option/i, 'fatal'],
  [
    /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|\b50[0-4]\b|Unable to connect/i,
    'transient',
  ],
];

export function classifyCliError(text: string): ErrorClass {
  for (const [re, cls] of RULES) if (re.test(text)) return cls;
  return 'fatal';
}

export function isRetryable(cls: ErrorClass): boolean {
  return cls === 'transient' || cls === 'rate_limited' || cls === 'auth';
}
