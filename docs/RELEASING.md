# Releasing

Releases are built on two machines — macOS (required for notarization) and
Linux (required to build an AppImage) — and must happen **in this order**.

## 1. macOS first

```bash
npm run release
```

This is `scripts/publish.sh`. It bumps the version (`npm version patch
--no-git-tag-version` — package.json only, **no commit, no git tag, no
push**), builds and notarizes the DMG + zip, and publishes the GitHub
release. The `vX.Y.Z` tag is created **server-side** by electron-builder's
GitHub publisher when it publishes the release — there is no local tag to
look at.

Because the version bump is local-only, **commit and push it** before moving
to the Linux machine:

```bash
git add package.json
git commit -m "chore: release vX.Y.Z"
git push
```

`publish.sh` also prunes old releases, keeping only the 2 most recent
(`--cleanup-tag`). If the Linux machine falls behind by more than one
release, step 2 below will fail its existence check — that's expected, not a
bug; publish the Linux build for a release before the next macOS release
prunes it away, or skip straight to the newest one.

## 2. Linux second

On the Linux machine:

```bash
git pull
npm run release:linux
```

This is `scripts/publish-linux.sh`. It reads the version from `package.json`
and checks — via `gh release view`, against GitHub, not a local tag — that
the release from step 1 already exists and isn't a draft. If it doesn't, the
script fails loudly rather than silently building the wrong version; the fix
is almost always "you forgot to `git pull` after step 1." It then builds the
AppImage and uploads it plus `latest-linux.yml` to the **same** release.

`publish-linux.sh` is intentionally one-directional: it never bumps the
version, never deletes a release, and never touches the mac artifacts. It
only adds to a release step 1 already created.

## Why the stable AppImage filename matters

`scripts/install-linux.sh` installs the AppImage as
`kubernetes-dashboard.AppImage` — never the versioned release-asset name.
This isn't cosmetic: `electron-updater`'s Linux updater decides whether to
replace a file in place or write a new one alongside it based on whether the
current filename already looks versioned. An unversioned name means each
auto-update overwrites the same file in place, which is what keeps the
`~/.local/bin` symlink and the `.desktop` entry's `Exec=` valid after an
update with no user action. If this filename convention ever changes, check
that assumption against the installed electron-updater version before
shipping it.

## Release artifacts, per platform

| Platform | Files |
|---|---|
| macOS | `*.dmg`, `*-mac.zip`, `latest-mac.yml` |
| Linux | `*-x86_64.AppImage`, `latest-linux.yml` |

## Future option: CI

There is currently no CI (no `.github/workflows`) — both platforms are built
by hand on a developer's own machine, in the order above. A GitHub Actions
matrix (`macos-latest` + `ubuntu-latest`) triggered on a version tag could
build and publish both platforms from one push, removing the two-machine
ordering and the manual "commit and push the version bump" step entirely.
This is a reasonable next step but is out of scope for the PR that added
Linux support in the first place — it would need real macOS notarization
credentials (`APPLE_ID`/`APPLE_TEAM_ID` or `APPLE_API_KEY`, `CSC_LINK`,
`CSC_KEY_PASSWORD`) in CI secrets, since `scripts/notarize.js` currently
authenticates via a local `notarytool-profile` keychain entry that only
exists on the maintainer's own Mac.
