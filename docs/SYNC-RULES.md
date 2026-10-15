# Sync rules

What Nucleon Sync does with your files: the four pair directions, how deletions and conflicts are handled, the
safety brakes, what is never synced, and the limits that come from the official `proton-drive` CLI. Implementation
details are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Basics

- A **pair** connects one local folder with one Proton Drive folder of one account, with a **direction**: `backup`,
  `mirror-down`, `upload-only` or `two-way`. Example: `~/Documents ⇄ /my-files/Laptop/Documents`.
- For every file the app remembers the **base**: the state both sides agreed on at the last successful sync (content
  sha1, size, local modification time, Proton revision). Every decision compares the local file and the Proton file
  with the base. That is how the app tells "changed here" from "changed in Proton" from "changed on both sides".
- "Changed" locally means the content changed (the file is re-hashed when size, modification time or inode changed;
  touching a file without changing it is not a change). "Changed" in Proton means a new revision.
- **Nothing is deleted outright.** Local files go to the freedesktop trash (`~/.local/share/Trash`, or
  `<mount>/.Trash-<uid>` on other drives; restorable from your file manager). Proton files go to the Proton trash
  (restorable in the web app). Emptying the Proton trash is a separate, always confirmed action.
- **Nothing is overwritten silently.** When both sides changed, you get a conflict or both versions are kept.
- Identical files found on both sides at the first sync are only recorded ("adopted"): no transfer, no new revision.

## Directions

### `backup` (the local side leads)

| Local                | Proton                     | What happens                                                                                                          |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| new                  | –                          | uploaded                                                                                                              |
| new                  | same content               | adopted (recorded, no transfer)                                                                                       |
| new                  | different content          | conflict                                                                                                              |
| –                    | new                        | downloaded (everything exists twice)                                                                                  |
| changed              | unchanged                  | uploaded as a new revision                                                                                            |
| unchanged            | changed (edited elsewhere) | downloaded; the old local version goes to the trash. Pair option `remoteChanges=conflict` makes it a conflict instead |
| changed              | changed                    | conflict (unless the contents are identical)                                                                          |
| deleted              | unchanged or changed       | **pending deletion**: the Proton copy stays until you decide (a warning is shown when Proton changed it)              |
| unchanged or changed | deleted                    | uploaded again (the local side leads). Pair option `remoteDeletions=ask` makes it a conflict instead                  |
| moved or renamed     | unchanged                  | the Proton file is moved/renamed (no new upload)                                                                      |

Pending deletions are never carried out automatically. Your choices: **delete in Proton** (Proton trash),
**restore** (download again), or **keep only in Proton** (not downloaded again).

### `mirror-down` (Proton leads)

| Local           | Proton         | What happens                                                                                    |
| --------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| –               | new or changed | downloaded                                                                                      |
| unchanged       | deleted        | the local copy goes to the trash                                                                |
| edited locally  | any            | conflict; resolving it with "keep Proton" keeps your edit as `name (local edit YYYY-MM-DD).ext` |
| deleted locally | still there    | downloaded again on the next run                                                                |
| new local file  | –              | stays local only (not uploaded)                                                                 |

A mirror never writes to Proton, with one opt-in exception: the pair option **"upload new files from this computer"**
(`options.uploadLocalNew`). With it, files created locally _after_ the option was switched on are uploaded to the
same relative path (missing Proton folders are created). If Proton already has a different file with that name, both
are kept: the local file is renamed to `name (from PC YYYY-MM-DD).ext` and uploaded under that name, and Proton's file
is downloaded into the original name. Proton files are never overwritten, moved, renamed or trashed by a mirror.

### `upload-only` (an outbox)

New and changed local files are uploaded. Nothing is ever downloaded. Local deletions are ignored (the Proton copy
stays), and changes made in Proton are ignored (a later local change is uploaded as a new revision on top). A file
deleted in Proton is uploaded again only when it changes locally.

### `two-way` (both sides are equal)

For folders you edit on several devices.

| Local                    | Proton                                | What happens                                                                                     |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| new                      | –                                     | uploaded                                                                                         |
| –                        | new                                   | downloaded                                                                                       |
| new                      | new, same content                     | adopted                                                                                          |
| new                      | new, no checksum in Proton, same size | small files (≤ 64 MiB) are downloaded to a staging folder and compared; bigger ones wait for you |
| new or changed           | new or changed, different content     | **both kept** (see "Conflict copies")                                                            |
| changed                  | unchanged                             | uploaded as a new revision (only after checking Proton still has the base revision)              |
| unchanged                | changed                               | downloaded; the old local version goes to the trash                                              |
| deleted                  | unchanged                             | Proton copy → Proton trash                                                                       |
| unchanged                | deleted                               | local copy → local trash                                                                         |
| deleted                  | changed                               | the change wins: Proton's version is restored locally and listed for review                      |
| changed                  | deleted                               | the change wins: the local version is uploaded again and listed for review                       |
| moved or renamed locally | unchanged                             | the Proton file is moved/renamed                                                                 |
| unchanged                | moved or renamed in Proton            | the local file is moved/renamed the same way                                                     |

