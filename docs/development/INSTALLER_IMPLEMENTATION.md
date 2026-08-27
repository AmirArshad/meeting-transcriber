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

- Windows embedded Python
- macOS standalone Python
- Linux standalone Python (python-build-standalone, same release as macOS)
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

- downloads the embedded Python zip
- verifies the checksum
- extracts Python into `build/resources/python`
- bootstraps pip from the pinned wheel
- normalizes `python311._pth` so packaged imports resolve correctly
- installs Windows runtime requirements
- stages `ffmpeg.exe`
- builds and stages `speakrs-cli.exe` under `build/resources/bin`

### macOS

- downloads the standalone Python tarball
- verifies the checksum
- extracts Python into `build/resources/python`
- bootstraps pip from the pinned wheel
- installs macOS runtime requirements
- downloads and stages ffmpeg
- builds the Swift `audiocapture-helper`
- builds and stages `speakrs-cli` under `build/resources/bin`
- stages the helper in `build/resources/bin`

### Linux

- downloads the python-build-standalone tarball
- verifies the checksum
- extracts Python into `build/resources/python`
- bootstraps pip from the pinned wheel
- installs Linux runtime requirements (`requirements-linux-build.txt`)
- downloads and stages ffmpeg
- **skips** `speakrs-cli` (Core Beta; empty `build/resources/bin` so extraResources `from` exists)
- stages legal notices

## Packaged Layout

Electron bundles these prepared resources via `package.json` `extraResources`.

### Windows packaged app

```text
resources/
├── python/
│   ├── python.exe
│   ├── python311._pth
│   └── Lib/site-packages/
├── ffmpeg/
│   └── ffmpeg.exe
├── backend/
│   └── *.py
├── bin/
│   └── speakrs-cli.exe
└── icon.ico
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
    │   └── speakrs-cli
    ├── iconTemplate.png
    └── iconTemplate@2x.png
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
├── legal/
│   └── THIRD_PARTY_NOTICES.md
├── requirements-linux.txt
└── requirements-linux-build.txt
```

There is no `resources/bin/speakrs-cli` (or llama.cpp / CUDA ORT) in Core Beta. electron-builder skips an empty `bin` directory.

Pacman installs the same tree under `/opt/AvaNevis/`.

## Runtime Path Resolution

`src/main.js` chooses runtime paths based on whether the app is packaged:

- development:
  - macOS uses `python3`
  - Windows uses `python`
  - Linux uses `python3` (or the repo `.venv`)
  - ffmpeg is expected on `PATH`
- packaged app:
  - Windows uses `resources/python/python.exe`
  - macOS and Linux use `resources/python/bin/python3`
  - ffmpeg is resolved from the packaged `resources/ffmpeg` directory
  - packaged children get `AVANEVIS_PACKAGED=1` and `PYTHONNOUSERSITE=1`; ambient `PYTHONPATH` / `PYTHONHOME` / `PYTHONUSERBASE` are stripped

The main process also selects the platform transcriber and launches it with `python -m` so package-relative imports work in packaged builds:

- Apple Silicon macOS packaged builds use `transcription.mlx_whisper_transcriber`
- Windows and Linux use `transcription.faster_whisper_transcriber` (Linux packaged builds are CPU-only)
- Intel Mac development runs can still fall back to `transcription.faster_whisper_transcriber`

## Installer Artifacts

`package.json` sets the artifact naming convention to:

- Windows: `AvaNevis-Setup-<version>.exe`
- macOS: `AvaNevis-Setup-<version>.dmg`
- Linux: `AvaNevis-Setup-<version>.AppImage` (preferred updater match) and `AvaNevis-Setup-<version>.pkg.tar.zst`

`src/updater.js` `findInstallerAsset` requires the `AvaNevis-Setup-` token on every platform. Linux never matches source `.tar.gz`, `.deb`, or unprefixed AppImages. The updater stays notify-only (no AppImage self-update; pacman-installed apps must not self-update).

## CI Coverage

The current CI workflow validates packaging more directly than before:

- Windows frontend/build smoke job runs `npm run build:dir`
- macOS backend job builds the Swift helper
- macOS backend job also runs `npm run build:mac:dir`
- macOS packaged output is checked for bundled helper, Python, and ffmpeg
- Ubuntu packaging job (`test-packaging-linux` on `ubuntu-latest`) runs `npm ci`, `npm run test:all`, `prepare-build`, electron-builder `dir` + AppImage + pacman, and `scripts/verify-linux-packaging.js`
- GitHub Release workflow remains Windows/macOS-only while Gate B ([issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76)) is open

This is still not a substitute for hardware recording tests, but it catches many packaging regressions before release tags.

## Known Constraints

- macOS packaged builds target Apple Silicon only.
- Linux packaged builds target x86_64 AppImage + pacman only; no `.deb` / RPM / Flatpak in Core Beta.
- Linux AppImage uses electron-builder 26.x static toolset `1.0.2` (no host fuse2). Kernel `/dev/fuse` is still required to mount.
- Unsigned distribution means users still see the normal Gatekeeper workaround flow.
- Update delivery is still a manual browser-download flow, not an in-app auto-install system.
- Recorder smoke tests on real hardware remain manual.

## Related Files

- `build/download-manifest.js`
- `build/prepare-resources.js`
- `package.json`
- `src/main.js`
- `.github/workflows/ci.yml`
