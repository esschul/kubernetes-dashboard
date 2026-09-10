#!/bin/sh
# Installs the Kubernetes Dashboard AppImage for the current user (no sudo).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/esschul/kubernetes-dashboard/main/scripts/install-linux.sh | sh
#   sh install-linux.sh --uninstall
#
# POSIX sh, not bash: this is meant to work whether piped to `sh` or `bash`,
# and the shebang above is ignored when the script is piped in rather than
# executed directly, so no bash-only syntax ([[, arrays, local) is used.
set -eu

REPO="esschul/kubernetes-dashboard"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/kubernetes-dashboard"
# Stable, unversioned filename — required, not cosmetic: electron-updater's
# Linux updater replaces the running AppImage in place at this exact path.
# Naming it with a version (as electron-builder's own release asset is named)
# would make the updater write a *new* file instead of updating this one,
# leaving the desktop entry and this script's symlink pointing at a stale
# binary after the very first auto-update.
APPIMAGE="$APP_DIR/kubernetes-dashboard.AppImage"
BIN="$HOME/.local/bin/kubernetes-dashboard"
DESKTOP_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$DESKTOP_DIR/kubernetes-dashboard.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
ICON_FILE="$ICON_DIR/kubernetes-dashboard.png"

log() { echo "$@"; }
err() { echo "$@" >&2; }

uninstall() {
    rm -f "$APPIMAGE" "$BIN" "$DESKTOP_FILE" "$ICON_FILE"
    rmdir "$APP_DIR" 2>/dev/null || true
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
    fi
    log "✓ Uninstalled Kubernetes Dashboard."
    log "  Settings and logs remain at \$XDG_CONFIG_HOME/kubernetes-dashboard (usually ~/.config/kubernetes-dashboard) — remove that yourself if you want a clean slate."
    exit 0
}

for arg in "$@"; do
    case "$arg" in
        --uninstall) uninstall ;;
        *) err "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [ "$(uname -s)" != "Linux" ]; then
    err "✗ This installer is for Linux only."
    exit 1
fi
if [ "$(uname -m)" != "x86_64" ]; then
    err "✗ Only x86_64 builds are published (this machine reports $(uname -m))."
    exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT HUP TERM

log "→ Resolving latest release…"
# Avoids the GitHub REST API (and its unauthenticated rate limit): the
# releases/latest page redirects to the tag URL, so a HEAD request is enough.
# /releases/latest never resolves to a draft or prerelease, which matches how
# this project publishes (gh release edit --draft=false --latest).
tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed -n 's#.*/tag/##p')"
if [ -z "$tag" ]; then
    err "✗ Could not resolve the latest release tag for $REPO."
    exit 1
fi
log "  latest release: $tag"

yml_url="https://github.com/$REPO/releases/download/$tag/latest-linux.yml"
yml_file="$tmp/latest-linux.yml"
if ! curl -fsSL -o "$yml_file" "$yml_url"; then
    err "✗ No Linux release asset found for $tag ($yml_url)."
    err "  A Linux build may not have been published yet for this release."
    exit 1
fi

# latest-linux.yml (YAML) has the asset name and its sha512 (base64, not hex)
# at the TOP level; there is also an indented sha512 per entry under files:.
# Anchoring on column 0 picks the top-level keys and skips the indented ones.
asset_name="$(sed -n 's/^path: *//p' "$yml_file" | head -1)"
expected_sha512="$(sed -n 's/^sha512: *//p' "$yml_file" | head -1)"
if [ -z "$asset_name" ] || [ -z "$expected_sha512" ]; then
    err "✗ Could not parse latest-linux.yml."
    exit 1
fi

log "→ Downloading $asset_name…"
asset_url="https://github.com/$REPO/releases/download/$tag/$asset_name"
asset_file="$tmp/$asset_name"
curl -fsSL -o "$asset_file" "$asset_url"

log "→ Verifying checksum…"
actual_sha512="$(openssl dgst -sha512 -binary "$asset_file" | openssl base64 -A)"
if [ "$actual_sha512" != "$expected_sha512" ]; then
    err "✗ Checksum mismatch — refusing to install."
    err "  expected: $expected_sha512"
    err "  actual:   $actual_sha512"
    exit 1
fi
log "  sha512 OK"

chmod +x "$asset_file"

log "→ Extracting icon…"
icon_extracted=0
(
    cd "$tmp"
    # electron-builder's AppImage root has <executableName>.png and .DirIcon,
    # but both are symlinks into the FHS icon theme path below (verified
    # against the actual build output) — extracting just the symlink name
    # leaves it dangling, since its target isn't included unless it also
    # matches the pattern. So extract the FHS path directly, and use `find
    # -L` in case a future build ever bundles a real symlink chain here.
    # --appimage-extract exits 0 even when its glob matches nothing, so each
    # pattern is checked for actual output before moving on.
    for pattern in 'usr/share/icons/hicolor/*/apps/*.png' 'kubernetes-dashboard.png' '.DirIcon'; do
        rm -rf squashfs-root
        "./$asset_name" --appimage-extract "$pattern" >/dev/null 2>&1 || true
        found="$(find -L squashfs-root -name '*.png' -type f 2>/dev/null | head -1)"
        if [ -n "$found" ]; then
            mkdir -p "$ICON_DIR"
            cp "$found" "$ICON_FILE"
            exit 0
        fi
    done
    exit 1
) && icon_extracted=1 || true
if [ "$icon_extracted" != 1 ]; then
    log "  ⚠ could not extract an icon; the app will use a generic icon in menus"
fi

log "→ Installing to $APP_DIR…"
mkdir -p "$APP_DIR"
mv "$asset_file" "$APPIMAGE"
chmod 0755 "$APPIMAGE"

mkdir -p "$(dirname "$BIN")"
ln -sfn "$APPIMAGE" "$BIN"

log "→ Writing desktop entry…"
mkdir -p "$DESKTOP_DIR"
# Exec= points at the real AppImage, never the ~/.local/bin symlink: the
# AppImage runtime sets $APPIMAGE to whatever path was actually invoked, and
# electron-updater relies on that to find the file it should replace.
# StartupWMClass matches what electron-builder itself bakes into the
# AppImage's own bundled .desktop entry (derived from productName).
cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kubernetes Dashboard
Comment=Kubernetes deployments, PRs and pipelines in one view
Exec=$APPIMAGE %U
Icon=kubernetes-dashboard
Categories=Development;
Terminal=false
StartupWMClass=Kubernetes Dashboard
StartupNotify=true
DESKTOP

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

log "→ Checking for the AppImage runtime dependency (FUSE)…"
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    log "  ⚠ libfuse.so.2 not found. The app may fail to launch until you either:"
    log "    - install it: sudo dnf install fuse   (or)   sudo apt install libfuse2"
    log "    - or run it with: $APPIMAGE --appimage-extract-and-run"
fi

case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) log "  ⚠ $HOME/.local/bin is not on your PATH — add it to launch with 'kubernetes-dashboard' from a terminal." ;;
esac

log ""
log "✓ Installed Kubernetes Dashboard $tag."
log "  App:      $APPIMAGE"
log "  Launch:   kubernetes-dashboard   (or find it in your applications menu)"
log "  Uninstall: sh $0 --uninstall"
