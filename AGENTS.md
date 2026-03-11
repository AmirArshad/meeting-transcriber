# Meeting Transcriber Agent Guide

This file is intentionally mirrored with its counterpart. Keep `AGENTS.md` and `CLAUDE.md` byte-for-byte aligned whenever agent guidance changes.

## Product Summary

Meeting Transcriber is a privacy-first Electron desktop app for recording microphone audio plus desktop/system audio, then transcribing locally with Whisper.

- Frontend: Electron 28 with plain HTML/CSS/JavaScript
- Backend: Python 3.11 scripts spawned from Electron
- macOS desktop audio: native Swift helper preferred, PyObjC fallback
- Windows transcription: `faster-whisper`
- macOS transcription: `lightning-whisper-mlx` on Apple Silicon, CPU fallback path exists for Intel Macs in dev logic
- Storage: recordings and meeting metadata live in Electron `userData`, not in the repo

## Platform Targets

- Windows: Windows 10/11 x64
- macOS runtime: macOS 13+
- macOS packaged builds: Apple Silicon only (`arm64`)
- Intel Mac note: `src/main.js` contains a `faster-whisper` fallback for Intel Macs, but packaged macOS builds are not targeting Intel

## Architecture Map

### Electron

- `src/main.js`: app lifecycle, tray, startup checks, Python process management, IPC handlers, update checks
- `src/preload.js`: safe API bridge exposed as `window.electronAPI`
- `src/renderer/app.js`: main UI state machine, settings persistence, meeting history, GPU/settings UI, update banner
- `src/renderer/index.html`: renderer markup
- `src/renderer/styles.css`: renderer styles
- `src/updater.js`: GitHub Releases update checker

### Python backend

- `backend/device_manager.py`: enumerate audio devices for UI
- `backend/meeting_manager.py`: persistent meeting history in `meetings.json`, dedupe, scan/import, delete with retry
- `backend/check_permissions.py`: macOS permission checks
- `backend/audio/windows_recorder.py`: Windows recording pipeline using `pyaudiowpatch` WASAPI loopback
- `backend/audio/macos_recorder.py`: macOS recording pipeline using `sounddevice` + Swift/PyObjC desktop capture
- `backend/audio/swift_audio_capture.py`: bridge to bundled Swift helper
- `backend/audio/processor.py`, `backend/audio/compressor.py`, `backend/audio/timeline.py`, `backend/audio/constants.py`: Windows audio processing modules
- `backend/transcription/faster_whisper_transcriber.py`: Windows/default transcriber
- `backend/transcription/mlx_whisper_transcriber.py`: Apple Silicon transcriber

### Native macOS helper

- `swift/AudioCaptureHelper/Package.swift`
- `swift/AudioCaptureHelper/Sources/main.swift`

### Build and release

- `build/prepare-resources.js`: bundles Python, ffmpeg, and macOS Swift helper
- `package.json`: Electron builder config and build scripts
- `.github/workflows/ci.yml`: syntax/build/doc validation
- `.github/workflows/build-release.yml`: tagged release builds

## End-to-End Flow

1. Renderer calls `window.electronAPI` from `src/renderer/app.js`.
2. `src/preload.js` forwards calls to `ipcMain.handle(...)` handlers in `src/main.js`.
3. `src/main.js` spawns Python recorder/transcriber processes.
4. Recorder emits:
   - JSON audio level events on stdout
   - human-readable status/progress on stderr
   - final JSON result on stdout when recording stops
5. Electron parses those outputs, updates UI, then saves finished meetings through `backend/meeting_manager.py`.

## Critical Invariants

### Recording startup still depends on stderr strings

`src/main.js` still detects key recorder lifecycle events by matching stderr text such as `Recording started!`.

If you change recorder startup/progress messages in either recorder:

- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`

you must update the parsing logic in `src/main.js` too.

There is a planned migration to structured events in `docs/features/json-based-events.md`, but it is not implemented yet.

### Keep recorder output contracts stable

- Windows final JSON uses `audioPath`
- macOS final JSON uses `outputPath`
- `src/main.js` currently supports both for backward compatibility

Do not casually break this contract unless you update all call sites together.

### Preserve post-processing mix architecture

The app intentionally records mic and desktop audio separately, then mixes after recording stops.

Do not reintroduce real-time mixing unless you are deliberately redesigning the audio pipeline.

Key quality assumptions to preserve:

- 48 kHz target output
- stereo output
- Opus compression via ffmpeg
- gentle mic enhancement instead of aggressive processing
- desktop audio preserved as faithfully as possible

### Preserve local-only/privacy-first behavior

- No cloud transcription
- No telemetry or analytics
- No background uploads
- No surprise network dependencies beyond explicit model/update checks and build-time downloads

## High-Risk Areas

### IPC surface

If you rename or change an IPC handler in `src/main.js`, update `src/preload.js` and every renderer call site in `src/renderer/app.js`.

### Build packaging

If you change bundled runtime locations, keep these aligned:

- `build/prepare-resources.js`
- `package.json` `extraResources`
- `src/main.js` runtime path resolution

Windows packaged Python relies on `python311._pth` containing `../backend`. Dev mode relies on `PYTHONPATH` setup in `src/main.js`.

### macOS desktop audio capture

Preferred path is the bundled Swift helper. PyObjC ScreenCaptureKit is only a fallback.

If you touch the helper pipeline, verify:

- the helper still builds from `swift/AudioCaptureHelper`
- `build/prepare-resources.js` still copies it to `build/resources/bin`
- codesign/entitlement steps still happen
- `electron-builder` still bundles `bin/audiocapture-helper`

### Release asset naming

`src/updater.js` identifies installers by filename patterns.

If you change artifact naming in `package.json` or `.github/workflows/build-release.yml`, update `src/updater.js` too.

## Important Repo Facts

- There are no `AGENTS.md` or `CLAUDE.md` predecessors in this repo before this file.
- CI now includes a small regression suite for pure Python logic and main-process JS helper logic, but it is still not full end-to-end product coverage.
- Root `README.md` is broadly useful, but some docs are stale.
- `docs/development/BUILD_INSTRUCTIONS.md` currently references `npm run prebuild`, but the real script is `npm run prepare-build`.
- `src/renderer/app.js` still has a TODO for saving transcripts through a file dialog.

## Commands That Reflect The Actual Repo

### Install

```bash
npm install
```

Use platform-specific Python requirements for local development:

```bash
# Windows
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt

# macOS
python3 -m pip install -r requirements-macos.txt -r requirements-dev.txt
```

### Run

```bash
npm start
npm run dev
```

### Build

```bash
npm run prepare-build
npm run build
npm run build:dir
npm run build:mac
npm run build:mac:dir
```

### Swift helper only

```bash
swift build -c release --arch arm64
```

Run that inside `swift/AudioCaptureHelper`.

### Test suite

```bash
npm test
npm run test:python
npm run test:all
```

- `npm test`: JS regression tests plus syntax checks
- `npm run test:python`: Python unit tests under `tests/python`
- `npm run test:all`: runs both JS and Python suites
- Manual recorder validation checklist lives in `tests/manual/recording-smoke-checklist.md`
- Setup instructions for new machines live in `docs/development/TESTING.md`

### CI-style validation

```bash
npm test
python3 -m pytest tests/python
python -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py
python backend/device_manager.py
```

On macOS, also validate the helper still builds:

```bash
swift build -c release --arch arm64
```

## What To Validate After Changes

### Recorder or device changes

- device enumeration still works
- recording startup still resolves correctly
- audio level updates still reach the renderer
- stop flow still returns a valid output path
- meeting history still saves usable audio/transcript files
- relevant automated tests still pass
- manual smoke checklist still passes on the affected platform

### Transcription changes

- model preload still works
- transcript JSON shape still matches renderer expectations
- markdown transcript output still saves correctly
- CPU/GPU fallback behavior still makes sense for the platform
- relevant automated tests still pass

### Meeting history changes

- duplicate IDs are still prevented
- scan/import still avoids re-adding persisted files
- delete still handles Windows file locking gracefully
- meeting manager tests still pass

### Build/release changes

- `npm run prepare-build` still stages Python/ffmpeg correctly
- macOS helper still lands in bundled resources
- updater can still detect release assets by filename
- CI still runs the regression suite successfully

## Common Change Patterns

### If you change recorder process output

Update all of:

- recorder stdout/stderr output
- `src/main.js` parser logic
- any renderer UI states that depend on that progress

### If you change saved meeting file names or locations

Update all of:

- recorder output path logic
- `backend/meeting_manager.py`
- scan/import logic
- delete logic
- any renderer assumptions about playback paths

### If you change model download behavior

Update all of:

- `src/main.js`
- renderer first-time setup flow in `src/renderer/app.js`
- transcriber preload CLI behavior
- build logic if bundled/offline behavior changes

## Known Maintenance Hotspots

- `src/main.js`: very large, many responsibilities, easy to regress via small output-contract changes
- `src/renderer/app.js`: large stateful UI file with many implicit assumptions
- `backend/audio/windows_recorder.py`: timing-sensitive, sample-rate-sensitive, callback-sensitive
- `backend/audio/macos_recorder.py`: threading plus native helper integration plus permission edge cases
- `build/prepare-resources.js`: packaging-critical and platform-specific

## Guidance For Future Refactors

- Prefer extracting logic behind stable interfaces instead of rewriting whole flows.
- Keep platform-specific behavior explicit rather than hiding it behind overly clever abstractions.
- Preserve user-facing resilience: many handlers intentionally degrade gracefully instead of hard-failing.
- When simplifying code, preserve the current operational behavior first, then reduce complexity.

## When In Doubt

- Trust the current runtime scripts and CI over stale docs.
- Inspect both Electron and Python sides before changing any cross-process contract.
- Favor targeted, low-risk edits over architecture rewrites unless the task explicitly calls for a redesign.
