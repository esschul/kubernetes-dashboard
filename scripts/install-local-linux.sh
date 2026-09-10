#!/usr/bin/env bash
# Builds the Linux AppImage locally and installs it to the same stable path
# scripts/install-linux.sh uses (~/.local/share/kubernetes-dashboard/), so a
# dev build behaves identically to a real install. No sudo — everything is
# under $HOME.
#
# Usage:
#   bash scripts/install-local-linux.sh              # build + install + launch
#   bash scripts/install-local-linux.sh --unpacked    # skip packaging, just run dist/linux-unpacked
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/kubernetes-dashboard"
APPIMAGE="$APP_DIR/kubernetes-dashboard.AppImage"
BIN="$HOME/.local/bin/kubernetes-dashboard"
DESKTOP_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$DESKTOP_DIR/kubernetes-dashboard.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
ICON_FILE="$ICON_DIR/kubernetes-dashboard.png"

echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > src/build-info.json

if [ "${1:-}" = "--unpacked" ]; then
    echo "→ Building unpacked (fast dev loop) for v${VERSION}…"
    npx electron-builder --linux --dir
    echo "→ Launching dist/linux-unpacked/kubernetes-dashboard…"
    exec "dist/linux-unpacked/kubernetes-dashboard"
fi

echo "→ Building AppImage for v${VERSION}…"
npm run build:linux

APPIMAGE_SRC="dist/kubernetes-dashboard-${VERSION}-x86_64.AppImage"
if [ ! -f "$APPIMAGE_SRC" ]; then
    # electron-builder's ${arch} token has varied across versions; fall back
    # to whatever single .AppImage landed in dist/ rather than hardcoding it.
    APPIMAGE_SRC="$(find dist -maxdepth 1 -name '*.AppImage' | head -1)"
fi
if [ -z "$APPIMAGE_SRC" ] || [ ! -f "$APPIMAGE_SRC" ]; then
    echo "✗ No .AppImage found under dist/ after build."
    exit 1
fi

echo "→ Installing to $APP_DIR…"
mkdir -p "$APP_DIR"
chmod +x "$APPIMAGE_SRC"
cp "$APPIMAGE_SRC" "$APPIMAGE"

mkdir -p "$(dirname "$BIN")"
ln -sfn "$APPIMAGE" "$BIN"

echo "→ Extracting icon…"
(
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    cp "$APPIMAGE" "$tmp/app.AppImage"
    cd "$tmp"
    for pattern in 'usr/share/icons/hicolor/*/apps/*.png' 'kubernetes-dashboard.png' '.DirIcon'; do
        rm -rf squashfs-root
        ./app.AppImage --appimage-extract "$pattern" >/dev/null 2>&1 || true
        found="$(find -L squashfs-root -name '*.png' -type f 2>/dev/null | head -1)"
        if [ -n "$found" ]; then
            mkdir -p "$ICON_DIR"
            cp "$found" "$ICON_FILE"
            break
        fi
    done
) || echo "  ⚠ could not extract an icon; the app will use a generic icon in menus"

echo "→ Writing desktop entry…"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kubernetes Dashboard (dev)
Comment=Kubernetes deployments, PRs and pipelines in one view
Exec=$APPIMAGE %U
Icon=kubernetes-dashboard
Categories=Development;
Terminal=false
StartupWMClass=Kubernetes Dashboard
StartupNotify=true
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

echo "→ Launching…"
"$APPIMAGE" &

echo "✓ Done. Run scripts/publish.sh (mac) then npm run release:linux to create a real release."
