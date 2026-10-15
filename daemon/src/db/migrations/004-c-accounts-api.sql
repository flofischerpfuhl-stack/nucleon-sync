-- SPDX-License-Identifier: GPL-3.0-or-later
-- daemon-side timed pauses (POST /v1/pause with `until`) and a notifier digest marker.
CREATE TABLE IF NOT EXISTS pause_timers (
  scope            TEXT NOT NULL CHECK (scope IN ('all','account','pair')),
  target           TEXT NOT NULL,                   -- '' for scope 'all', account id or pair id
  until            INTEGER NOT NULL,                -- epoch ms
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (scope, target)
);
CREATE INDEX IF NOT EXISTS storage_samples_area ON storage_samples(account_id, area, measured_at);
