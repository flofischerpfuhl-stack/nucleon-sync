// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * RemoteOps — the ONLY module that builds `proton-drive` command lines.
 * Typed wrappers with uid addressing (`<section>/<uid>`, ARCHITECTURE §5.1 "UID path segments"), strict output
 * parsing into RemoteNode, and a write guard that refuses every mutating command unless writes are allowed.
 */
import { copyFileSync, constants as fsConstants, linkSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ErrorClass } from '@nucleon-sync/shared';

import { CliError } from '../cli/replWorker.ts';
import type { CliPool, PoolWorker } from '../cli/pool.ts';
import { TransferMonitor, type ProgressSample } from '../cli/progress.ts';
import { globUnsafe, isThumbnailFailure, needsSkipThumbnails, tempRemoteName, withNames } from '../cli/quirks.ts';
import { log } from '../util/log.ts';

export type RemoteRef = { section: string; uid: string } | { path: string };

export interface RemoteRevision {
  uid: string;
  size: number | null; // claimedSize
  mtimeMs: number | null; // claimedModificationTime
  sha1: string | null; // claimedDigests.sha1 (null = old Windows upload)
  storageSize: number | null;
  creationTimeMs: number | null;
}

export interface RemoteNode {
  uid: string;
  parentUid: string | null;
  /** NFC-normalised decrypted name; null when the CLI could not decrypt it (name.ok=false) */
  name: string | null;
  type: 'file' | 'folder' | 'other';
  mediaType: string | null;
  creationTimeMs: number | null;
  modificationTimeMs: number | null;
  trashed: boolean;
  totalStorageSize: number | null;
  rev: RemoteRevision | null;
  /** Proton Docs/Sheets: the CLI skips them on download -> 'unsupported' */
  isProtonDoc: boolean;
}

export interface RemoteDevice {
  uid: string;
  name: string | null;
  type: string | null;
  rootFolderUid: string;
}

export interface TransferSummary {
  transferredItems: number;
  transferredBytes: number;
  skippedItems: number;
  failedItems: number;
  failures: { name: string; nodeUid?: string; error: string }[];
}

export type UploadStrategy = 'skip' | 'create-new-revision' | 'replace';

export class WriteBlockedError extends CliError {
  constructor(reason: string) {
    super(`write blocked: ${reason}`, 'fatal');
  }
}

export class RemoteParseError extends CliError {
  constructor(what: string, sample: unknown) {
    super(`unexpected CLI output for ${what}: ${JSON.stringify(sample)?.slice(0, 200)}`, 'fatal');
  }
}

const PROTON_DOC_TYPES = new Set([
  'application/vnd.proton.doc',
  'application/vnd.proton.sheet',
  'application/vnd.proton.docs',
]);

/** Escape one name for use as a CLI path segment (`/` and `\` are escaped with a backslash). */
export function escapeSegment(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\//g, '\\/');
}

export function refToCli(ref: RemoteRef): string {
  if ('path' in ref) return ref.path;
  return `${ref.section.replace(/\/+$/, '')}/${ref.uid}`;
}

