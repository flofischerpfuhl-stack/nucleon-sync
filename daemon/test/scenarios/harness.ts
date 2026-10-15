// SPDX-License-Identifier: GPL-3.0-or-later
/** Scenario harness: a real Engine + REPL workers against mock-proton-drive remotes in a temp dir. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolvePaths, type PairDirection, type RunDto, type SyncRequest } from '@nucleon-sync/shared';

import { openDb } from '../../src/db/db.ts';
import type { EntryRow } from '../../src/db/repo.ts';
import { Engine, type EngineOptions } from '../../src/engine/engine.ts';
import { MOCK_BIN, SEED_BIN, tmp } from '../helpers.ts';

export interface AccountSpec {
  id: string;
  workers?: number;
  devices?: string[];
}
export interface PairSpec {
  account: string;
  name: string;
  local: string; // relative to <dir>/data
  remote: string; // e.g. /devices/Workstation/Documents
  direction?: PairDirection;
  enabled?: boolean;
  /** pairs.options JSON (e.g. { uploadLocalNew: true }) */
  options?: Record<string, unknown>;
}

export interface Cmd {
  cmd: string;
  args: string[];
  ok: boolean;
  error?: string;
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export async function makeHarness(o: {
  accounts?: AccountSpec[];
  pairs: PairSpec[];
  /** pre-seed remote trees: account -> [{from (dir relative to <dir>/seed), to (remote path), noDigest}] */
  seed?: Record<string, { files: Record<string, string>; to: string; noDigest?: boolean; mtime?: Date }[]>;
  localFiles?: Record<string, string>; // relative to <dir>/data
  mtime?: Date;
  engine?: Partial<EngineOptions>;
  accountEnv?: Record<string, Record<string, string>>;
}) {
  const dir = tmp('scn-');
  const data = path.join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const secrets = path.join(dir, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const accounts = o.accounts ?? [{ id: 'alex', workers: 2 }];
  const remotes: Record<string, string> = {};
  const cmdLogs: Record<string, string> = {};
  const mtime = o.mtime ?? new Date('2025-03-01T10:00:00Z');

  const writeTree = (root: string, files: Record<string, string>, t: Date) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      utimesSync(p, t, t);
    }
  };

  for (const a of accounts) {
    const remote = path.join(dir, `remote-${a.id}`);
    remotes[a.id] = remote;
    cmdLogs[a.id] = path.join(dir, `cmd-${a.id}.jsonl`);
    const devs = (a.devices ?? ['Workstation']).flatMap((d) => ['--device', d]);
    execFileSync(SEED_BIN, ['--remote', remote, '--email', `${a.id}@mock.test`, ...devs]);
    let i = 0;
    for (const s of o.seed?.[a.id] ?? []) {
      const src = path.join(dir, 'seed', `${a.id}-${i++}`);
      writeTree(src, s.files, s.mtime ?? mtime);
      execFileSync(SEED_BIN, ['--remote', remote, '--from', src, '--to', s.to, ...(s.noDigest ? ['--no-digest'] : [])]);
    }
    for (const p of o.pairs.filter((x) => x.account === a.id)) {
      // make sure the remote root exists (empty seed)
      const empty = path.join(dir, 'seed', `empty-${a.id}`);
      mkdirSync(empty, { recursive: true });
      execFileSync(SEED_BIN, ['--remote', remote, '--from', empty, '--to', p.remote]);
    }
    writeFileSync(
      path.join(secrets, `${a.id}.json`),
      execFileSync(SEED_BIN, ['--remote', remote, '--print-session'], { encoding: 'utf8' }).trim(),
    );
  }
  if (o.localFiles) writeTree(data, o.localFiles, mtime);
  for (const p of o.pairs) mkdirSync(path.join(data, p.local), { recursive: true });

  const db = openDb(path.join(dir, 'state.sqlite'));
  const now = Date.now();
  for (const a of accounts)
    db.prepare(
      'INSERT INTO accounts (id, display_name, email, credential_backend, workers, created_at) VALUES (?,?,?,?,?,?)',
    ).run(a.id, a.id, `${a.id}@mock.test`, 'mock', a.workers ?? 2, now);
  for (const p of o.pairs) {
    const segs = p.remote.split('/').filter(Boolean);
    const section = segs[0] === 'devices' ? `/devices/${segs[1]}` : `/${segs[0]}`;
    db.prepare(
      'INSERT INTO pairs (account_id, name, local_root, remote_root, remote_section, direction, enabled, options, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      p.account,
      p.name,
      path.join(data, p.local),
      p.remote,
      section,
      p.direction ?? 'backup',
      p.enabled === false ? 0 : 1,
      JSON.stringify(p.options ?? {}),
      now,
    );
  }
  const paths = resolvePaths({ NUCLEON_SYNC_HOME: path.join(dir, 'home') });
  const accountEnv: Record<string, Record<string, string>> = {};
  const injectFiles: Record<string, string> = {};
  for (const a of accounts) {
    injectFiles[a.id] = path.join(dir, `inject-${a.id}.json`);
    accountEnv[a.id] = {
      MOCK_PROTON_REMOTE: remotes[a.id]!,
      MOCK_COMMAND_LOG: cmdLogs[a.id]!,
      MOCK_INJECT_FILE: injectFiles[a.id]!,
      ...(o.accountEnv?.[a.id] ?? {}),
    };
  }

