// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * On-disk fake Proton backend for the mock CLI.
 * One "remote" directory == one Proton account:
 *   <remote>/state.json   nodes, devices, server-side session state, rate window
 *   <remote>/blobs/<id>   file contents (one blob per revision)
 * All mutating access goes through withStore(), which holds an exclusive lock directory.
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface MockRevision {
  uid: string;
  creationTime: string;
  size: number;
  storageSize: number;
  sha1: string | null; // null == uploaded by the old Windows client (no claimed digest)
  claimedModificationTime: string | null;
  blob: string;
}

export interface MockNode {
  uid: string;
  parentUid: string | null;
  name: string;
  type: 'file' | 'folder';
  mediaType?: string;
  creationTime: string;
  modificationTime: string;
  trashed: string | null;
  revisions?: MockRevision[]; // files only, last = active
}

export interface MockDevice {
  uid: string;
  name: string;
  type: string;
  rootFolderUid: string;
  creationTime: string;
}

export interface MockServer {
  /** current valid refresh token; null == logged out everywhere */
  refreshToken: string | null;
  /** bumped to expire all access tokens (simulates token expiry) */
  accessGeneration: number;
  /** timestamps (ms) of recent commands, for the tarpit simulation */
  window: number[];
}

export interface MockState {
  version: 1;
  email: string;
  volumeId: string;
  myFilesUid: string;
  nodes: Record<string, MockNode>;
  devices: MockDevice[];
  server: MockServer;
}

export interface MockSession {
  mock: true;
  email: string;
  refreshToken: string;
  accessGeneration: number;
}

const b64url = (n: number) => randomBytes(n).toString('base64url');

export function newUid(volumeId: string): string {
  return `${volumeId}~${b64url(16)}`;
}

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function storageSizeFor(size: number): number {
  // encrypted size approximation: per-4MiB-block overhead + header
  return size + 64 * Math.max(1, Math.ceil(size / (4 * 1024 * 1024))) + 51;
}

export function now(): string {
  return new Date().toISOString();
}

export function createState(email: string): MockState {
  const volumeId = b64url(16);
  const myFilesUid = `${volumeId}~${b64url(16)}`;
  const t = now();
  return {
    version: 1,
    email,
    volumeId,
    myFilesUid,
    nodes: {
      [myFilesUid]: {
        uid: myFilesUid,
        parentUid: null,
        name: 'root',
        type: 'folder',
        creationTime: t,
        modificationTime: t,
        trashed: null,
      },
    },
    devices: [],
    server: { refreshToken: null, accessGeneration: 1, window: [] },
  };
}

export function addDevice(state: MockState, name: string, type = 'Windows'): MockDevice {
  const rootUid = newUid(state.volumeId);
  const t = now();
  state.nodes[rootUid] = {
    uid: rootUid,
    parentUid: null,
    name: 'root',
    type: 'folder',
    creationTime: t,
    modificationTime: t,
    trashed: null,
  };
  const dev: MockDevice = { uid: b64url(48), name, type, rootFolderUid: rootUid, creationTime: t };
  state.devices.push(dev);
  return dev;
}

export class Store {
  readonly dir: string;
  readonly statePath: string;
  readonly blobDir: string;
  readonly lockDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.blobDir = path.join(dir, 'blobs');
    this.lockDir = path.join(dir, 'state.lock');
  }

  exists(): boolean {
    return existsSync(this.statePath);
  }

  init(email: string): MockState {
    mkdirSync(this.blobDir, { recursive: true });
    const st = createState(email);
    this.save(st);
    return st;
  }

  load(): MockState {
    return JSON.parse(readFileSync(this.statePath, 'utf8')) as MockState;
  }

  save(state: MockState): void {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.statePath);
  }

  writeBlob(content: Buffer): string {
    mkdirSync(this.blobDir, { recursive: true });
    const id = b64url(12);
    writeFileSync(path.join(this.blobDir, id), content);
    return id;
  }

  readBlob(id: string): Buffer {
    return readFileSync(path.join(this.blobDir, id));
  }

  deleteBlob(id: string): void {
    rmSync(path.join(this.blobDir, id), { force: true });
  }

  /** Run fn with an exclusive cross-process lock; saves state if fn returns normally. */
  withStore<T>(fn: (state: MockState) => T): T {
    this.lock();
    try {
      const st = this.load();
      const result = fn(st);
      this.save(st);
      return result;
    } finally {
      this.unlock();
    }
  }

  private lock(): void {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        mkdirSync(this.lockDir);
        return;
      } catch {
        try {
          if (Date.now() - statSync(this.lockDir).mtimeMs > 15_000)
            rmSync(this.lockDir, { recursive: true, force: true });
        } catch {
          /* lock vanished */
        }
        if (Date.now() > deadline) throw new Error('mock: could not acquire store lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  private unlock(): void {
    rmSync(this.lockDir, { recursive: true, force: true });
  }
}