- **First sync of a two-way pair** (also when an existing pair is switched to two-way): identical files are only
  recorded, and nothing is deleted on either side; a file missing on one side is restored. Deletions start once the
  first complete sync has finished.
- **Remote changes** are found by listing the Proton folder, by default every 10 minutes per two-way pair
  (`remoteCheckMinutes`), or at once with "Sync now" / `nucleon-sync sync --pair N`.
- **Folders** deleted on one side are removed on the other only when they are empty there. A folder that still holds
  files the app does not track (junk files, excluded files) is kept.
- **Nested pairs**: a two-way pair may lie inside a backup pair when its Proton folder lies at the same sub path
  inside the backup pair's Proton folder. The outer pair then excludes that sub folder automatically; nothing is
  deleted.
- **Two devices** on one Proton folder work without extra setup; each device keeps its own base.
- **Limit**: the CLI cannot upload conditionally. Between the app's revision check and its upload, another device can
  still upload a revision; that version then survives only in Proton's revision history.
- Keep Git repositories out of two-way pairs or exclude `.git` (see below).

## Conflict copies

| Situation                                                            | Name of the extra copy                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| two-way, both sides changed                                          | `Name (conflict <hostname> YYYY-MM-DD).ext` (on both sides)      |
| backup conflict resolved with "keep both"                            | `Name (Proton YYYY-MM-DD HH-MM).ext` (Proton's version, locally) |
| mirror-down, local edit resolved with "keep Proton"                  | `Name (local edit YYYY-MM-DD).ext` (stays local)                 |
| mirror-down upload of a new local file meets a different Proton file | `Name (from PC YYYY-MM-DD).ext`                                  |

Two-way conflicts never block syncing: both versions exist on both sides, and the case is listed for review. Review
choices only clean up: _keep local_ (the copy replaces the original), _keep Proton_ (the copy goes to the trash),
_keep both_ or _ignore_ (dismiss). Other conflicts block only the affected file until you resolve them in
**Conflicts & deletions** or with `nucleon-sync conflicts resolve`.

## Safety brakes

A brake stops one pair before anything is deleted. The pair does nothing until you release the brake (dashboard
banner, or `nucleon-sync release-brake N`). After a release, missing files are treated as deleted, which for backup
pairs still only creates pending deletions.

| Brake                        | When                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| local folder missing         | the pair's local folder does not exist (an unmounted drive, a renamed folder)       |
| local folder empty           | the local folder is empty while files were synced before                            |
| mass disappearance           | ≥ 500 synced files gone, or ≥ 50 and more than 2 % of the pair's synced files       |
| Proton folder missing        | the Proton folder is gone or in the trash                                           |
| Proton folder suddenly empty | nothing is deleted locally                                                          |
| two-way mass deletion        | more than 20 deletions, or more than 10 % of the pair (from 5 files on), in one run |

Two-way mass deletions are **held**: nothing is deleted, the pair pauses completely, and you approve ("carry out
deletions") or deny ("restore everything") in the dashboard or with `nucleon-sync deletions approve|deny PAIR`. The
thresholds are pair options (`massDeleteMaxFiles`, `massDeletePercent`).

In `daemon.json`, `requiredMounts` lists paths that must be mount points (`nucleon-sync doctor` reports an error
otherwise).

## What is not synced

- **Selection**: per pair, folders can be excluded in the folder tree (tri-state checkboxes). Excluding a folder
  never deletes anything; the Proton copy stays.
- **Junk and temporary files** (default global excludes): `desktop.ini`, `Thumbs.db`, `.DS_Store`, `~$*`, `.~lock.*`,
  `.goutputstream*`, `*.tmp`, `*.part`, `*.crdownload`, `*.swp`, `.Trash-*`, `.nucleon-sync-*`.
- **Rebuildable developer caches** (default excludes, visible and switchable): `node_modules`, `.venv`, `venv`,
  `__pycache__`, `site-packages`, `dist-packages`, `.gradle`, `.dart_tool`, `.pnpm-store`, `.next`, `.mypy_cache`,
  `.pytest_cache`; Unity `Library` only next to `Assets` + `ProjectSettings`; `build`/`target` only next to a build
  marker file.
- **Protected paths**: `protectedPaths` in `daemon.json` (e.g. a backup disk). Pairs overlapping them are refused.
- **Special files**: symbolic links are not followed and not uploaded (reported as skipped); sockets, FIFOs and
  devices are skipped; hard links are uploaded as independent files.
- **Names with a newline** cannot be passed to the CLI and are marked unsupported.
- **Proton Docs and Sheets** are skipped by the CLI on download (open them in the web app).
- **Files being written**: files modified less than 10 seconds ago are postponed to the next run (a manual pair sync
  waits for them briefly instead).

### The `.git` rule

`.git` folders are **included** by default (an unpushed repository would otherwise be lost). Conflicts on files inside
`.git/` of backup and upload-only pairs are resolved automatically: the local version wins. In two-way pairs this
rule does not apply; keep repositories out of two-way pairs or exclude `.git`.

## Schedule and change detection

- Incremental run every 6 hours, full check every 4 weeks (Sunday 03:00), one catch-up run 5 minutes after boot or
  resume if a run was missed. "Sync now" runs at once. All of this is configurable in **Schedule & settings**.
- The defaults are deliberately gentle: Proton asks third-party apps not to poll or traverse the drive often, and the
  CLI has no change feed. Local changes are found by a stat walk (cheap); Proton changes are found by listing folders.
  An incremental run lists recently active folders plus a rotating slice of the rest; small pairs are listed
  completely; the full check lists everything.
- At most 3 CLI processes run at once over all accounts (2 per account by default). When Proton slows down, the app
  drops to one worker and then pauses the account for 15 minutes.

## Quirks of the official CLI

Nucleon Sync uses the unmodified `proton-drive` CLI and works around its limits:

- **No change feed**: remote changes are only seen when a folder is listed (see the schedule above). A folder's
  modification time in Proton does not change when its contents change.
- **"Skip identical" needs a checksum**: the CLI only recognises identical content when the Proton file has a sha1
  checksum. Files uploaded by some other clients have none. The app decides itself (size + modification time within
  ±2 s), and **Maintenance → Add checksums** (digest backfill) can re-upload such files so they get one; the replaced
  versions go to the Proton trash. Not available for two-way pairs.
- **Glob characters in names**: local paths containing `[`, `]`, `*`, `?` or a brace list like `{a,b}` cannot be
  passed to the CLI as they are. The app uploads them through a hard link with a safe path, and, if the file name
  itself is affected, under a temporary name (`*.psync-<hash>.tmp`) that is renamed in Proton afterwards.
- **Names starting with `-`** are passed after `--`.
- **Thumbnails**: the CLI loads whole images into memory to make thumbnails and fails for some formats. Thumbnails are
  skipped for TIFF, RAW formats, PSD, EXR, HEIC, JPEG 2000 and files over 100 MB, and after a thumbnail failure. You
  can switch thumbnails off completely in the settings.
- **Downloads do not keep the modification time**: the app sets it from the time Proton reports.
- **Bandwidth**: the CLI cannot throttle a transfer; the bandwidth limit is an average enforced between files.
- **One session, several processes**: parallel CLI processes of one account can lose a token-refresh race, and the
  CLI then deletes the stored session. The app's credential shim prevents that (only an explicit logout deletes a
  session). Do not run your own `proton-drive` commands with the same session settings while the app syncs.
- **Untested CLI versions**: the app checks the CLI version at start. A version whose `major.minor` this release was
  not tested with puts the app into read-only mode until a tested release supports it.

## When things go wrong

| Situation                             | What the app does                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| network drop                          | retries with backoff (30 s up to 30 min); after 3 failures in a row the account is "offline" and is probed every 30 s |
| Proton slows down or answers 429      | one worker, then a 15-minute pause for that account ("throttled")                                                     |
| session expired or revoked            | the account shows "needs login"; other accounts keep syncing                                                          |
| keyring locked at login               | the account waits ("needs keyring") and retries every minute                                                          |
| CLI hangs or crashes                  | per-command timeout, the worker is restarted, the job retried                                                         |
| app or computer crashes mid-transfer  | jobs are resumable; before uploading again the app checks whether the upload had completed                            |
| power loss during a download          | partial files only exist in the staging folder, which is cleaned at start                                             |
| file changed during its upload        | the new local state is uploaded as a revision on the next run                                                         |
| local disk full                       | downloads need the file size + 1 GiB free; otherwise they wait and retry                                              |
| Proton storage full                   | uploads fail with a notice; free space or upgrade                                                                     |
| Proton folder renamed or moved by you | pairs address folders by id and keep working                                                                          |
