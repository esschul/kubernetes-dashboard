#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > src/build-info.json

echo "→ Building for Intel (x64, no signing, no auto-update) v${VERSION}…"
SKIP_NOTARIZE=1 CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --x64

APP_SRC="dist/mac/Kubernetes Dashboard.app"
APP_DEST="/Applications/Kubernetes Dashboard.app"

if [ ! -d "${APP_SRC}" ]; then
    echo "✗ App not found at ${APP_SRC}"
    exit 1
fi

echo "→ Installing to /Applications…"
pkill -x "Kubernetes Dashboard" 2>/dev/null || true
sleep 0.5
sudo rm -rf "${APP_DEST}"
cp -R "${APP_SRC}" "${APP_DEST}"
echo "→ Launching…"
open "${APP_DEST}"

echo "✓ Done."
