-- SPDX-License-Identifier: GPL-3.0-or-later
-- nucleon-sync state DB, schema version 1 (SQLite via node:sqlite, WAL mode).
-- Base schema. Changes go into new files in migrations/ (see db.ts); never edit a released version.
-- Conventions: timestamps = INTEGER unix epoch milliseconds (UTC); sizes = INTEGER bytes;
-- rel_path = NFC-normalised, '/'-separated path relative to the pair's local_root / remote_root (no leading '/').

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per Proton account profile. Credentials are NOT stored here (keyring via secret-shim).
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,                -- slug: 'alex', 'sam'
  display_name     TEXT NOT NULL,
  email            TEXT,
  credential_backend TEXT NOT NULL DEFAULT 'keyring-shim', -- keyring-shim | keychain-direct | mock
  secret_service   TEXT,                            -- libsecret attribute "service" used by the shim
  secret_key       TEXT,                            -- libsecret attribute "account"
  secret_schema    TEXT,                            -- optional xdg:schema (com.oven-sh.bun.Secret to share with plain CLI)
  workers          INTEGER NOT NULL DEFAULT 2,
  status           TEXT NOT NULL DEFAULT 'ok',
  last_error       TEXT,
  last_ok_at       INTEGER,
  paused           INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);

-- A sync pair = local folder <-> remote folder of one account, with a direction.
CREATE TABLE IF NOT EXISTS pairs (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  name             TEXT NOT NULL,
  local_root       TEXT NOT NULL,                   -- absolute, e.g. /srv/sync/Documents
  remote_root      TEXT NOT NULL,                   -- display path, e.g. /devices/Workstation/Documents
  remote_section   TEXT NOT NULL,                   -- CLI path prefix used for uid addressing: /devices/Workstation | /my-files | /shared-with-me
  remote_root_uid  TEXT,                            -- resolved once, then all remote addressing is <section>/<uid>
  direction        TEXT NOT NULL CHECK (direction IN ('backup','mirror-down','upload-only')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  paused           INTEGER NOT NULL DEFAULT 0,
  options          TEXT NOT NULL DEFAULT '{}',      -- JSON: {remoteChanges:'download'|'conflict', remoteDeletions:'reupload'|'ask', ...}
  last_run_at      INTEGER,
  last_full_at     INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (account_id, remote_root),
  UNIQUE (local_root)
);

-- Selection rules (folder tree checkboxes + global/default globs). pair_id NULL = global.
CREATE TABLE IF NOT EXISTS rules (
  id               INTEGER PRIMARY KEY,
  pair_id          INTEGER REFERENCES pairs(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('include','exclude')),
  pattern_type     TEXT NOT NULL CHECK (pattern_type IN ('prefix','glob')),
  pattern          TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','default')),
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_pair ON rules(pair_id);

-- THE core table: one row per tracked file or folder per pair. Three snapshots:
--   l_* = last local observation, r_* = last remote observation, b_* = base (state at last successful sync).
-- Decisions are made by comparing l_/r_ against b_ (3-way), never by blind re-upload.
CREATE TABLE IF NOT EXISTS entries (
  id               INTEGER PRIMARY KEY,
  pair_id          INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  rel_path         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('file','folder')),
  -- local snapshot
  l_exists         INTEGER NOT NULL DEFAULT 0,
  l_size           INTEGER,
  l_mtime_ns       INTEGER,                         -- stat mtime in ns (as TEXT-safe integer; SQLite INTEGER is 64-bit)
  l_ctime_ns       INTEGER,
  l_inode          INTEGER,
  l_dev            INTEGER,
  l_sha1           TEXT,                            -- hex; NULL until hashed
  l_hashed_at      INTEGER,
  l_seen_scan      INTEGER,                         -- scans.id of last local scan that saw it
  -- remote snapshot
  r_exists         INTEGER NOT NULL DEFAULT 0,
  r_uid            TEXT,
  r_parent_uid     TEXT,
  r_rev_uid        TEXT,                            -- activeRevision.uid (changes on every new revision)
  r_size           INTEGER,                         -- activeRevision.claimedSize
  r_mtime_ms       INTEGER,                         -- activeRevision.claimedModificationTime
  r_sha1           TEXT,                            -- activeRevision.claimedDigests.sha1 (NULL = old Windows upload)
  r_storage        INTEGER,                         -- totalStorageSize (all revisions)
  r_rev_storage    INTEGER,                         -- activeRevision.storageSize
  r_media_type     TEXT,
  r_seen_crawl     INTEGER,                         -- scans.id of last remote listing that saw it
  -- base (last agreed state)
  b_sha1           TEXT,
  b_size           INTEGER,
  b_l_mtime_ns     INTEGER,
  b_r_rev_uid      TEXT,
  synced_at        INTEGER,
  -- classification
  state            TEXT NOT NULL DEFAULT 'synced',  -- see shared/src/api.ts EntryState
  flags            INTEGER NOT NULL DEFAULT 0,      -- bit0 digest_missing, bit1 needs_verification, bit2 from_import,
                                                    -- bit3 matched_by_size_mtime, bit4 keep_remote_only, bit5 excluded_kept_remote
  last_error       TEXT,
  updated_at       INTEGER NOT NULL,
  UNIQUE (pair_id, rel_path)
);
CREATE INDEX IF NOT EXISTS entries_state ON entries(pair_id, state);
CREATE INDEX IF NOT EXISTS entries_ruid ON entries(r_uid);
CREATE INDEX IF NOT EXISTS entries_lsha1 ON entries(l_sha1);
CREATE INDEX IF NOT EXISTS entries_inode ON entries(l_dev, l_inode);

-- Remote folder bookkeeping for rotating incremental crawls.
CREATE TABLE IF NOT EXISTS remote_folders (
  pair_id          INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  rel_path         TEXT NOT NULL,
  uid              TEXT NOT NULL,
  last_listed_at   INTEGER,
  listing_hash     TEXT,                            -- hash of (uid,rev_uid,name) of children -> detect changes cheaply
  child_count      INTEGER,
  hot              INTEGER NOT NULL DEFAULT 0,      -- touched recently -> list every incremental run
  PRIMARY KEY (pair_id, rel_path)
);
CREATE INDEX IF NOT EXISTS remote_folders_uid ON remote_folders(uid);

CREATE TABLE IF NOT EXISTS scans (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER REFERENCES runs(id),
  pair_id          INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  side             TEXT NOT NULL CHECK (side IN ('local','remote')),
  mode             TEXT NOT NULL,                   -- incremental | full | rotate
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  status           TEXT NOT NULL DEFAULT 'running', -- running | ok | partial | failed | cancelled
  stats            TEXT NOT NULL DEFAULT '{}'       -- JSON counters
);

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY,
  trigger          TEXT NOT NULL,                   -- schedule | manual | api | startup | resume
  mode             TEXT NOT NULL,                   -- incremental | full | verify
  account_id       TEXT REFERENCES accounts(id),
  pair_id          INTEGER REFERENCES pairs(id),
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  status           TEXT NOT NULL DEFAULT 'running', -- running | ok | partial | failed | cancelled
  counters         TEXT NOT NULL DEFAULT '{}'       -- JSON, see RunDto.counters
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);

