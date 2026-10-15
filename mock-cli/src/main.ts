// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * mock-proton-drive — a behavioural fake of the official `proton-drive` CLI 0.9.0 (Bun binary).
 *
 * Mirrors what nucleon-sync relies on:
 *  - single invocation (`mock-proton-drive filesystem list -j /my-files`) and REPL mode (no args, prompt
 *    "proton-drive> ", one command per line, POSIX-like quoting, recoverable errors on stderr);
 *  - JSON shapes of list/info/size and the transfer summary of upload/download;
 *  - conflict strategies incl. "skip identical content only if the remote has a claimed sha1";
 *  - UID path segments (<section>/<uid>) and `\/` escaping;
 *  - credential stores (keychain|pass|unsafe_file) and the refresh-token race -> signOut -> store.remove().
 *
 * Fault injection (env):
 *  MOCK_PROTON_REMOTE   required: backend dir (one per account), create with mock-proton-drive-seed
 *  MOCK_LATENCY_MS      base latency per command (default 0)
 *  MOCK_FAIL_RATE       0..1 probability of a transient "fetch failed" error
 *  MOCK_OFFLINE_FILE    if this file exists every command fails with a network error
 *  MOCK_TARPIT_RPM      commands/minute (all processes of this remote) above which latency jumps
 *  MOCK_TARPIT_LATENCY_MS latency while tarpitted (default 1700)
 *  MOCK_LOGIN_AUTO_APPROVE_MS  `auth login` completes after this delay (default: wait for <remote>/approve-login)
 *  MOCK_CORRUPT_DOWNLOAD=1    downloads write one extra byte (a CLI that did not detect corruption) -> engine must verify
 *  MOCK_COMMAND_LOG     append one JSON line per command ({ts,pid,cmd,args,ok,error?}) for test assertions/counters
 *  MOCK_MODIFY_DURING_UPLOAD  substring of a file name: after the upload has read such a file, append bytes to the
 *                       local file (simulates "file modified while uploading")
 *  MOCK_CLI_VERSION     version printed by --version (default 0.9.0)
 *  MOCK_TRANSFER_BPS    throttle uploads/downloads to this many bytes/s (file stays open -> /proc fd progress)
 *  MOCK_PREAD=1         read upload sources with pread (fd offset stays 0, only /proc/<pid>/io rchar grows)
 *  MOCK_HANG_FILE       while this file exists and contains the command name (e.g. "filesystem move"), that command
 *                       hangs (a server call that never answers) — tests for per-command timeouts
 *  MOCK_INJECT_FILE     JSON array of { before: "<command>", ...DeviceOp } (see device.ts): right before the next
 *                       command of that name runs, another device's operation is applied to the remote (and removed
 *                       from the file) — races like "Proton changed between our listing and our write"
 *
 * Real CLI quirks emulated (see daemon/src/cli/quirks.ts):
 *  - local upload paths are glob patterns: [ ] * ? (and {a,b}) are interpreted; no match -> "No paths matched";
 *    a backslash does not escape them; {x} without a comma is literal
 *  - arguments starting with "-" are options unless they come after "--" ("error: unknown option '-x'")
 *  - thumbnails: TIFF/RAW files and files > MOCK_THUMBNAIL_MAX_BYTES (default 100 MB) fail without --skip-thumbnails
 */
import { createInterface } from 'node:readline';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  Store,
  type MockNode,
  type MockState,
  type MockSession,
  newUid,
  now,
  sha1Hex,
  storageSizeFor,
} from './store.ts';
import { cacheDir, loadSession, removeSession, saveSession, storeKind } from './session.ts';
import { applyDeviceOp, type DeviceOp } from './device.ts';

const PROMPT = 'proton-drive> ';

class RecoverableError extends Error {}
class AuthRequiredError extends RecoverableError {
  constructor() {
    super('You need to login first');
  }
}

const COMMANDS: Record<string, string[]> = {
  auth: ['login', 'logout'],
  filesystem: [
    'list',
    'info',
    'size',
    'create-folder',
    'upload',
    'download',
    'rename',
    'copy',
    'move',
    'trash',
    'restore',
    'delete',
    'empty-trash',
  ],
};

const UID_RE = /^([a-zA-Z0-9=_-]{88,108}|[a-zA-Z0-9_-]{22})~([a-zA-Z0-9=_-]{88,108}|[a-zA-Z0-9_-]{22})$/;

// ------------------------------------------------------------------ helpers

function splitQuotedLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: false | '"' | "'" = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q === '"') {
      if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        cur += line[++i];
      } else if (c === '"') q = false;
      else cur += c;
    } else if (q === "'") {
      if (c === "'") q = false;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      started = true;
    } else if (c === ' ' || c === '\t') {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (q) throw new RecoverableError('Unclosed quote in command line');
  if (started || cur) out.push(cur);
  return out;
}

