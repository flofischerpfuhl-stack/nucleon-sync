---
name: nucleon-sync
description: Operate the local Proton Drive sync service Nucleon Sync through its `nucleon-sync` CLI. Check status and transfers, trigger a sync, pause and resume, add a folder pair, and inspect conflicts, pending deletions and errors, all with --json. Use this skill whenever a task involves Proton Drive syncing on this machine. Destructive actions always need the user's approval in the dashboard.
---

# Nucleon Sync for agents

A background service (`nucleon-sync.service`, systemd user unit) syncs local folders with Proton Drive for one or
more Proton accounts. A dashboard app (`nucleon-sync-gui`) shows everything to the user. Nucleon Sync is a
third-party app built on the official `proton-drive` CLI; it is not made by Proton.

You talk to the service only through the `nucleon-sync` command. Always add `--json`. You then get exactly one JSON
document on stdout, also on errors, and the command never prompts. The full contract (every command, every field,
every exit code) is in `docs/CLI-JSON.md` of the project.

## Never do this

- **Never run `proton-drive` (the official Proton CLI) yourself, and never touch its session or keyring items.** A
  second CLI process on the same account can log the user out of the running service.
- Never read, copy, print or move token files (`~/.config/nucleon-sync/*token*`) or session secrets. Never use
  `--ui-token`; that token belongs to the user.
- Never edit `~/.local/state/nucleon-sync` (state database) or `~/.config/nucleon-sync` by hand. Never stop, restart
  or kill the service unless the user asks for it.
- Destructive actions are only allowed when the user asked for them in this conversation, and they always wait for
  the user's approval in the dashboard. Do not try to work around a denied approval. These are destructive:
  - removing a pair or an account
  - logging out
  - `deletions decide trash_remote` / `trash_local`
  - `deletions approve PAIR` (held mass deletions of a two-way pair)
  - `empty-trash`
  - `release-brake`
  - `digest-backfill`
  - conflict resolutions that put a file or a copy into the trash
  - changing a pair's direction (also to `two-way`)
- Do not decide conflicts or pending deletions on your own. Show them to the user and ask.

## Your token

```bash
nucleon-sync whoami --json
# {"scope":"agent","tokenId":"default","name":"default","permissions":["read","sync"],"approvalRequired":["destructive"]}
```

Without options the CLI uses the built-in token `default`. It may read everything, sync, pause and resume, and
measure storage.

Some tasks need more: adding a pair, changing settings, resolving conflicts. For those, ask the user to create a
token in **Settings → Agents & API** with the scopes `manage` (and `destructive` if needed), then use it:

- `nucleon-sync --agent NAME …`, or
- `NUCLEON_SYNC_AGENT=NAME nucleon-sync …`

If a command answers exit 6 with `code: "forbidden"`, the token lacks a scope. Tell the user which scope is missing
(the `needs` field and the error message say it). Do not look for other tokens.

## Check the status

```bash
nucleon-sync status --json | jq '{state, paused, pausedUntil, openConflicts, pendingDeletions,
  accounts: [.accounts[] | {id, status, paused, lastError}],
  upload: .transfers.upload, download: .transfers.download}'
```

- `state`: `idle`, `syncing`, `paused`, `offline` or `error`.
- `accounts[].status`: `ok`, `needs_login`, `needs_keyring`, `offline`, `throttled` or `error`.
- `transfers.upload`/`download` hold `files`, `bytes`, `bytesDone`, `rateBps` and `etaSeconds` (ETA in seconds).
  `transfers.active[]` lists the running files with progress.
- `pairs[]` lists the folder pairs (`id`, `localRoot`, `remoteRoot`, `direction`, `enabled`, `paused`, `brake`). A
  `brake` is a safety stop. Tell the user about it; only they can release it.
- Exit 3 means the service is not running. Tell the user; do not start it yourself unless asked.

`nucleon-sync doctor --json` gives a health check list (`[{id, ok, severity, message}]`), even without the service.

## Trigger a sync

```bash
nucleon-sync sync --json                       # all accounts, incremental
nucleon-sync sync --pair 3 --wait --json       # one pair, priority lane, wait until done
nucleon-sync sync --account alex --full --json # full comparison (slow)
```

- Exit 4: nothing was synced for that scope, because the pair or account is disabled, paused or needs a login. The
  reason is in `notRunnable`.
- With `--wait`: exit 0 when the run finished `ok`, exit 1 otherwise. The result is in `status`, `counters` and
  `runs[]`.
- `writesBlocked` is set when the service runs in planning mode (no uploads or downloads).

## Pause and resume

```bash
nucleon-sync pause --for 2h --json            # everything, resumes by itself
nucleon-sync pause --account alex --json      # one account; --pair N for one pair
nucleon-sync pause --now --json               # also stop running transfers immediately
nucleon-sync resume --json
nucleon-sync pause --toggle --json            # {"ok":true,"action":"pause"|"resume"}
nucleon-sync paused                           # exit 0 = paused, 1 = running
```

## Add a folder pair (scope `manage`)

Preview first, then show the result to the user, then create:

