-- SPDX-License-Identifier: GPL-3.0-or-later
-- Message keys (shared/src/messages.ts): activity rows keep the English text in `message` and the key + params of
-- daemon messages as JSON in `msg` ({"key":"activity.backOnline"} / {"key":…,"params":{…}}), so the dashboard can
-- show them in its own language. Older rows have no `msg` and keep their text. Other daemon texts in TEXT columns
-- (accounts.last_error, pair_state.brake_reason, jobs.last_error) are stored as `msg:{…}` (encodeMsg) instead.
ALTER TABLE activity ADD COLUMN msg TEXT;