function splitPathSegments(p: string): string[] {
  const segs: string[] = [];
  let cur = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\' && (p[i + 1] === '/' || p[i + 1] === '\\')) {
      cur += p[++i];
    } else if (c === '/') {
      segs.push(cur);
      cur = '';
    } else cur += c;
  }
  segs.push(cur);
  return segs.filter((s) => s !== '');
}

function resolveCommand(args: string[]): { group: string; name: string; rest: string[] } {
  const [g, n, ...rest] = args;
  const groups = Object.keys(COMMANDS).filter((k) => k.startsWith(g ?? '\0') || (g === 'fs' && k === 'filesystem'));
  if (groups.length !== 1) throw new RecoverableError(`Unknown command: ${args.join(' ')}`);
  const group = groups[0]!;
  const names = COMMANDS[group]!.filter((k) => k === n || k.startsWith(n ?? '\0'));
  const exact = COMMANDS[group]!.find((k) => k === n);
  if (!exact && names.length !== 1) throw new RecoverableError(`Unknown command: ${args.join(' ')}`);
  return { group, name: exact ?? names[0]!, rest };
}

interface Parsed {
  positional: string[];
  json: boolean;
  file?: string;
  folder?: string;
  type?: string;
  skipThumbnails: boolean;
  name?: string;
}

function parseOptions(rest: string[]): Parsed {
  const p: Parsed = { positional: [], json: false, skipThumbnails: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') {
      p.positional.push(...rest.slice(i + 1));
      break;
    }
    if (a === '-j' || a === '--json') p.json = true;
    else if (a === '-v' || a === '--verbose') continue;
    else if (a === '-t' || a === '--skip-thumbnails') p.skipThumbnails = true;
    else if (a === '-f' || a === '--file-conflict-strategy') p.file = rest[++i];
    else if (a === '-d' || a === '--folder-conflict-strategy') p.folder = rest[++i];
    else if (a === '--type') p.type = rest[++i];
    else if (a === '-n' || a === '--name') p.name = rest[++i];
    else if (a.length > 1 && a.startsWith('-')) throw new RecoverableError(`error: unknown option '${a}'`);
    else p.positional.push(a);
  }
  return p;
}

// ------------------------------------------------------------------ local path globbing (real CLI quirk)

const GLOB_RE = /[[\]*?]|\{[^}]*,[^}]*\}/;