function ms(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Strict parser for one node of `filesystem list -j` / `info -j` (CLI 0.9.0 shape, ARCHITECTURE §5.1). */
export function parseNode(raw: unknown): RemoteNode {
  if (!raw || typeof raw !== 'object') throw new RemoteParseError('node', raw);
  const o = raw as Record<string, unknown>;
  if (typeof o.uid !== 'string' || !o.uid) throw new RemoteParseError('node.uid', raw);
  const nameObj = o.name as { ok?: boolean; value?: unknown } | string | undefined;
  let name: string | null = null;
  if (typeof nameObj === 'string') name = nameObj;
  else if (nameObj && nameObj.ok !== false && typeof nameObj.value === 'string') name = nameObj.value;
  if (name !== null) name = name.normalize('NFC');
  const type = o.type === 'file' || o.type === 'folder' ? o.type : 'other';
  const ar = o.activeRevision as Record<string, unknown> | undefined;
  let rev: RemoteRevision | null = null;
  if (ar && typeof ar === 'object') {
    if (typeof ar.uid !== 'string') throw new RemoteParseError('activeRevision.uid', raw);
    const digests = (ar.claimedDigests ?? {}) as Record<string, unknown>;
    const sha1 = typeof digests.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(digests.sha1) ? digests.sha1 : null;
    rev = {
      uid: ar.uid,
      size: num(ar.claimedSize),
      mtimeMs: ms(ar.claimedModificationTime),
      sha1: sha1 ? sha1.toLowerCase() : null,
      storageSize: num(ar.storageSize),
      creationTimeMs: ms(ar.creationTime),
    };
  }
  if (type === 'file' && !rev) throw new RemoteParseError('file without activeRevision', raw);
  const mediaType = typeof o.mediaType === 'string' ? o.mediaType : null;
  return {
    uid: o.uid,
    parentUid: typeof o.parentUid === 'string' ? o.parentUid : null,
    name,
    type,
    mediaType,
    creationTimeMs: ms(o.creationTime),
    modificationTimeMs: ms(o.modificationTime),
    trashed: !!o.trashTime,
    totalStorageSize: num(o.totalStorageSize),
    rev,
    isProtonDoc: mediaType !== null && PROTON_DOC_TYPES.has(mediaType),
  };
}

export function parseNodeList(raw: unknown): RemoteNode[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RemoteParseError('list (expected array)', raw);
  return raw.map(parseNode);
}

export function parseDevices(raw: unknown): RemoteDevice[] {
  if (!Array.isArray(raw)) throw new RemoteParseError('devices', raw);
  return raw.map((d) => {
    const o = d as Record<string, unknown>;
    if (typeof o.uid !== 'string' || typeof o.rootFolderUid !== 'string') throw new RemoteParseError('device', d);
    const n = o.name as { ok?: boolean; value?: string } | undefined;
    return {
      uid: o.uid,
      name: n && n.ok !== false && typeof n.value === 'string' ? n.value.normalize('NFC') : null,
      type: typeof o.type === 'string' ? o.type : null,
      rootFolderUid: o.rootFolderUid,
    };
  });
}

export function parseTransferSummary(text: string): TransferSummary | null {
  const t = text.trim();
  if (!t) return null;
  // the summary is the last JSON object on stdout (single-line or pretty-printed, possibly after progress output)
  let o: Record<string, unknown> | null = null;
  for (let i = t.lastIndexOf('{'); i >= 0 && !o; i = t.lastIndexOf('{', i - 1)) {
    try {
      const v = JSON.parse(t.slice(i)) as unknown;
      if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).transferredItems === 'number')
        o = v as Record<string, unknown>;
    } catch {
      /* not the start of the summary */
    }
  }
  if (!o) return null;
  return {
    transferredItems: o.transferredItems as number,
    transferredBytes: num(o.transferredBytes) ?? 0,
    skippedItems: num(o.skippedItems) ?? 0,
    failedItems: num(o.failedItems) ?? 0,
    failures: Array.isArray(o.failures)
      ? (o.failures as Record<string, unknown>[]).map((f) => ({
          name: String(f.name ?? ''),
          ...(typeof f.nodeUid === 'string' ? { nodeUid: f.nodeUid } : {}),
          error: String(f.error ?? ''),
        }))
      : [],
  };
}

/**
 * Per-command timeouts (ARCHITECTURE §5.3): a hung server call must never stall a run. On timeout the worker is
 * killed (cli_timeout), the job goes to retry_wait with backoff.
 */
export interface CliTimeouts {
  listMs: number;
  infoMs: number;
  sizeMs: number;
  probeMs: number;
  /** create-folder, move, rename, trash */
  mutateMs: number;
  emptyTrashMs: number;
  /** transfers: base + bytes / minBytesPerSec */
  transferBaseMs: number;
  minBytesPerSec: number;
}

export const DEFAULT_CLI_TIMEOUTS: CliTimeouts = {
  listMs: 120_000,
  infoMs: 60_000,
  sizeMs: 120_000,
  probeMs: 60_000,
  mutateMs: 120_000,
  emptyTrashMs: 10 * 60_000,
  transferBaseMs: 120_000,
  minBytesPerSec: 1024 * 1024,
};

