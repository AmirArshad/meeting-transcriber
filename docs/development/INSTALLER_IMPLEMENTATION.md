# Installer And Packaged Runtime Implementation

This document describes how packaged AvaNevis builds are assembled today.

## Overview

AvaNevis ships as an Electron app with bundled Python, backend scripts, ffmpeg, and (on macOS) the native Swift desktop-audio helper.

The packaging flow is intentionally explicit:

1. `npm run prepare-build` stages runtime resources in `build/resources/`
2. `electron-builder` packages those prepared resources into the app
3. the main process resolves platform-specific runtime paths from `process.resourcesPath`

## Build Inputs

### Pinned downloads

`build/download-manifest.js` pins build-time downloads and their SHA-256 hashes:

- Windows standalone Python (Astral `python-build-standalone` `3.11.18+`)
- macOS standalone Python (Astral `python-build-standalone` `3.11.18+`)
- Linux standalone Python (Astral `python-build-standalone` `3.11.18+`, same release as Windows and macOS)
- Windows ffmpeg (gyan.dev essentials)
- macOS ffmpeg (shaka-project/static-ffmpeg-binaries `ffmpeg-osx-arm64`, arm64)
- Linux ffmpeg (shaka-project/static-ffmpeg-binaries `ffmpeg-linux-x64`)
- a pinned `pip` wheel used for bootstrap

The build no longer depends on the moving-target `get-pip.py` bootstrap script.

### Resource manifest invalidation

`build/prepare-resources.js` writes `build/resources/resource-manifest.json` and compares current build inputs against the last prepared state.

Prepared resources are invalidated when relevant inputs change, including:

- pinned download metadata
- platform requirements files
- Swift helper sources under `swift/AudioCaptureHelper/Sources`
- `swift/AudioCaptureHelper/Package.swift`
- macOS inherit entitlements

This avoids shipping stale prepared resources after build-time changes.

## What `npm run prepare-build` Does

### Windows

- downloads the standalone Python `.tar.gz` archive
- verifies the checksum
- extracts Python into `build/resources/python` through traversal-guarded extraction
- bootstraps pip from the pinned wheel
- authors an isolated `python311._pth` so packaged imports resolve without inheriting ambient paths
- installs Windows runtime requirements (`requirements-windows-build.txt`)
- stages `ffmpeg.exe`
- builds and stages `speakrs-cli.exe` plus its validation fixture WAV and `speakrs-integrity.json` under `build/resources/bin`
- stages legal notices

### macOS

- downloads the standalone Python tarball
- verifies the checksum
- extracts Python into `build/resources/python`
- bootstraps pip from the pinned wheel
- installs macOS runtime requirements (`requirements-macos-build.txt`, trimming build-time `torch` after install)
- downloads and stages ffmpeg
- builds and stages the Swift `audiocapture-helper` under `build/resources/bin`
- builds and stages `speakrs-cli` plus its validation fixture WAV and `speakrs-integrity.json` under `build/resources/bin`
- stages legal notices

### Linux

- downloads the python-build-standalone tarball
- verifies the checksum
- extracts Python into `build/resources/python`
- bootstraps pip from the pinned wheel
- installs Linux runtime requirements (`requirements-linux-build.txt`)
- downloads and stages ffmpeg
- builds and stages `speakrs-cli` plus its validation fixture WAV and `speakrs-integrity.json` under `build/resources/bin`
- stages legal notices

## Packaged Layout

Electron bundles these prepared resources via `package.json` `extraResources`.

### Windows packaged app

```text
resources/
├── python/
│   ├── python.exe
│   ├── python311._pth
│   ├── DLLs/
│   └── Lib/site-packages/
├── ffmpeg/
│   └── ffmpeg.exe
├── backend/
│   └── *.py
├── bin/
│   ├── speakrs-cli.exe
│   ├── speakrs-integrity.json
│   └── speakrs-two-speaker-16k.wav
├── legal/
│   └── THIRD_PARTY_NOTICES.md
├── icon.ico
└── recording-overlay.png
```

### macOS packaged app

```text
AvaNevis.app/
└── Contents/Resources/
    ├── python/
    │   └── bin/python3
    ├── ffmpeg/
    │   └── ffmpeg
    ├── backend/
    │   └── *.py
    ├── bin/
    │   ├── audiocapture-helper
    │   ├── speakrs-cli
    │   ├── speakrs-integrity.json
    │   └── speakrs-two-speaker-16k.wav
    ├── legal/
    │   └── THIRD_PARTY_NOTICES.md
    ├── iconTemplate.png
    ├── iconTemplate@2x.png
    ├── iconRecording.png
    └── iconRecording@2x.png
```

### Linux packaged app

