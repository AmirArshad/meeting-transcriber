# macOS Support

Status: implemented

## Supported Targets

- Runtime: macOS 13+
- Packaged builds: Apple Silicon only (`arm64`)
- Development-only note: `src/main.js` still contains an Intel Mac `faster-whisper` CPU fallback path, but packaged macOS builds do not target Intel

## Current Architecture

### Desktop audio capture

- Preferred path: native Swift `audiocapture-helper`
- Fallback path: PyObjC ScreenCaptureKit bridge
- Recorder implementation: `backend/audio/macos_recorder.py`
- Swift bridge: `backend/audio/swift_audio_capture.py`
- Native helper source: `swift/AudioCaptureHelper/Sources/main.swift`

### Permissions and startup behavior

- Recording preflight runs before the recorder starts.
- Missing Microphone or Screen Recording permission is surfaced before recording begins.
- Desktop-start failures preserve detailed messages instead of collapsing to a generic error.
- The current recorder contract uses structured stdout messages plus stderr compatibility output.

### Transcription

- Apple Silicon packaged builds use `backend/transcription/mlx_whisper_transcriber.py`.
- Development runs on Intel Macs can still fall back to `backend/transcription/faster_whisper_transcriber.py`.
- Apple Silicon MLX models are cached under `~/Library/Caches/meeting-transcriber/mlx_models`.

## Build And Packaging

macOS builds use the same top-level build entry points as Windows:

```bash
npm run prepare-build
npm run build:mac
npm run build:mac:dir
```

`build/prepare-resources.js` now:

- stages Python and ffmpeg for the current platform
- builds and stages the Swift helper on macOS
- writes `build/resources/resource-manifest.json`
- invalidates stale prepared resources when pinned downloads, requirements, entitlements, or Swift helper sources change

The Swift helper invalidation now tracks the helper source tree, not just `Package.swift`.

## CI Coverage

PR CI now validates the macOS path more directly:

- Python unit tests and syntax checks on macOS
- Swift helper build on `macos-14`
- packaged app smoke build via `npm run build:mac:dir`
- verification that the packaged app contains:
  - `bin/audiocapture-helper`
  - bundled Python
  - bundled ffmpeg

## Key Files

- `src/main.js`
- `src/main-process-helpers.js`
- `src/preload.js`
- `src/renderer/app.js`
- `backend/audio/macos_recorder.py`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/screencapture_helper.py`
- `backend/transcription/mlx_whisper_transcriber.py`
- `swift/AudioCaptureHelper/Package.swift`
- `swift/AudioCaptureHelper/Sources/main.swift`

## Known Constraints

- Packaged macOS builds are `arm64` only.
- The app is not code-signed/notarized by default, so first-run Gatekeeper workarounds are still documented.
- Hardware-dependent validation is still required for recorder sync, permission prompts, and desktop-audio edge cases.

## Related Docs

- `docs/MACOS_INSTALLATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/features/MACOS_AUDIO_ARCHITECTURE.md`
- `docs/features/json-based-events.md`
