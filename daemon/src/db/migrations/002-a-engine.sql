-- SPDX-License-Identifier: GPL-3.0-or-later
-- engine additions (adoption, remote index for adoption sources, digest-backfill priority, pair brakes).

CREATE INDEX IF NOT EXISTS entries_rparent ON entries(pair_id, r_parent_uid);
CREATE INDEX IF NOT EXISTS entries_rsha1 ON entries(r_sha1);

-- Remote folders outside all pairs that may be searched for identical content (docs/SYNC-RULES.md), read-only.
CREATE TABLE IF NOT EXISTS adoption_sources (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_path      TEXT NOT NULL,                   -- display path, e.g. /my-files/Laptop
  remote_section   TEXT NOT NULL,                   -- /my-files | /devices/Laptop
  uid              TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_crawled_at  INTEGER,
  UNIQUE (account_id, remote_path)
);

-- Files seen remotely outside pairs (adoption sources crawl, or imported by earlier versions).
CREATE TABLE IF NOT EXISTS remote_index (
  account_id       TEXT NOT NULL,
  uid              TEXT NOT NULL,
  parent_uid       TEXT,
  section          TEXT NOT NULL,
  path             TEXT NOT NULL,                   -- display path
  name             TEXT NOT NULL,
  size             INTEGER,
  mtime_ms         INTEGER,
  sha1             TEXT,
  rev_uid          TEXT,
  source           TEXT NOT NULL,                   -- crawl | import
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (account_id, uid)
);
CREATE INDEX IF NOT EXISTS remote_index_sha1 ON remote_index(account_id, sha1);
CREATE INDEX IF NOT EXISTS remote_index_name ON remote_index(account_id, name, size);

-- Proposed remote moves instead of uploads (AdoptionProposalDto).
CREATE TABLE IF NOT EXISTS adoption_proposals (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL,
  pair_id          INTEGER NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  target_rel_path  TEXT NOT NULL,
  source_remote_path TEXT NOT NULL,
  source_uid       TEXT NOT NULL,
  source_section   TEXT NOT NULL,
  source_entry_id  INTEGER,                         -- set when the source is an entry of another pair
  size             INTEGER NOT NULL,
  matched_by       TEXT NOT NULL,                   -- sha1 | name_size_mtime
  outside_pair     INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | done | stale
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  decided_by       TEXT,
  job_id           INTEGER
);
CREATE INDEX IF NOT EXISTS adoption_open ON adoption_proposals(state, pair_id);
CREATE UNIQUE INDEX IF NOT EXISTS adoption_entry_open ON adoption_proposals(entry_id) WHERE state IN ('pending','accepted');

-- Priority list for the digest backfill (filled by earlier versions; read by the backfill).
CREATE TABLE IF NOT EXISTS backfill_priority (
  account_id       TEXT NOT NULL,
  remote_path      TEXT NOT NULL,
  uid              TEXT NOT NULL,
  reclaimable      INTEGER,
  PRIMARY KEY (account_id, uid)
);

-- Safety brake state per pair (docs/SYNC-RULES.md): set when a run was stopped, released by the user.
CREATE TABLE IF NOT EXISTS pair_state (
  pair_id          INTEGER PRIMARY KEY REFERENCES pairs(id) ON DELETE CASCADE,
  brake_reason     TEXT,
  brake_at         INTEGER,
  brake_released_at INTEGER,
  last_scan_stats  TEXT
);
