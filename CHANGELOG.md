# Changelog

All notable changes to Nucleon Sync. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/). Until 1.0, minor versions may change the local API,
`daemon.json` or the CLI's JSON output; such changes are listed here.

## [0.3.0] – unreleased

First public release.

Why 0.3.0 and not 1.0.0: the app has been in daily use (0.1 and 0.2 were private), but it depends on the output of
the official `proton-drive` CLI, which is itself pre-1.0, and the local API and JSON contract are not frozen yet. A
plain `0.3.0` also keeps AUR package versions simple (no pre-release suffixes).

### Sync

- Folder pairs with the directions backup, mirror, upload-only and two-way, several Proton accounts at once, each
  account with its own runs and CLI workers; pair syncs get a priority lane next to long background runs.
- Safety: pending-deletion review for backup pairs, safety brakes (empty folder, mass disappearance), held mass
  deletions for two-way pairs, freedesktop trash for local deletions, Proton trash for remote ones.
- Adoption of files that already exist in Proton (by checksum or name, size and date) instead of uploading them
  again; checksum backfill for old remote files without a checksum.
- Robustness: per-command CLI timeouts, a pause that never interrupts a file half-way unless asked to, detection of
  other `proton-drive` processes using the same session, CLI quirks handled in one place (glob characters in names,
  names starting with `-`, thumbnails), live progress and ETA for big transfers, `.git` internals resolved as
  "local wins" in backup pairs.
- Gentle default schedule: a quick run every 6 hours and a full comparison every 4 weeks (`schedule.fullEveryWeeks`),
  because the CLI has no change feed and Proton asks apps not to poll often.

### Dashboard

- Electron dashboard with tray icon: overview, activity, folders and selection, conflicts and deletions, storage,
  accounts, settings, maintenance (diagnostics, job queue, read-only CLI console).
- First-run wizard: system check, official CLI (installed package or a verified download), keyring or encrypted
  file, background service, login with Proton's third-party notice, folder pairs and directions (nothing
  preselected), schedule and notifications.
- English and German; every text the service produces carries a message key, so the dashboard shows it fully in the
  chosen language. Keyboard shortcuts and focus handling throughout. Follows the Omarchy theme.
- New name, icon and colours.

### Command line, agents, desktop integration

- `nucleon-sync` CLI with a documented `--json` contract and exit codes; scoped agent tokens; destructive agent
  requests wait for the user's approval; an agent skill in `agent-skill/SKILL.md`.
- Status bar module for Waybar and the Omarchy shell, Omarchy menu entries (`nucleon-sync-omarchy`).
- Notifications: desktop, a Telegram bot of your own (token in the keyring), or any command (`notifyCommand`).

### Packaging

- AUR packages `nucleon-sync` (from source, system Electron) and `nucleon-sync-bin` (prebuilt); both depend on the
  official CLI (`proton-drive-cli`).
- AppImage; the wizard installs the user service and the tray autostart.
- The CLI download is checked against Proton's release list and against SHA-512 hashes pinned in the release; an
  untested CLI version keeps the service read-only.

### Configuration

- `daemon.json`: `cliPath`, `stagingDir`, `secretBackend`, `requiredMounts`, `protectedPaths`, `notifyCommand`,
  `tcpPort`, `dailyHour`, `cliTimeouts`. A new install starts without accounts or pairs.
