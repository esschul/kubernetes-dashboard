#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

echo "→ Building DMG for v${VERSION}…"
npm run build:mac

APP_SRC="dist/mac-arm64/Kubernetes Dashboard.app"
APP_DEST="/Applications/Kubernetes Dashboard.app"

if [ ! -d "${APP_SRC}" ]; then
    echo "✗ App not found at ${APP_SRC}"
    exit 1
fi

echo "→ Installing to /Applications…"
pkill -x "Kubernetes Dashboard" 2>/dev/null || true
sleep 0.5
rm -rf "${APP_DEST}"
cp -R "${APP_SRC}" "${APP_DEST}"
echo "→ Launching…"
open "${APP_DEST}"

echo "✓ Done. Run scripts/publish.sh to create the GitHub release."