```bash
nucleon-sync --agent NAME pairs preview --account alex --local ~/Projects --remote /my-files/Projects \
  --direction backup --json
# {"adopt":12,"upload":340,"uploadBytes":…,"download":0,"conflicts":0,"excluded":3,"warnings":[]}
nucleon-sync --agent NAME pairs add --account alex --local ~/Projects --remote /my-files/Projects \
  --direction backup --json
```

Directions:

- `backup`: the local side leads. Local deletions only happen after the user decides.
- `mirror-down`: Proton leads. The local copy follows it.
- `upload-only`: an outbox. Nothing is ever downloaded or deleted.
- `two-way`: both sides are equal; changes and deletions go both ways (see "Two-way pairs" below).

The local folder must exist and must not be the folder of another pair. A two-way pair may lie inside another pair
when its Proton folder lies at the same sub path inside that pair's Proton folder; the outer pair then excludes the
sub folder (nothing is deleted). Change a pair with
`pairs set N name=… enabled=false paused=true options.uploadLocalNew=true`.

## Conflicts, pending deletions, errors

```bash
nucleon-sync conflicts --json      # [{id, pairId, relPath, kind, local:{size,mtime}, remote:{…}}]
nucleon-sync deletions --json      # deleted locally, still in Proton: [{id, relPath, size, remoteChangedSinceDelete}]
nucleon-sync adoptions --json      # identical content found elsewhere in Proton
nucleon-sync jobs --state failed --json
nucleon-sync activity --action error --since 2026-10-13T00:00:00Z --limit 50 --json
```

Summarise what you find for the user. When they decide, apply it:

- `conflicts resolve ID keep_local|keep_remote|keep_both|ignore`
- `deletions decide restore_local|keep_remote_only|trash_remote ID…`

Choices that delete something wait for the user's approval (see below).

## Two-way pairs

A `two-way` pair compares both sides with the last state they agreed on. Edits go both ways; a file changed on both
sides is **kept twice** (`Name (conflict <host> <date>).ext` next to the original, on both sides); deletions go into
the trash of the other side (local freedesktop trash, Proton trash). Remote changes are found by listing, every
`remoteCheckMinutes` (default 10), or at once with `nucleon-sync sync --pair N`.

What you may do with a `manage` token:

- create a two-way pair (`pairs add … --direction two-way`; preview first), also nested in a backup pair;
- change its options: `pairs set N options.remoteCheckMinutes=15 options.massDeleteMaxFiles=50
options.massDeletePercent=10`;
- dismiss review items: `conflicts resolve ID keep_both` (both versions stay);
- restore: `deletions decide restore_local|restore_remote ID…`, or `deletions deny PAIR` for a whole held batch —
  only when the user said so.

What you report and leave to the human:

- **Held mass deletions.** When one run would delete more than `massDeleteMaxFiles` files (or `massDeletePercent` %),
  nothing is deleted: the pair stops completely, `pairs --json` shows `heldDeletions`, `deletions --json` shows the
  entries with `held: true` and `side` (`local` = deleted here, `remote` = deleted in Proton). Tell the user, list a
  few paths, and point them to **Conflicts & deletions** in the dashboard (`nucleon-sync open issues`). Approving is
  their decision. `deletions approve PAIR` needs the `destructive` scope and still waits for their approval in the
  dashboard; never use it just to get the pair running again.
- **Review items** (`conflicts --json` entries with `keptBoth`): `keep_local` / `keep_remote` put one version into
  the trash (destructive, approval). Ask first.
- Switching an existing pair to `two-way` changes what happens to deletions from then on; it needs the user's
  approval (`pairs set N direction=two-way --yes`).

## Destructive actions: the user approves in the dashboard

```bash
nucleon-sync --agent NAME pairs remove 3 --yes --json
```

- Without `--yes` you get exit 5 and nothing happens; the `confirm.summary` field says what would happen.
- With `--yes`, the dashboard shows the request to the user (dialog plus desktop notification) and the CLI waits up
  to 5 minutes (`--approval-timeout S`). The outcome:
  - approved: exit 0, the action ran once.
  - denied: exit 6, `code: "approval_denied"`. Accept that.
  - no decision yet: exit 7, `code: "approval_pending"`. The answer contains `approval.id` and `confirmToken`. Tell
    the user what is waiting. Later, run the identical command again with `--confirm-token <token>`. The approval
    expires after 15 minutes.

## Notifications

```bash
nucleon-sync notifications --json   # what the notify command sent: [{ts, channel, key, message, ok}]
```

The user configures notifications: desktop notifications in Settings → Notifications, anything else (phone push,
chat bot, mail) through their own `notifyCommand` script in `~/.config/nucleon-sync/daemon.json`. Change
notification settings only when the user asks; never edit `daemon.json` or the user's notify script on your own, and
never handle the secrets such a script uses. Problems are sent right away, pending decisions once a day.

## Status bar and dashboard

`nucleon-sync bar --json` prints the status-bar JSON: `{text, alt: idle|syncing|paused|throttled|conflicts|error|stopped,
tooltip, class}`. Held two-way deletions and review items count as `conflicts` (the tooltip names the held pairs).

`nucleon-sync open issues` opens the dashboard on a screen. Screens: `overview`, `activity`, `folders`, `issues`,
`storage`, `accounts`, `settings`, `maintenance`. Use it when you want to show the user something.
