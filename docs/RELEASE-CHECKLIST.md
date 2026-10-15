# Release checklist

What to do before a release is published, and the results of the checks for the first public release (0.3.0).
Run everything from the repository root of the clean release tree.

## 1. Quality gates

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
npx prettier --check .
pnpm test                                                        # vitest, mock CLI only
xvfb-run -a pnpm --filter @nucleon-sync/ui test:e2e              # Playwright + Electron, headless
xvfb-run -a pnpm smoke                                           # daemon + CLI + hidden dashboard
```

On machines with little memory, run each heavy step on its own, e.g.
`systemd-run --user --collect -p MemoryMax=4G --wait --pipe --working-directory=$PWD pnpm test`.

Tests must never find a real `proton-drive`: the test set-up drops `PATH` entries that contain one, and every test
uses the mock CLI (`mock-cli/`).

0.3.0 results (2026-10-13):

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean (5 packages) |
| `pnpm lint` | 0 problems |
| `npx prettier --check .` | clean |
| `pnpm test` | 67 files, 330 passed, 1 skipped (opt-in libsecret test) |
| e2e (`xvfb-run -a`) | 44 passed |
| `pnpm smoke` | passed |

## 2. Packages

```bash
node scripts/package.mjs           # AppImage, release tarball, local build of the nucleon-sync-bin PKGBUILD, SHA256SUMS
node scripts/packaged-test/run.mjs dist/Nucleon-Sync-<version>-x86_64.AppImage --appimage --display :117
                                   # whole first-run wizard on a private Xvfb, isolated HOME/D-Bus, fake systemctl,
                                   # mock CLI served as the "official" download; result in build/packaged-test/
namcap dist/nucleon-sync-bin-<version>-1-x86_64.pkg.tar.zst
namcap packaging/aur/nucleon-sync/PKGBUILD packaging/aur/nucleon-sync-bin/PKGBUILD
```

For the AUR: bump `pkgver` in both PKGBUILDs, upload the release files, `updpkgsums`, then
`makepkg --printsrcinfo > .SRCINFO` in each package directory, and test-build the source package from the tag
archive (`makepkg -f`).

0.3.0 results:

- `Nucleon-Sync-0.3.0-x86_64.AppImage` (125 MB), `nucleon-sync-0.3.0-linux-x64.tar.gz` (126 MB),
  `nucleon-sync-bin-0.3.0-1-x86_64.pkg.tar.zst` (107 MB); the AppImage smoke test went through every wizard step
  (CLI download with SHA-512 check, encrypted-file store, service, login, folders, schedule, first sync) and
  uploaded the test files to the mock remote.
- The source package `nucleon-sync` was built from a `git archive` of the tree with `makepkg` (pnpm install,
  esbuild bundle, typecheck in `check()`).
- `namcap` on both PKGBUILDs: no findings. On the built packages: only the expected notes for a prebuilt Electron
  app in `/opt` (ELF files in `/opt`, the setuid `chrome-sandbox`, libraries reached through `gtk3`/`nss`) and for
  the source package's script-only dependencies.

## 3. Privacy and secrets

The first public commit is a fresh repository with a single commit (no private history). Before pushing it:

```bash
# secrets in the history and in the tree (build/ and dist/ are not part of the repository)
gitleaks git --no-banner -v .
git archive HEAD | (mkdir -p /tmp/rel && tar -x -C /tmp/rel) && gitleaks dir --no-banner /tmp/rel

# personal paths and private mail addresses (the demo user is "alex"; /home/a, /home/x, /home/demo are test values)
git grep -n -I -E '/home/[a-z][a-z0-9_-]*|/Users/[A-Za-z]|@(gmail|gmx|web|yahoo|outlook|hotmail|protonmail|proton|pm)\.(com|me|de|ch|net)' \
  -- . ':!pnpm-lock.yaml'

# bot-token shapes and numeric chat ids
git grep -n -I -E '\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b|chat_id[^,]*[0-9]{6,}' -- . ':!pnpm-lock.yaml'

# the old private name
git grep -n -I -i -E 'proton[ _-]?sync|PROTON_SYNC|protonsync' -- . ':!pnpm-lock.yaml'

# metadata in images (only IHDR/IDAT/IEND and colour chunks are expected)
python3 -c "import struct,subprocess
for f in subprocess.run(['git','ls-files','*.png'],capture_output=True,text=True).stdout.split():
    d=open(f,'rb').read(); i=8
    while i<len(d):
        n,t=struct.unpack('>I4s',d[i:i+8]); i+=12+n
        if t not in (b'IHDR',b'IDAT',b'IEND',b'PLTE',b'tRNS',b'sRGB',b'gAMA',b'cHRM',b'pHYs',b'bKGD'): print(f,t)"
```

The maintainer additionally runs a private scan with a list of personal terms (names, folder names, device names,
account identifiers, storage figures of the original installation). That list is deliberately not part of the
repository, because publishing it would publish the data it looks for.

0.3.0 results (on the fresh single-commit repository):

| Scan | Result |
| --- | --- |
| `gitleaks git` | 1 commit scanned, no leaks found |
| `gitleaks dir` on the tree | no leaks found |
| personal paths / mail domains | test values only: `/home/alex/…`, `/home/a/Zwei`, `/home/x/…`, `/home/demo/Outbox` (and this checklist) |
| token shapes / chat ids | 1 hit: the fake chat id `424242` in `daemon/test/notify.test.ts` |
| old name | none (except the scan command in this checklist) |
| PNG metadata chunks | none (16 PNG files) |
| maintainer's private term scan | clean |

What was removed or replaced while preparing the first release: real names and household details, real folder and
file names, real storage figures, Proton UIDs and file hashes in the CLI contract fixtures (now random values in the
real format), machine names and paths, a chat id, references to private helper scripts and to the old private
workflow. The demo data used for the screenshots is invented.

## 4. Publish

- Tag `v<version>`, create the GitHub release, attach the AppImage, the tarball and `SHA256SUMS`.
- Update the AUR packages (see section 2).
- Screenshots in `docs/screenshots/` come from `ui/test/e2e/screenshots.spec.ts` (`ui/test/screenshots/`, not
  tracked); copy the curated ones over when the UI changed.
