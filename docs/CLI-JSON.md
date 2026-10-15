# `nucleon-sync` CLI: the agent contract

Stable within API `v1` (app version 0.3.0). Agents (coding agents such as Claude Code or Codex, scripts, chat
bridges) use the CLI with `--json`. The instructions for agents themselves are in
[`agent-skill/SKILL.md`](../agent-skill/SKILL.md); the token and approval design is in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §7.

## Rules

- `--json` prints exactly one JSON document on stdout, on success and on failure. Human text and progress go to
  stderr. Exception: `bar` always prints one line of status-bar JSON, with or without `--json`.
- `--json` never prompts. Destructive commands need `--yes` (alias `--confirm`), otherwise exit 5.
- DTO names refer to `shared/src/api.ts`, `shared/src/ext-*.ts` and `shared/src/ext-agent.ts`. New fields can be
  added at any time (additive), so parse leniently. Fields are never renamed or removed within `v1`.

## Exit codes

| Code | `code` in the error JSON                                           | Meaning                                                                                              |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 0    | –                                                                  | ok                                                                                                   |
| 1    | `error`, `api_error`, `timeout`, `approval_expired`, `gui_missing` | failure (API error, `sync --wait` run not ok, ...)                                                   |
| 2    | `usage`                                                            | bad command line                                                                                     |
| 3    | `daemon_down`                                                      | daemon not running or not configured                                                                 |
| 4    | – (stdout is the `SyncResponse`)                                   | `sync`: the requested scope is not runnable (pair disabled/paused, account paused, login needed)     |
| 5    | `confirmation_required`                                            | destructive command without `--yes`; `confirm.summary` says what would happen                        |
| 6    | `forbidden`, `approval_denied`                                     | the token lacks the scope (`status: 403`), or the user denied the approval                           |
| 7    | `approval_pending`                                                 | the user has not approved yet (`--no-wait`, or `--approval-timeout` reached); `confirmToken` resumes |

`paused` uses the exit code as its answer: 0 = paused, 1 = running, 3 = daemon down.

Error document:

```json
{
  "ok": false,
  "exitCode": 6,
  "code": "forbidden",
  "error": "the agent token \"default\" lacks the scope \"manage\" (…)",
  "status": 403
}
```

Additional fields by code:

- `confirmation_required`: `confirm: { summary: ConfirmSummaryDto, expiresAt }`.
- `approval_pending`: `approval: ApprovalDto, confirmToken`.
- `approval_denied`: `approval`.

## Tokens

The CLI picks the first token that applies:

1. `--ui-token`: the dashboard's full-access token. For humans only.
2. `NUCLEON_SYNC_TOKEN`: the token itself.
3. `NUCLEON_SYNC_TOKEN_FILE`: path to a file holding the token.
4. `--agent NAME`, or `NUCLEON_SYNC_AGENT=NAME`: a named token from Settings → Agents. The CLI reads its file from
   `~/.config/nucleon-sync/agent-tokens/<id>.token`.
5. Otherwise the built-in token `default` from `~/.config/nucleon-sync/agent-token`. Its scopes are `read` and
   `sync`.

`nucleon-sync whoami --json` shows which token is in use and what it may do.

## Commands and their JSON

