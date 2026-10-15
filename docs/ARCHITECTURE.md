# Nucleon Sync — Architecture

This document describes how Nucleon Sync is built, for contributors. It reflects the current code (version 0.3.0).
What the sync does from a user's point of view (directions, deletions, conflicts, brakes) is in
[`SYNC-RULES.md`](SYNC-RULES.md); the agent-facing CLI contract is in [`CLI-JSON.md`](CLI-JSON.md); the feature
audit "everything in the GUI, everything for agents" is in [`PARITY.md`](PARITY.md).

Nucleon Sync is a third-party application. It is not affiliated with or endorsed by Proton AG. Proton and Proton
Drive are trademarks of Proton AG. The app talks to Proton only through the official, unmodified `proton-drive`
CLI; it does not use a reverse-engineered API.

---

## 1. Overview

```
                ┌──────────────────────────── Electron UI (ui/) ─────────────────────────────┐
                │ renderer (React, sandboxed) ⇄ IPC allowlist ⇄ main (tray, notifications)   │
                └───────────────────────────────┬────────────────────────────────────────────┘
   nucleon-sync CLI (humans, agents) ──┐        │ HTTP/JSON + SSE, bearer token
   status bar helper (bar.json) ◄──┐   │        │ Unix socket $XDG_RUNTIME_DIR/nucleon-sync/api.sock
                                   │   ▼        ▼ (optional TCP 127.0.0.1:<port>)
┌────────────────────────── nucleon-syncd (daemon/, systemd user service) ──────────────────────────┐
│ API server ── Engine facade ─┬─ Scheduler (incremental every 6 h, full every 4 weeks, catch-up)   │
│                              ├─ Local scanner (stat walk, sha1 on change) ──► pair roots          │
│                              ├─ Remote crawler (list via CLI: hot + rotating slice | full)        │
│                              ├─ Planner (3-way diff → jobs, moves/adoption, conflicts, brakes)    │
│                              ├─ Job queue (SQLite, resumable) → Executor (verify → act → verify)  │
│                              ├─ Notifier (notify command; desktop via the UI)                     │
│                              └─ CLI pool: per account N × ReplWorker ─┐                           │
│ State DB: ~/.local/state/nucleon-sync/state.sqlite (node:sqlite, WAL) │                           │
└───────────────────────────────────────────────────────────────────────┼───────────────────────────┘
                     env-isolated child processes (one REPL each)       ▼
      ┌────────────────── account alex ──────────────────┐   ┌────────────── account sam ───────────────┐
      │ proton-drive (REPL) w0, w1                       │   │ proton-drive (REPL) w0                   │
      │ PROTON_DRIVE_CACHE_DIR=…/accounts/alex/cli/wN    │   │ …/accounts/sam/cli/w0                    │
      │ CREDENTIALS_STORE=pass → secret shim → keyring   │   │ pass → secret shim → keyring             │
      │   item service=nucleon-sync account=alex         │   │   item service=nucleon-sync account=sam  │
      └──────────────────────────────────────────────────┘   └──────────────────────────────────────────┘
                                   │ HTTPS (Proton Drive API, spoken by the official CLI)
```

Principles:

- The daemon is the only writer of the state DB and the only component that runs the CLI. The dashboard, the CLI
  client and agents are API clients.
- Every remote mutation is a persisted job. Every job verifies before and after acting.
- Decisions are made by the engine from a three-way comparison (local, remote, base). The CLI is only asked to do
  precise single actions; it never uploads trees blindly.
- Nothing is deleted outright: local files go to the freedesktop trash, remote nodes to the Proton trash. Emptying
  the Proton trash is a separate, always confirmed action.
- Be gentle with Proton's servers: few parallel processes, persistent REPL workers instead of one process per call,
  a slow default schedule (§11).

A fresh install starts empty: no accounts, no pairs. The first-run wizard of the packaged app, or the CLI
(`nucleon-sync accounts add`, `accounts login`, `pairs add`), creates them.

---

## 2. Technology choices

| Area          | Choice                                                                                                               | Reasons                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daemon        | Node ≥ 26 + TypeScript, run directly with Node's type stripping (no build step in development; `erasableSyntaxOnly`) | Shares DTO types with the dashboard and the CLI client (`shared/`), one toolchain (pnpm), async process management for REPL workers, `node:sqlite` built in (no native module to rebuild). |
| DB            | SQLite via `node:sqlite` (`DatabaseSync`), WAL, `busy_timeout`                                                       | Embedded, transactional, inspectable with `sqlite3`.                                                                                                                                       |
| UI            | Electron 44, React 19, esbuild bundling (main/preload CJS, renderer ESM), plain CSS variables                        | Data-heavy dashboard with a tray icon on Linux desktops; esbuild is one small build tool.                                                                                                  |
| Tests         | vitest (all packages), a behavioural mock of the CLI, Playwright `_electron` for UI e2e                              | Nothing in the test suite talks to Proton.                                                                                                                                                 |
| Lint/format   | ESLint + typescript-eslint, TypeScript 6, Prettier 3                                                                 |                                                                                                                                                                                            |
| Packaging     | AUR (`nucleon-sync`, `nucleon-sync-bin`), AppImage (electron-builder), source checkout with a user unit              | §16                                                                                                                                                                                        |
| Packaged Node | The daemon, CLI client and shim are bundled with esbuild and run on Electron's Node (`ELECTRON_RUN_AS_NODE=1`)       | No system Node needed for packaged installs.                                                                                                                                               |

Dependency versions are pinned exactly.

---

## 3. Repository layout

```
nucleon-sync/
├─ shared/         @nucleon-sync/shared — DTOs (api.ts, ext-*.ts), events, defaults, XDG paths, API client,
│                  daemon message catalogue (messages.ts), status-bar formatter (bar.ts)
├─ daemon/
│  ├─ src/main.ts               bootstrap (paths, daemon.json, DB, tokens, API, engine, signals)
│  ├─ src/api/                  HTTP server, routes, auth, agent tokens, confirm/approvals, SSE, bar files
│  ├─ src/bin/nucleon-sync.ts   CLI client (humans and agents, --json contract)
│  ├─ src/cli/                  ReplWorker, pool, env builder, error classifier, quirks, login/logout, progress
│  ├─ src/db/                   schema.sql, migrations/, repositories
│  ├─ src/engine/               scanner, crawler, planner, decision tables, queue, executor, scheduler, limiter
│  ├─ src/accounts/             accounts, pairs, storage, settings, pause timers, maintenance, doctor, keyring
│  ├─ src/notify/               notifier (notify command), one-time clean-up of a 0.3.x bot token
│  └─ test/                     vitest: unit, scenarios against the mock CLI, contract, API, robustness
├─ mock-cli/       behavioural fake of proton-drive 0.9 (REPL + one-shot) and a seed tool
├─ secret-shim/    pass-compatible per-account credential shim (libsecret / encrypted file / test file)
├─ ui/             Electron app (main, preload, renderer), unit and e2e tests
├─ agent-skill/    SKILL.md for coding agents (Agent Skills format)
├─ packaging/      aur/, arch/ (units and launchers of the packages), systemd/ (unit template for a source
│                  checkout), desktop/, omarchy/, icons/
├─ scripts/        dev launcher, mock seeding, smoke test, package.mjs, install-user.sh, packaged-app test
└─ docs/
```

---

## 4. Daemon internals

### 4.1 Modules

- `engine/engine.ts` — facade used by the API (`EngineApi` in `engine/api.ts`): status, runs, jobs, activity, tree,
  rules, conflicts, deletions, adoptions, held deletions, digest backfill, empty trash, brakes, pause, reload.
- `engine/remote.ts` — `RemoteOps`, the **only** place that builds `proton-drive` command lines (the login runner and
  the read-only CLI passthrough are the documented exceptions); strict output parsers; the write guard.
- `engine/scanner.ts`, `engine/crawler.ts` — local and remote snapshots.
- `engine/decide.ts` — pure decision tables per direction (exhaustively tested).
- `engine/planner.ts` — classification, move pairing, folder moves, adoption, conflicts, pending deletions,
  mass-delete guard.
- `engine/queue.ts`, `engine/executor.ts` — persistent job queue and execution.
- `engine/entries.ts` (row merges after moves), `engine/trash.ts` (freedesktop trash), `engine/nested.ts` (nested
  pairs), `engine/rules.ts` (selection rules and exclusion heuristics), `engine/limiter.ts`, `engine/scheduler.ts`,
  `engine/settings.ts` (read-only settings view).
- `cli/replWorker.ts`, `cli/pool.ts`, `cli/oneshot.ts`, `cli/env.ts`, `cli/classify.ts`, `cli/quirks.ts`,
  `cli/compat.ts`, `cli/login.ts`, `cli/progress.ts`.
- `api/daemon.ts` (assembly: DB, tokens, engine, services, API; used by `main.ts` and tests), `api/server.ts`
  (transport, auth, permissions, SSE), `api/routes.ts` (route table), `api/confirm.ts` (confirm tokens, approvals),
  `api/agentTokens.ts`, `api/barFile.ts`, `api/services.ts`.
- `accounts/*` — account and pair management, storage measurement, settings, timed pauses, maintenance summary,
  doctor, keyring presence and the foreign-process gate.
- `notify/*` — notifier (§12).

### 4.2 Engine facade and remote operations (sketch)

```ts
// engine/engine.ts — facade used by the API
class Engine extends EventEmitter /* emits 'event': DaemonEvent */ {
  status(): StatusDto;
  accounts(): AccountDto[];
  pairs(): PairDto[];
  activity(limit, beforeId?, filter?): ActivityItem[];
  runs(limit): RunDto[];
  runById(id): RunDto;
  jobs(filter): JobDto[];
  requestSync(req: SyncRequest, trigger): SyncResponse;
  pause(req: PauseRequest): void;
  resume(req: PauseRequest): void;
  tree(pairId, relPath): TreeNodeDto[];
  setRules(pairId, rules: SelectionRule[]): void;
  conflicts(): ConflictDto[];
  resolveConflict(id, res: ConflictResolution, by: string): void;
  deletions(): PendingDeletionDto[];
  decideDeletions(req, by): { jobIds };
  decideHeld(pairId, approve: boolean, by): DecideHeldDeletionsResponse;
  adoptions(): AdoptionProposalDto[];
  decideAdoptions(ids, accept: boolean, by): void;
  startDigestBackfill(pairId, relPrefix?, limit?): number;
  emptyTrash(accountId, by): Promise<void>;
  releaseBrake(pairId, by): void;
  reload(): Promise<void>;
}

// engine/remote.ts
interface RemoteOps {
  list(folder: RemoteRef): Promise<RemoteNode[]>; // filesystem list -j <section>/<uid>
  info(node: RemoteRef): Promise<RemoteNode>; // filesystem info -j
  mkdir(parent: RemoteRef, name: string): Promise<RemoteNode>; // create-folder, then list to learn the uid
  upload(files, parent, strategy: 'skip' | 'create-new-revision' | 'replace', bytes?): Promise<{ summary; error }>;
  download(node, localDir, bytes?): Promise<{ summary; error }>; // -f skip -d merge into a staging dir
  move(nodes, newParent): Promise<void>;
  rename(node, newName): Promise<void>;
  trash(nodes): Promise<void>;
  size(node): Promise<{ size; numberOfDescendants }>;
  // + listDevices(), probe(), emptyTrash(); every write method throws WriteBlockedError while the write guard is on
}
type RemoteRef = { section: string; uid: string } | { path: string }; // uid form preferred
```