```text
resources/
├── python/
│   └── bin/python3
├── ffmpeg/
│   └── ffmpeg
├── backend/
│   └── *.py
├── bin/
│   ├── speakrs-cli
│   ├── speakrs-integrity.json
│   └── speakrs-two-speaker-16k.wav
├── legal/
│   └── THIRD_PARTY_NOTICES.md
├── iconTrayLinux.png
├── iconTrayLinuxRecording.png
├── requirements-linux.txt
└── requirements-linux-build.txt
```

Optional model weights, `llama.cpp` runtimes, Parakeet runtimes, and managed CUDA 12 libraries are never bundled in installers; they download only on explicit setup under Electron `userData`.

Pacman installs the same tree under `/opt/AvaNevis/`.

## Runtime Path Resolution

`src/main.js` chooses runtime paths based on whether the app is packaged:

- development:
  - macOS uses `python3` (or the repo `.venv`)
  - Windows uses `python` (or the repo `.venv`)
  - Linux uses `python3` (or the repo `.venv`)
  - ffmpeg is expected on `PATH`
- packaged app:
  - Windows uses `resources/python/python.exe`
  - macOS and Linux use `resources/python/bin/python3`
  - ffmpeg is resolved from the packaged `resources/ffmpeg` directory
  - packaged children get `AVANEVIS_PACKAGED=1`, `PYTHONNOUSERSITE=1`, and `PYTHONDONTWRITEBYTECODE=1`; ambient `PYTHONPATH` / `PYTHONHOME` / `PYTHONUSERBASE` are stripped

The main process also selects the platform transcriber and launches it with `python -m` so package-relative imports work in packaged builds:

- Apple Silicon macOS packaged builds use `transcription.mlx_whisper_transcriber`
- Windows and Linux use `transcription.faster_whisper_transcriber` (Linux defaults to CPU, with optional managed CUDA 12)
- Intel Mac development runs can still fall back to `transcription.faster_whisper_transcriber`

## Installer Artifacts

`package.json` sets the artifact naming convention to:

- Windows: `AvaNevis-Setup-<version>.exe` (plus `latest.yml` and `*.blockmap`)
- macOS: `AvaNevis-Setup-<version>.dmg` and `AvaNevis-Setup-<version>.zip` (plus `latest-mac.yml` and `*.blockmap`)
- Linux: `AvaNevis-Setup-<version>.AppImage` (plus `latest-linux.yml` and `*.blockmap`), `AvaNevis-Setup-<version>.pkg.tar.zst`, and experimental `AvaNevis-Setup-<version>.deb`

`src/main/updater-service.js` runs `electron-updater` differential in-app updates on packaged Windows NSIS, Linux AppImage, and Developer ID-signed macOS builds. `src/updater.js` `findInstallerAsset` requires the `AvaNevis-Setup-` token on every platform and powers `manual-package` mode for Linux `pacman`/`.deb` installs (providing copyable `pacman` / `apt` commands rather than self-updating system-managed packages) and ad-hoc macOS builds (`.dmg` download). Source `.tar.gz` and unprefixed names never match.

## CI Coverage

The current CI workflow validates packaging more directly than before:

- Windows frontend/build smoke job runs `npm run build:dir` and Speakrs CLI tests/smoke
- macOS backend job builds the Swift helper, runs Speakrs CLI tests/smoke, runs `npm run build:mac:dir`, and verifies helper, Python, ffmpeg, and DMG payload
- Ubuntu packaging job (`test-packaging-linux` on `ubuntu-latest`) runs `npm ci`, `npm run test:all`, `prepare-build`, electron-builder `dir` + AppImage + pacman + deb, and `scripts/verify-linux-packaging.js`
- GitHub Release workflow builds Windows, macOS (`dmg` + `zip`), Linux AppImage, Linux pacman, and experimental Linux `.deb` artifacts plus `latest*.yml`, `*.blockmap`, and staged legal/FFmpeg source assets

This is still not a substitute for hardware recording tests, but it catches many packaging regressions before release tags.

## Known Constraints

- macOS packaged builds target Apple Silicon (`arm64`, macOS 15+) only.
- Linux packaged builds target x86_64 AppImage + pacman + one experimental `.deb`; no RPM / Flatpak / Snap in Core Beta.
- Linux AppImage uses electron-builder 26.x static toolset `1.0.2` (no host fuse2). Kernel `/dev/fuse` is still required to mount.
- Ad-hoc signed macOS / unsigned Windows distribution means users see the normal Gatekeeper / SmartScreen workaround flow until paid signing secrets are configured, and ad-hoc macOS builds use manual `.dmg` updates rather than Squirrel.Mac in-app install.
- Recorder smoke tests on real hardware remain manual.

## Related Files

- `build/download-manifest.js`
- `build/prepare-resources.js`
- `package.json`
- `src/main.js`
- `.github/workflows/ci.yml`
