-- SPDX-License-Identifier: GPL-3.0-or-later
-- Failed upload jobs whose file has since reached Proton (e.g. a later full run uploaded it) stayed "failed" forever
-- and kept the queue counter red. Mark them cancelled once; the executor now does this itself on success.
UPDATE jobs SET state = 'cancelled', last_error = 'superseded: the file is in sync'
 WHERE state = 'failed' AND type IN ('upload', 'upload_revision')
   AND entry_id IN (SELECT id FROM entries WHERE r_uid IS NOT NULL AND l_exists = 1 AND r_size = l_size);
