-- SPDX-License-Identifier: GPL-3.0-or-later
-- Like 007 for the other job types: a failed download whose file is now identical on both sides, and a failed
-- local trash whose file is already gone locally, are superseded.
UPDATE jobs SET state = 'cancelled', last_error = 'superseded: the file is in sync'
 WHERE state = 'failed' AND type = 'download'
   AND entry_id IN (SELECT id FROM entries WHERE l_exists = 1 AND l_sha1 IS NOT NULL AND l_sha1 = r_sha1);
UPDATE jobs SET state = 'cancelled', last_error = 'superseded: the file is already gone locally'
 WHERE state = 'failed' AND type = 'trash_local'
   AND (entry_id IS NULL OR entry_id IN (SELECT id FROM entries WHERE l_exists = 0));