### 4.3 Run pipeline

A run has a mode (`incremental`, `full`, `verify`) and a scope (all, one account, one pair). Per pair:

1. **Preconditions**: account usable (logged in, not gated), pair enabled and not paused, no held deletions, CLI
   version known good (otherwise read-only).
2. **Remote root**: the root uid is resolved once by path (`info`) and cached in `pairs.remote_root_uid`; afterwards
   the root is addressed by uid, so renaming or moving the root folder in Proton does not break the pair.
3. **Local scan** → upsert `entries.l_*` (stat; sha1 only when size/mtime/ctime changed or unknown). Files younger
   than 10 s are postponed (not hashed, never treated as deleted).
4. **Safety brakes** on the scan result (missing or empty local root, mass disappearance; §9.4). A brake stops the
   pair before anything is planned.
5. **Apply missing**: entries not seen by a complete scan of their folder become locally absent.
6. **Remote crawl** → upsert `entries.r_*` and `remote_folders` (§11.2). Incremental crawls also list the parents of
   locally changed entries. Only folders whose listing **succeeded** can make children absent; a partial or failed
   crawl never produces deletions.
7. **Adoption sources** are crawled by background (full) runs only.
8. **Plan** (§9) → jobs, conflicts, pending deletions, adoption proposals. `dedupe_key` prevents duplicate open jobs.
9. **Execute**: the executor drains the pair's jobs through the account's CLI pool. When moves happened, up to two
   more plan/execute passes follow (a folder move reveals what is left to do).
10. **Finish**: run counters, `pairs.last_run_at` / `last_full_at`, notices.

Pairs of different accounts run in parallel; pairs of one account run one after another in the account's background
lane (§4.6).

### 4.4 Executor contract

| Job               | Pre-check                                                                                             | CLI                                                                                         | Post-check / state update                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mkdir`           | parent uid known                                                                                      | `filesystem create-folder -j <sec>/<parentUid> <name>`                                      | list parent → record uid                                                                                                                                      |
| `upload` (new)    | local stat equals the plan, sha1 computed                                                             | `filesystem upload -j -f skip -d skip [--skip-thumbnails] <files…> <sec>/<parentUid>`       | list parent: node with that name → `r_*` incl. revision uid and sha1; sha1 ≠ local → conflict `initial_mismatch` (never retried blindly); re-stat → base      |
| `upload_revision` | remote revision uid equals the base revision (re-checked with `info`/list if stale)                   | `filesystem upload -j -f create-new-revision -d skip … <file> <sec>/<parentUid>`            | list parent → new revision uid, sha1 equals local, base advanced                                                                                              |
| `download`        | free space ≥ size + 1 GiB; target not modified since planning                                         | `filesystem download -j -f skip -d merge <sec>/<uid> <staging>/job-<id>/`                   | size and sha1 (when Proton has one) verified; `utimes` = `claimedModificationTime`; old local file → trash if replacing; atomic rename; record `l_*` and base |
| `move` / `rename` | node still at the expected parent                                                                     | `filesystem move <sec>/<uid> <sec>/<newParentUid>` / `filesystem rename <sec>/<uid> <name>` | list target parent; rewrite `rel_path` of the entry (folder moves rewrite all descendants in one transaction)                                                 |
| `trash_remote`    | decision recorded; remote revision unchanged since the decision (else back to pending with a warning) | `filesystem trash <sec>/<uid>…`                                                             | entry removed                                                                                                                                                 |
| `trash_local`     | local snapshot unchanged since planning                                                               | — (freedesktop trash, same filesystem)                                                      | entry updated                                                                                                                                                 |
| `digest_backfill` | entry synced, digest missing, local sha1 equals base, local unchanged; not for two-way pairs          | `filesystem upload -j -f replace -d skip … <file> <sec>/<parentUid>`                        | list parent: new uid with sha1; the replaced node is in the Proton trash                                                                                      |
| `empty_trash`     | confirmed                                                                                             | `filesystem empty-trash`                                                                    | storage re-measured                                                                                                                                           |
| two-way jobs      | see §10                                                                                               | `conflict_copy`, `verify_content`, `move_local`                                             |                                                                                                                                                               |

Rules:

- Always `-j`; always explicit `-f`/`-d`. Never `-d merge` for uploads (the engine uploads files, not trees) and never
  `-d replace`. Reason: the CLI's "skip identical content" only works when the remote file has a sha1, so a blind
  tree upload with `create-new-revision` creates a new revision of every digest-less file. New files use `-f skip`, so
  an unexpected remote file is never overwritten; the engine then lists the parent and decides (adopt or conflict).
  `create-new-revision` is only used when the base proves the remote node is the previous version.
- One parent folder per upload command. Small files (≤ 8 MiB) into the same parent are batched (≤ 50 files or
  256 MiB per command); large files go one per command.
- Jobs whose parent folder has no uid yet wait for the open `mkdir`/`move` that creates it (no attempt counted), or
  create the missing `mkdir` themselves (self-healing).
- Downloads go to `<stagingDir>/job-<id>/` and are renamed into place. Across filesystems (EXDEV) the file is copied
  next to the target first, then renamed.
- A file modified during its upload: the base becomes what was uploaded (verified by the remote sha1), the local
  snapshot what is on disk; the entry stays `local_changed`, and the next run uploads a new revision.
- **Crash recovery**: a job found `running` at startup re-runs its pre-check, which detects completed work (e.g. a
  node with the expected name and sha1 already exists). Staging leftovers are cleaned at start.
- **Retries**: transient errors back off exponentially from 30 s to 30 min (max 8 attempts, integrity errors 3),
  then the job is `failed` with a visible error. `auth` errors restart the worker once, then the account goes to
  `needs_login`.
- **Offline**: 3 consecutive transient failures mark the account `offline`; no jobs are picked; a probe
  (`filesystem list -j /`) runs every 30 s and resumes the account.
- Pausing "immediately" kills the account's workers; interrupted jobs go back to the queue without burning an attempt.

### 4.5 Write guard

In production the executor refuses **every** job type (uploads, downloads, local folder creation, local trash moves)
unless the daemon runs with `NUCLEON_SYNC_ALLOW_WRITES=1`, so a "planning mode" run leaves both sides untouched.
Refused jobs stay `blocked` and are released when the daemon starts with writes enabled. An unknown CLI
`major.minor` puts the engine into the same read-only mode (notice `cli:version`).

The packaged units (AUR, wizard) set `NUCLEON_SYNC_ALLOW_WRITES=1`. The source-checkout template
(`packaging/systemd/nucleon-sync.service`) starts in planning mode (`=0`) on purpose: run `nucleon-sync doctor`,
look at the first planned run, then switch it on.

### 4.6 Per-account runs and the priority lane

- **Lanes** (`requestSyncTicket()`): every account has a background lane `acct:<id>` (scheduled, global,
  account-scoped and full/verify runs; one at a time per account); every pair has a priority lane `pair:<id>`
  (pair-scoped incremental runs: `nucleon-sync sync --pair N`, the dashboard's pair sync, rule changes, brake release,
  the fresh-file re-run). Runs in different lanes run in parallel. A global run holds the lanes of all accounts with
  enabled pairs and releases each one as soon as that account's pairs are done.
- **Queued runs**: a request for a busy lane becomes that lane's queued run. Its `runs` row exists at once
  (`status = 'queued'`, final id); later requests for the lane merge into it (scope union, the bigger mode wins). A
  global request while some accounts are busy is split into one run per account.
- **Same pair, two runs**: the local scan (+ brakes + applying missing files) is a per-pair FIFO mutex; planning is
  synchronous; remote crawls may overlap (per-folder absence is decided inside one transaction).
- **Priority jobs** (`queue.ts`, `PRIORITY_LANE = 1000`): a priority run lifts the jobs its plan created, plus open
  jobs of files changed locally within the last 10 min (max 200), so the executor (`ORDER BY priority, id`) runs them
  before the account's backlog. Derived jobs inherit the lane. CLI commands of lane jobs get a better slot priority.
  The account's worker cap is unchanged: a lane job starts when the next in-flight file is done.
- **Targeted crawl**: a priority run lists only the pair root, the parents of locally changed entries and folders
  newly found there. Two-way pair runs are never targeted (§10).
- **Waiting**: `POST /v1/sync` answers `SyncResponse {runId, runIds, followUp, queuedBehind, notRunnable,
writesBlocked}`; `nucleon-sync sync --wait` waits for exactly those runs. `GET /v1/runs/:id` returns one run.
- **Global process cap** (`cli/pool.ts` `ProcessBudget`): live `proton-drive` processes over all accounts ≤
  `transfer.maxWorkersTotal` (default 3). At the cap, the least recently used idle process is stopped first.
- **Restart**: on shutdown active runs keep `status = 'running'`, queued ones stay `queued`; at the next start they
  are cancelled and their scopes requested again as incremental runs (trigger `startup`) after 60 s.

### 4.7 Pause and gates

- The CLI pool has a **gate** (`gate()` returns `{reason, soft}`). Global or account pause is _soft_: nothing new
  starts, a job that already runs finishes its current file (its follow-up commands pass, tracked with
  `AsyncLocalStorage`), then the worker stops; idle workers stop at once. "Stop transfers immediately" kills. A gated
  pool never starts a process. `Engine.enforceGates()` re-checks every 15 s; idle workers stop after 10 min anyway.
- **Timed pauses** are persisted in `pause_timers` (`POST /v1/pause {until}`) and survive restarts of the UI and the
  daemon.
- **Foreign-process gate** (hard): an account does not run while another `proton-drive` process uses **its** stored
  session (another Nucleon Sync instance, a worker left over from a crashed daemon, a script started with the same
  session settings). Two processes refreshing one session can make one of them delete it (§5.1). The session identity
  of every process is derived from its environment (`accounts/keyring.ts` `sessionIdOf`); our workers carry
  `NUCLEON_SYNC_DAEMON_PID`. The account shows `error` with the PIDs until the process is gone; our own workers of that
  account are killed. Cached 30 s. `NUCLEON_SYNC_IGNORE_FOREIGN_CLI=1` disables the gate. A plain `proton-drive` run
  by the user with its default keychain store uses a different session and does not gate any account.

### 4.8 Transfer progress

`cli/progress.ts` (`TransferMonitor`) estimates live progress of a running transfer from the read offset of the file
in the CLI process (`/proc/<pid>/fdinfo`), then `rchar` of `/proc/<pid>/io`, then bytes in the staging directory,
then a time estimate. `StatusDto.transfers` reports running transfers and the upload/download backlog with rate and
ETA; the throughput EWMA is persisted in `meta('rate:<kind>')`. Files ≥ 100 MB get an activity row when they start.

---

## 5. Proton Drive CLI integration

### 5.1 Verified CLI facts (proton-drive 0.9.x)

Obtained from the CLI's help, its open source code (`ProtonDriveApps/sdk`, folder `cli/`) and read-only calls.

| Topic                            | Fact                                                                                                                                                                                                        | Consequence                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PROTON_DRIVE_CREDENTIALS_STORE` | accepts `keychain` (default), `unsafe_file`, `pass`                                                                                                                                                         | per-account isolation via `pass` + the shim                                                                     |
| keychain store                   | one fixed libsecret item (`service=ch.proton.drive/drive-sdk-cli`, `account=auth-session`, schema `com.oven-sh.bun.Secret`)                                                                                 | only one account per desktop session with the default store                                                     |
| pass store                       | spawns `pass show`, `pass insert -f -m`, `pass rm -f` for `ch.proton.drive/drive-sdk-cli/auth-session` from `PATH`                                                                                          | the shim is a drop-in `pass`                                                                                    |
| unsafe_file store                | plaintext `auth-session.json`                                                                                                                                                                               | not used                                                                                                        |
| `PROTON_DRIVE_CACHE_DIR`         | overrides the cache, app and log directories                                                                                                                                                                | one directory per account and worker isolates SQLite caches, the events DB, `clientUid.json` and logs           |
| `PROTON_DRIVE_LOG_LEVEL`         | default `DEBUG` (≈ 5 MB of logs every few minutes under load)                                                                                                                                               | set to `INFO`; `INFO [api] … (NNNms)` lines give request latency                                                |
| `PROTON_DRIVE_UNSAFE_CACHE`      | stores the crypto cache unencrypted ("only for testing")                                                                                                                                                    | never set                                                                                                       |
| REPL mode                        | no arguments → prompt `proton-drive> `, one command per line, POSIX-like quoting, recoverable errors on stderr, `exit`/EOF ends it                                                                          | persistent workers: a metadata call costs a fraction of a one-shot call, which needs a full bootstrap each time |
| UID path segments                | a path segment matching the uid format resolves via `getNode(uid)`; name segments iterate the folder's children                                                                                             | address nodes as `<section>/<uid>` (e.g. `/my-files/<uid>`): O(1) instead of O(depth × children)                |
| Upload skip                      | identical content is skipped **only** if the existing node's `activeRevision.claimedDigests.sha1` equals the local sha1                                                                                     | files without a remote sha1 ("digest-less", e.g. uploaded by older clients) must be decided by the engine       |
| Upload output (`-j`)             | only `{transferredItems, transferredBytes, skippedItems, failedItems, failures:[{name, nodeUid?, error}]}`                                                                                                  | after every upload the parent is listed to learn uid, revision and sha1                                         |
| Interactive conflicts            | disabled in JSON mode → error `Name conflict on "<name>" …`                                                                                                                                                 | always pass strategies                                                                                          |
| Download                         | verifies sha1 when present; does **not** set mtime; skips Proton Docs                                                                                                                                       | the engine sets mtime and uses staging + rename                                                                 |
| Upsell                           | on quota errors without `-j` it opens a browser                                                                                                                                                             | always `-j`; `BROWSER=true` in the worker env                                                                   |
| Login                            | `auth login -j` prints `{"signInUrl": "..."}` and waits; the URL can be opened on another device                                                                                                            | the dashboard shows URL + QR; the daemon runs the process                                                       |
| Token refresh                    | on 401 the SDK refreshes; a refresh failing with 4xx (≠ 429) calls `credentials.signOut()` → `store.remove()`                                                                                               | parallel processes of one account can delete the stored session → the shim suppresses `rm` (§5.4)               |
| list JSON (file)                 | `uid, parentUid, name{ok,value}, type, mediaType, creationTime, modificationTime, totalStorageSize, activeRevision{uid, state, storageSize, claimedSize, claimedModificationTime, claimedDigests{sha1}}, …` | mapped into `entries.r_*`                                                                                       |
| `/devices` listing               | `{uid, type, rootFolderUid, name{ok,value}, …}`                                                                                                                                                             | device roots (e.g. `/devices/Workstation`)                                                                      |
| `filesystem size -j`             | `{"size": n, "numberOfDescendants": n}` including trashed descendants                                                                                                                                       | storage screen                                                                                                  |
| Folder `modificationTime`        | does not change when children change; there is no change feed in the CLI                                                                                                                                    | remote changes are found by listing (§11.2)                                                                     |
| Error texts                      | `Path "/x" not supported`, `You need to login first`, `Name conflict on …`, `TypeError: fetch failed`, `No paths matched`, `Unknown option …`                                                               | `cli/classify.ts` maps them to classes (`transient`, `auth`, `rate_limited`, `quota`, `local_io`, `fatal`, …)   |

