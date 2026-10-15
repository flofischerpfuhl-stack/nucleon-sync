-- SPDX-License-Identifier: GPL-3.0-or-later
-- node:sqlite cannot read integers > 2^53 as JS numbers: store local mtimes/ctimes in microseconds instead of ns.
ALTER TABLE entries RENAME COLUMN l_mtime_ns TO l_mtime_us;
ALTER TABLE entries RENAME COLUMN l_ctime_ns TO l_ctime_us;
ALTER TABLE entries RENAME COLUMN b_l_mtime_ns TO b_l_mtime_us;
UPDATE entries SET l_mtime_us = l_mtime_us / 1000, l_ctime_us = l_ctime_us / 1000, b_l_mtime_us = b_l_mtime_us / 1000;
