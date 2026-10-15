// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Another device" acting on the mock remote: edits, creates, deletes (trash), renames and moves
 * remote files between — or, with MOCK_INJECT_FILE, in the middle of — the engine's runs. Used by the seed tool
 * (`mock-proton-drive-seed --edit/--trash/--rename/--move/--strip-digest`) and by the CLI's injection hook.
 * Operates directly on the store (no session), like a second Proton client on another computer.
 */
import { randomBytes } from 'node:crypto';

import { newUid, now, sha1Hex, storageSizeFor, type MockNode, type MockState, type Store } from './store.ts';

export interface DeviceOp {
  op: 'edit' | 'create' | 'trash' | 'rename' | 'move' | 'strip-digest';
  /** remote display path, e.g. /devices/Workstation/Documents/a.txt */
  path: string;
  /** edit/create: new content */
  content?: string;
  /** edit/create: claimed modification time (ISO), default now */
  mtime?: string;
  /** edit/create: upload like the old Windows client (no claimed sha1) */
  noDigest?: boolean;
  /** rename: new name */
  newName?: string;
  /** move: remote display path of the new parent folder */
  into?: string;
}

/** Remote display path -> node (non-trashed), or undefined. */
export function nodeAt(st: MockState, p: string): MockNode | undefined {
  const segs = p.split('/').filter(Boolean);
  let cur: string | undefined;
  if (segs[0] === 'my-files') {
    cur = st.myFilesUid;
    segs.shift();
  } else if (segs[0] === 'devices') {
    cur = st.devices.find((d) => d.name === segs[1])?.rootFolderUid;
    segs.splice(0, 2);
  } else return undefined;
  for (const name of segs) {
    if (!cur) return undefined;
    cur = Object.values(st.nodes).find((n) => n.parentUid === cur && n.name === name && !n.trashed)?.uid;
  }
  return cur ? st.nodes[cur] : undefined;
}

function parentAndName(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return [p.slice(0, i), p.slice(i + 1)];
}

function revision(st: MockState, store: Store, content: Buffer, op: DeviceOp) {
  return {
    uid: `${st.volumeId}~${randomBytes(16).toString('base64url')}~${randomBytes(16).toString('base64url')}`,
    creationTime: now(),
    size: content.length,
    storageSize: storageSizeFor(content.length),
    sha1: op.noDigest ? null : sha1Hex(content),
    claimedModificationTime: op.mtime ?? now(),
    blob: store.writeBlob(content),
  };
}

/** Applies one operation; throws when the path does not exist (except create/edit of a new file). */
export function applyDeviceOp(st: MockState, store: Store, op: DeviceOp): void {
  const node = nodeAt(st, op.path);
  switch (op.op) {
    case 'edit':
    case 'create': {
      const content = Buffer.from(op.content ?? '');
      if (node) {
        if (node.type !== 'file') throw new Error(`mock device: ${op.path} is a folder`);
        node.revisions!.push(revision(st, store, content, op));
        node.modificationTime = now();
        return;
      }
      const [parentPath, name] = parentAndName(op.path);
      const parent = nodeAt(st, parentPath);
      if (!parent) throw new Error(`mock device: parent folder ${parentPath} not found`);
      const t = now();
      const uid = newUid(st.volumeId);
      st.nodes[uid] = {
        uid,
        parentUid: parent.uid,
        name,
        type: 'file',
        creationTime: t,
        modificationTime: t,
        trashed: null,
        revisions: [revision(st, store, content, op)],
      };
      return;
    }
    case 'trash':
      if (!node) throw new Error(`mock device: ${op.path} not found`);
      node.trashed = now();
      return;
    case 'rename':
      if (!node || !op.newName) throw new Error(`mock device: rename ${op.path} needs an existing node and newName`);
      node.name = op.newName;
      node.modificationTime = now();
      return;
    case 'move': {
      const target = op.into ? nodeAt(st, op.into) : undefined;
      if (!node || !target) throw new Error(`mock device: move ${op.path} -> ${op.into}: not found`);
      node.parentUid = target.uid;
      return;
    }
    case 'strip-digest': {
      const r = node?.revisions?.[node.revisions.length - 1];
      if (!r) throw new Error(`mock device: ${op.path} is not a file`);
      r.sha1 = null;
      return;
    }
  }
}
