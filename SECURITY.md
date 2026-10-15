# Security policy

## Supported versions

Only the latest release receives security fixes. Please update before reporting.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private vulnerability reporting on the
repository (Security → Report a vulnerability). Include the version, how to reproduce the problem and what an
attacker gains. You will get an answer as soon as possible; this is a volunteer project, so please allow some time
for a fix before you publish details.

Problems in Proton's services or in the official `proton-drive` CLI itself belong to Proton; please report them
through Proton's official channels. Nucleon Sync is a third-party application and is not affiliated with
Proton AG.

## Threat model in short

Nucleon Sync runs as your user. It protects your Proton session and your files against other users on the machine,
against websites in your browser, and against mistakes by agents and by the app itself. It does not protect against
malware running as your own user: such a process can read the same files and keyring items that the app and the
official CLI can.

### Local API

- The daemon listens on a Unix socket `$XDG_RUNTIME_DIR/nucleon-sync/api.sock` (socket 0600 in a 0700 directory).
- Optional TCP listens on `127.0.0.1` only. TCP requests must carry an allowed `Host` header (`127.0.0.1:<port>` or
  `localhost:<port>`, against DNS rebinding), and every request with an `Origin` header is rejected, so web pages
  cannot talk to the API.
- Every request needs a bearer token. Token files are 0600 in `~/.config/nucleon-sync/`: `api-token` (the dashboard's
  full-access token), `agent-token` (the built-in agent token with `read` + `sync`), named agent tokens in
  `agent-tokens/` (the registry `agent-tokens.json` stores only SHA-256 digests; lookups compare digests in constant
  time).
- **Scopes**: agent tokens carry `read`, `sync`, `manage` and/or `destructive`. Token and approval management is only
  possible with the dashboard's token. A request without the needed scope gets 403.
- **Approvals**: destructive requests made with an agent token (removing a pair or account, logging out, trashing
  files, emptying the Proton trash, releasing a safety brake, …) only run after the user approves them in the
  dashboard. The confirm token is single use, bound to the agent token, method, path and body, and expires after
  15 minutes.
- Processes running as the same user can read the token files and call the API. This is the same trust boundary as
  the official CLI's own session.

### Proton session

- The app runs the official, unmodified `proton-drive` CLI. Each account's session is stored by the CLI itself,
  through a `pass`-compatible shim, in its own Secret Service item (`service=nucleon-sync`, `account=<id>`; GNOME
  Keyring, KWallet, KeePassXC, …). Secrets pass only through pipes, never through command lines, environment variables
  or plaintext files. Presence checks use D-Bus `SearchItems` and never read the secret.
- Processes running as your user can read Secret Service items while the keyring is unlocked. The same is true for
  the official CLI's default store.
- **Logout suppression**: the CLI deletes the stored session when a token refresh fails, which can happen when two of
  its processes race. The shim ignores such deletions unless `NUCLEON_SYNC_ALLOW_LOGOUT=1`, which only the explicit
  logout sets. To really log out, use the dashboard (Accounts → Log out …) or `nucleon-sync accounts logout <id>`; this
  runs `proton-drive auth logout` and removes the keyring item. Removing an account from the app does not remove its
  keyring item. As a last resort you can delete the item yourself:
  `secret-tool clear service nucleon-sync account <id>`.
- **Encrypted file store** (`encfile`, only for desktops without a Secret Service, chosen explicitly): sessions are
  AES-256-GCM files in `~/.local/state/nucleon-sync/secrets/` (0600) with a key in `~/.config/nucleon-sync/secret.key`
  (0600). This protects copies of the state directory (backups, synced folders) that do not include the key. It does
  not protect against processes running as your user, which can read both files.
- The CLI's metadata caches stay encrypted (`PROTON_DRIVE_UNSAFE_CACHE` is never set). Each CLI worker gets a minimal,
  explicit environment.

### Dashboard (Electron)

- Renderers run with `contextIsolation`, `sandbox` and without Node integration, under a strict Content Security
  Policy, with no remote content.
- Navigation, redirects, `window.open` and webviews are blocked; permission requests are denied.
- The renderer talks to the main process through an IPC allowlist: API requests only to `/v1/…` paths of safe
  characters; external links only to `https://*.proton.me`; "show in folder" and "open file" only below a pair's
  local folder. Every IPC call must come from the bundled UI. The API token never reaches the renderer.

### The official CLI binary

- The setup wizard uses an installed `proton-drive` (e.g. from your distribution or the AUR) or downloads the official
  build listed at `https://proton.me/download/drive/cli/version.json`. The download is verified with SHA-512 against
  Proton's manifest **and**, for the versions a release was tested with, against hashes pinned in the release
  (`PINNED_CLI_SHA512` in `shared/src/defaults.ts`). A mismatch aborts the installation.
- An untested CLI version puts the daemon into read-only mode.
- There is no self-updater: neither the app nor the CLI updates itself. Updates come from your package manager or a
  new AppImage you download.

### Notifications

- Beyond desktop notifications, the only channel is the optional `notifyCommand`; the app stores no third-party
  credentials for notifications (a script you point it at keeps its own secrets). Since 0.4.0 a chat bot token left
  behind by 0.3.x is deleted from the keyring or the encrypted file store once at startup.
- The optional `notifyCommand` is read only from `~/.config/nucleon-sync/daemon.json`. It cannot be set over the API,
  so an agent token cannot make the daemon run commands. It is started without a shell, with a 30-second timeout.

### Data safety

- Writes in production require `NUCLEON_SYNC_ALLOW_WRITES=1` (the packaged units set it; the source-checkout unit
  starts in planning mode).
- Nothing is deleted outright: local files go to the freedesktop trash, Proton files to the Proton trash. Safety
  brakes stop a pair when its folder is missing or suddenly empty, or when many files disappear at once.
- The state database (`~/.local/state/nucleon-sync/state.sqlite`) holds paths, sizes, checksums and Proton node ids,
  no file contents. Logs never contain tokens or secrets.