function globSegmentRe(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${seg.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      const end = seg.indexOf('}', i + 1);
      const body = end < 0 ? '' : seg.slice(i + 1, end);
      if (end < 0 || !body.includes(',')) re += '\\{';
      else {
        re += `(?:${body
          .split(',')
          .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Expands one local source like the real CLI: plain paths as is, glob patterns against the file system. */
function expandLocal(src: string): string[] {
  if (!GLOB_RE.test(src)) return [src];
  const abs = path.resolve(src);
  const segs = abs.split('/').filter(Boolean);
  let cur = ['/'];
  for (const seg of segs) {
    const next: string[] = [];
    for (const dir of cur) {
      if (!GLOB_RE.test(seg)) {
        const p = path.join(dir, seg);
        if (existsSync(p)) next.push(p);
        continue;
      }
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        /* not a dir */
      }
      const re = globSegmentRe(seg);
      for (const n of names) if (re.test(n)) next.push(path.join(dir, n));
    }
    cur = next;
  }
  return cur;
}

const THUMB_EXT = new Set(['.tif', '.tiff', '.exr', '.psd', '.arw', '.cr2', '.nef', '.dng', '.raw']);

/** Reads a file in chunks at MOCK_TRANSFER_BPS (keeps the fd open like a real upload). */
function readThrottled(file: string, env: NodeJS.ProcessEnv): Buffer {
  const bps = Number(env.MOCK_TRANSFER_BPS ?? 0);
  if (!(bps > 0)) return readFileSync(file);
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const out = Buffer.alloc(size);
    const chunk = 64 * 1024;
    let off = 0;
    const t0 = Date.now();
    while (off < size) {
      // MOCK_PREAD=1: positional reads (pread) leave the fd offset at 0 -> the daemon must fall back to /proc/<pid>/io
      const n = readSync(fd, out, off, Math.min(chunk, size - off), env.MOCK_PREAD === '1' ? off : null);
      if (n <= 0) break;
      off += n;
      const due = t0 + (off / bps) * 1000;
      sleep(due - Date.now());
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Writes a file in chunks at MOCK_TRANSFER_BPS (download progress is visible in the target dir). */
function writeThrottled(file: string, content: Buffer, env: NodeJS.ProcessEnv): void {
  const bps = Number(env.MOCK_TRANSFER_BPS ?? 0);
  if (!(bps > 0)) return writeFileSync(file, content);
  const fd = openSync(file, 'w');
  try {
    const chunk = 64 * 1024;
    const t0 = Date.now();
    for (let off = 0; off < content.length; off += chunk) {
      writeSync(fd, content, off, Math.min(chunk, content.length - off));
      const due = t0 + ((off + chunk) / bps) * 1000;
      sleep(due - Date.now());
    }
  } finally {
    closeSync(fd);
  }
}

function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function availableName(st: MockState, parentUid: string, name: string): string {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!childByName(st, parentUid, cand)) return cand;
  }
}

function children(st: MockState, parentUid: string, includeTrashed = false): MockNode[] {
  return Object.values(st.nodes).filter((n) => n.parentUid === parentUid && (includeTrashed || !n.trashed));
}

function childByName(st: MockState, parentUid: string, name: string): MockNode | undefined {
  return children(st, parentUid).find((n) => n.name === name);
}

function nodeJson(st: MockState, n: MockNode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    uid: n.uid,
    parentUid: n.parentUid,
    name: { ok: true, value: n.name },
    directRole: 'admin',
    ownedBy: { email: st.email },
    type: n.type,
    isShared: false,
    isSharedByUrl: false,
    creationTime: n.creationTime,
    modificationTime: n.modificationTime,
    ...(n.trashed ? { trashTime: n.trashed } : {}),
  };
  if (n.type === 'folder') return { ...base, folder: { isImported: false } };
  const revs = n.revisions ?? [];
  const r = revs[revs.length - 1];
  return {
    ...base,
    mediaType: n.mediaType ?? 'application/octet-stream',
    totalStorageSize: revs.reduce((s, x) => s + x.storageSize, 0),
    activeRevision: r
      ? {
          uid: r.uid,
          state: 'active',
          creationTime: r.creationTime,
          storageSize: r.storageSize,
          isImported: false,
          claimedSize: r.size,
          claimedModificationTime: r.claimedModificationTime,
          claimedDigests: r.sha1 ? { sha1: r.sha1, sha1Verified: false } : {},
        }
      : undefined,
  };
}

function print(obj: unknown, json: boolean): void {
  if (json) {
    if (Array.isArray(obj)) console.log('[\n' + obj.map((o) => JSON.stringify(o)).join(',\n') + '\n]');
    else console.log(JSON.stringify(obj));
  } else {
    console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  }
}

// ------------------------------------------------------------------ the CLI session (one per process)

class MockCli {
  private session: MockSession | null = null;
  private store: Store;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
    const dir = env.MOCK_PROTON_REMOTE;
    if (!dir) throw new Error('mock-proton-drive: MOCK_PROTON_REMOTE is not set');
    this.store = new Store(dir);
    if (!this.store.exists())
      throw new Error(`mock-proton-drive: no mock remote at ${dir} (run mock-proton-drive-seed)`);
    storeKind(env); // validates PROTON_DRIVE_CREDENTIALS_STORE like the real CLI (throws on invalid)
    mkdirSync(cacheDir(env), { recursive: true });
    this.session = loadSession(env); // like the real CLI: credentials are loaded once at init
  }

  run(args: string[]): void {
    const t0 = Date.now();
    let cmd = args.slice(0, 2).join(' ');
    try {
      const { group, name, rest } = resolveCommand(args);
      cmd = `${group} ${name}`;
      const opts = parseOptions(rest);
      this.simulateNetwork(cmd);
      this.simulateHang(cmd);
      this.injectDeviceOps(cmd);
      if (!(group === 'auth' && name === 'login')) this.ensureAuth();
      try {
        this.dispatch(group, name, opts);
      } finally {
        this.apiLog(`${group}/${name}`, Date.now() - t0);
      }
      this.commandLog(cmd, args, null);
    } catch (e) {
      this.commandLog(cmd, args, e);
      throw e;
    }
  }

  /** MOCK_COMMAND_LOG: one JSON line per command (tests count e.g. create-new-revision uploads). */
  private commandLog(cmd: string, args: string[], err: unknown): void {
    const f = this.env.MOCK_COMMAND_LOG;
    if (!f) return;
    try {
      appendFileSync(
        f,
        JSON.stringify({
          ts: now(),
          pid: process.pid,
          cmd,
          args,
          ok: !err,
          ...(err ? { error: formatError(err).slice(0, 300) } : {}),
        }) + '\n',
      );
    } catch {
      /* ignore */
    }
  }

  private apiLog(what: string, ms: number): void {
    try {
      appendFileSync(
        path.join(cacheDir(this.env), 'proton-drive.log'),
        `${now()} INFO [api] POST /mock/${what} 200 (${ms}ms)\n`,
      );
    } catch {
      /* ignore */
    }
  }

  private simulateNetwork(what: string): void {
    const env = this.env;
    if (env.MOCK_OFFLINE_FILE && existsSync(env.MOCK_OFFLINE_FILE)) {
      sleep(Number(env.MOCK_OFFLINE_DELAY_MS ?? 200));
      throw new RecoverableError(`TypeError: fetch failed (mock offline) during ${what}`);
    }
    let latency = Number(env.MOCK_LATENCY_MS ?? 0);
    const rpm = Number(env.MOCK_TARPIT_RPM ?? 0);
    if (rpm > 0) {
      const count = this.store.withStore((st) => {
        const t = Date.now();
        st.server.window = st.server.window.filter((x) => t - x < 60_000);
        st.server.window.push(t);
        return st.server.window.length;
      });
      if (count > rpm) latency = Number(env.MOCK_TARPIT_LATENCY_MS ?? 1700);
    }
    sleep(latency);
    const fail = Number(env.MOCK_FAIL_RATE ?? 0);
    if (fail > 0 && Math.random() < fail)
      throw new RecoverableError(`TypeError: fetch failed (mock transient) during ${what}`);
  }

  /** MOCK_INJECT_FILE: another device acts on the remote right before this command (consumed once). */
  private injectDeviceOps(cmd: string): void {
    const f = this.env.MOCK_INJECT_FILE;
    if (!f || !existsSync(f)) return;
    this.store.withStore((st) => {
      let ops: (DeviceOp & { before: string })[];
      try {
        ops = JSON.parse(readFileSync(f, 'utf8')) as (DeviceOp & { before: string })[];
      } catch {
        return;
      }
      const now = ops.filter((o) => o.before === cmd);
      if (!now.length) return;
      for (const o of now) applyDeviceOp(st, this.store, o);
      writeFileSync(f, JSON.stringify(ops.filter((o) => o.before !== cmd)));
    });
  }

  /** MOCK_HANG_FILE: the named command never answers while the file exists (hung server call). */
  private simulateHang(cmd: string): void {
    const f = this.env.MOCK_HANG_FILE;
    if (!f) return;
    const hangs = () => {
      try {
        return readFileSync(f, 'utf8')
          .split('\n')
          .map((x) => x.trim())
          .includes(cmd);
      } catch {
        return false;
      }
    };
    while (hangs()) sleep(100);
  }

  /** Emulates proton-drive-sdk-account ApiClient: 401 -> refresh; refresh 4xx -> credentials.signOut() -> store.remove(). */
  private ensureAuth(): void {
    const s = this.session;
    if (!s) throw new AuthRequiredError();
    if (s.accessGeneration === -1) return; // MOCK_KEYCHAIN_SESSION=1 shortcut: always valid
    const outcome = this.store.withStore((st) => {
      if (st.server.refreshToken === null) return 'revoked';
      if (s.accessGeneration === st.server.accessGeneration && s.refreshToken === st.server.refreshToken) return 'ok';
      if (s.refreshToken !== st.server.refreshToken) return 'refresh-failed';
      const refreshToken = randomBytes(16).toString('hex');
      st.server.refreshToken = refreshToken;
      return { refreshToken, accessGeneration: st.server.accessGeneration };
    });
    if (outcome === 'ok') return;
    if (outcome === 'refresh-failed' || outcome === 'revoked') {
      this.session = null;
      removeSession(this.env); // the real CLI deletes the stored session here!
      throw new AuthRequiredError();
    }
    this.session = { ...s, ...outcome };
    saveSession(this.env, this.session);
  }

  private dispatch(group: string, name: string, o: Parsed): void {
    if (group === 'auth') return name === 'login' ? this.login(o) : this.logout();
    switch (name) {
      case 'list':
        return this.list(o);
      case 'info':
        return this.info(o);
      case 'size':
        return this.size(o);
      case 'create-folder':
        return this.createFolder(o);
      case 'upload':
        return this.upload(o);
      case 'download':
        return this.download(o);
      case 'rename':
        return this.rename(o);
      case 'move':
        return this.move(o);
      case 'trash':
        return this.setTrashed(o, true);
      case 'restore':
        return this.setTrashed(o, false);
      case 'delete':
        return this.deleteNodes(o);
      case 'empty-trash':
        return this.emptyTrash();
      default:
        throw new RecoverableError(`mock: command not implemented: ${name}`);
    }
  }

  // ---------------- auth

  private login(o: Parsed): void {
    const url = `https://account.proton.me/desktop/login?app=drive&pv=3#payload=0%3AMOCK${randomBytes(6).toString('hex')}%3Acli-drive`;
    if (o.json) console.log(JSON.stringify({ signInUrl: url }));
    else {
      console.log('Sign in in your browser. Keep the terminal open. Waiting for authentication to complete...');
      console.log('Open following URL manually (can be on another device) if browser did not open automatically:');
      console.log(url);
    }
    const approveFile = path.join(this.store.dir, 'approve-login');
    const auto = this.env.MOCK_LOGIN_AUTO_APPROVE_MS;
    const deadline = Date.now() + (auto ? Number(auto) : 10 * 60_000);
    while (!auto && !existsSync(approveFile)) {
      if (Date.now() > deadline) throw new RecoverableError('Authentication timed out');
      sleep(100);
    }
    if (auto) sleep(Number(auto));
    rmSync(approveFile, { force: true });
    const session = this.store.withStore((st): MockSession => {
      st.server.refreshToken = randomBytes(16).toString('hex');
      return {
        mock: true,
        email: st.email,
        refreshToken: st.server.refreshToken,
        accessGeneration: st.server.accessGeneration,
      };
    });
    this.session = session;
    saveSession(this.env, session);
    if (!o.json) console.log('Authentication successful');
  }

  private logout(): void {
    this.store.withStore((st) => {
      st.server.refreshToken = null;
    });
    this.session = null;
    removeSession(this.env);
  }

  // ---------------- path resolution

  private resolve(st: MockState, p: string): { node: MockNode | null; section: string; virtual?: string } {
    const segs = splitPathSegments(p);
    if (segs.length === 0) return { node: null, section: '/', virtual: '/' };
    const [sec, ...rest] = segs;
    let cur: MockNode | undefined;
    if (sec === 'my-files') cur = st.nodes[st.myFilesUid];
    else if (sec === 'devices') {
      if (rest.length === 0) return { node: null, section: 'devices', virtual: 'devices' };
      const devName = rest.shift()!;
      const dev = st.devices.find((d) => d.name === devName || d.uid === devName);
      if (!dev) throw new RecoverableError('Device not found');
      cur = st.nodes[dev.rootFolderUid];
    } else if (sec === 'trash' && rest.length === 0) return { node: null, section: 'trash', virtual: 'trash' };
    else if (sec === 'shared-with-me' && rest.length === 0)
      return { node: null, section: 'shared-with-me', virtual: 'shared-with-me' };
    else throw new RecoverableError(`Path "${p}" not supported`);
    for (const part of rest) {
      if (UID_RE.test(part)) cur = st.nodes[part];
      else cur = cur ? childByName(st, cur.uid, part) : undefined;
      if (!cur) throw new RecoverableError(`Node not found: ${p}`);
    }
    if (!cur) throw new RecoverableError(`Node not found: ${p}`);
    return { node: cur, section: sec! };
  }

  private requireNode(st: MockState, p: string): MockNode {
    const r = this.resolve(st, p);
    if (!r.node) throw new RecoverableError(`Path "${p}" is not a node`);
    return r.node;
  }

  // ---------------- read commands

  private list(o: Parsed): void {
    const p = o.positional[0];
    if (!p) throw new RecoverableError('Missing path');
    const st = this.store.load();
    const r = this.resolve(st, p);
    if (r.virtual === '/') {
      return print(
        ['/my-files', '/devices', '/shared-by-me', '/shared-with-me', '/trash', '/albums', '/photos'].map((x) => ({
          path: x,
        })),
        true,
      );
    }
    if (r.virtual === 'devices') {
      return print(
        st.devices.map((d) => ({
          uid: d.uid,
          type: d.type,
          rootFolderUid: d.rootFolderUid,
          creationTime: d.creationTime,
          hasDeprecatedName: false,
          name: { ok: true, value: d.name },
        })),
        true,
      );
    }
    if (r.virtual === 'trash')
      return print(
        Object.values(st.nodes)
          .filter((n) => n.trashed)
          .map((n) => nodeJson(st, n)),
        true,
      );
    if (r.virtual === 'shared-with-me') return print([], true);
    const node = r.node!;
    if (node.type !== 'folder') throw new RecoverableError('Node is not a folder');
    let items = children(st, node.uid);
    if (o.type) items = items.filter((n) => n.type === o.type);
    print(
      items.map((n) => nodeJson(st, n)),
      o.json,
    );
  }

  private info(o: Parsed): void {
    const st = this.store.load();
    print(nodeJson(st, this.requireNode(st, o.positional[0] ?? '')), o.json);
  }

  private size(o: Parsed): void {
    const st = this.store.load();
    const root = this.requireNode(st, o.positional[0] ?? '');
    let size = 0;
    let numberOfDescendants = 0;
    const walk = (n: MockNode) => {
      for (const c of children(st, n.uid, true)) {
        numberOfDescendants++;
        size += (c.revisions ?? []).reduce((s, r) => s + r.storageSize, 0);
        if (c.type === 'folder') walk(c);
      }
    };
    walk(root);
    print({ size, numberOfDescendants }, true);
  }

  // ---------------- write commands

  private createFolder(o: Parsed): void {
    const [parentPath, name] = o.positional;
    if (!parentPath || !name) throw new RecoverableError('Usage: filesystem create-folder parentPath name');
    const node = this.store.withStore((st) => {
      const parent = this.requireNode(st, parentPath);
      if (childByName(st, parent.uid, name))
        throw new RecoverableError(`A node with the name "${name}" already exists`);
      return this.mkFolder(st, parent.uid, name);
    });
    print(nodeJson(this.store.load(), node), o.json);
  }

  private mkFolder(st: MockState, parentUid: string, name: string): MockNode {
    const t = now();
    const n: MockNode = {
      uid: newUid(st.volumeId),
      parentUid,
      name,
      type: 'folder',
      creationTime: t,
      modificationTime: t,
      trashed: null,
    };
    st.nodes[n.uid] = n;
    return n;
  }

  private upload(o: Parsed): void {
    if (o.positional.length < 2)
      throw new RecoverableError('At least one local source and a remote parent path are required');
    const patterns = o.positional.slice(0, -1);
    const parentPath = o.positional[o.positional.length - 1]!;
    const sources: string[] = [];
    for (const pat of patterns) {
      const m = expandLocal(pat);
      if (!m.length) throw new RecoverableError(`No paths matched: ${pat}`);
      sources.push(...m);
    }
    const sum = {
      transferredItems: 0,
      transferredBytes: 0,
      skippedItems: 0,
      failedItems: 0,
      failures: [] as { name: string; error: string }[],
    };
    // read file contents before taking the store lock (throttled transfers can take long)
    const contents = new Map<string, Buffer>();
    const thumbMax = Number(this.env.MOCK_THUMBNAIL_MAX_BYTES ?? 100_000_000);
    for (const src of sources) {
      let st;
      try {
        st = statSync(src);
      } catch {
        continue; // reported by uploadOne
      }
      if (!st.isFile()) continue;
      if (!o.skipThumbnails && (THUMB_EXT.has(path.extname(src).toLowerCase()) || st.size > thumbMax)) {
        sum.failedItems++;
        sum.failures.push({ name: path.basename(src), error: 'Failed to generate thumbnail (out of memory)' });
        contents.set(src, Buffer.alloc(0));
        continue;
      }
      contents.set(src, readThrottled(src, this.env));
    }
    this.store.withStore((st) => {
      const parent = this.requireNode(st, parentPath);
      for (const src of sources) {
        if (sum.failures.some((f) => f.name === path.basename(src) && /thumbnail/.test(f.error))) continue;
        this.uploadOne(st, src, parent.uid, o, sum, contents);
      }
    });
    if (o.json) console.log(JSON.stringify(sum));
    else console.log(`Transfer summary:\n  Uploaded: ${sum.transferredItems} items`);
    if (sum.failedItems > 0) throw new RecoverableError(`${sum.failedItems} item(s) failed to upload`);
  }

  private uploadOne(
    st: MockState,
    local: string,
    parentUid: string,
    o: Parsed,
    sum: {
      transferredItems: number;
      transferredBytes: number;
      skippedItems: number;
      failedItems: number;
      failures: { name: string; error: string }[];
    },
    contents?: Map<string, Buffer>,
  ): void {
    const name = path.basename(local);
    let lst;
    try {
      lst = statSync(local);
    } catch (e) {
      sum.failedItems++;
      sum.failures.push({ name, error: String((e as Error).message) });
      return;
    }
    if (lst.isDirectory()) {
      let target = childByName(st, parentUid, name);
      if (target) {
        const strat = o.folder;
        if (!strat) {
          if (o.json) {
            sum.failedItems++;
            sum.failures.push({ name, error: `Name conflict on "${name}" (folder) already exists` });
            return;
          }
          throw new RecoverableError('interactive conflict prompt not supported by mock; pass -d');
        }
        if (strat === 'skip') {
          sum.skippedItems++;
          return;
        }
        if (strat === 'replace') {
          target.trashed = now();
          target = this.mkFolder(st, parentUid, name);
        } else if (strat === 'rename') target = this.mkFolder(st, parentUid, availableName(st, parentUid, name));
      } else target = this.mkFolder(st, parentUid, name);
      for (const c of readdirSync(local).sort()) this.uploadOne(st, path.join(local, c), target.uid, o, sum);
      return;
    }
    const content = contents?.get(local) ?? readFileSync(local);
    const sha1 = sha1Hex(content);
    const modify = this.env.MOCK_MODIFY_DURING_UPLOAD;
    if (modify && name.includes(modify)) {
      // the upload has read the content; the user keeps writing to the file meanwhile
      appendFileSync(local, '\nmodified during upload');
      const t = new Date(Date.now() + 1000);
      utimesSync(local, t, t);
    }
    const existing = childByName(st, parentUid, name);
    let targetName = name;
    if (existing) {
      const active = existing.revisions?.[existing.revisions.length - 1];
      if (existing.type === 'file' && active?.sha1 && active.sha1 === sha1) {
        sum.skippedItems++; // "Files with the same content are automatically skipped" (only with a claimed digest!)
        return;
      }
      const strat = o.file;
      if (!strat) {
        sum.failedItems++;
        sum.failures.push({ name, error: `Name conflict on "${name}" (file) already exists` });
        return;
      }
      if (strat === 'skip') {
        sum.skippedItems++;
        return;
      }
      if (strat === 'create-new-revision' && existing.type === 'file') {
        existing.revisions!.push(this.newRevision(st, content, sha1, lst.mtime));
        existing.modificationTime = now();
        sum.transferredItems++;
        sum.transferredBytes += content.length;
        return;
      }
      if (strat === 'replace') existing.trashed = now();
      else if (strat === 'rename') targetName = availableName(st, parentUid, name);
    }
    const t = now();
    const node: MockNode = {
      uid: newUid(st.volumeId),
      parentUid,
      name: targetName,
      type: 'file',
      creationTime: t,
      modificationTime: t,
      trashed: null,
      revisions: [this.newRevision(st, content, sha1, lst.mtime)],
    };
    st.nodes[node.uid] = node;
    sum.transferredItems++;
    sum.transferredBytes += content.length;
  }

  private newRevision(st: MockState, content: Buffer, sha1: string | null, mtime: Date) {
    return {
      uid: `${st.volumeId}~${randomBytes(16).toString('base64url')}~${randomBytes(16).toString('base64url')}`,
      creationTime: now(),
      size: content.length,
      storageSize: storageSizeFor(content.length),
      sha1,
      claimedModificationTime: mtime.toISOString(),
      blob: this.store.writeBlob(content),
    };
  }

  private download(o: Parsed): void {
    if (o.positional.length < 2)
      throw new RecoverableError('At least one remote source and a local folder are required');
    const targets = o.positional.slice(0, -1);
    const localFolder = o.positional[o.positional.length - 1]!;
    if (!existsSync(localFolder) || !statSync(localFolder).isDirectory())
      throw new RecoverableError(`Local folder does not exist: ${localFolder}`);
    const st = this.store.load();
    const sum = {
      transferredItems: 0,
      transferredBytes: 0,
      skippedItems: 0,
      failedItems: 0,
      failures: [] as { name: string; error: string }[],
    };
    const one = (n: MockNode, dir: string) => {
      let dest = path.join(dir, n.name);
      if (n.type === 'folder') {
        if (existsSync(dest)) {
          const s = o.folder;
          if (s === 'skip') return void sum.skippedItems++;
          if (s === 'remove') rmSync(dest, { recursive: true, force: true });
          else if (s === 'rename') dest = path.join(dir, `${n.name} (1)`);
          else if (s !== 'merge')
            return void (sum.failedItems++,
            sum.failures.push({ name: n.name, error: `Name conflict on "${n.name}" (folder) already exists` }));
        }
        mkdirSync(dest, { recursive: true });
        for (const c of children(st, n.uid)) one(c, dest);
        return;
      }
      if (n.mediaType === 'application/vnd.proton.doc') return void sum.skippedItems++;
      if (existsSync(dest)) {
        const s = o.file;
        if (s === 'skip') return void sum.skippedItems++;
        if (s === 'remove') rmSync(dest, { force: true });
        else if (s === 'rename') {
          const ext = path.extname(n.name);
          dest = path.join(dir, `${ext ? n.name.slice(0, -ext.length) : n.name} (1)${ext}`);
        } else
          return void (sum.failedItems++,
          sum.failures.push({ name: n.name, error: `Name conflict on "${n.name}" (file) already exists` }));
      }
      const rev = n.revisions![n.revisions!.length - 1]!;
      const content = this.store.readBlob(rev.blob);
      writeThrottled(dest, content, this.env); // like the real CLI: mtime is NOT set to claimedModificationTime
      if (this.env.MOCK_CORRUPT_DOWNLOAD === '1') writeFileSync(dest, Buffer.concat([content, Buffer.from('x')]));
      sum.transferredItems++;
      sum.transferredBytes += content.length;
    };
    for (const t of targets) one(this.requireNode(st, t), localFolder);
    if (o.json) console.log(JSON.stringify(sum));
    if (sum.failedItems > 0) throw new RecoverableError(`${sum.failedItems} item(s) failed to download`);
  }

  private rename(o: Parsed): void {
    const [p, newName] = o.positional;
    if (!p || !newName) throw new RecoverableError('Usage: filesystem rename path newName');
    this.store.withStore((st) => {
      const n = this.requireNode(st, p);
      if (n.parentUid && childByName(st, n.parentUid, newName))
        throw new RecoverableError(`A node with the name "${newName}" already exists`);
      n.name = newName;
      n.modificationTime = now();
    });
    if (o.json) console.log(JSON.stringify({ ok: true }));
  }

  private move(o: Parsed): void {
    if (o.positional.length < 2) throw new RecoverableError('Usage: filesystem move sourcePath... targetParentPath');
    const srcs = o.positional.slice(0, -1);
    const target = o.positional[o.positional.length - 1]!;
    this.store.withStore((st) => {
      const parent = this.requireNode(st, target);
      for (const s of srcs) {
        const n = this.requireNode(st, s);
        if (childByName(st, parent.uid, n.name))
          throw new RecoverableError(`A node with the name "${n.name}" already exists`);
        n.parentUid = parent.uid;
      }
    });
    if (o.json) console.log(JSON.stringify(srcs.map(() => ({ ok: true }))));
  }

  private setTrashed(o: Parsed, trashed: boolean): void {
    this.store.withStore((st) => {
      for (const p of o.positional) {
        const n = UID_RE.test(p)
          ? st.nodes[p]
          : trashed
            ? this.requireNode(st, p)
            : st.nodes[splitPathSegments(p).pop() ?? ''];
        if (!n) throw new RecoverableError(`Node not found: ${p}`);
        n.trashed = trashed ? now() : null;
      }
    });
    if (o.json) console.log(JSON.stringify(o.positional.map(() => ({ ok: true }))));
  }

  private deleteNodes(o: Parsed): void {
    this.store.withStore((st) => {
      for (const p of o.positional) {
        const n = st.nodes[splitPathSegments(p).pop() ?? ''] ?? this.requireNode(st, p);
        this.purge(st, n);
      }
    });
    if (o.json) console.log(JSON.stringify({ ok: true }));
  }

  private emptyTrash(): void {
    this.store.withStore((st) => {
      for (const n of Object.values(st.nodes).filter((x) => x.trashed)) this.purge(st, n);
    });
  }

  private purge(st: MockState, n: MockNode): void {
    for (const c of children(st, n.uid, true)) this.purge(st, c);
    for (const r of n.revisions ?? []) this.store.deleteBlob(r.blob);
    delete st.nodes[n.uid];
  }
}

// ------------------------------------------------------------------ entry

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function repl(cli: MockCli): Promise<void> {
  // Like the real CLI (node:readline), prompt on stdout, one command per line.
  const rl = createInterface({ input: process.stdin, terminal: false });
  process.stdout.write(PROMPT);
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === 'exit' || trimmed === 'quit') process.exit(2);
    if (trimmed) {
      try {
        cli.run(splitQuotedLine(trimmed));
      } catch (e) {
        if (e instanceof RecoverableError) console.error(formatError(e));
        else {
          console.error('===============================================');
          console.error(e);
          process.exit(1);
        }
      }
    }
    process.stdout.write(PROMPT);
  }
  process.exit(2); // EOF -> ExitError -> exit code 2 (real CLI behaviour)
}

export async function main(argv: string[]): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-V') {
    console.log(`Proton Drive CLI ${process.env.MOCK_CLI_VERSION ?? '0.9.0'}`);
    console.log('Proton Drive SDK 0.14.0-mock');
    process.exit(0);
  }
  let cli: MockCli;
  try {
    cli = new MockCli(process.env);
  } catch (e) {
    console.error(formatError(e));
    process.exit(1);
  }
  if (argv.length === 0 || argv[0] === '') return repl(cli);
  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log('mock-proton-drive: fake of proton-drive CLI 0.9.0 (see mock-cli/src/main.ts)');
    process.exit(0);
  }
  try {
    cli.run(argv);
    process.exit(0);
  } catch (e) {
    console.error(formatError(e));
    process.exit(1);
  }
}