The contract tests (`daemon/test/contract/`) parse recorded output shapes; the mock CLI must produce the same shapes.
`daemon/test/contract/record-fixtures.ts` records new fixtures with read-only commands, only when run by hand with
`NUCLEON_SYNC_RECORD_FIXTURES=1`.

### 5.2 Known CLI quirks (`cli/quirks.ts`)

1. **Local upload paths are glob patterns.** A path containing `[`, `]`, `*` or `?` matches nothing; `[ ]` cannot be
   escaped. A brace list `{a,b}` would expand; `{x}` passes unchanged. Fix: hard-link (reflink/copy fallback) the file
   into `<staging>/upload-links/`; if the _name_ itself is affected, upload it as `<name>.psync-<hash>.tmp` and rename
   the node remotely afterwards (`*.tmp` is a default exclusion; leftovers of an interrupted attempt are reused).
2. **Names starting with `-`** are parsed as options: they go after `--`.
3. **Thumbnails**: thumbnail generation loads the whole image into memory and fails for some formats.
   `--skip-thumbnails` is passed for TIFF, RAW formats, PSD, EXR, HEIC, JPEG 2000 and every file > 100 MB, plus one
   retry with it after a thumbnail failure. The setting `transfer.thumbnails = false` skips them for all files.
4. **Downloads do not set mtime**: the executor sets it from `claimedModificationTime`.
5. **Version string** `Proton Drive CLI cli-drive@0.9.0+<hash>` is parsed in `compat.ts`.

### 5.3 REPL protocol (`cli/replWorker.ts`)

1. `spawn(cliPath, [], { env })`; wait for stdout to end with `proton-drive> ` (start timeout 60 s).
2. For each command write the quoted arguments and a newline; collect stdout until it ends with the prompt. Non-empty
   stderr during the command (+ a short drain) ⇒ `CliError` with `errorClass = classifyCliError(stderr)`; stdout is
   still returned (upload summaries).
3. Exactly one command in flight per worker (internal queue).
4. **Per-command timeouts** (`engine/remote.ts` `DEFAULT_CLI_TIMEOUTS`, overridable with daemon.json `cliTimeouts`):
   list/size 120 s, info/probe 60 s, create-folder/move/rename/trash 120 s, empty-trash 10 min, transfers
   120 s + bytes at 1 MiB/s. On timeout the worker is killed (`cli_timeout` in the journal), the job goes to
   `retry_wait`.
5. Process exit ⇒ the pending command is rejected ⇒ the pool restarts the worker with backoff (1 s, 5 s, 30 s, 2 min).
6. Workers are recycled after 2,000 commands or 6 h (memory hygiene, picks up refreshed sessions).
7. Arguments containing newlines are rejected (`unsupported`).
8. Fallback: `NUCLEON_SYNC_CLI_ONESHOT=1` runs every command as a separate process (same parser; for debugging or if
   a future CLI breaks REPL mode).

The pool starts worker 0 first and runs one cheap call before starting the others, so a due token refresh happens
once.

### 5.4 Credentials: the `pass` shim (`secret-shim/`)

The CLI is started with `PROTON_DRIVE_CREDENTIALS_STORE=pass`, `PATH=<shim dir>:$PATH` and
`NUCLEON_SYNC_ACCOUNT=<id>`. The shim implements `show`, `insert -f -m`, `rm -f` and the extension `has` against one
of these backends:

- **`libsecret`** (default): Secret Service item `service=nucleon-sync`, `account=<id>` via `secret-tool`
  (GNOME Keyring, KWallet, KeePassXC, …). Secrets pass only through pipes, never argv, environment or disk.
- **`encfile`** (no Secret Service, chosen explicitly in the wizard or with daemon.json `secretBackend`): AES-256-GCM
  file `~/.local/state/nucleon-sync/secrets/<id>.enc` (0600), AAD = account id, 32-byte key in
  `~/.config/nucleon-sync/secret.key` (0600).
- **`file`**: plaintext, tests and the mock only.

