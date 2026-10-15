// SPDX-License-Identifier: GPL-3.0-or-later
import type { SelectionRule, SettingsDto } from './api.ts';

/**
 * Built-in paths that may never be part of any pair: none. Users add their own with daemon.json `protectedPaths`
 * (e.g. a backup disk); the daemon refuses pairs that overlap them and the rule matcher never syncs them.
 */
export const HARD_EXCLUDED_LOCAL_PATHS: readonly string[] = [];

/**
 * proton-drive CLI versions (major.minor) whose output shapes this release was tested against
 * (daemon/test/contract). Other versions put the daemon into read-only mode until they are tested.
 */
export const TESTED_CLI_MINORS = ['0.9'];

/**
 * SHA-512 of the official CLI builds this release was tested with, per Proton manifest platform. The setup wizard
 * downloads the CLI from proton.me and checks it against Proton's release manifest AND, for these versions, against
 * this table (the manifest is served from the same origin as the binary, so on its own it only proves integrity).
 */
export const PINNED_CLI_SHA512: Record<string, Record<string, string>> = {
  '0.9.0': {
    'linux/x64':
      '3533025ba69ae112b64e3e01fbcc1ad0688136a4043f6cf6a72886967d85fdcd9ec235479c2e113171614be5225bfba93427509a05ca5aa6071d924fa7e91ca8',
    'linux/arm64':
      'c8d5a6b174e57f06d05cb5483400b9963faf58e743b6b33706bb73ecff718047ffce6b439994255b94b5b226b90d2e91bef7418ec96c1c3f5d8bf39b6cd01321',
    'linux/x64-musl':
      '8f99c3bc478ebc2948ca69c8576a48d83b3290d807ca61fac9b0f5d0a91c0d418e595232d67e2ae0173d2188963771afd4292aefafab3f64e808a61c4399d6ed',
    'linux/arm64-musl':
      '4b632e5e694f6d0825aaa57f39f99494aa6a46eac45e90d65daa10b2e46316046b627d3c1145cb9c7d58951735cc6e81c28cca44dda648b411315a28d04b2acf',
  },
};

/** Names never synced (temp/lock/OS junk). Matched against the file/folder name. */
export const JUNK_GLOBS = [
  'desktop.ini',
  'Thumbs.db',
  '.DS_Store',
  '~$*',
  '.~lock.*',
  '.goutputstream*',
  '*.tmp',
  '*.part',
  '*.crdownload',
  '*.swp',
  '.Trash-*',
  '.nucleon-sync-*',
];

/**
 * Recreatable dev/cache trees (virtualenvs, package caches, build caches) that can be large and are easy to rebuild.
 * Default-excluded, visible and toggleable in the UI. `.git` is NOT excluded by default (unpushed repos would be lost).
 */
export const DEV_CACHE_GLOBS = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  'dist-packages',
  '.gradle',
  '.dart_tool',
  '.pnpm-store',
  '.next',
  '.mypy_cache',
  '.pytest_cache',
];

export function defaultGlobalExcludes(): SelectionRule[] {
  return [...JUNK_GLOBS, ...DEV_CACHE_GLOBS].map((pattern) => ({
    kind: 'exclude',
    patternType: 'glob',
    pattern,
    source: 'default',
  }));
}

export const DEFAULT_SETTINGS: SettingsDto = {
  schedule: {
    incrementalEveryMinutes: 360,
    fullWeekly: { weekday: 0, hour: 3 },
    fullEveryWeeks: 4,
    runOnStartupDelayMinutes: 5,
  },
  transfer: {
    maxWorkersTotal: 3,
    maxWorkersPerAccount: 2,
    bandwidthLimitKBps: null,
    quietHours: null,
    thumbnails: true,
    maxFileBytes: null,
  },
  notifications: {
    desktop: true,
    minIntervalMinutes: 360,
  },
  storagePoolBytes: null,
  globalExcludes: defaultGlobalExcludes(),
};
