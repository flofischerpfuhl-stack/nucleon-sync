## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, new or changed tests. Tests run against the mock CLI only, never against a real Proton account. -->

## Checklist

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` and `npx prettier --check .` pass
- [ ] UI changes: `xvfb-run -a pnpm --filter @nucleon-sync/ui test:e2e` passes (headless)
- [ ] Sync behaviour changes come with a scenario test against the mock CLI and keep (or update) `docs/SYNC-RULES.md`
- [ ] New UI strings are in `ui/src/renderer/i18n/en.ts` first, then in every other language; daemon texts have a
      message key in `shared/src/messages.ts`
- [ ] Docs updated where routes, CLI commands, settings or behaviour changed (`docs/`, `agent-skill/SKILL.md`)
- [ ] New files carry `SPDX-License-Identifier: GPL-3.0-or-later`
- [ ] No personal data (paths, e-mail addresses, account names, tokens) in code, tests, fixtures or screenshots