export function transferTimeoutMs(bytes: number, t: CliTimeouts = DEFAULT_CLI_TIMEOUTS): number {
  return t.transferBaseMs + Math.ceil((Math.max(0, bytes) / Math.max(1, t.minBytesPerSec)) * 1000);
}

export interface RemoteOpsOptions {
  pool: CliPool;
  /** returns a reason string when writes are not allowed right now (write guard), else null */
  writeGuard: () => string | null;
  skipThumbnails?: () => boolean;
  /** per-command timeouts (defaults: DEFAULT_CLI_TIMEOUTS) */
  timeouts?: Partial<CliTimeouts>;
  /** @deprecated use timeouts.listMs */
  listTimeoutMs?: number;
  /** directory on the same filesystem as the pair roots for glob-safe hard links (upload quirk 1) */
  tempDir?: () => string;
  /** expected throughput for progress estimates (bytes/s) */
  expectedBps?: (kind: 'upload' | 'download') => number;
}

export interface TransferResult {
  summary: TransferSummary;
  /** CLI error raised together with a summary (e.g. "1 item(s) failed to upload") */
  error: CliError | null;
}

export interface TransferOptions {
  onProgress?: (p: ProgressSample) => void;
  /** download: staging dir (progress = bytes written there) */
  stagingDir?: string;
}

const emptySummary = (): TransferSummary => ({
  transferredItems: 0,
  transferredBytes: 0,
  skippedItems: 0,
  failedItems: 0,
  failures: [],
});

