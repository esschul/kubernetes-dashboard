#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
DMG=$(ls "dist/Kubernetes Dashboard-${VERSION}"*.dmg 2>/dev/null | head -1)

echo "→ Building DMG for v${VERSION}…"
npm run build:mac

if [ -z "${DMG}" ] || [ ! -f "${DMG}" ]; then
    echo "✗ DMG not found in dist/ for version ${VERSION}"
    exit 1
fi
echo "→ Found DMG: ${DMG}"

echo "→ Publishing GitHub release ${TAG}…"
gh release delete "${TAG}" --yes 2>/dev/null || true
gh release create "${TAG}" "${DMG}" \
    --title "Kubernetes Dashboard ${TAG}" \
    --notes "Kubernetes Dashboard ${TAG}"

APP_SRC="dist/mac-arm64/Kubernetes Dashboard.app"
APP_DEST="/Applications/Kubernetes Dashboard.app"

if [ -d "${APP_SRC}" ]; then
    echo "→ Installing to /Applications…"
    pkill -x "Kubernetes Dashboard" 2>/dev/null || true
    sleep 0.5
    rm -rf "${APP_DEST}"
    cp -R "${APP_SRC}" "${APP_DEST}"
    echo "→ Launching…"
    open "${APP_DEST}"
fi

echo "✓ Done."
