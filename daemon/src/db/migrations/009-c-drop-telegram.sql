-- SPDX-License-Identifier: GPL-3.0-or-later
-- 0.4.0 removed the built-in Telegram channel (the notifyCommand hook in daemon.json replaces it): drop its settings
-- from the per-section row 'notifications' and from the older whole-settings row 'settings', and drop its rows from
-- the notification log. The bot token lives outside the DB (keyring or encrypted file); notify/legacyToken.ts
-- deletes it once at startup, best effort.
UPDATE settings SET value = json_remove(value, '$.telegram')
 WHERE key = 'notifications' AND json_valid(value) AND json_type(value, '$.telegram') IS NOT NULL;
UPDATE settings SET value = json_remove(value, '$.notifications.telegram')
 WHERE key = 'settings' AND json_valid(value) AND json_type(value, '$.notifications.telegram') IS NOT NULL;
DELETE FROM notifications WHERE channel = 'telegram';
