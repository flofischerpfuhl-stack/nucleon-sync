-- psync:foreign-keys-off
-- SPDX-License-Identifier: GPL-3.0-or-later
-- two-way pairs: direction 'two-way', held deletions (mass-delete guard), conflict review after "keep both".
-- The direction CHECK of `pairs` can only change by rebuilding the table (SQLite "other kinds of table schema
-- changes"): db.ts runs this file with foreign keys switched off (marker above), so DROP TABLE pairs does NOT cascade
-- into entries/rules/jobs, and checks foreign_key_check before COMMIT. Only the few pair rows are copied.

CREATE TABLE pairs_new (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  name             TEXT NOT NULL,
  local_root       TEXT NOT NULL,
  remote_root      TEXT NOT NULL,
  remote_section   TEXT NOT NULL,
  remote_root_uid  TEXT,
  direction        TEXT NOT NULL CHECK (direction IN ('backup','mirror-down','upload-only','two-way')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  paused           INTEGER NOT NULL DEFAULT 0,
  options          TEXT NOT NULL DEFAULT '{}',
  last_run_at      INTEGER,
  last_full_at     INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (account_id, remote_root),
  UNIQUE (local_root)
);
INSERT INTO pairs_new (id, account_id, name, local_root, remote_root, remote_section, remote_root_uid, direction, enabled,
  paused, options, last_run_at, last_full_at, created_at)
  SELECT id, account_id, name, local_root, remote_root, remote_section, remote_root_uid, direction, enabled,
  paused, options, last_run_at, last_full_at, created_at FROM pairs;
DROP TABLE pairs;
ALTER TABLE pairs_new RENAME TO pairs;

-- which side deleted the file ('local' = this computer, 'remote' = Proton) and whether the mass-delete guard holds it
ALTER TABLE pending_deletions ADD COLUMN side TEXT NOT NULL DEFAULT 'local';
ALTER TABLE pending_deletions ADD COLUMN held INTEGER NOT NULL DEFAULT 0;

-- two-way "keep both" was carried out automatically: the conflict stays listed for review (needs_review = 1) with the
-- name of the conflict copy, but no longer blocks syncing the entry (resolution is set to 'keep_both' by 'auto')
ALTER TABLE conflicts ADD COLUMN copy_rel_path TEXT;
ALTER TABLE conflicts ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS conflicts_review ON conflicts(needs_review) WHERE needs_review = 1;
CREATE INDEX IF NOT EXISTS pending_deletions_held ON pending_deletions(held) WHERE held = 1;
-- PairDto.lastRemoteCheckAt (MAX(finished_at) of complete remote listings per pair, read on every status)
CREATE INDEX IF NOT EXISTS scans_pair_side ON scans(pair_id, side, status, finished_at);
