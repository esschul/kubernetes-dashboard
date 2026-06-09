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
