#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

export GH_TOKEN=$(gh auth token)

echo "→ Building and publishing v${VERSION} to GitHub…"
electron-builder --mac dmg --publish always

echo "✓ Done."