| Command                                                                                                                                                                                                                                             | Scope                                                                                                                                                        | stdout (`--json`)                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`                                                                                                                                                                                                                                            | read                                                                                                                                                         | `StatusDto` (+ `pausedUntil`)                                                                                                                          |
| `whoami`                                                                                                                                                                                                                                            | read                                                                                                                                                         | `WhoAmIDto` `{scope, tokenId, name, permissions, approvalRequired}`                                                                                    |
| `paused`                                                                                                                                                                                                                                            | read                                                                                                                                                         | `{paused, pausedUntil}` (exit 0/1)                                                                                                                     |
| `sync [--account ID] [--pair N] [--full\|--verify]`                                                                                                                                                                                                 | sync                                                                                                                                                         | `SyncResponse` `{runId, runIds, followUp, queuedBehind, notRunnable, writesBlocked}`                                                                   |
| `sync … --wait [--timeout S]`                                                                                                                                                                                                                       | sync                                                                                                                                                         | `RunDto` of the first covering run + `followUp, requestedRunId, runIds, runs[], notRunnable, writesBlocked, blockedJobs` (exit 1 if a run is not `ok`) |
| `pause [--account ID\|--pair N] [--for 30m\|2h\|1d\|tomorrow] [--now] [--toggle]`                                                                                                                                                                   | sync                                                                                                                                                         | `{ok, until, action: "pause"\|"resume"}`                                                                                                               |
| `resume [--account ID\|--pair N]`                                                                                                                                                                                                                   | sync                                                                                                                                                         | `{ok, action: "resume"}`                                                                                                                               |
| `activity [--since ISO] [--account] [--pair] [--action a,b] [--q TEXT] [--limit N]`                                                                                                                                                                 | read                                                                                                                                                         | `ActivityItem[]` (newest first)                                                                                                                        |
| `runs [--limit N]`                                                                                                                                                                                                                                  | read                                                                                                                                                         | `RunDto[]`                                                                                                                                             |
| `jobs [--state S] [--limit N]`                                                                                                                                                                                                                      | read                                                                                                                                                         | `JobDto[]`                                                                                                                                             |
| `conflicts`                                                                                                                                                                                                                                         | read                                                                                                                                                         | `ConflictDto[]`                                                                                                                                        |
| `conflicts resolve ID keep_local\|keep_remote\|keep_both\|ignore`                                                                                                                                                                                   | manage; + destructive + approval when the resolution trashes something (also the two-way review clean-ups `keep_local`/`keep_remote` and "delete after all") | `{ok: true}`                                                                                                                                           |
| `deletions`                                                                                                                                                                                                                                         | read                                                                                                                                                         | `PendingDeletionDto[]` (two-way: `side`, `held`)                                                                                                       |
| `deletions decide restore_local\|keep_remote_only\|restore_remote ID…`                                                                                                                                                                              | manage                                                                                                                                                       | `{ok, jobIds}`                                                                                                                                         |
| `deletions decide trash_remote\|trash_local ID…`                                                                                                                                                                                                    | destructive + approval                                                                                                                                       | `{ok, jobIds}`                                                                                                                                         |
| `deletions deny PAIR`                                                                                                                                                                                                                               | manage                                                                                                                                                       | `{ok, decided, jobIds}`: restores every held deletion of a two-way pair                                                                                |
| `deletions approve PAIR`                                                                                                                                                                                                                            | destructive + approval                                                                                                                                       | `{ok, decided, jobIds}`: carries out every held deletion (trash on both sides)                                                                         |
| `adoptions` / `adoptions accept\|reject ID…`                                                                                                                                                                                                        | read / manage                                                                                                                                                | `AdoptionProposalDto[]` / `{ok}`                                                                                                                       |
| `accounts` / `accounts show ID`                                                                                                                                                                                                                     | read                                                                                                                                                         | `AccountDto[]` / `AccountDto`                                                                                                                          |
| `accounts add ID NAME` / `accounts set ID name=…\|workers=N\|enabled=…`                                                                                                                                                                             | manage                                                                                                                                                       | `AccountDto`                                                                                                                                           |
| `accounts login ID [--no-wait]`                                                                                                                                                                                                                     | manage                                                                                                                                                       | `{accountId, signInUrl}` (`--no-wait`), else the same + `{ok, message}` once the user confirmed                                                        |
| `accounts cancel-login ID`                                                                                                                                                                                                                          | manage                                                                                                                                                       | `{ok}`                                                                                                                                                 |
| `accounts logout ID` / `accounts remove ID`                                                                                                                                                                                                         | destructive + approval                                                                                                                                       | `{ok}`                                                                                                                                                 |
| `pairs` / `pairs show N` / `pairs rules N`                                                                                                                                                                                                          | read                                                                                                                                                         | `PairDto[]` / `PairDto` / `SelectionRule[]`                                                                                                            |
| `pairs preview\|add --account ID --local DIR --remote PATH [--name N] [--direction D] [--disabled]` (`D` = `backup`, `mirror-down`, `upload-only`, `two-way`; anything else exits 2)                                                                | manage (also a two-way pair nested in another pair)                                                                                                          | `PairPreviewDto` / `PairDto`                                                                                                                           |
| `pairs set N key=value…` (`name`, `enabled`, `paused`, `direction`, `options.uploadLocalNew`, `options.remoteChanges`, `options.remoteDeletions`; two-way: `options.remoteCheckMinutes`, `options.massDeleteMaxFiles`, `options.massDeletePercent`) | manage (direction change, also to `two-way`: + approval)                                                                                                     | `PairDto`                                                                                                                                              |
| `pairs remove N`                                                                                                                                                                                                                                    | destructive + approval                                                                                                                                       | `{ok}` (only the sync state is removed)                                                                                                                |
| `release-brake N`                                                                                                                                                                                                                                   | destructive + approval                                                                                                                                       | `{ok}`                                                                                                                                                 |
| `empty-trash --account ID`                                                                                                                                                                                                                          | destructive + approval                                                                                                                                       | `{ok}`                                                                                                                                                 |
| `digest-backfill --pair N [--prefix P] [--limit N]`                                                                                                                                                                                                 | destructive + approval                                                                                                                                       | `{runId}`                                                                                                                                              |
| `storage` / `storage --history` / `storage --measure [--account ID]`                                                                                                                                                                                | read / read / sync                                                                                                                                           | `StoragePoolDto` / `StorageHistoryPoint[]` / `StoragePoolDto`                                                                                          |
| `settings` / `settings set section.key=<json>…`                                                                                                                                                                                                     | read / manage                                                                                                                                                | `SettingsDto`                                                                                                                                          |
| `doctor`                                                                                                                                                                                                                                            | read (works without daemon)                                                                                                                                  | `DoctorCheck[]` (exit 1 when an error-level check fails)                                                                                               |
| `notifications [--limit N]`                                                                                                                                                                                                                         | read                                                                                                                                                         | `NotificationLogItem[]` (what the notify command sent, newest first)                                                                                   |
| `cli --account ID -- <proton-drive args>`                                                                                                                                                                                                           | sync                                                                                                                                                         | `CliPassthroughResponse` `{exitCode, stdout, stderr}` (read-only allow-list)                                                                           |
| `bar [--format waybar\|omarchy] [--watch]`                                                                                                                                                                                                          | read                                                                                                                                                         | status-bar JSON `{text, alt, tooltip, class, percentage?}` (always exit 0)                                                                             |
| `open [SCREEN]`                                                                                                                                                                                                                                     | –                                                                                                                                                            | `{ok, screen}`: starts or focuses the dashboard (`nucleon-sync-gui --open=SCREEN`)                                                                     |
| `tokens [list]`, `tokens create NAME --scopes …`, `tokens revoke\|enable\|disable ID`, `tokens set ID scopes=a,b`                                                                                                                                   | UI token                                                                                                                                                     | `AgentTokenInfoDto[]` / `CreateAgentTokenResponse` (secret once) / `{ok}` / `AgentTokenInfoDto`                                                        |
| `token [--rotate]`                                                                                                                                                                                                                                  | UI token                                                                                                                                                     | `{file, token}` of the built-in token                                                                                                                  |
| `approvals [list]`, `approvals show ID`, `approvals approve\|deny ID`                                                                                                                                                                               | UI token (`show`: own approvals with an agent token)                                                                                                         | `ApprovalDto[]` / `ApprovalDto`                                                                                                                        |

## Destructive commands with an agent token

1. `nucleon-sync --agent assistant pairs remove 3 --yes --json`:
   - The agent confirms with `--yes`.
   - The daemon shows the request to the user (dashboard dialog and desktop notification).
   - The CLI waits up to `--approval-timeout` seconds (default 300).
2. If the user approves: exit 0. The request runs once.
3. If the user denies: exit 6, `code: "approval_denied"`.
4. If the user has not decided in time, or `--no-wait` was given: exit 7. The answer contains `approval.id` and
   `confirmToken`. Later, re-run the identical command with `--confirm-token <token>`. The approval expires after
   15 minutes.

Without `--yes` you get exit 5, and nothing is shown to the user.

## Two-way pairs

- `pairs --json` shows per pair `direction: "two-way"`, `heldDeletions` (deletions held by the mass-delete guard),
  `lastRemoteCheckAt`, `options.twoWayAdoption` (first sync still running) and `ownedElsewhere` (sub folders owned by
  a nested pair). Human output: `HELD: N deletions (deletions approve|deny N)`.
- A pair with held deletions does not run at all until every held deletion is decided. **The decision is for the
  human:** `deletions approve PAIR` needs the `destructive` scope and the user's approval in the dashboard, exactly
  like `pairs remove`; `deletions deny PAIR` (restore everything) only needs `manage`.
- Single decisions on held deletions: files deleted here (`side: "local"`) take `trash_remote` / `restore_local`,
  files deleted in Proton (`side: "remote"`) take `trash_local` / `restore_remote`. The trashing ones are
  destructive.
- `conflicts --json` marks two-way review items with `keptBoth: {copyRelPath}` (both versions exist, nothing is
  blocked). `keep_both` / `ignore` only dismiss the item (manage); `keep_local` / `keep_remote` put one version into
  the trash (destructive + approval).

Example (agent token with `destructive`):

```sh
nucleon-sync --agent assistant deletions approve 7 --yes --no-wait --json   # exit 7, {approval, confirmToken}
# … the user approves in the dashboard …
nucleon-sync --agent assistant deletions approve 7 --confirm-token <token> --json   # exit 0, {ok, decided, jobIds}
```

## Notifications

`notifications --json` lists what the daemon's notify command sent (`NotificationLogItem[]`: `ts`, `channel`
`command`, `key`, `message`, `ok`, `detail`). The command is configured by the user as `notifyCommand` in
`~/.config/nucleon-sync/daemon.json` (file only, not settable over the API); see the README for the environment it
gets and an example script. Desktop notifications are the dashboard's and are not listed here.

`GET /v1/notifications/config` (read) reports `{command: {configured, program}}`; `POST /v1/notifications/test` (UI
token) runs the command with a test event. CLI: `notifications config`, `notifications test [command] --ui-token`.

Since 0.4.0 there is no built-in chat bot channel any more: `settings.notifications` has only `desktop` and
`minIntervalMinutes` (other keys are refused with 400), and the old token route and CLI command are gone.
