# macOS Feature Compatibility

This document tracks the current state of major user-facing features on macOS.

## Summary

- Packaged macOS support is implemented for Apple Silicon (`arm64`).
- Most core product features now work on macOS through the same Electron UI and shared meeting-history flow used on Windows.
- Remaining risk is mostly hardware validation, not missing feature code.

## Compatibility Matrix

| Feature | Status | Notes |
| --- | --- | --- |
| Window/tray behavior | Implemented | Uses Electron APIs; macOS tray uses template PNG assets. |
| Recording while minimized | Implemented | Recorder runs in Python subprocesses; not tied to renderer visibility. |
| Desktop audio capture | Implemented | Swift helper preferred, PyObjC fallback. Screen Recording permission required. |
| Microphone capture | Implemented | Uses `sounddevice` on macOS. |
| Audio visualizer | Implemented | Recorder emits structured `levels` messages consumed by the renderer. |
| Stop-and-save workflow | Implemented | Main-process stop flow is guarded against duplicate stop races. |
| Meeting history | Implemented | Shared metadata, scan/import, transcript loading, delete flow. |
| Transcript loading | Implemented | History detail panel renders immediately and loads transcript asynchronously. |
| Update checks | Implemented | Checks GitHub Releases; browser download only, not in-app install. |
| ffmpeg/Opus output | Implemented | ffmpeg is bundled in packaged builds and used for Opus compression with WAV fallback. |
| GPU acceleration | Implemented | Apple Silicon uses Lightning-Whisper-MLX with Metal. |
| Packaged build CI coverage | Implemented | CI builds `build:mac:dir` and verifies helper/Python/ffmpeg in the app bundle. |

## macOS-Specific Behavior Worth Remembering

### Permissions

- Microphone permission is required for mic capture.
- Screen Recording permission is required for desktop audio capture.
- Recording preflight now blocks start when those permissions are missing and can direct the user to System Settings.

### Packaging

- Distributed macOS installers are `Meeting Transcriber-Setup-<version>.dmg`.
- Packaged builds target Apple Silicon only.
- Unsigned builds still require the normal Gatekeeper bypass steps described in `docs/MACOS_INSTALLATION.md`.

### Update flow

- The app does not use `electron-updater`.
- Startup and `Help > Check for Updates...` both call the same GitHub release-check path.
- Update banners can appear more than once in one app session.

## Still Best Validated Manually

These areas have code coverage and smoke coverage, but still need real-hardware checks after risky changes:

- mic + desktop sync on current macOS hardware
- first seconds of desktop audio after recording starts
- denied Screen Recording guidance
- helper backpressure/drop warnings
- quitting during an active recording

## Related Files

- `src/main.js`
- `src/renderer/app.js`
- `backend/audio/macos_recorder.py`
- `backend/audio/swift_audio_capture.py`
- `swift/AudioCaptureHelper/Sources/main.swift`
