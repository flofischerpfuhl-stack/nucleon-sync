// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Known quirks of the proton-drive CLI 0.9.0, handled in ONE place (learned from large real-world uploads and
 * listings with the official CLI):
 *
 *  1. Local upload paths are glob patterns. A path containing `[`, `]`, `*` or `?` matches nothing ("No paths
 *     matched"); `[ ]` cannot be escaped with a backslash. `{ }` without a comma pass through unchanged and must NOT be
 *     escaped (a backslash would become part of the name). A brace pair with a comma (`{a,b}`) would expand -> treated
 *     like the other glob characters. Fix: hard-link the file into a clean temp dir; if the *name* itself is unsafe,
 *     upload it under a temporary name and rename the node remotely afterwards.
 *  2. Names starting with `-` are parsed as options ("Unknown option '-4'"): pass them after `--`.
 *  3. Thumbnail generation loads the whole image into memory (a 12.5 GB TIFF stalled the CLI) and fails for some
 *     TIFF/RAW files: `--skip-thumbnails` for TIFF/RAW/PSD/EXR and for every file > 100 MB.
 *  4. Downloads do not set the mtime (the executor sets it from claimedModificationTime).
 *  5. `--version` prints `Proton Drive CLI cli-drive@0.9.0+<hash>` (parsed in compat.ts).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Characters that make the CLI's local-path globbing match nothing (or something else). */
const GLOB_CHARS = /[[\]*?]/;
/** `{a,b}` would be brace-expanded; `{x}` without a comma is passed through literally */
const BRACE_LIST = /\{[^}]*,[^}]*\}/;

/** True if this local path cannot be passed to `filesystem upload` as is. */
export function globUnsafe(p: string): boolean {
  return GLOB_CHARS.test(p) || BRACE_LIST.test(p);
}

/** Extensions whose thumbnail generation is known to fail or to need the whole image in memory. */
export const SKIP_THUMBNAIL_EXT = new Set([
  '.tif',
  '.tiff',
  '.exr',
  '.psd',
  '.psb',
  '.arw',
  '.cr2',
  '.cr3',
  '.nef',
  '.nrw',
  '.dng',
  '.orf',
  '.raf',
  '.rw2',
  '.pef',
  '.srw',
  '.raw',
  '.heic',
  '.jp2',
]);
export const SKIP_THUMBNAIL_BYTES = 100 * 1000 * 1000;

/** `--skip-thumbnails` needed for this file? */
export function needsSkipThumbnails(file: string, size: number | null | undefined): boolean {
  return SKIP_THUMBNAIL_EXT.has(path.extname(file).toLowerCase()) || (size ?? 0) > SKIP_THUMBNAIL_BYTES;
}

/** The upload failed because of thumbnail generation -> retry the file with --skip-thumbnails. */
export function isThumbnailFailure(msg: string): boolean {
  return /thumbnail/i.test(msg);
}

/**
 * Deterministic temporary remote name for a file whose name contains glob characters. It ends in `.tmp` (a default
 * junk exclusion, so a left-over temp node is never downloaded or treated as user data) and is stable per name, so an
 * interrupted attempt is found again on retry.
 */
export function tempRemoteName(name: string): string {
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  const clean = name.replace(/[[\]*?{},]/g, '_').replace(/^-+/, '_');
  return `${clean.slice(0, 180)}.psync-${hash}.tmp`;
}

export const TEMP_REMOTE_RE = /\.psync-[0-9a-f]{8}\.tmp$/;

/**
 * Positional name arguments for create-folder / rename. Names starting with `-` go after `--` (otherwise the CLI
 * parses them as options); `-j` must therefore come before the positionals.
 */
export function withNames(cmd: string[], fixed: string[], names: string[]): string[] {
  const dash = names.some((n) => n.startsWith('-'));
  return [...cmd, '-j', ...fixed, ...(dash ? ['--'] : []), ...names];
}