**Logout suppression.** `rm` is a no-op unless `NUCLEON_SYNC_ALLOW_LOGOUT=1`. Only the explicit logout flow
(`DELETE /v1/accounts/:id/session`, `nucleon-sync accounts logout ID`, the dashboard's "Log out …") sets it. Reason:
the CLI calls `pass rm` whenever a token refresh fails with 4xx, which happens when two processes of the same account
race on the rotating refresh token. Without the suppression one losing worker would wipe the session for everybody.
The shim appends `{ts, account, op, result}` lines to `~/.local/state/nucleon-sync/shim-events.jsonl` (never
secrets); the pool treats a `rm suppressed` event or an `auth` error as "this worker's in-memory session is stale" and
restarts that worker, which loads the fresh session written by the winner. Tested in `daemon/test/replWorker.test.ts`
and `daemon/test/scenarios/s09-refresh-race.test.ts` with the mock's server-side refresh-token rotation.

`insert` writes only if the value changed.

**Presence without reading secrets.** `pass has` answers exit 0 present, 1 missing, 3 Secret Service unavailable,
4 locked. The libsecret backend uses D-Bus `SearchItems` (busctl) and never reads the value. Used at boot (accounts go
to `needs_keyring` and are retried every 60 s while the keyring is locked or unavailable; `needs_login` when the item
is missing), by `doctor` and after account creation.

The code still knows a credential backend `keychain-direct` and an "adopted" account that shares the plain CLI's
keychain item (`PLAIN_CLI_SECRET` in `accounts/context.ts`). No API or wizard step creates such accounts.

### 5.5 Adding an account (login flow)

1. `POST /v1/accounts {id:"sam", displayName:"Sam"}` (CLI: `nucleon-sync accounts add sam Sam`) → row with
   `credential_backend` `keyring-shim` (or `encfile`), `secret_service="nucleon-sync"`, `secret_key="sam"`, status
   `needs_login`.
2. `POST /v1/accounts/sam/login` → the daemon spawns a one-shot `proton-drive auth login -j` with the account's env
   (own cache dir, shim, `BROWSER=true`), reads `{"signInUrl"}` from stdout and emits SSE `login {phase:'url',
signInUrl}`. The dashboard shows the URL and a QR code (generated locally, no network) together with the notice
   "This is a third-party application not officially supported by Proton."
3. The user opens the URL on any device and approves. The CLI stores the session via `pass insert` (→ shim → keyring
   item `nucleon-sync/sam`) and exits 0 → SSE `login {phase:'done'}`; the daemon lists `/` and `/devices` to fill the
   account card; the e-mail comes from `ownedBy.email` of the root listing.
4. Timeout 10 min (`NUCLEON_SYNC_LOGIN_TIMEOUT_MS`) → the process is killed, `login {phase:'failed'}`.
   `DELETE /v1/accounts/:id/login` cancels a running login.

**Logout** runs `proton-drive auth logout` with `NUCLEON_SYNC_ALLOW_LOGOUT=1` and removes the keyring item. Removing
an account (`DELETE /v1/accounts/:id`) is refused while it still has pairs and does not touch the keyring item (log
out first).

### 5.6 Per-worker environment (`cli/env.ts`)

```
HOME, USER, LANG, PATH=<shim dir>:$PATH, DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR
PROTON_DRIVE_CACHE_DIR=~/.local/state/nucleon-sync/accounts/<id>/cli/w<N>   (0700; clientUid.json seeded from accounts/<id>/)
PROTON_DRIVE_CREDENTIALS_STORE=pass, NUCLEON_SYNC_ACCOUNT=<id>, NUCLEON_SYNC_SECRET_{BACKEND,SERVICE,KEY,SCHEMA,FILE_DIR,KEYFILE}
NUCLEON_SYNC_SHIM_EVENTS=~/.local/state/nucleon-sync/shim-events.jsonl
PROTON_DRIVE_LOG_LEVEL=INFO, BROWSER=true, NUCLEON_SYNC_DAEMON_PID=<daemon pid>
```

No other variables are inherited (no accidental `PROTON_DRIVE_UNSAFE_CACHE`, no `XDG_CACHE_HOME` leaks). Separate
cache directories per worker avoid SQLite lock contention between workers of one account. All workers of one account
share one client UID.

### 5.7 CLI binary, version check and installation

- **Location**: daemon.json `cliPath`, else `~/.local/bin/proton-drive` if present (the copy the wizard installs),
  else the first `proton-drive` on `PATH` (e.g. `/usr/bin/proton-drive` from the AUR package
  `proton-drive-cli-bin`). `NUCLEON_SYNC_CLI` overrides all of them.
- **Version check**: at startup and whenever the binary's mtime/size changes, a one-shot `proton-drive --version`
  (it prints `Proton Drive CLI …` and `Proton Drive SDK …`, and may print a hint about a newer release, which the
  dashboard shows). The tested `major.minor` list is `TESTED_CLI_MINORS` in `shared/src/defaults.ts`. An untested
  version puts the daemon into read-only mode with a notice until the contract tests have been re-run for it.
- **Installation by the wizard** (`ui/src/main/setup.ts`): uses an installed `proton-drive` when there is one;
  otherwise downloads the official build listed in `https://proton.me/download/drive/cli/version.json`. It prefers the
  newest stable release of a tested `major.minor`, verifies the SHA-512 against Proton's manifest **and**, for the
  versions this release was tested with, against `PINNED_CLI_SHA512` in `shared/src/defaults.ts` (the manifest comes
  from the same origin as the binary, so on its own it only proves integrity), then installs atomically to
  `~/.local/bin/proton-drive`. A pinned version whose manifest hash differs is refused.
- **No auto-update**: neither the CLI nor the app updates itself.

---

## 6. Local API

### 6.1 Transport and authentication

- Unix socket `$XDG_RUNTIME_DIR/nucleon-sync/api.sock` (directory 0700, socket 0600) is the primary transport.
- Optional TCP on `127.0.0.1:<port>` only (daemon.json `tcpPort` or `NUCLEON_SYNC_API_PORT`). TCP requests must carry
  `Host: 127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard), and every request with an `Origin` header is
  rejected (no browser access, no CORS).
- Every request needs a bearer token. The **UI token** (`~/.config/nucleon-sync/api-token`, 0600) has every
  permission; **agent tokens** carry scopes (§7).
- JSON bodies, ISO timestamps, errors `{error, code}`. A route whose optional engine method is missing answers 501.

### 6.2 Permissions

Every route declares a permission: `read`, `sync`, `manage`, `destructive` or `ui` (UI token only). An agent token
without the needed scope gets 403 with `needs: "<scope>"`. Destructive requests of agents additionally need the
user's approval (§7.2).

### 6.3 Routes

Route table: `daemon/src/api/routes.ts`.

| Method               | Path                                                           | Body / query                                 | Response                                            | Permission                                                                                     |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET                  | `/v1/health`                                                   |                                              | `{ok, apiVersion}`                                  | read                                                                                           |
| GET                  | `/v1/status`                                                   |                                              | `StatusDto` (+ `pausedUntil`)                       | read                                                                                           |
| GET                  | `/v1/whoami`                                                   |                                              | `WhoAmIDto`                                         | read                                                                                           |
| GET                  | `/v1/events`                                                   |                                              | SSE `DaemonEvent`                                   | read                                                                                           |
| GET                  | `/v1/runs?limit=`, `/v1/runs/:id`                              |                                              | `RunDto[]`, `RunDto`                                | read                                                                                           |
| GET                  | `/v1/jobs?state=&limit=`                                       |                                              | `JobDto[]`                                          | read                                                                                           |
| GET                  | `/v1/activity?limit=&before=&account=&pair=&action=&since=&q=` |                                              | `ActivityItem[]`                                    | read                                                                                           |
| POST                 | `/v1/sync`                                                     | `SyncRequest`                                | `SyncResponse`                                      | sync                                                                                           |
| POST                 | `/v1/pause`, `/v1/resume`                                      | `PauseRequest` (`until`, `immediate`, scope) | `{ok}`                                              | sync                                                                                           |
| GET                  | `/v1/accounts`, `/v1/accounts/:id`                             |                                              | `AccountDto[]`, `AccountDto`                        | read                                                                                           |
| POST                 | `/v1/accounts`                                                 | `CreateAccountRequest`                       | `AccountDto`                                        | manage                                                                                         |
| PATCH                | `/v1/accounts/:id`                                             | `PatchAccountRequest`                        | `AccountDto`                                        | manage                                                                                         |
| DELETE               | `/v1/accounts/:id`                                             | `{confirmToken?}`                            | `{ok}`                                              | destructive                                                                                    |
| POST / DELETE        | `/v1/accounts/:id/login`                                       |                                              | `LoginStartResponse` (+ SSE `login`) / `{ok}`       | manage                                                                                         |
| DELETE               | `/v1/accounts/:id/session`                                     | `{confirmToken?}`                            | `{ok}` (logout)                                     | destructive                                                                                    |
| POST                 | `/v1/accounts/:id/cli`                                         | `CliPassthroughRequest`                      | `CliPassthroughResponse`                            | sync (read-only allowlist: `filesystem list\|info\|size`); `allowWrite` only with the UI token |
| GET                  | `/v1/accounts/:id/storage`, `/v1/storage`                      |                                              | `StorageDto`, `StoragePoolDto`                      | read                                                                                           |
| GET                  | `/v1/storage/history?days=`                                    |                                              | `StorageHistoryPoint[]`                             | read                                                                                           |
| POST                 | `/v1/storage/measure`                                          | `{accountId?, wait?}`                        | `StoragePoolDto` or `{started, skipped, measuring}` | sync                                                                                           |
| GET                  | `/v1/pairs`, `/v1/pairs/:id`                                   |                                              | `PairDto[]`, `PairDto`                              | read                                                                                           |
| POST                 | `/v1/pairs/preview`                                            | `CreatePairRequest`                          | `PairPreviewDto` (dry run, reads only)              | manage                                                                                         |
| POST                 | `/v1/pairs`                                                    | `CreatePairRequest` (`createRemote?`)        | `PairDto`                                           | manage                                                                                         |
| PATCH                | `/v1/pairs/:id`                                                | `PatchPairRequest`                           | `PairDto`                                           | manage (direction change: confirm; agents: approval)                                           |
| DELETE               | `/v1/pairs/:id`                                                | `{confirmToken?}`                            | `{ok}` (only the sync state is removed)             | destructive                                                                                    |
| GET                  | `/v1/pairs/:id/tree?path=`                                     |                                              | `TreeNodeDto[]`                                     | read                                                                                           |
| GET / PUT            | `/v1/pairs/:id/rules`                                          | `SelectionRule[]`                            | `SelectionRule[]` / `{ok}`                          | read / manage                                                                                  |
| POST                 | `/v1/pairs/:id/release-brake`                                  | `{confirmToken?}`                            | `{ok}`                                              | destructive                                                                                    |
| POST                 | `/v1/pairs/:id/held-deletions`                                 | `{approve}`                                  | `DecideHeldDeletionsResponse`                       | manage (`approve: true`: destructive)                                                          |
| GET                  | `/v1/remote/:accountId/browse?path=`                           |                                              | `RemoteBrowseEntry[]` (pair wizard)                 | manage                                                                                         |
| GET                  | `/v1/conflicts`                                                |                                              | `ConflictDto[]`                                     | read                                                                                           |
| POST                 | `/v1/conflicts/:id/resolve`                                    | `ResolveConflictRequest`                     | `{ok}`                                              | manage (resolutions that trash: destructive)                                                   |
| GET                  | `/v1/deletions`                                                |                                              | `PendingDeletionDto[]`                              | read                                                                                           |
| POST                 | `/v1/deletions/decide`                                         | `DecideDeletionsRequest`                     | `{ok, jobIds}`                                      | manage (`trash_remote`/`trash_local`: destructive)                                             |
| GET / POST           | `/v1/adoptions`, `/v1/adoptions/decide`                        | `{ids, accept}`                              | `AdoptionProposalDto[]` / `{ok}`                    | read / manage                                                                                  |
| GET / PUT            | `/v1/settings`                                                 | `SettingsDto` (partial on PUT)               | `SettingsDto`                                       | read / manage                                                                                  |
| GET                  | `/v1/doctor`                                                   |                                              | `DoctorCheck[]`                                     | read                                                                                           |
| GET                  | `/v1/notifications?limit=`                                     |                                              | `NotificationLogItem[]`                             | read                                                                                           |
| GET                  | `/v1/notifications/config`                                     |                                              | `NotificationConfigDto`                             | read                                                                                           |
| POST                 | `/v1/notifications/test`                                       | `{channel?: 'command'}`                      | `NotificationTestResult[]`                          | ui                                                                                             |
| GET                  | `/v1/maintenance/summary`                                      |                                              | `MaintenanceSummaryDto`                             | read                                                                                           |
| POST                 | `/v1/maintenance/digest-backfill`                              | `{pairId, relPrefix?, limit?}`               | `{runId}`                                           | destructive                                                                                    |
| POST                 | `/v1/maintenance/empty-trash`                                  | `{accountId, confirmToken?}`                 | `{ok}`                                              | destructive                                                                                    |
| GET / POST           | `/v1/tokens/agent`, `/v1/tokens/agent/rotate`                  | `{confirmToken?}`                            | `AgentTokenDto`                                     | ui                                                                                             |
| GET / POST           | `/v1/tokens`                                                   | `CreateAgentTokenRequest`                    | `AgentTokenInfoDto[]` / `CreateAgentTokenResponse`  | ui                                                                                             |
| GET / PATCH / DELETE | `/v1/tokens/:id`                                               | `PatchAgentTokenRequest` / `{confirmToken?}` | `AgentTokenInfoDto` / `{ok}`                        | ui                                                                                             |
| GET                  | `/v1/approvals`                                                |                                              | `ApprovalDto[]`                                     | ui                                                                                             |
| GET                  | `/v1/approvals/:id`                                            |                                              | `ApprovalDto`                                       | read (agents: own approvals only)                                                              |
| POST                 | `/v1/approvals/:id/approve`, `/v1/approvals/:id/deny`          |                                              | `ApprovalDto`                                       | ui                                                                                             |

### 6.4 Confirm round-trip

The first call without `confirmToken` returns `409 {code:'conflict', confirmToken, summary}`; the same call with the
token within 5 min executes. Tokens are single use and bound to method + path + body (and, for agents, to the agent
token). Summaries are English for CLI and agents and carry a stable `kind` plus `params` (`ConfirmSummaryDto`), which
the dashboard translates.

With the UI token these steps are confirmed: account removal, logout, pair removal, direction change of a pair that
has entries, brake release, approving held two-way deletions, conflict resolutions that trash a file (classic
`keep_remote` in backup pairs, `keep_local` with the local file missing, two-way review choices), deletion decisions
`trash_remote`/`trash_local` above 100 files or 1 GB, empty trash, agent token rotation and revocation. With an agent token every destructive step goes through the approval flow (§7.2), whatever its size.

### 6.5 Server-sent events

`hello` (full status) on connect, `heartbeat` every 15 s, coalesced `status` (≤ 1/s), `activity`, `job` (throttled,
progress every 2 s), `run`, `account`, `login`, `storage`, `notice`, `conflicts_changed`, `deletions_changed`,
`approval`. Clients reconnect after 3 s and re-fetch the status. Revoking or narrowing an agent token closes its
streams.

---

## 7. Agent layer

### 7.1 Tokens and scopes (`api/agentTokens.ts`)

- **Principal.** Each request is authenticated as the UI principal (every permission) or an agent token with scopes.
- **Scopes:**
  - `read` (implied for every token);
  - `sync`: sync, pause/resume, storage measurement, read-only CLI passthrough;
  - `manage`: accounts, pairs, rules, settings, non-trashing conflict resolutions and deletion decisions, adoptions,
    remote browsing;
  - `destructive`: remove a pair or account, log out, release a brake, empty the trash, digest backfill, and every
    step inside a `manage` route that trashes something (`trash_remote`/`trash_local`, trashing conflict resolutions,
    approving held deletions).
  - Token and approval management is UI-only.
- **Registry**: `~/.config/nucleon-sync/agent-tokens.json` (0600) stores id, name, scopes, timestamps and the
  SHA-256 of each secret, never the secret. Lookups compare digests in constant time.
- **Secret files**: the secret is written once to `~/.config/nucleon-sync/agent-tokens/<id>.token` (0600, directory 0700) so local agents can use `nucleon-sync --agent NAME`. Revoking deletes the file.
- **Format**: `nst_` + 32 random bytes in base64url.
- **Built-in token**: `~/.config/nucleon-sync/agent-token` is the built-in token `default` (read + sync). It can be
  rotated and disabled, not deleted.
- **Revoking, disabling or narrowing** a token takes effect at once, closes its SSE streams and drops its open
  approvals. `lastUsedAt` is written at most every 30 s.

### 7.2 Approval of destructive agent requests (`api/confirm.ts`)

The user approves; an agent never confirms on its own behalf.

1. **Request.** The agent sends a destructive request. Answer: `409 {error:'approval required', confirmToken, summary,
approval:{id, state:'requested'}}`. The user sees nothing yet.
2. **Confirm.** The agent repeats the identical request with `confirmToken` (CLI: `--yes`). The state becomes
   `pending`, SSE `approval` is broadcast: the dashboard shows a modal (Deny has the initial focus), main sends a
   desktop notification, the request appears in Settings → Agents.
3. **Decide.** The user calls `POST /v1/approvals/:id/approve|deny` (UI token; also
   `nucleon-sync approvals approve ID --ui-token`).
4. **Execute.** Approved: the same request with the token executes **once** (state `used`). Denied: 403. Undecided
   after 15 min: `expired`. The agent may poll `GET /v1/approvals/:id` for its own approvals.

The CLI drives this: `--yes` performs step 2 and waits up to `--approval-timeout` (default 300 s); `--no-wait` exits 7
with the confirm token and `--confirm-token` resumes later. Engine decisions made by agents are recorded with the
actor `api:<token name>`.

### 7.3 CLI contract

Full contract: [`CLI-JSON.md`](CLI-JSON.md). In short: one JSON document on stdout, also for errors
(`{ok:false, exitCode, code, error, …}`); exit codes 0–7; `--json` never prompts; destructive commands need
`--yes`/`--confirm`. The client never refuses commands by itself: the daemon decides from the token's scopes and the
CLI adds a hint. Token sources in order: `--ui-token`, `NUCLEON_SYNC_TOKEN`, `NUCLEON_SYNC_TOKEN_FILE`,
`--agent NAME` / `NUCLEON_SYNC_AGENT`, the built-in `default` token. `doctor` falls back to an in-process, read-only
check (state DB opened read-only, never starts `proton-drive`) when the daemon is down.

The agent skill for coding agents is [`agent-skill/SKILL.md`](../agent-skill/SKILL.md); the packages install it to
`/usr/share/nucleon-sync/agent-skill/SKILL.md`.

---

## 8. State DB

Schema: `daemon/src/db/schema.sql` plus `daemon/src/db/migrations/NNN-*.sql` (applied once, in name order; never edit
an applied migration, add a new one). The DB file lives in `~/.local/state/nucleon-sync/`.

- `entries` holds three snapshots per `(pair_id, rel_path)`: local `l_*`, remote `r_*`, base `b_*` (what both sides
  agreed on at the last sync). Indexes on `r_uid`, `l_sha1`, `(l_dev, l_inode)` and the remote parent support move
  detection and adoption.
- Local mtimes/ctimes are stored in **microseconds** (`l_mtime_us`, `l_ctime_us`, `b_l_mtime_us`): `node:sqlite`
  cannot read integers above 2^53 as JS numbers. Comparisons use a 1 ms tolerance.
- `remote_folders` keeps uid, `last_listed_at` and a listing hash per folder (rotation, uid addressing).
- `jobs` is the persistent queue; a partial unique index on `dedupe_key` over open states guarantees at most one open
  job per intended action.
- `activity` is append-only (pruned after 180 days) and carries the message key of daemon texts in `msg` (§14.5);
  `runs` and `scans` hold counters.
- `conflicts` (with `copy_rel_path`, `needs_review` for two-way) and `pending_deletions` (with `side`, `held`) hold
  user decisions with who/when.
- `adoption_sources`, `remote_index`, `adoption_proposals`, `backfill_priority`, `pair_state` (brakes),
  `pause_timers`, `storage_samples`, `notifications`, `settings`, `meta`.

Invariants (tested): (1) an entry is `synced` only if the base has a sha1 (or the flag `matched_by_size_mtime`), the
base revision equals the remote revision and the local snapshot equals the base; (2) no remote mutation without a
`jobs` row; (3) every job transition is in one transaction with its entry update and activity row; (4) undecided
pending deletions never produce `trash_remote` jobs.

**Backups**: once a week the engine writes `VACUUM INTO ~/.local/state/nucleon-sync/backup/state-<date>.sqlite` and
keeps the last 4.

**Migrations with foreign keys**: a migration file starting with `-- psync:foreign-keys-off` (e.g. `005-a-twoway.sql`,
which rebuilds `pairs` to extend a CHECK constraint) runs with foreign keys switched off around its transaction,
followed by `PRAGMA foreign_key_check`.

---

## 9. Planner

```
for entry in dirty(pair):            // seen by this run's scan/crawl, or state != synced
  if excluded(entry.rel_path): state = excluded; continue
  L = localDelta(entry)  ∈ {absent, new, unchanged, changed, deleted}
  R = remoteDelta(entry) ∈ {absent, new, unchanged, changed, deleted}
  action = decideFile(pair.direction, L, R, contentEq(entry), pair.options)   // engine/decide.ts
  if action == upload and adoptionCandidate(entry): propose a move instead
  apply(action) → jobs | conflict | pending_deletion | state
```

The user-facing tables per direction are in [`SYNC-RULES.md`](SYNC-RULES.md).

### 9.1 Deltas and content equality

- `localDelta`: without a base, `new`/`absent`; with a base, the sha1 is compared (re-hashed only when size, mtime or
  inode changed); without hashes, size + mtime.
- `remoteDelta`: `r_rev_uid` against the base revision; a node uid change with the same name counts as `changed`.
- `contentEq`: equal sha1 → `yes`; Proton has no sha1, same size and mtime within ±2 s → `size_mtime` (adopted with
  the flag `digest_missing`, a candidate for the digest backfill); otherwise `no`.

### 9.2 Moves

- Move pairing runs before per-entry classification: `deleted` and `new` local entries are paired by unique sha1;
  `(dev, inode)` only disambiguates duplicates. Ambiguity → upload, never a guessed move.
- First-contact relocations inside a pair (remote-only file at the old path, identical local-only file at the new
  path) become an automatic move.
- Folder moves: moves are grouped by the common path suffix (`A/x/f → B/x/f` gives `A → B`); when ≥ 90 % of the
  remote files below `A` moved, one folder move (+ rename) is planned and the entries below are re-planned after it.
- Two-way pairs also detect remote moves (same node uid at a new path) and rename the local file (`move_local`).

### 9.3 Adoption across roots

Before uploading a `local_new` file, the planner looks for identical content already in Proton: sha1 match, or for
digest-less remote files `(name, size, |mtime difference| ≤ 2 s)`. The search space is the account's
**adoption sources** (`adoption_sources` → `remote_index`) and remote-only entries of **disabled** pairs. A match must
be unique and not claimed by a live local file; ambiguous matches are uploaded normally (a wrong move is worse than
one extra copy). Matches become **adoption proposals** that the user accepts or rejects (`/v1/adoptions`), because
they move a node from outside the pair. Remote-only files of enabled pairs are downloaded, never moved away. There is
no API to configure adoption sources yet.

### 9.4 Safety brakes

Evaluated after scanning and crawling, before deletions are planned. A brake stops the pair (no plan, no jobs) and
sends a notice; only the user releases it (`release-brake`, confirmed; the next run then treats missing files as
deleted, which for backup pairs still only creates pending deletions).

| Brake               | Trigger                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| local root missing  | the pair's local folder does not exist (drive not mounted?)                                                |
| local root empty    | the local folder is empty while the DB knows synced files                                                  |
| mass disappearance  | ≥ 500 tracked files gone, or ≥ 50 and more than 2 % of the synced files (backup, mirror-down, upload-only) |
| remote root missing | the Proton folder is gone or in the trash                                                                  |
| remote root empty   | the Proton folder is suddenly empty while the DB knows synced files (nothing is deleted locally)           |
| two-way mass delete | see §10 (held deletions instead of a brake on the scan)                                                    |

`requiredMounts` in daemon.json makes `doctor` report an error when a listed path is not a mount point.

### 9.5 Conflict resolutions

| Resolution    | backup                                                                                                 | mirror-down                                                            | two-way review item                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `keep_local`  | upload the local file as a new revision (confirmed when the local file is missing)                     | refused (a mirror never writes to Proton)                              | the conflict copy replaces the original (original's local version → trash) |
| `keep_remote` | download Proton's version; the local file goes to the trash (confirmed)                                | download; the local edit is kept as `name (local edit YYYY-MM-DD).ext` | the copy goes to the local trash, then the Proton trash                    |
| `keep_both`   | download Proton's version as `name (Proton YYYY-MM-DD HH-MM).ext`, upload the local file as a revision | like `keep_remote`                                                     | dismiss (both versions stay)                                               |
| `ignore`      | accept the current state of both sides as the new base                                                 | same                                                                   | dismiss                                                                    |

Conflicts on paths inside `.git/` of backup and upload-only pairs are resolved automatically with `keep_local`
(`resolved_by = 'auto:.git'`), after planning, after every run and at start.

---

## 10. Two-way pairs

- **Decisions** (`engine/decide.ts` `decideTwoWay`): three-way against the base, both sides equal. Both changed or
  first contact with different content → `conflict_copy` job (the local version is renamed to
  `Name (conflict <host> YYYY-MM-DD).ext` and uploaded, Proton's version is downloaded into the original name) plus a
  review item (`conflicts.needs_review`). Deleted here → Proton trash; deleted in Proton → local trash; deleted on one
  side but changed on the other → the change is restored (review item). Digest-less first-contact files with the
  same size but another mtime → `verify_content` (≤ 64 MiB downloaded to staging and hashed) or a held `needs_check`
  conflict.
- **Mass-delete guard** (planner): when one run would delete more than `massDeleteMaxFiles` (default 20) files, or
  more than `massDeletePercent` % (default 10, from 5 files on) of the pair's synced files (local and remote deletions
  counted together), nothing is deleted. Every deletion is stored as a held pending deletion
  (`pending_deletions.held = 1`, `side`), and the pair does not run at all until every held deletion is decided
  (`POST /v1/pairs/:id/held-deletions`, single decisions, or the dashboard card). Deny restores. The job pick query
  skips paused and held pairs, so a held pair never stalls the account's other pairs.
- **Adoption run**: a pair created as or switched to two-way gets `options.twoWayAdoption` until its first complete
  run (full listing, no open job). Meanwhile nothing is deleted on either side (a missing file is restored) and
  identical files are only recorded (no transfer, no new revision). Switching an existing pair drops the base of every
  entry that is not cleanly synced, so it is compared like at first contact.
- **Executor**: uploads of new files list the parent first (same name + same sha1 → recorded; different → keep both);
  revision uploads `info` the node first and cancel when Proton has another revision than the base; downloads `info`
  first and never replace a local file that changed meanwhile (conflict copy instead); folders are deleted only when
  empty on that side (a folder that still holds untracked files is kept and re-created on the side that deleted it).
  A local folder that cannot be read counts as unknown: nothing below it is deleted.
- **Remote checks**: `Engine.remoteChecks()` (every 30 s) requests a pair run for every two-way pair whose last run is
  older than `remoteCheckMinutes` (default 10). Two-way pair runs are never targeted; pairs below 2000 folders are
  listed completely. `PairDto.lastRemoteCheckAt` = end of the last complete listing.
- **Nested pairs** (`engine/nested.ts`): a pair whose local folder lies inside another pair's local folder, and (same
  account) whose Proton folder lies at the same sub path inside the other pair's Proton folder, owns that sub folder.
  The outer pair excludes it (rule source `pair`, not toggleable) and the executor cancels outer-pair jobs on that path
  (`ownedElsewhere`). Crossed nesting, different sub paths and the same folder twice are refused.
- **Two devices** on one Proton folder need nothing special: each daemon has its own base; the second one to sync
  after concurrent edits sees "both changed" and keeps both (its host name is in the copy's name).
- **Known limits**: between the `info` check and a `create-new-revision` upload another device can still upload a
  revision (the CLI cannot upload conditionally; the other version survives in Proton's revision history). Remote
  folder renames are applied file by file. Digest backfill is refused for two-way pairs.

---

## 11. Scheduler, change detection and limiter

### 11.1 Schedule

Proton asks third-party apps not to poll or traverse the drive often, and the CLI has no change feed. The defaults are
therefore gentle (`DEFAULT_SETTINGS` in `shared/src/defaults.ts`):

| Setting                                 | Default                     |
| --------------------------------------- | --------------------------- |
| `schedule.incrementalEveryMinutes`      | 360 (every 6 h)             |
| `schedule.fullEveryWeeks`               | 4                           |
| `schedule.fullWeekly.weekday` / `.hour` | 0 / 3 (Sunday 03:00)        |
| `schedule.runOnStartupDelayMinutes`     | 5                           |
| `transfer.maxWorkersTotal`              | 3                           |
| `transfer.maxWorkersPerAccount`         | 2 (new accounts get 1)      |
| two-way `remoteCheckMinutes`            | 10 (per pair, two-way only) |

The scheduler (`engine/scheduler.ts`) persists `nextRuns` in `settings`, uses timers with drift correction and
detects suspend/resume by a wall-clock jump (> tick + 2 min). Overdue runs are not fired at once after boot or resume:
one incremental catch-up run is scheduled after `runOnStartupDelayMinutes`. "Sync now" and agent requests run at once.

### 11.2 Run modes and remote crawling

| Mode        | Local side                                              | Remote side                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| incremental | stat walk of all selected folders (hash only on change) | root + **hot** folders (touched by us or changed in the last 7 days) + parents of locally changed entries + a **rotating slice** of the least recently listed folders (600 folders or 15 min) + new folders; pairs below 2000 folders are listed completely |
| full        | stat walk, re-hash files whose ctime changed            | every folder of the pair                                                                                                                                                                                                                                    |
| verify      | re-hash a random 1 % sample plus recently changed files | every folder                                                                                                                                                                                                                                                |
| targeted    | (priority pair runs) as incremental                     | root + parents of locally changed entries + folders newly found there                                                                                                                                                                                       |

Rotation is needed because a folder's `modificationTime` does not change when its children change.

### 11.3 Limiter

- Global semaphore (`maxWorkersTotal`) + per-account pool size + the global process cap (§4.6).
- EWMA of metadata-call latency per account, from `list/info/size` durations and the CLI's `INFO [api] … (NNNms)` log
  lines (tailed every 5 s). States `normal → reduced (1 worker) → cooldown (0 workers, 15 min)`. "High" = EWMA > 1.2 s,
  or > 4× the baseline above a 400 ms floor. HTTP 429 jumps straight to cooldown. After a cooldown the account
  restarts with one worker and a fresh EWMA. Accounts show `throttled` while reduced or cooling down.
- Bandwidth pacing (`transfer.bandwidthLimitKBps`, optional quiet hours with their own limit): the CLI cannot
  throttle, so the executor sleeps between transfers to keep the moving average at the limit. A single large file
  cannot be throttled mid-transfer.

---

## 12. Notifications

- **Desktop**: the dashboard turns SSE `notice` events into desktop notifications (setting
  `notifications.desktop`), de-duplicated per key. A pending agent approval also produces a desktop notification.
- **Daemon channel** (`notify/notifier.ts`), optional: **`notifyCommand`** in daemon.json, an argv array started
  without a shell, 30 s timeout, with the event in the environment: `NUCLEON_SYNC_EVENT` (`notice` | `digest` |
  `test`), `NUCLEON_SYNC_SEVERITY`, `NUCLEON_SYNC_KEY`, `NUCLEON_SYNC_TITLE`, `NUCLEON_SYNC_BODY`, `NUCLEON_SYNC_TEXT`
  (title + body), `NUCLEON_SYNC_ACCOUNT_ID`, `NUCLEON_SYNC_ACCOUNT_NAME`. Exit code 0 counts as sent; otherwise the
  exit code and the start of stderr are logged. It is configurable only in the file, not over the API, so an agent
  token cannot make the daemon run commands. Use it for phone push (ntfy), a chat bot, mail or another agent; the
  README has an example script. `GET /v1/notifications/config` reports `{command: {configured, program}}` (the
  program's base name only).
- **Removed in 0.4.0**: the built-in chat bot channel of 0.3.x (its own keys under `notifications` and a bot token in
  the keyring or the encrypted file store). Migration 009 drops those settings and the channel's log rows;
  `notify/legacyToken.ts` deletes a stored bot token once at startup, best effort (`secret-tool clear` with a timeout
  for the libsecret backend, the `.enc` file for `encfile`), never failing the start, and records the attempt in
  `meta` (`cleanup:legacy-bot-token`). `PUT /v1/settings` answers 400 for unknown keys under `notifications`.
- **Rules**: warn/error notices go out at once, de-duplicated per notice key within
  `notifications.minIntervalMinutes` (default 360); pending decisions (new conflicts, pending deletions, adoption
  proposals) only go into one daily digest after `dailyHour`; info notices never. Every attempt is logged in the
  `notifications` table (`GET /v1/notifications`, channel `command`). `POST /v1/notifications/test` (UI token)
  sends a test message.

---

## 13. Configuration

### 13.1 `~/.config/nucleon-sync/daemon.json`

All keys are optional and read at daemon start (restart the service after a change). Type: `DaemonFileConfig` in
`daemon/src/accounts/context.ts`.

| Key               | Meaning                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cliPath`         | `proton-drive` binary. Default: `~/.local/bin/proton-drive` if present, else `proton-drive` on `PATH`                                                                       |
| `tcpPort`         | also listen on `127.0.0.1:<port>`                                                                                                                                           |
| `stagingDir`      | download staging directory (default `<state>/staging`). On the same filesystem as the pair roots, downloads are renamed into place without a copy; `doctor` warns otherwise |
| `dailyHour`       | hour (0–23) of the daily storage measurement and the daily decision digest (default 9)                                                                                      |
| `secretBackend`   | session store for new accounts: `libsecret` (default) or `encfile`                                                                                                          |
| `cliTimeouts`     | per-command CLI timeouts in ms: `listMs`, `infoMs`, `sizeMs`, `probeMs`, `mutateMs`, `emptyTrashMs`, `transferBaseMs`, `minBytesPerSec`                                     |
| `requiredMounts`  | absolute paths that must be mount points (`doctor` error otherwise), e.g. a data disk holding the pair roots                                                                |
| `protectedPaths`  | absolute local paths that are never synced: pairs overlapping them are refused and the rule matcher skips them                                                              |
| `notifyCommand`   | argv array run on every notification (§12)                                                                                                                                  |

Example:

```json
{
  "stagingDir": "/mnt/storage/.nucleon-sync-staging",
  "requiredMounts": ["/mnt/storage"],
  "protectedPaths": ["/mnt/storage/backups"],
  "notifyCommand": ["/usr/local/bin/notify-me"]
}
```

### 13.2 Settings (`GET/PUT /v1/settings`)

`SettingsDto`: `schedule`, `transfer` (workers, bandwidth, quiet hours, thumbnails, max file size), `notifications`
(desktop, minimum interval), `storagePoolBytes` (shared storage plan size to display), `globalExcludes`.
Stored per section; every change calls `engine.reload()`. Pair options (`PATCH /v1/pairs/:id`) and account fields
(`PATCH /v1/accounts/:id`) are separate.

### 13.3 Environment variables

| Variable                                                                                                      | Purpose                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NUCLEON_SYNC_ALLOW_WRITES=1`                                                                                 | allow writes in production (otherwise planning mode, §4.5)                                        |
| `NUCLEON_SYNC_CLI`                                                                                            | `proton-drive` path (overrides daemon.json)                                                       |
| `NUCLEON_SYNC_API_PORT`                                                                                       | TCP port (overrides daemon.json)                                                                  |
| `NUCLEON_SYNC_HOME`                                                                                           | dev/test root: everything below `<dir>/{config,state,run}`                                        |
| `NUCLEON_SYNC_MOCK=1`                                                                                         | use the mock CLI and mock accounts below `$NUCLEON_SYNC_HOME/mock` (requires `NUCLEON_SYNC_HOME`) |
| `NUCLEON_SYNC_LOG_LEVEL`, `NUCLEON_SYNC_CLI_LOG_LEVEL`                                                        | daemon and CLI log levels                                                                         |
| `NUCLEON_SYNC_CLI_ONESHOT=1`                                                                                  | one process per CLI command (debugging)                                                           |
| `NUCLEON_SYNC_IGNORE_FOREIGN_CLI=1`                                                                           | disable the foreign-process gate                                                                  |
| `NUCLEON_SYNC_LOGIN_TIMEOUT_MS`                                                                               | login approval timeout (default 10 min)                                                           |
| `NUCLEON_SYNC_SHIM_DIR`, `NUCLEON_SYNC_NODE`                                                                  | packaged app: location of the shim wrapper and the Node runtime it uses                           |
| `NUCLEON_SYNC_TOKEN`, `NUCLEON_SYNC_TOKEN_FILE`, `NUCLEON_SYNC_AGENT`                                         | CLI client token selection                                                                        |
| `NUCLEON_SYNC_UI_LANG`, `NUCLEON_SYNC_UI_THEME`                                                               | dashboard language and theme override                                                             |
| `NUCLEON_SYNC_UI_FIXTURES`, `NUCLEON_SYNC_UI_OFFSCREEN`, `NUCLEON_SYNC_UI_USER_DATA`, `NUCLEON_SYNC_UI_SMOKE` | dashboard development and tests (§14.4)                                                           |
| `NUCLEON_SYNC_CLI_RELEASES_URL`, `NUCLEON_SYNC_SYSTEMCTL`, `NUCLEON_SYNC_BUSCTL`                              | setup wizard tests                                                                                |

Shim variables are listed in §5.4 and `secret-shim/src/pass.ts`.

### 13.4 Files

| Path                                                                     | Content                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `~/.config/nucleon-sync/api-token`                                       | UI token (0600)                                        |
| `~/.config/nucleon-sync/agent-token`                                     | built-in agent token `default` (0600)                  |
| `~/.config/nucleon-sync/agent-tokens.json`, `agent-tokens/`              | named agent tokens (hashes; secret files 0600)         |
| `~/.config/nucleon-sync/secret.key`                                      | key of the encrypted file store (0600, `encfile` only) |
| `~/.config/nucleon-sync/daemon.json`                                     | optional daemon configuration                          |
| `~/.local/state/nucleon-sync/state.sqlite`                               | state DB; `backup/` weekly copies                      |
| `~/.local/state/nucleon-sync/accounts/<id>/cli/w<N>`                     | CLI cache, events DB and logs per worker               |
| `~/.local/state/nucleon-sync/secrets/`                                   | encrypted sessions (`encfile` only)                    |
| `~/.local/state/nucleon-sync/staging/`                                   | download staging (default)                             |
| `~/.local/state/nucleon-sync/shim-events.jsonl`                          | shim events (no secrets)                               |
| `$XDG_RUNTIME_DIR/nucleon-sync/api.sock`, `bar.json`, `bar-omarchy.json` | API socket and status-bar files                        |

---

## 14. Electron UI architecture

### 14.1 Processes

- `ui/src/main/main.ts`: single-instance lock (`--open[=SCREEN]` focuses a running window), `BrowserWindow` (hidden to
  the tray on close; `--hidden` starts in the tray), `Tray` (StatusNotifierItem), desktop notifications, IPC handlers,
  SSE relay. The API token never reaches the renderer.
- Two windows from the same bundle: the main window and the tray flyout (`index.html#flyout`, frameless, hides on
  blur, opens at the pointer because StatusNotifierItem hosts report no tray bounds). Tray icons are rasterised in
  code (`ui/src/main/icons.ts`, animated while syncing); the tray state derivation is shared with the renderer
  (`ui/src/common/trayState.ts`).