  const engineOpts: EngineOptions = {
    db,
    paths,
    cliPath: MOCK_BIN,
    mode: 'mock',
    version: 'test',
    accountEnv,
    secretFileDir: secrets,
    stagingDir: path.join(data, '.nucleon-sync-staging'),
    trashDir: path.join(dir, 'trash'),
    scheduler: false,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    probeIntervalMs: 200,
    freshMs: 0,
    shimPollMs: 100,
    restartBackoffMs: [50, 100, 200],
    hostname: 'pc',
    ...o.engine,
  };
  let engine = new Engine(engineOpts);

  const h = {
    dir,
    data,
    db,
    remotes,
    secrets,
    get engine() {
      return engine;
    },
    async restart(extra: Partial<EngineOptions> = {}) {
      await engine.shutdown();
      engine = new Engine({ ...engineOpts, ...extra });
      return engine;
    },
    async sync(req: SyncRequest = {}): Promise<RunDto> {
      const id = engine.requestSync(req, 'manual');
      await engine.waitIdle();
      return engine.runs(50).find((r) => r.id === id)!;
    },
    /** waits until the queue has no queued/running/retry_wait jobs */
    async drain(timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const n = (
          db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','retry_wait')").get() as {
            n: number;
          }
        ).n;
        if (n === 0) return;
        if (Date.now() > end)
          throw new Error(
            `queue not drained: ${JSON.stringify(h.jobs().filter((j) => ['queued', 'running', 'retry_wait'].includes(j.state)))}`,
          );
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    /** another client uploads a new revision / new file with this content into a remote folder */
    otherUpload(
      account: string,
      remoteFolder: string,
      name: string,
      content: string,
      strategy = 'create-new-revision',
    ) {
      const d = path.join(dir, 'other-files', String(Date.now()) + Math.random().toString(36).slice(2));
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, name), content);
      return h.other(
        account,
        'filesystem',
        'upload',
        '-j',
        '-f',
        strategy,
        '-d',
        'merge',
        path.join(d, name),
        remoteFolder,
      );
    },
    /** commands the engine sent to the mock for an account (from MOCK_COMMAND_LOG), optionally only since mark */
    commands(account = 'alex', since = 0): Cmd[] {
      const f = cmdLogs[account]!;
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(since)
        .map((l) => JSON.parse(l) as Cmd);
    },
    mark(account = 'alex'): number {
      return h.commands(account).length;
    },
    /** another Proton client (web/phone) acting on the remote directly, not logged in the engine's command log */
    other(account: string, ...args: string[]): string {
      return execFileSync(MOCK_BIN, args, {
        env: {
          ...process.env,
          MOCK_PROTON_REMOTE: remotes[account]!,
          PROTON_DRIVE_CACHE_DIR: path.join(dir, `other-${account}`),
          MOCK_KEYCHAIN_SESSION: '1',
          PROTON_DRIVE_CREDENTIALS_STORE: 'keychain',
        },
        encoding: 'utf8',
      });
    },
    otherJson<T>(account: string, ...args: string[]): T {
      return JSON.parse(h.other(account, ...args, '-j')) as T;
    },
    write(rel: string, content: string, t?: Date) {
      const p = path.join(data, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      if (t) utimesSync(p, t, t);
    },
    read(rel: string): string {
      return readFileSync(path.join(data, rel), 'utf8');
    },
    exists(rel: string): boolean {
      return existsSync(path.join(data, rel));
    },
    entry(pairId: number, rel: string): EntryRow | undefined {
      return db.prepare('SELECT * FROM entries WHERE pair_id = ? AND rel_path = ?').get(pairId, rel) as unknown as
        EntryRow | undefined;
    },
    jobs(state?: string): {
      id: number;
      type: string;
      state: string;
      error_class: string | null;
      last_error: string | null;
      payload: string;
    }[] {
      return (
        state
          ? db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY id').all(state)
          : db.prepare('SELECT * FROM jobs ORDER BY id').all()
      ) as never;
    },
    /** full mock remote state (nodes) */
    remoteState(account = 'alex') {
      return JSON.parse(readFileSync(path.join(remotes[account]!, 'state.json'), 'utf8')) as {
        nodes: Record<
          string,
          {
            uid: string;
            parentUid: string | null;
            name: string;
            type: string;
            trashed: string | null;
            revisions?: { sha1: string | null }[];
          }
        >;
        devices: { name: string; rootFolderUid: string }[];
        myFilesUid: string;
      };
    },
    /** remote path -> node (non-trashed) */
    remoteNode(account: string, p: string) {
      const st = h.remoteState(account);
      const segs = p.split('/').filter(Boolean);
      let cur: string | undefined;
      if (segs[0] === 'my-files') {
        cur = st.myFilesUid;
        segs.shift();
      } else {
        cur = st.devices.find((d) => d.name === segs[1])?.rootFolderUid;
        segs.splice(0, 2);
      }
      for (const s of segs) {
        cur = Object.values(st.nodes).find((n) => n.parentUid === cur && n.name === s && !n.trashed)?.uid;
        if (!cur) return undefined;
      }
      return cur ? st.nodes[cur] : undefined;
    },
    /**
     * another device (laptop, phone, web) acting on the remote between runs, without a session and outside the
     * engine's command log: edit/create, trash, rename, move, strip-digest (see mock-cli/src/device.ts)
     */
    device(account: string, ...args: string[]): string {
      return execFileSync(SEED_BIN, ['--remote', remotes[account]!, ...args], { encoding: 'utf8' });
    },
    remoteEdit(account: string, p: string, content: string, o: { mtime?: Date; noDigest?: boolean } = {}) {
      h.device(
        account,
        '--edit',
        p,
        '--content',
        content,
        ...(o.mtime ? ['--mtime', o.mtime.toISOString()] : []),
        ...(o.noDigest ? ['--no-digest'] : []),
      );
    },
    remoteTrash(account: string, ...paths: string[]) {
      h.device(account, ...paths.flatMap((p) => ['--trash', p]));
    },
    remoteRename(account: string, p: string, newName: string) {
      h.device(account, '--rename', p, '--new-name', newName);
    },
    remoteMove(account: string, p: string, into: string) {
      h.device(account, '--move', p, '--into', into);
    },
    /** another device acts right before the engine's next command of this name (e.g. 'filesystem upload') */
    inject(account: string, ops: ({ before: string; op: string; path: string } & Record<string, unknown>)[]) {
      writeFileSync(injectFiles[account]!, JSON.stringify(ops));
    },
    /**
     * a second computer with its own daemon (own state DB and local folders) on the same Proton account and remote
     * folders — e.g. PC and laptop syncing one two-way folder
     */
    async secondDevice(d: { pairs: PairSpec[]; hostname?: string; engine?: Partial<EngineOptions> }) {
      const ddir = path.join(dir, 'device2');
      const ddata = path.join(ddir, 'data');
      mkdirSync(ddata, { recursive: true });
      for (const p of d.pairs) mkdirSync(path.join(ddata, p.local), { recursive: true });
      const ddb = openDb(path.join(ddir, 'state.sqlite'));
      const t = Date.now();
      for (const a of accounts)
        ddb
          .prepare(
            'INSERT INTO accounts (id, display_name, email, credential_backend, workers, created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(a.id, a.id, `${a.id}@mock.test`, 'mock', a.workers ?? 2, t);
      for (const p of d.pairs) {
        const segs = p.remote.split('/').filter(Boolean);
        const section = segs[0] === 'devices' ? `/devices/${segs[1]}` : `/${segs[0]}`;
        ddb
          .prepare(
            'INSERT INTO pairs (account_id, name, local_root, remote_root, remote_section, direction, enabled, options, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .run(
            p.account,
            p.name,
            path.join(ddata, p.local),
            p.remote,
            section,
            p.direction ?? 'backup',
            p.enabled === false ? 0 : 1,
            JSON.stringify(p.options ?? {}),
            t,
          );
      }
      const denv: Record<string, Record<string, string>> = {};
      for (const a of accounts)
        denv[a.id] = { ...accountEnv[a.id]!, MOCK_COMMAND_LOG: path.join(ddir, `cmd-${a.id}.jsonl`) };
      const e2 = new Engine({
        ...engineOpts,
        db: ddb,
        paths: resolvePaths({ NUCLEON_SYNC_HOME: path.join(ddir, 'home') }),
        accountEnv: denv,
        stagingDir: path.join(ddata, '.nucleon-sync-staging'),
        trashDir: path.join(ddir, 'trash'),
        hostname: d.hostname ?? 'laptop',
        ...d.engine,
      });
      const dev = {
        dir: ddir,
        data: ddata,
        db: ddb,
        engine: e2,
        async sync(req: SyncRequest = {}): Promise<RunDto> {
          const id = e2.requestSync(req, 'manual');
          await e2.waitIdle();
          return e2.runs(50).find((r) => r.id === id)!;
        },
        write(rel: string, content: string, tm?: Date) {
          const p = path.join(ddata, rel);
          mkdirSync(path.dirname(p), { recursive: true });
          writeFileSync(p, content);
          if (tm) utimesSync(p, tm, tm);
        },
        read(rel: string): string {
          return readFileSync(path.join(ddata, rel), 'utf8');
        },
        exists(rel: string): boolean {
          return existsSync(path.join(ddata, rel));
        },
        async close() {
          await e2.shutdown();
          ddb.close();
        },
      };
      devices.push(dev);
      return dev;
    },
    async close() {
      for (const d of devices) await d.close();
      await engine.shutdown();
      db.close();
    },
  };
  const devices: { close(): Promise<void> }[] = [];
  return h;
}

/** upload commands with the given file conflict strategy (-f) */
export const uploadsWith = (cmds: Cmd[], strategy: string) =>
  cmds.filter((c) => c.cmd === 'filesystem upload' && c.args[c.args.indexOf('-f') + 1] === strategy);
