#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs nucleon-sync for the current user from a source checkout (runs from this repository, no copies of the code;
# for development and for people who prefer a git checkout over the AUR package or the AppImage):
#   - checks Node >= 26, pnpm and the proton-drive CLI (~/.local/bin/proton-drive or on PATH)
#   - pnpm install --frozen-lockfile + UI build
#   - systemd user unit   ~/.config/systemd/user/nucleon-sync.service   (NOT enabled unless --enable)
#   - desktop launcher    ~/.local/share/applications/nucleon-sync.desktop
#   - tray autostart      ~/.config/autostart/nucleon-sync.desktop      (Hidden=true unless --enable-autostart)
#   - CLI symlink         ~/.local/bin/nucleon-sync -> daemon/bin/nucleon-sync (for agents)
#   - runs the read-only `nucleon-sync doctor` at the end
# Usage: scripts/install-user.sh [--dry-run] [--uninstall] [--enable] [--enable-autostart] [--no-build]
# --uninstall removes unit/launcher/autostart/symlink and keeps the state DB, tokens and keyring items.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0
UNINSTALL=0
ENABLE=0
AUTOSTART=0
BUILD=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --enable) ENABLE=1 ;;
    --enable-autostart) AUTOSTART=1 ;;
    --no-build) BUILD=0 ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $a" >&2
      exit 2
      ;;
  esac
done

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT="$UNIT_DIR/nucleon-sync.service"
APP="$DATA_HOME/applications/nucleon-sync.desktop"
AUTO="$CONFIG_HOME/autostart/nucleon-sync.desktop"
BIN_LINK="$HOME/.local/bin/nucleon-sync"
CLI="${NUCLEON_SYNC_CLI:-}"
if [ -z "$CLI" ]; then
  if [ -x "$HOME/.local/bin/proton-drive" ]; then CLI="$HOME/.local/bin/proton-drive"; else CLI="$(command -v proton-drive || true)"; fi
fi
SYSTEMCTL="${NUCLEON_SYNC_SYSTEMCTL:-systemctl}"

say() { printf '%s\n' "$*"; }
die() {
  printf 'install-user.sh: %s\n' "$*" >&2
  exit 1
}
# run: print the action; execute it unless --dry-run
run() {
  say "+ $*"
  if [ "$DRY" -eq 0 ]; then "$@"; fi
}
# render TEMPLATE TARGET [sed expressions...]
render() {
  local src="$1" dst="$2"
  shift 2
  say "+ render $src -> $dst"
  if [ "$DRY" -eq 0 ]; then
    local tmp="$dst.tmp.$$"
    sed "$@" "$src" >"$tmp"
    mv "$tmp" "$dst"
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$UNIT" ]; then run "$SYSTEMCTL" --user disable --now nucleon-sync.service || true; fi
  run rm -f "$UNIT" "$APP" "$AUTO"
  if [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$ROOT/daemon/bin/nucleon-sync" ]; then run rm -f "$BIN_LINK"; fi
  run "$SYSTEMCTL" --user daemon-reload
  say "uninstalled (state in $STATE_HOME/nucleon-sync, tokens in $CONFIG_HOME/nucleon-sync and keyring items kept)"
  exit 0
fi

# ---------------------------------------------------------------- checks (refuse on failure)
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found (Node >= 26 required)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 26 ] || die "Node >= 26 required (found $("$NODE" -v))"
say "ok: node $("$NODE" -v) ($NODE)"
if [ "$BUILD" -eq 1 ]; then
  command -v pnpm >/dev/null || die "pnpm not found"
  say "ok: pnpm $(pnpm -v)"
fi
[ -n "$CLI" ] && [ -x "$CLI" ] || die "proton-drive CLI not found (install proton-drive-cli-bin from the AUR or put the official binary into ~/.local/bin)"
say "ok: proton-drive CLI present ($CLI; not executed)"

# ---------------------------------------------------------------- build
if [ "$BUILD" -eq 1 ]; then
  run pnpm --dir "$ROOT" install --frozen-lockfile
  run pnpm --dir "$ROOT" --filter @nucleon-sync/ui run build
fi

# ---------------------------------------------------------------- files
run mkdir -p "$UNIT_DIR" "$(dirname "$APP")" "$(dirname "$AUTO")" "$(dirname "$BIN_LINK")"
run mkdir -p -m 700 "$CONFIG_HOME/nucleon-sync" "$STATE_HOME/nucleon-sync"
render "$ROOT/packaging/systemd/nucleon-sync.service" "$UNIT" -e "s|@ROOT@|$ROOT|g" -e "s|@NODE@|$NODE|g"
render "$ROOT/packaging/desktop/nucleon-sync.desktop" "$APP" -e "s|@ROOT@|$ROOT|g" -e '/^# Template/d'
if [ "$AUTOSTART" -eq 1 ]; then HIDDEN=false ENABLED=true; else HIDDEN=true ENABLED=false; fi
render "$ROOT/packaging/desktop/nucleon-sync-autostart.desktop" "$AUTO" -e "s|@ROOT@|$ROOT|g" \
  -e "s|@HIDDEN@|$HIDDEN|g" -e "s|@ENABLED@|$ENABLED|g" -e '/^# /d'
if [ -e "$BIN_LINK" ] && [ ! -L "$BIN_LINK" ]; then
  say "skip: $BIN_LINK exists and is not a symlink"
else
  run ln -sfn "$ROOT/daemon/bin/nucleon-sync" "$BIN_LINK"
fi
run "$SYSTEMCTL" --user daemon-reload

# ---------------------------------------------------------------- enable (explicit only)
if [ "$ENABLE" -eq 1 ]; then
  run "$SYSTEMCTL" --user enable --now nucleon-sync.service
else
  say "service installed, NOT enabled. Start later with: systemctl --user enable --now nucleon-sync.service"
fi
if [ "$AUTOSTART" -eq 0 ]; then
  say "tray autostart installed but disabled (Hidden=true). Enable with: $0 --no-build --enable-autostart"
fi

# ---------------------------------------------------------------- read-only diagnosis
say "+ $ROOT/daemon/bin/nucleon-sync doctor"
if [ "$DRY" -eq 0 ]; then "$ROOT/daemon/bin/nucleon-sync" doctor || true; fi
