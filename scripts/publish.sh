#!/usr/bin/env bash
set -euo pipefail

npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")

export GH_TOKEN=$(gh auth token)

echo "→ Cleaning dist/…"
rm -rf dist/

echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > src/build-info.json

echo "→ Deleting existing GitHub release v${VERSION}…"
gh release delete "v${VERSION}" --yes 2>/dev/null || true

echo "→ Building and publishing v${VERSION} to GitHub…"
npx electron-builder --mac dmg zip --publish always

# Ensure latest-mac.yml is attached and release is published (not draft)
if [ -f "dist/latest-mac.yml" ]; then
    gh release upload "v${VERSION}" dist/latest-mac.yml --clobber
fi
gh release edit "v${VERSION}" --draft=false --latest

echo "✓ Done."
