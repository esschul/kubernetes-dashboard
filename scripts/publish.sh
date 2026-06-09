#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
DMG="dist/Kubernetes Dashboard-${VERSION}.dmg"

echo "→ Building DMG for v${VERSION}…"
npm run build:mac

if [ ! -f "${DMG}" ]; then
    echo "✗ DMG not found at: ${DMG}"
    exit 1
fi

echo "→ Creating GitHub release ${TAG}…"
if gh release view "${TAG}" &>/dev/null; then
    echo "  Release ${TAG} already exists — uploading asset…"
    gh release upload "${TAG}" "${DMG}" --clobber
else
    gh release create "${TAG}" "${DMG}" \
        --title "Kubernetes Dashboard ${TAG}" \
        --notes "Kubernetes Dashboard ${TAG}" \
        --draft
    echo "  Draft release ${TAG} created with DMG attached."
    echo "  → Go to GitHub to publish it when ready."
fi

echo "✓ Done."