function mergeSummary(a: TransferSummary, b: TransferSummary): TransferSummary {
  return {
    transferredItems: a.transferredItems + b.transferredItems,
    transferredBytes: a.transferredBytes + b.transferredBytes,
    skippedItems: a.skippedItems + b.skippedItems,
    failedItems: a.failedItems + b.failedItems,
    failures: [...a.failures, ...b.failures],
  };
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export class RemoteOps {
  private readonly o: RemoteOpsOptions;
  readonly timeouts: CliTimeouts;
  constructor(o: RemoteOpsOptions) {
    this.o = o;
    this.timeouts = {
      ...DEFAULT_CLI_TIMEOUTS,
      ...(o.listTimeoutMs ? { listMs: o.listTimeoutMs } : {}),
      ...(o.timeouts ?? {}),
    };
  }

  private read<T>(fn: (w: PoolWorker) => Promise<T>, priority = 50): Promise<T> {
    return this.o.pool.withWorker(fn, { priority });
  }

  private write<T>(fn: (w: PoolWorker) => Promise<T>, priority = 100): Promise<T> {
    const blocked = this.o.writeGuard();
    if (blocked) return Promise.reject(new WriteBlockedError(blocked));
    return this.o.pool.withWorker(fn, { priority });
  }

  async list(folder: RemoteRef): Promise<RemoteNode[]> {
    const t = this.timeouts.listMs;
    return parseNodeList(await this.read((w) => w.json(['filesystem', 'list', refToCli(folder)], t)));
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const t = this.timeouts.listMs;
    return parseDevices(await this.read((w) => w.json(['filesystem', 'list', '/devices'], t)));
  }

  /** Cheap liveness probe (offline detection). */
  async probe(): Promise<void> {
    const t = this.timeouts.probeMs;
    await this.read((w) => w.json(['filesystem', 'list', '/'], t), 10);
  }

  async info(node: RemoteRef): Promise<RemoteNode> {
    const t = this.timeouts.infoMs;
    return parseNode(await this.read((w) => w.json(['filesystem', 'info', refToCli(node)], t)));
  }

  async size(node: RemoteRef): Promise<{ size: number; numberOfDescendants: number }> {
    const t = this.timeouts.sizeMs;
    const r = await this.read((w) => w.json<Record<string, unknown>>(['filesystem', 'size', refToCli(node)], t));
    if (!r || typeof r.size !== 'number') throw new RemoteParseError('size', r);
    return { size: r.size, numberOfDescendants: num(r.numberOfDescendants) ?? 0 };
  }

  /** create-folder; returns the new (or already existing) folder node found by listing the parent. */
  async mkdir(parent: RemoteRef, name: string): Promise<RemoteNode> {
    const t = this.timeouts.mutateMs;
    try {
      await this.write((w) => w.run(withNames(['filesystem', 'create-folder'], [refToCli(parent)], [name]), t), 20);
    } catch (e) {
      if (!(e instanceof CliError) || e.errorClass !== 'conflict') throw e;
      // already exists (e.g. crash after create) -> adopt it below
    }
    const found = (await this.list(parent)).find((n) => n.type === 'folder' && n.name === name.normalize('NFC'));
    if (!found) throw new CliError(`folder "${name}" not found after create-folder`, 'transient');
    return found;
  }

  /**
   * Upload local files into one remote folder. Handles the CLI quirks centrally (see cli/quirks.ts): glob characters
   * in the local path (hard link into a clean temp dir, temporary remote name + rename when the name itself is
   * affected), `--skip-thumbnails` for TIFF/RAW/>100 MB (and a retry with it after a thumbnail failure).
   */
  async upload(
    files: string[],
    parent: RemoteRef,
    strategy: UploadStrategy,
    expectedBytes = 0,
    opts: TransferOptions = {},
  ): Promise<TransferResult> {
    const globalSkip = !!this.o.skipThumbnails?.();
    const sized = files.map((f) => ({ path: f, size: fileSize(f) }));
    const plain = sized.filter((f) => !globUnsafe(f.path));
    const special = sized.filter((f) => globUnsafe(f.path));
    const groups: { files: typeof sized; skipThumbs: boolean }[] = [];
    const withThumbs = plain.filter((f) => !globalSkip && !needsSkipThumbnails(f.path, f.size));
    const noThumbs = plain.filter((f) => globalSkip || needsSkipThumbnails(f.path, f.size));
    if (withThumbs.length) groups.push({ files: withThumbs, skipThumbs: false });
    if (noThumbs.length) groups.push({ files: noThumbs, skipThumbs: true });
    const total = Math.max(
      expectedBytes,
      sized.reduce((s, f) => s + f.size, 0),
    );
    let doneBefore = 0;
    const progress = (base: number) =>
      opts.onProgress
        ? (p: ProgressSample) => opts.onProgress!({ ...p, bytesDone: base + p.bytesDone, bytesTotal: total })
        : undefined;
    let summary = emptySummary();
    let error: CliError | null = null;
    for (const g of groups) {
      const bytes = g.files.reduce((s, f) => s + f.size, 0);
      const r = await this.uploadCmd(g.files, parent, strategy, g.skipThumbs, progress(doneBefore));
      doneBefore += bytes;
      // thumbnail generation failed for some files: once more for those, without thumbnails
      const thumbFailed = g.skipThumbs ? [] : r.summary.failures.filter((f) => isThumbnailFailure(f.error));
      if (thumbFailed.length) {
        const again = g.files.filter((f) => thumbFailed.some((x) => x.name === path.basename(f.path)));
        log('info', 'upload: thumbnail failure, retrying with --skip-thumbnails', { files: again.length });
        const r2 = await this.uploadCmd(again, parent, strategy, true);
        r.summary.failures = r.summary.failures.filter((f) => !thumbFailed.includes(f));
        r.summary.failedItems -= thumbFailed.length;
        r.summary = mergeSummary(r.summary, r2.summary);
        if (!r.summary.failures.length) r.error = r2.error;
      }
      summary = mergeSummary(summary, r.summary);
      error ??= r.error;
    }
    // only a folder name has glob characters: all such files go through ONE temp dir (hard links keep their names)
    // and one command per thumbnail group, like plain files
    const dirOnly = special.filter((f) => !globUnsafe(path.basename(f.path)));
    if (dirOnly.length) {
      const linked = this.linkIntoTemp(dirOnly);
      try {
        for (const skip of [false, true]) {
          const g = linked.files.filter((f) => (globalSkip || needsSkipThumbnails(f.path, f.size)) === skip);
          if (!g.length) continue;
          const r = await this.uploadCmd(g, parent, strategy, skip, progress(doneBefore));
          doneBefore += g.reduce((n, f) => n + f.size, 0);
          summary = mergeSummary(summary, r.summary);
          error ??= r.error;
        }
      } finally {
        rmSync(linked.dir, { recursive: true, force: true });
      }
    }
    for (const f of special.filter((x) => globUnsafe(path.basename(x.path)))) {
      const r = await this.uploadViaTemp(f, parent, strategy, globalSkip, progress(doneBefore));
      doneBefore += f.size;
      summary = mergeSummary(summary, r.summary);
      error ??= r.error;
    }
    return { summary, error };
  }

  /** One `filesystem upload` command (files must be glob-safe). */
  private uploadCmd(
    files: { path: string; size: number }[],
    parent: RemoteRef,
    strategy: UploadStrategy,
    skipThumbs: boolean,
    onProgress?: (p: ProgressSample) => void,
  ): Promise<TransferResult> {
    const args = ['filesystem', 'upload', '-j', '-f', strategy, '-d', 'skip'];
    if (skipThumbs) args.push('--skip-thumbnails');
    args.push(...files.map((f) => f.path), refToCli(parent));
    const bytes = files.reduce((s, f) => s + f.size, 0);
    return this.transfer(args, bytes, 'upload', { onProgress }, files);
  }

  /**
   * Quirk 1: a local path with glob characters. The file is hard-linked (copy as fallback) into a fresh temp dir. If
   * only a folder name is affected the link keeps the real name. If the file name itself is affected, the upload uses
   * a temporary remote name and the node is renamed afterwards; the conflict strategy is emulated by name (skip: an
   * existing node is left alone; revision/replace: the existing node is renamed to the temporary name first, so the
   * upload adds a revision to / replaces exactly that node, then it gets its real name back).
   */
  /** Hard links (reflink/copy fallback) of files into a fresh, glob-safe temp dir; names are kept. */
  private linkIntoTemp(files: { path: string; size: number }[], name?: (f: { path: string }) => string) {
    const blocked = this.o.writeGuard();
    if (blocked) throw new WriteBlockedError(blocked);
    if (!this.o.tempDir)
      throw new CliError(`local path contains glob characters and no temp dir is set: ${files[0]?.path}`, 'local_io');
    const base = this.o.tempDir();
    if (globUnsafe(base)) throw new CliError(`temp dir ${base} itself contains glob characters`, 'local_io');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'upload-'));
    const out: { path: string; size: number }[] = [];
    for (const f of files) {
      const link = path.join(dir, name ? name(f) : path.basename(f.path));
      try {
        linkSync(f.path, link);
      } catch {
        copyFileSync(f.path, link, fsConstants.COPYFILE_FICLONE); // other filesystem / no hard links: reflink or copy
      }
      out.push({ path: link, size: f.size });
    }
    return { dir, files: out };
  }

  private async uploadViaTemp(
    f: { path: string; size: number },
    parent: RemoteRef,
    strategy: UploadStrategy,
    globalSkip: boolean,
    onProgress?: (p: ProgressSample) => void,
  ): Promise<TransferResult> {
    const name = path.basename(f.path);
    const nameSafe = !globUnsafe(name);
    const linkName = nameSafe ? name : tempRemoteName(name);
    const { dir, files: linkedFiles } = this.linkIntoTemp([f], () => linkName);
    const link = linkedFiles[0]!.path;
    try {
      const skipThumbs = globalSkip || needsSkipThumbnails(f.path, f.size);
      const one = [{ path: link, size: f.size }];
      if (nameSafe) return await this.uploadCmd(one, parent, strategy, skipThumbs, onProgress);

      const listing = await this.list(parent);
      const byName = (n: string) => listing.find((x) => x.type === 'file' && x.name === n.normalize('NFC'));
      const existing = byName(name);
      const leftover = byName(linkName); // an earlier attempt was interrupted after the upload
      if (strategy === 'skip' && existing) {
        return { summary: { ...emptySummary(), skippedItems: 1 }, error: null };
      }
      let strat: UploadStrategy = strategy;
      if (leftover) strat = 'create-new-revision';
      else if (existing && strategy !== 'skip')
        await this.rename({ section: sectionOf(parent), uid: existing.uid }, linkName);
      const r = await this.uploadCmd(one, parent, strat, skipThumbs, onProgress);
      const after = (await this.list(parent)).find((x) => x.type === 'file' && x.name === linkName);
      if (after) await this.rename({ section: sectionOf(parent), uid: after.uid }, name);
      // failures carry the real name for the executor
      r.summary.failures = r.summary.failures.map((x) => (x.name === linkName ? { ...x, name } : x));
      return r;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async download(
    node: RemoteRef,
    localDir: string,
    expectedBytes = 0,
    opts: TransferOptions = {},
  ): Promise<TransferResult> {
    const args = ['filesystem', 'download', '-j', '-f', 'skip', '-d', 'merge', refToCli(node), localDir];
    return this.transfer(args, expectedBytes, 'download', { ...opts, stagingDir: opts.stagingDir ?? localDir });
  }

  private async transfer(
    args: string[],
    bytes: number,
    kind: 'upload' | 'download',
    opts: TransferOptions,
    files?: { path: string; size: number }[],
  ): Promise<TransferResult> {
    // size-based timeout (quirk-independent): base + bytes at the minimum assumed throughput
    const timeout = transferTimeoutMs(bytes, this.timeouts);
    const exec = async (w: PoolWorker) => {
      const mon = opts.onProgress
        ? new TransferMonitor({
            kind,
            files,
            stagingDir: opts.stagingDir,
            bytesTotal: bytes,
            expectedBps: this.o.expectedBps?.(kind) ?? 2 * 1024 * 1024,
            pid: () => w.pid ?? null,
            onProgress: opts.onProgress,
          })
        : null;
      try {
        return await w.run(args, timeout);
      } finally {
        mon?.stop();
      }
    };
    try {
      const r = await (kind === 'upload' ? this.write(exec, 60) : this.write(exec, 70));
      const summary = parseTransferSummary(r.stdout);
      if (!summary) throw new RemoteParseError(`${kind} summary`, r.stdout.slice(0, 200));
      return { summary, error: null };
    } catch (e) {
      if (e instanceof CliError && !(e instanceof WriteBlockedError)) {
        const summary = parseTransferSummary(e.stdout);
        if (summary) return { summary, error: e };
      }
      throw e;
    }
  }

  async move(nodes: RemoteRef[], newParent: RemoteRef): Promise<void> {
    const t = this.timeouts.mutateMs;
    await this.write((w) => w.run(['filesystem', 'move', '-j', ...nodes.map(refToCli), refToCli(newParent)], t), 30);
  }

  async rename(node: RemoteRef, newName: string): Promise<void> {
    const t = this.timeouts.mutateMs;
    await this.write((w) => w.run(withNames(['filesystem', 'rename'], [refToCli(node)], [newName]), t), 30);
  }

  async trash(nodes: RemoteRef[]): Promise<void> {
    if (nodes.length > 50) throw new CliError('trash: at most 50 nodes per call', 'fatal');
    const t = this.timeouts.mutateMs;
    await this.write((w) => w.run(['filesystem', 'trash', '-j', ...nodes.map(refToCli)], t), 80);
  }

  async emptyTrash(): Promise<void> {
    const t = this.timeouts.emptyTrashMs;
    await this.write((w) => w.run(['filesystem', 'empty-trash', '-j'], t), 90);
  }
}

/** Section part of a ref (`/devices/Workstation`, `/my-files`) for uid addressing of nodes found by listing. */
function sectionOf(ref: RemoteRef): string {
  if ('section' in ref) return ref.section;
  const segs = ref.path.split('/').filter(Boolean);
  return segs[0] === 'devices' ? `/devices/${segs[1] ?? ''}` : `/${segs[0] ?? ''}`;
}

export function errorClassOf(e: unknown): ErrorClass {
  return e instanceof CliError ? e.errorClass : 'fatal';
}