- `ui/src/main/preload.ts`: the `window.nucleonSync` bridge (typed in `ui/src/bridge.ts`).
- `ui/src/renderer/`: React app. `store.ts` (external store fed by `GET /v1/status` and the event stream; `useApi`
  re-fetches on reconnect and on selected SSE event types; selector results are memoised), `api.ts` (typed wrappers),
  `withConfirm()` (the 409 confirm round-trip with the only modal dialog), `logic/*` (pure functions: selection →
  rules, run grouping, histograms, status texts, storage, normalisers), screens wrapped in error boundaries.
- `ui/src/main/setup.ts` + `ui/src/renderer/screens/Setup.tsx`: the first-run wizard of the packaged app (IPC
  `ps:setup` with an operation allowlist): system check (CLI, Secret Service, systemd, session, tray watcher, install
  kind) → CLI installation (§5.7) → session store (keyring via the shim, or the encrypted file store with explicit
  consent) → systemd user unit and tray autostart (explicit consent; files carry the marker
  `# managed-by: nucleon-sync-app`, a unit not written by the app is never overwritten; the AppImage copies itself to
  `~/.local/share/nucleon-sync`) → login with URL/QR → folder pairs (suggestions for the user's documents and pictures
  folders, missing Proton folders are created with `createRemote`) → first sync. After setup it uses the normal API.

