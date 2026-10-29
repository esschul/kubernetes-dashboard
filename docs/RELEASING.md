# Releasing

One command on the maintainer's Mac. GitHub Actions builds Linux.

## Steps

1. Commit and push your work to `main`.
2. On macOS:

   ```bash
   npm run release
   ```

   `scripts/publish.sh`:
   - bumps the patch version in `package.json` (no commit, no tag)
   - builds and notarizes the DMG and zip
   - publishes the GitHub release (`vX.Y.Z` is tagged on GitHub)
   - prunes old releases, keeping the 2 newest
3. Commit and push the version bump:

   ```bash
   git add package.json package-lock.json
   git commit -m "chore: release vX.Y.Z"
   git push
   ```

4. Linux builds itself. Publishing the release triggers
   [`.github/workflows/linux-release.yml`](../.github/workflows/linux-release.yml), which builds the
   x86_64 AppImage on `ubuntu-latest` and uploads it with `latest-linux.yml` to the same release.
   Check it with `gh run list -w "Linux release" -L 1` and `gh release view vX.Y.Z`.

## Don't run `npm run release:linux` on a Mac

`scripts/publish-linux.sh` builds for the machine it runs on. On Apple Silicon that is an **arm64**
AppImage, and it uploads `latest-linux.yml` with `--clobber`, so x86_64 users would auto-update to the
wrong file. The workflow already does this job. Only use the script on an x86_64 Linux machine if the
workflow is broken; to rebuild for an existing release, rerun the workflow instead:

```bash
gh workflow run "Linux release" -f tag=vX.Y.Z
```

## Release artifacts

| Platform | Files | Built by |
|---|---|---|
| macOS | `*.dmg`, `*-mac.zip`, `latest-mac.yml` | `npm run release` on the Mac |
| Linux | `*-x86_64.AppImage`, `latest-linux.yml` | Linux release workflow |

## Why the AppImage filename is unversioned when installed

`scripts/install-linux.sh` installs the AppImage as `kubernetes-dashboard.AppImage`. electron-updater
then replaces that file in place on each update, which keeps the `~/.local/bin` symlink and the
`.desktop` entry valid. Check this against the installed electron-updater version before changing
the name.

## Notarization

`scripts/notarize.js` uses a local `notarytool-profile` keychain entry, so macOS releases can only be
built on the maintainer's Mac.
