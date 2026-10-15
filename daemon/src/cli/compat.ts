// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CLI version check (ARCHITECTURE §5.7). The engine relies on undocumented output shapes of proton-drive 0.9.x
 * (list/info JSON, transfer summaries, error texts). An unknown major/minor puts the daemon into read-only mode
 * until the contract tests (daemon/test/contract) have been re-run against the new version.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

import { TESTED_CLI_MINORS } from '@nucleon-sync/shared';

/** Known-good version prefixes (major.minor). */
export const KNOWN_GOOD = TESTED_CLI_MINORS;

export interface CliVersionInfo {
  cliVersion: string | null;
  sdkVersion: string | null;
  /** hint printed by the CLI when a newer release exists (shown in the UI, never auto-updated) */
  updateHint: string | null;
  compatible: boolean;
  raw: string;
}

export function parseVersionOutput(text: string): CliVersionInfo {
  // real 0.9.0 output (2026-10-11): "Proton Drive CLI cli-drive@0.9.0+75612299" / "Proton Drive SDK js@0.22.2+75612299"
  const cli = /Proton Drive CLI\s+(?:[\w.-]+@)?v?(\d+\.\d+\.\d+[^\s]*)/i.exec(text)?.[1] ?? null;
  const sdk = /Proton Drive SDK\s+(?:[\w.-]+@)?v?(\d+\.\d+\.\d+[^\s]*)/i.exec(text)?.[1] ?? null;
  const hint = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /new(er)? (version|release)|update available/i.test(l));
  return { cliVersion: cli, sdkVersion: sdk, updateHint: hint ?? null, compatible: isCompatible(cli), raw: text };
}

export function isCompatible(version: string | null): boolean {
  if (!version) return false;
  const [maj, min] = version.split('.');
  return KNOWN_GOOD.includes(`${maj}.${min}`);
}

/** Runs `<cli> --version` once (one-shot; also fetches Proton's version.json in the real CLI). */
export function checkCliVersion(cliPath: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CliVersionInfo> {
  return new Promise((resolve) => {
    execFile(cliPath, ['--version'], { env, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`;
      const info = parseVersionOutput(text);
      if (err && !info.cliVersion) resolve({ ...info, compatible: false, raw: `${text}\n${err.message}` });
      else resolve(info);
    });
  });
}

/** Fingerprint of the binary (mtime+size); the engine re-checks the version when it changes. */
export function binaryFingerprint(cliPath: string): string | null {
  try {
    const s = statSync(cliPath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}
