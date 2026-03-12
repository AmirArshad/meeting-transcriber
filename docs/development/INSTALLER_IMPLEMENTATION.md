# Installer And Packaged Runtime Implementation

This document describes how packaged Meeting Transcriber builds are assembled today.

## Overview

Meeting Transcriber ships as an Electron app with bundled Python, backend scripts, ffmpeg, and (on macOS) the native Swift desktop-audio helper.

The packaging flow is intentionally explicit:

1. `npm run prepare-build` stages runtime resources in `build/resources/`
2. `electron-builder` packages those prepared resources into the app
3. the main process resolves platform-specific runtime paths from `process.resourcesPath`

## Build Inputs

### Pinned downloads

`build/download-manifest.js` pins build-time downloads and their SHA-256 hashes:

- Windows embedded Python
- macOS standalone Python
- Windows ffmpeg
- macOS ffmpeg
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

### macOS

- downloads the standalone Python tarball
- verifies the checksum
- extracts Python into `build/resources/python`
- bootstraps pip from the pinned wheel
- installs macOS runtime requirements
- downloads and stages ffmpeg
- builds the Swift `audiocapture-helper`
- stages the helper in `build/resources/bin`

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
└── icon.ico
```

### macOS packaged app

```text
Meeting Transcriber.app/
└── Contents/Resources/
    ├── python/
    │   └── bin/python3
    ├── ffmpeg/
    │   └── ffmpeg
    ├── backend/
    │   └── *.py
    ├── bin/
    │   └── audiocapture-helper
    ├── iconTemplate.png
    └── iconTemplate@2x.png
```

## Runtime Path Resolution

`src/main.js` chooses runtime paths based on whether the app is packaged:

- development:
  - macOS uses `python3`
  - Windows uses `python`
  - ffmpeg is expected on `PATH`
- packaged app:
  - Windows uses `resources/python/python.exe`
  - macOS uses `resources/python/bin/python3`
  - ffmpeg is resolved from the packaged `resources/ffmpeg` directory

The main process also selects the platform transcriber:

- Apple Silicon macOS packaged builds use `mlx_whisper_transcriber.py`
- Windows uses `faster_whisper_transcriber.py`
- Intel Mac development runs can still fall back to `faster_whisper_transcriber.py`

## Installer Artifacts

`package.json` sets the artifact naming convention to:

- Windows: `Meeting Transcriber-Setup-<version>.exe`
- macOS: `Meeting Transcriber-Setup-<version>.dmg`

## CI Coverage

The current CI workflow validates packaging more directly than before:

- Windows frontend/build smoke job runs `npm run build:dir`
- macOS backend job builds the Swift helper
- macOS backend job also runs `npm run build:mac:dir`
- macOS packaged output is checked for bundled helper, Python, and ffmpeg

This is still not a substitute for hardware recording tests, but it catches many packaging regressions before release tags.

## Known Constraints

- macOS packaged builds target Apple Silicon only.
- Unsigned distribution means users still see the normal Gatekeeper workaround flow.
- Update delivery is still a manual browser-download flow, not an in-app auto-install system.
- Recorder smoke tests on real hardware remain manual.

## Related Files

- `build/download-manifest.js`
- `build/prepare-resources.js`
- `package.json`
- `src/main.js`
- `.github/workflows/ci.yml`
