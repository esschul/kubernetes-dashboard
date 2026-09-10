#!/usr/bin/env bash
# Adds a Linux AppImage to an EXISTING release. Strictly additive: never bumps
# the version, never deletes a release, never touches the mac artifacts —
# scripts/publish.sh (macOS) owns all of that. Run this after publish.sh has
# already published vX.Y.Z; running it before that release exists is a
# deliberate hard failure (there is no local git tag to check against —
# publish.sh's `npm version patch --no-git-tag-version` never commits or tags,
# the vX.Y.Z tag is created server-side when electron-builder publishes the
# GitHub release), so this checks the release on GitHub itself.
#
# See docs/RELEASING.md for the required order and the reason
# kubernetes-dashboard-*.AppImage in a release must always be re-buildable
# from the same commit that produced the mac artifacts.
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

export GH_TOKEN=$(gh auth token)

echo "→ Checking that ${TAG} was already published (by scripts/publish.sh on macOS)…"
if ! gh release view "$TAG" >/dev/null 2>&1; then
    echo "✗ Release ${TAG} not found." >&2
    echo "  Run scripts/publish.sh on macOS first, commit + push the package.json version bump it made, then git pull here and re-run." >&2
    exit 1
fi
if [ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = "true" ]; then
    echo "✗ Release ${TAG} still exists but is a draft — electron-updater won't see it. Finish publishing it on macOS first." >&2
    exit 1
fi

echo "→ Cleaning dist/…"
rm -rf dist/

echo "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > src/build-info.json

echo "→ Building and publishing the Linux AppImage for ${TAG}…"
npx electron-builder --linux --publish always

if [ -f "dist/latest-linux.yml" ]; then
    gh release upload "$TAG" dist/latest-linux.yml --clobber
fi

echo "✓ Done. ${TAG} now serves a Linux update feed."