### 14.2 Hardening

`contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, no remote content; `will-navigate`,
`will-redirect`, `window.open` and webviews blocked; permission requests denied; every IPC call must come from the
bundled `file://` UI.

IPC (`ui/src/common/ipc.ts`): `ps:request` (methods GET/POST/PUT/PATCH/DELETE, path `/v1/…` of safe characters, no
`..`, no encoded separators in the path part), `ps:event`, `ps:connection`/`ps:connection-state`, `ps:ui-state`,
`ps:get-ui-state`, `ps:navigate`, `ps:pause-for`, `ps:show-in-folder` and `ps:open-path` (only below a pair root),
`ps:open-external` (https `*.proton.me` only), `ps:copy-text`, `ps:pick-folder`, `ps:open-main`, `ps:close-flyout`,
`ps:set-prefs`, `ps:setup`/`ps:setup-progress`, `ps:smoke`. API errors cross IPC as `PSAPI <status> <body>`.

### 14.3 Theme

The dashboard follows the desktop: Omarchy's current theme (`~/.local/state/omarchy/current/theme/colors.toml`, §15),
else KDE (`kdeglobals`), else the system light/dark preference. Settings → appearance switches back to the built-in
palette. `NUCLEON_SYNC_UI_THEME=dark|light` overrides.

