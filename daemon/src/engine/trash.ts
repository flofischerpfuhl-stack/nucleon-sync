// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * freedesktop.org trash for local files on /data (docs/SYNC-RULES.md row 6): files replaced or removed by the engine
 * are never deleted, they go to `<topdir>/.Trash-<uid>/{files,info}` on the same filesystem (or the home trash when
 * the file lives on the home filesystem), so KDE's Dolphin can restore them.
 */
import { lstatSync, mkdirSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface LocalTrashOptions {
  /** fixed trash dir (tests); default: freedesktop topdir trash */
  fixedDir?: string;
  uid?: number;
}

export class LocalTrash {
  private readonly o: LocalTrashOptions;
  constructor(o: LocalTrashOptions = {}) {
    this.o = o;
  }

  trashDirFor(absPath: string): string {
    if (this.o.fixedDir) return this.o.fixedDir;
    const uid = this.o.uid ?? process.getuid?.() ?? 1000;
    const home = homedir();
    const top = mountTop(absPath);
    if (top === mountTop(home)) return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'Trash');
    return path.join(top, `.Trash-${uid}`);
  }

  /** Moves absPath into the trash; returns the path inside the trash. */
  trash(absPath: string, now = new Date()): string {
    const dir = this.trashDirFor(absPath);
    const files = path.join(dir, 'files');
    const info = path.join(dir, 'info');
    mkdirSync(files, { recursive: true, mode: 0o700 });
    mkdirSync(info, { recursive: true, mode: 0o700 });
    const base = path.basename(absPath);
    let name = base;
    for (let i = 2; existsSync(path.join(files, name)) || existsSync(path.join(info, `${name}.trashinfo`)); i++) {
      const ext = path.extname(base);
      name = ext ? `${base.slice(0, -ext.length)}.${i}${ext}` : `${base}.${i}`;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const encoded = absPath.split('/').map(encodeURIComponent).join('/');
    writeFileSync(path.join(info, `${name}.trashinfo`), `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}\n`, {
      mode: 0o600,
    });
    const target = path.join(files, name);
    renameSync(absPath, target);
    return target;
  }
}

/** Mount point of the filesystem that holds p (walk up while st_dev stays the same). */
export function mountTop(p: string): string {
  let cur = path.resolve(p);
  let dev: number;
  try {
    dev = lstatSync(cur).dev;
  } catch {
    cur = path.dirname(cur);
    dev = statSync(cur).dev;
  }
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    try {
      if (statSync(parent).dev !== dev) return cur;
    } catch {
      return cur;
    }
    cur = parent;
  }
}