-- Persistent job queue (resumable). Exactly one row per intended remote/local mutation.
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER REFERENCES runs(id),
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  pair_id          INTEGER REFERENCES pairs(id) ON DELETE CASCADE,
  entry_id         INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  type             TEXT NOT NULL,                   -- see JobType
  payload          TEXT NOT NULL DEFAULT '{}',      -- JSON: {localPath, parentUid, strategy, expectedSha1, expectedRevUid, ...}
  priority         INTEGER NOT NULL DEFAULT 100,    -- lower = earlier; small files first inside a run
  state            TEXT NOT NULL DEFAULT 'queued',  -- see JobState
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 8,
  not_before       INTEGER,                         -- retry backoff / schedule
  error_class      TEXT,
  last_error       TEXT,
  bytes            INTEGER,
  worker           TEXT,                            -- e.g. 'alex/w1'
  dedupe_key       TEXT,                            -- e.g. 'upload:<pair>:<rel_path>' -> at most one open job per key
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_pick ON jobs(state, account_id, priority, not_before);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_open_dedupe ON jobs(dedupe_key) WHERE state IN ('queued','running','retry_wait','blocked');

-- "What was synced when" (the activity feed). Append-only; pruned after N days (setting).
CREATE TABLE IF NOT EXISTS activity (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  account_id       TEXT NOT NULL,
  pair_id          INTEGER,
  run_id           INTEGER,
  job_id           INTEGER,
  action           TEXT NOT NULL,                   -- see ActivityAction
  rel_path         TEXT,
  bytes            INTEGER,
  duration_ms      INTEGER,
  message          TEXT
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);
CREATE INDEX IF NOT EXISTS activity_pair_ts ON activity(pair_id, ts);

