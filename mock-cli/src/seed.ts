// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * mock-proton-drive-seed — create/extend a mock Proton backend.
 *
 *   mock-proton-drive-seed --remote DIR --email alex@example.test [--device Workstation]
 *        [--from LOCALDIR --to /devices/Workstation/Documents [--no-digest]] [--print-session]
 *        [--expire-access] [--revoke]
 *
 * Another device acting on the remote between runs (two-way tests; applied in this order, all repeatable):
 *   --edit PATH --content TEXT [--mtime ISO] [--no-digest]   new revision (or new file) at PATH
 *   --trash PATH        --rename PATH --new-name NAME        --move PATH --into FOLDER
 *   --strip-digest PATH (active revision loses its sha1, like an old Windows upload)
 *
 * --no-digest imports files like the old Windows client did (no claimed sha1) to reproduce the
 * "duplicate revisions" lesson. --print-session prints a valid session JSON (pipe it into `pass insert`
 * or the secret-shim) so the mock considers the account logged in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';

import { applyDeviceOp } from './device.ts';
import { Store, addDevice, newUid, now, sha1Hex, storageSizeFor, type MockState, type MockNode } from './store.ts';

const { values } = parseArgs({
  options: {
    remote: { type: 'string' },
    email: { type: 'string', default: 'user@example.test' },
    device: { type: 'string', multiple: true },
    from: { type: 'string' },
    to: { type: 'string' },
    'no-digest': { type: 'boolean', default: false },
    'print-session': { type: 'boolean', default: false },
    'expire-access': { type: 'boolean', default: false },
    revoke: { type: 'boolean', default: false },
    edit: { type: 'string', multiple: true },
    content: { type: 'string', multiple: true },
    mtime: { type: 'string' },
    trash: { type: 'string', multiple: true },
    rename: { type: 'string' },
    'new-name': { type: 'string' },
    move: { type: 'string' },
    into: { type: 'string' },
    'strip-digest': { type: 'string', multiple: true },
  },
});

if (!values.remote) {
  console.error('--remote is required');
  process.exit(1);
}
const store = new Store(values.remote);
if (!store.exists()) store.init(values.email!);

store.withStore((st) => {
  for (const d of values.device ?? []) if (!st.devices.some((x) => x.name === d)) addDevice(st, d);
  if (values.from && values.to) importTree(st, values.from, values.to, !values['no-digest']);
  (values.edit ?? []).forEach((p, i) =>
    applyDeviceOp(st, store, {
      op: 'edit',
      path: p,
      content: values.content?.[i] ?? '',
      mtime: values.mtime,
      noDigest: values['no-digest'],
    }),
  );
  for (const p of values.trash ?? []) applyDeviceOp(st, store, { op: 'trash', path: p });
  if (values.rename) applyDeviceOp(st, store, { op: 'rename', path: values.rename, newName: values['new-name'] });
  if (values.move) applyDeviceOp(st, store, { op: 'move', path: values.move, into: values.into });
  for (const p of values['strip-digest'] ?? []) applyDeviceOp(st, store, { op: 'strip-digest', path: p });
  if (values['expire-access']) st.server.accessGeneration++; // all access tokens expire -> next call refreshes
  if (values.revoke) st.server.refreshToken = null; // session revoked server-side -> needs login
  if (values['print-session']) {
    st.server.refreshToken ??= randomBytes(16).toString('hex');
    console.log(
      JSON.stringify({
        mock: true,
        email: st.email,
        refreshToken: st.server.refreshToken,
        accessGeneration: st.server.accessGeneration,
      }),
    );
  }
});

function ensureFolderPath(st: MockState, remotePath: string): string {
  const segs = remotePath.split('/').filter(Boolean);
  let cur: string;
  if (segs[0] === 'my-files') {
    cur = st.myFilesUid;
    segs.shift();
  } else if (segs[0] === 'devices') {
    const dev = st.devices.find((d) => d.name === segs[1]) ?? addDevice(st, segs[1]!);
    cur = dev.rootFolderUid;
    segs.splice(0, 2);
  } else throw new Error(`unsupported root ${remotePath}`);
  for (const name of segs) {
    const ex = Object.values(st.nodes).find((n) => n.parentUid === cur && n.name === name && !n.trashed);
    if (ex) cur = ex.uid;
    else {
      const t = now();
      const n: MockNode = {
        uid: newUid(st.volumeId),
        parentUid: cur,
        name,
        type: 'folder',
        creationTime: t,
        modificationTime: t,
        trashed: null,
      };
      st.nodes[n.uid] = n;
      cur = n.uid;
    }
  }
  return cur;
}

function importTree(st: MockState, from: string, to: string, withDigest: boolean): void {
  const rootUid = ensureFolderPath(st, to);
  const walk = (dir: string, parentUid: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const s = statSync(p);
      const t = now();
      if (s.isDirectory()) {
        // merge into an existing folder of the same name (repeated seeds into one tree)
        const existing = Object.values(st.nodes).find(
          (x) => x.parentUid === parentUid && x.name === name && x.type === 'folder' && !x.trashed,
        );
        if (existing) {
          walk(p, existing.uid);
          continue;
        }
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
        walk(p, n.uid);
      } else if (s.isFile()) {
        const content = readFileSync(p);
        const uid = newUid(st.volumeId);
        st.nodes[uid] = {
          uid,
          parentUid,
          name,
          type: 'file',
          creationTime: t,
          modificationTime: t,
          trashed: null,
          revisions: [
            {
              uid: `${st.volumeId}~${randomBytes(16).toString('base64url')}~${randomBytes(16).toString('base64url')}`,
              creationTime: t,
              size: content.length,
              storageSize: storageSizeFor(content.length),
              sha1: withDigest ? sha1Hex(content) : null,
              claimedModificationTime: s.mtime.toISOString(),
              blob: store.writeBlob(content),
            },
          ],
        };
      }
    }
  };
  walk(from, rootUid);
}
