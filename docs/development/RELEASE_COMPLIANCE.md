# Release compliance checklist

Use this before publishing a **version tag** (`v*.*.*`) that triggers `.github/workflows/build-release.yml`.

This is maintainer guidance only, not legal advice.

## Automated (CI)

On tag push, the publish job:

1. Builds Windows `.exe` and macOS `.dmg` installers.
2. Runs `node scripts/stage-release-legal-assets.js`, which:
   - Verifies and attaches **`ffmpeg-8.0.1.tar.xz`** (SHA-256 pinned in `build/download-manifest.js`).
   - Attaches **`THIRD_PARTY_NOTICES.md`** and **`avanevis-legal-<version>.zip`** (notices + legal snippets).
3. Appends the FFmpeg section from `docs/development/RELEASE_FFMPEG_NOTICE.md` to GitHub release notes.

## Manual verification

- [ ] `package.json` version matches the git tag.
- [ ] `npm run test:all` passed on the release commit.
- [ ] GitHub release page lists **installers + ffmpeg source + legal zip** on the same release.
- [ ] Release notes include the FFmpeg (GPLv3) section (appended by CI).
- [ ] Optional: run `node scripts/generate-python-sbom.js` and commit updated `legal/PYTHON-BUNDLED-PACKAGES.md` if build pins changed.

## Local commands

```bash
# Regenerate pinned Python package list for notices
node scripts/generate-python-sbom.js

# Dry-run legal assets (downloads ffmpeg source; requires network)
RELEASE_VERSION=v2.1.0 node scripts/stage-release-legal-assets.js
```

## Installer contents

`npm run prepare-build` copies `THIRD_PARTY_NOTICES.md`, `LICENSE.txt`, `legal/*`, generated `FFMPEG-COMPLIANCE.json`, and `FFMPEG-BINARY-INFO.txt` (when ffmpeg is present) into `build/resources/legal/` for bundling under `resources/legal/` in the app.

The **full FFmpeg source tarball is not bundled inside installers** (size). It is attached to **GitHub Releases** instead.