### 14.4 Development aids

- `NUCLEON_SYNC_UI_FIXTURES=demo` answers every endpoint with simulated runs and events (no daemon needed); main
  window and flyout share one demo state via `BroadcastChannel`. `=1` only fills endpoints that answer 404/501.
- `NUCLEON_SYNC_UI_OFFSCREEN=1` renders offscreen (tests), `NUCLEON_SYNC_UI_USER_DATA=<dir>` isolates the Electron
  profile, `NUCLEON_SYNC_UI_SMOKE=1` exits after the renderer reported a status (`pnpm smoke`).
- Test hooks: `window.__psFixtures` (renderer) and `globalThis.__psTest` (main: tray state, menu labels,
  notifications) for Playwright.

### 14.5 UI language and daemon message keys

- `ui/src/renderer/i18n/en.ts` is the source of truth (`Strings = typeof en`); `de.ts` is typed `Strings`, so a
  missing key is a compile error. `ui/test/i18n.test.ts` checks key sets, value kinds (function arity, array lengths),
  non-empty strings and that every confirm `kind:` in `routes.ts` is translated.
- `i18n/index.ts` exports the live binding `t`; `section('…')` gives module-level aliases that follow language
  switches; `setLocale()` switches `t` and number/date formats. Components use `t.`, never a language module directly.
