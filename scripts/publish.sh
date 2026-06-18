#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

export GH_TOKEN=$(gh auth token)

echo "→ Cleaning dist/…"
rm -rf dist/

echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > src/build-info.json

echo "→ Building and publishing v${VERSION} to GitHub…"
electron-builder --mac dmg --publish always

# Ensure latest-mac.yml is attached (electron-builder sometimes skips it on existing releases)
if [ -f "dist/latest-mac.yml" ]; then
    gh release upload "v${VERSION}" dist/latest-mac.yml --clobber
fi

echo "✓ Done."