CREATE TABLE IF NOT EXISTS conflicts (
  id               INTEGER PRIMARY KEY,
  entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,                   -- see ConflictKind
  detected_at      INTEGER NOT NULL,
  local_snapshot   TEXT,                            -- JSON FileSnapshot
  remote_snapshot  TEXT,
  base_snapshot    TEXT,
  resolution       TEXT,                            -- keep_local | keep_remote | keep_both | ignore
  resolved_at      INTEGER,
  resolved_by      TEXT                             -- 'ui' | 'api:<client>' | 'auto'
);
CREATE INDEX IF NOT EXISTS conflicts_open ON conflicts(resolution) WHERE resolution IS NULL;

-- Local deletions are never propagated automatically: they wait here for a decision in the UI.
CREATE TABLE IF NOT EXISTS pending_deletions (
  id               INTEGER PRIMARY KEY,
  entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  detected_at      INTEGER NOT NULL,
  size             INTEGER,
  remote_rev_uid_at_detect TEXT,                    -- to warn if remote changed after the local delete
  decision         TEXT,                            -- trash_remote | restore_local | keep_remote_only
  decided_at       INTEGER,
  decided_by       TEXT,
  executed_at      INTEGER,
  job_id           INTEGER REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS pending_deletions_open ON pending_deletions(decision) WHERE decision IS NULL;

CREATE TABLE IF NOT EXISTS settings (
  key              TEXT PRIMARY KEY,                -- 'schedule' | 'transfer' | 'notifications' | 'storagePoolBytes' | ...
  value            TEXT NOT NULL                    -- JSON
);

-- Measured storage per account/area (from `filesystem size`), for the storage screen and history graph.
CREATE TABLE IF NOT EXISTS storage_samples (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  area             TEXT NOT NULL,                   -- remote path, e.g. /devices/Workstation, /my-files, /trash
  bytes            INTEGER NOT NULL,
  files            INTEGER,
  measured_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS storage_samples_acc ON storage_samples(account_id, measured_at);

-- Notification log for de-duplication (Telegram bot, notify command).
CREATE TABLE IF NOT EXISTS notifications (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  channel          TEXT NOT NULL,                   -- desktop | telegram
  dedupe_key       TEXT NOT NULL,                   -- e.g. 'error:auth:sam'
  message          TEXT NOT NULL,
  ok               INTEGER,
  detail           TEXT
);
CREATE INDEX IF NOT EXISTS notifications_key ON notifications(dedupe_key, ts);

-- Import bookkeeping of earlier versions (kept so existing databases stay valid; unused since 0.3).
CREATE TABLE IF NOT EXISTS import_batches (
  id               INTEGER PRIMARY KEY,
  source_dir       TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  dry_run          INTEGER NOT NULL,
  stats            TEXT NOT NULL DEFAULT '{}'
);