- Language choice: `NUCLEON_SYNC_UI_LANG` › Settings → Language (stored by main in `userData/ui-prefs.json`) › the
  system language list (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, Electron's preferred languages) › English. A
  switch re-mounts the renderer tree; main applies it to the tray menu.
- Adding a language: copy `en.ts` to `xx.ts`, translate, register it in `LOCALES`.
- **Daemon texts** are English. Every user-facing daemon text (activity messages, notices, doctor checks, brake
  reasons, account errors, preview warnings) also carries a message key + params (`shared/src/messages.ts`, `msg()`,
  `MsgRef`, e.g. `ActivityItem.msg`, `DoctorCheck.msg`). The dashboard translates the key with its own table (section
  `daemon` of each language, typed against `DaemonMessages`) and falls back to the English text for unknown keys and
  old rows. Texts stored in plain TEXT columns use `encodeMsg`/`decodeMsg`. The English text stays in the existing
  fields for the CLI and agents.

### 14.6 Keyboard and accessibility

`app.tsx` binds global keys; they are off while typing in a field and while a dialog is open.

| Key         | Action          |
| ----------- | --------------- |
| `1`–`8`     | screens         |
| `s`         | sync now        |
| `p`         | pause/resume    |
| `/`, Ctrl+F | activity search |
| `n`         | new pair        |
| `r`, F5     | refresh         |
| `?`         | help overlay    |

`components/a11y.ts`: `useFocusTrap` for every modal (Tab cycles inside, Esc closes, focus returns; the confirm dialog
focuses "Cancel", the approval dialog "Deny", and Esc denies), `rowKeys` (arrow keys, Home, End in the activity table,
the folder tree with →/← to expand/collapse, and menus). A skip link, a visible theme-aware `:focus-visible` ring and
`aria-keyshortcuts` on menu buttons, sidebar entries and the activity search.

---

## 15. Status bar and Omarchy integration

### 15.1 Status bar

- `shared/src/bar.ts` formats `StatusDto` as Waybar JSON `{text, alt, tooltip, class, percentage}`. States in order:
  stopped › error › conflicts › throttled › paused › syncing › idle. Held two-way deletions and review items count as
  `conflicts`. Nerd Font icons; the tooltip shows transfers, ETA, per-account state and held pairs; tooltip language
  German for a German `LANG`, else English.
- `api/barFile.ts` writes `<runtime>/bar.json` (Waybar) and `bar-omarchy.json` (Omarchy shell: `class:"active"`
  highlights stopped, error and conflicts), at most once per second on status events and every 15 s as a keep-alive;
  removed on shutdown.
- `packaging/omarchy/nucleon-sync-bar` only `cat`s the file (cheap enough to poll every few seconds; a file older than
  a minute means "stopped"); it also has `--is-paused`, `--tooltip` and `--notify`. `nucleon-sync bar --watch` uses SSE
  for Waybar's continuous mode.

### 15.2 Omarchy

Omarchy 4 draws bar, menu and notifications with one Quickshell process (`omarchy-shell`); there is no Waybar, Walker
or Mako.

- **Bar**: `~/.config/omarchy/shell.json` (watched; `omarchy-shell shell reloadConfig` reloads it). A module is
  `{"id", "type":"command", "exec", "interval", "onClick", "onRightClick", "onMiddleClick"}`; the output is read as
  Waybar-style JSON, of `class` only `"active"` has an effect.
- **Menu**: `~/.config/omarchy/extensions/omarchy-menu.jsonc` (watched), a flat object with dotted ids; `action`,
  `when` and `checked` are shell commands. Only whole-line `//` comments and trailing commas are stripped; a parse
  error silently drops all user entries.
- **Installer** `nucleon-sync-omarchy install|uninstall|status [--dry-run] [--no-bar] [--no-menu] [--waybar]`: adds
  the bar entry `nucleon-sync` before `omarchy.tray` with jq (replaced in place if present); adds a menu block between
  marker comments (open dashboard, sync now, pause/resume switched with `when`, status notification; labels follow
  `LANG`); validates every result the way the Omarchy parser does; keeps `*.nucleon-sync.bak` and reloads the shell.
  `uninstall` removes exactly these parts. `--waybar` copies `waybar-module.jsonc` and `waybar.css` for Omarchy 3 or
  plain Hyprland and never edits the Waybar config itself.
- **Clicks**: left opens the dashboard (`uwsm-app -- nucleon-sync-gui --open`), right pauses/resumes, middle syncs.
- **Theme**: `~/.local/state/omarchy/current/theme/colors.toml` (Omarchy 3: `~/.config/omarchy/current/theme`) is
  mapped to the dashboard's CSS variables (`common/omarchyTheme.ts`), status colours kept at ≥ 3:1 contrast with the
  theme's `bright_*` variants or built-in colours as fallback. Because `omarchy-theme-set` replaces the theme
  directory as a whole, main watches the parent directory and re-applies within 0.4 s.
- Omarchy's shell API is young; the module schema and menu format may change.

---

## 16. Packaging and operations

| Install method         | What                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUR `nucleon-sync`     | built from the source tarball with pnpm + esbuild (`scripts/package.mjs --bundle-only`), runs on the system `electron44`; files below `/usr/lib/nucleon-sync`; unit `packaging/arch/system-electron/nucleon-sync.service`          |
| AUR `nucleon-sync-bin` | the prebuilt app from the GitHub release tarball, installed to `/opt/nucleon-sync`; unit `packaging/arch/nucleon-sync.service`                                                                                                     |
| AppImage               | electron-builder via `scripts/package.mjs`; the wizard installs the user unit and autostart entry (needs FUSE 2, or `--appimage-extract-and-run`)                                                                                  |
| Source checkout        | `scripts/install-user.sh [--dry-run] [--uninstall] [--enable] [--enable-autostart] [--no-build]`: renders `packaging/systemd/nucleon-sync.service` (planning mode), launcher, autostart entry, `~/.local/bin/nucleon-sync` symlink |

- Both AUR packages depend on `proton-drive-cli` (provided e.g. by `proton-drive-cli-bin`); the CLI is never bundled.
  They install `/usr/bin/nucleon-sync-gui`, `/usr/bin/nucleon-sync` (CLI client), `/usr/bin/nucleon-sync-bar`,
  `/usr/bin/nucleon-sync-omarchy`, the desktop entry, icons, a fallback user unit in `/usr/lib/systemd/user/`, the
  Waybar snippets and the agent skill below `/usr/share/nucleon-sync/`.
- `scripts/package.mjs` bundles the daemon (`nucleon-syncd.mjs`), the CLI client and the pass shim with esbuild into
  `resources/daemon/`, builds the UI, runs electron-builder (AppImage + `linux-unpacked`), creates the release tarball
  `nucleon-sync-<v>-linux-x64.tar.gz` and a local `makepkg` of the `-bin` PKGBUILD. The bundled daemon runs with
  `ELECTRON_RUN_AS_NODE=1`.
- Launchers pass `--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations`; the tray uses Electron's
  StatusNotifierItem (Waybar `tray` module, KDE, GNOME with the AppIndicator extension).
- Units: `Nice=10`, `IOSchedulingClass=idle`, `After=graphical-session.target` (the keyring comes up with the
  session). The user unit written by the wizard takes precedence over the package's fallback unit.
- Logs: daemon JSON lines → journald (`journalctl --user -u nucleon-sync`); CLI logs per worker directory (INFO);
  `shim-events.jsonl`.
- Upgrades: through the package manager (AUR), a new AppImage, or `git pull && pnpm install` + restart for a source
  checkout. DB migrations run at start.

---

## 17. Testing strategy

**No test ever talks to a real Proton account.** The suite runs against `mock-cli/`, a behavioural fake of
`proton-drive` (not a stub): REPL and one-shot mode, the same JSON shapes, upload/download strategies including the
digest-less trap, uid paths, credential stores, server-side refresh-token rotation, "another device" operations
(`mock-proton-drive-seed --edit/--trash/--rename/--move/…`) and fault injection.

| Level        | What                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit         | quoting, error classification, decision tables (pure functions), rules, move pairing, brakes, limiter, scheduler, quirks                                                                                                                                                                                                                                                                           | `daemon/test/engine/`, `daemon/test/robust/`, `daemon/test/*.test.ts` |
| Scenarios    | engine + real REPL workers against the mock: first contact, idempotence, deletions, moves, adoption, mirror-down, resilience/offline, tarpit, refresh race, brakes, corrupt download, modified during upload, write guard, selection, maintenance, upload of new local files, parallel runs, two-way (basics, conflicts, mass delete, adoption, nested, two devices, crash), SIGKILL of the daemon | `daemon/test/scenarios/s01…s24`                                       |
| Contract     | parsers against recorded CLI output shapes; the mock must produce the same                                                                                                                                                                                                                                                                                                                         | `daemon/test/contract/`                                               |
| API and CLI  | auth, Host/Origin checks, permissions, confirm and approval flows, SSE, CLI JSON and exit codes, agent tokens, notifications (fake Bot API), packaging scripts, migrations                                                                                                                                                                                                                         | `daemon/test/*.test.ts`                                               |
| UI unit      | formatting, selection → rules, activity grouping, status texts, IPC allowlist, tray state, icons, theme, i18n completeness, setup wizard (CLI download + SHA-512 mismatch, units, foreign unit untouched)                                                                                                                                                                                          | `ui/test/*.test.ts`                                                   |
| UI e2e       | Playwright `_electron` against a mock daemon and the demo fixtures: flows, security (no Node globals, IPC allowlist, navigation blocked, CSP), keyboard, languages, screenshots                                                                                                                                                                                                                    | `ui/test/e2e/*.spec.ts`                                               |
| Smoke        | temp mock environment → daemon → CLI client → probe run → Electron renderer                                                                                                                                                                                                                                                                                                                        | `scripts/smoke.mjs`                                                   |
| Packaged app | walks through the wizard of the built app on a virtual display with the mock CLI served as the "official" download                                                                                                                                                                                                                                                                                 | `scripts/packaged-test/run.mjs`                                       |

Mock fault injection: `MOCK_OFFLINE_FILE`, `MOCK_TARPIT_RPM`, `MOCK_FAIL_RATE`, `MOCK_CORRUPT_DOWNLOAD`,
`MOCK_TRANSFER_BPS`, `MOCK_HANG_FILE`, `MOCK_INJECT_FILE` (an operation applied right before the next command of a
given name, for races), `MOCK_LOGIN_AUTO_APPROVE_MS`, refresh expiry and revocation via the seed tool.

All GUI tests run headless (`xvfb-run -a`, offscreen windows). How to run everything: [`CONTRIBUTING.md`](../CONTRIBUTING.md).
