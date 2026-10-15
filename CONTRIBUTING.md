# Contributing to Nucleon Sync

Thanks for helping. Nucleon Sync is a small, non-commercial project; bug reports, fixes, translations and careful
reviews are all welcome.

Be kind. Assume good intent, keep discussions about the work, and help newcomers.

## Before you start

- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how it is built) and [`docs/SYNC-RULES.md`](docs/SYNC-RULES.md)
  (what the sync does). Changes to sync behaviour must keep the rules there, or update them in the same pull request.
- For anything bigger than a bug fix, open an issue first so we can agree on the approach.
- Security problems: do **not** open a public issue, see [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements: Linux, Node.js ≥ 26 (the daemon runs TypeScript directly with Node's type stripping), pnpm 11, and
for the dashboard the usual Electron runtime libraries. `xvfb-run` (package `xorg-server-xvfb` on Arch) for headless
GUI tests.

```sh
git clone https://github.com/flofischerpfuhl-stack/nucleon-sync
cd nucleon-sync
pnpm install
```

Run the app against the mock CLI (nothing talks to Proton; state lives in `./.dev`):

```sh
pnpm dev            # daemon + dashboard
pnpm dev:daemon     # daemon only
NUCLEON_SYNC_HOME=$PWD/.dev daemon/bin/nucleon-sync status
```

## Checks

Run these before you open a pull request:

```sh
pnpm test                                             # vitest: daemon, shim, mock CLI, UI unit tests
pnpm typecheck
pnpm lint
npx prettier --check .
xvfb-run -a pnpm --filter @nucleon-sync/ui test:e2e   # Electron end-to-end tests (Playwright)
xvfb-run -a pnpm smoke                                # mock daemon → CLI client → probe run → dashboard
```

GUI tests always run headless (`xvfb-run -a`, offscreen windows). Never run them on your real display, and never on
a machine where they could click into someone's session.

## Never test against a real Proton account

- The test suite uses `mock-cli/`, a behavioural fake of the official `proton-drive` CLI (REPL and one-shot mode, the
  same JSON output, refresh-token rotation, "another device" edits, fault injection). New engine behaviour needs a
  scenario test against the mock (`daemon/test/scenarios/`).
- If the real CLI's behaviour matters, describe it in the issue or pull request (CLI version, command, output with
  personal data removed). Contract fixtures (`daemon/test/contract/fixtures/`) are only recorded by maintainers with
  read-only commands.
- Do not add tests or scripts that need a Proton login, a real keyring item or network access to Proton.
- When you try a development build on your own machine, start with a throwaway folder pair. The source-checkout unit
  starts in planning mode (`NUCLEON_SYNC_ALLOW_WRITES=0`), so you can look at the planned run first.

## Code style

- TypeScript, ESM, erasable syntax only (no enums, parameter properties or namespaces), because Node runs the `.ts`
  files directly.
- Prettier formats everything (`pnpm format`). ESLint must pass.
- Prefer Node built-ins over new dependencies. Explain every new runtime dependency in the pull request.
- `engine/remote.ts` is the only place that builds `proton-drive` command lines. Every remote mutation is a persisted
  job that verifies before and after acting. Nothing is ever deleted outright (trash on both sides).
- New source files start with an SPDX header:

  ```ts
  // SPDX-License-Identifier: GPL-3.0-or-later
  ```

- DB changes go into a new migration file in `daemon/src/db/migrations/` (never edit an applied migration).

## Texts and translations

- The dashboard's strings live in `ui/src/renderer/i18n/`. `en.ts` is the source of truth: add new keys to `en.ts`
  first, then to `de.ts` (and any other language). The typecheck and `ui/test/i18n.test.ts` fail when a language
  misses a key. Components use `t.` (or `section('…')`), never a language file directly.
- Texts produced by the daemon (activity messages, notices, doctor checks, errors) are English and get a message key:
  add the key and its English text to `shared/src/messages.ts`, create the message with `msg('key', params)`, and add
  the key to the `daemon` section of every UI language. The English text stays in the existing fields for the CLI and
  agents.
- New languages are welcome: copy `en.ts` to `<code>.ts`, translate it, and register it in `LOCALES`
  (`ui/src/renderer/i18n/index.ts`).

## Pull requests

- Keep pull requests focused; one topic per pull request.
- Describe what changed and why, and how you tested it.
- Update the docs when behaviour, routes, CLI commands or settings change (`docs/`, `agent-skill/SKILL.md`,
  `docs/CLI-JSON.md`, `docs/PARITY.md`).
- A sign-off line (DCO) is not required. By contributing you agree that your contribution is licensed under the
  project's license, GPL-3.0-or-later.

## Reporting bugs

Use the bug report form on GitHub. Please include:

- the output of `nucleon-sync doctor --json`, **with personal paths, e-mail addresses and account names removed**;
- the versions of Nucleon Sync and of `proton-drive` (`proton-drive --version`), your distribution and desktop, and
  how you installed the app (AUR `nucleon-sync`, AUR `nucleon-sync-bin`, AppImage, source checkout);
- what you did, what you expected and what happened; relevant lines from
  `journalctl --user -u nucleon-sync` (again without personal data).

Never post tokens, the contents of `~/.config/nucleon-sync/`, keyring items or files from
`~/.local/state/nucleon-sync/`.

Nucleon Sync is not affiliated with Proton AG. Please report problems with the app here, not to Proton support.
