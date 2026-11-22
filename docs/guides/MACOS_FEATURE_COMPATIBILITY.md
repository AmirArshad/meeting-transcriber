# macOS Feature Compatibility

This document tracks the current state of major user-facing features on macOS.

## Summary

- Packaged macOS support is implemented for Apple Silicon (`arm64`, macOS 15+).
- Core recording, transcription, local audio import, History search, grounded Chat, recording tags, speaker naming, subtitle exports, and local AI add-ons work on macOS through the same Electron UI and shared storage architecture used on Windows and Linux.
- Remaining risk is hardware and version-matrix validation (e.g., macOS 15 vs newer macOS, permission prompt variants, and signed/notarized updater acceptance), not missing feature code.

## Compatibility Matrix

| Feature | Status | Notes |
| --- | --- | --- |
| Window/tray behavior | Implemented | Uses Electron APIs; macOS tray uses template PNG assets (`iconTemplate*.png`) and saturated red `REC` assets (`iconRecording*.png`). |
| Recording while minimized | Implemented | Recorder runs in Python subprocesses; not tied to renderer visibility. |
| Desktop audio capture | Implemented | Swift helper preferred: CoreAudio process tap on macOS 14.2+, Swift ScreenCaptureKit fallback, PyObjC ScreenCaptureKit fallback. System Audio Recording and/or Screen Recording permission may be required depending on the path. |
| Microphone capture | Implemented | Uses `sounddevice` on macOS. |
| Audio visualizer | Implemented | Recorder emits structured `levels` messages consumed by the renderer. |
| Stop-and-save workflow | Implemented | Main-process stop flow is guarded against duplicate stop races; durable `{stem}.capture/` spools support interrupted-capture recovery. |
| Recording history & local import | Implemented | Shared metadata, scan/import, local WAV/MP3/Opus import, transcript loading, delete flow, and `.md`/`.txt`/`.srt`/`.vtt` exports. |
| Transcript loading | Implemented | History detail panel renders immediately and loads transcript asynchronously. |
| History search & local Chat | Implemented | Local SQLite FTS5 full-text search (no AI add-ons needed), plus streaming grounded Chat with clickable timestamp citations (`llama-server` with `llama-cli` fallback). |
| Tags & speaker naming | Implemented | 11 canonical recording tags with dedicated summary templates and non-destructive inline speaker naming with timestamped voice previews. |
| Optional AI add-ons | Implemented | Speakrs 0.7 (CoreML) or Pyannote (MPS) speaker identification; Summaries & Chat (`llama.cpp` Metal with Qwen3.5 9B/4B and Gemma 4 E4B/12B; Inkling 2 Mini gated) with single-slot memory release; optional Parakeet v2 (Metal). |
| Updates | Implemented | `electron-updater` (Squirrel.Mac `.zip` in-app updates) activates on Developer ID signed builds; ad-hoc builds use manual `.dmg` download from GitHub Releases. |
| ffmpeg/Opus output | Implemented | ffmpeg is bundled in packaged builds and used for Opus compression with WAV fallback. |
| GPU acceleration | Implemented | Apple Silicon uses Lightning-Whisper-MLX and Metal automatically. |
| Packaged build CI coverage | Implemented | CI builds `build:mac:dir` and verifies helper, `speakrs-cli`, Python, ffmpeg, and DMG layout in the app bundle. |

## macOS-Specific Behavior Worth Remembering

### Permissions

- Microphone permission is required for mic capture.
- Desktop audio capture uses the bundled Swift helper. macOS 14.2+ prefers CoreAudio process taps and may require System Audio Recording permission.
- Screen Recording permission is still required when the ScreenCaptureKit fallback path is used.
- Recording preflight blocks start when those permissions are missing and can direct the user to System Settings.

### Packaging

- Distributed macOS installers are `AvaNevis-Setup-<version>.dmg` (plus `AvaNevis-Setup-<version>.zip` and `latest-mac.yml` for Squirrel.Mac updates on signed releases).
- Packaged builds target Apple Silicon (`arm64`, macOS 15+) only.
- Ad-hoc signed builds require the normal Gatekeeper bypass steps described in [MACOS_INSTALLATION.md](MACOS_INSTALLATION.md).

### Update flow

- `src/main/updater-service.js` inspects the packaged `.app` signature (`isMacAppDeveloperIdSigned`):
  - **Developer ID signed builds** use `electron-updater` (Squirrel.Mac) differential in-app updates with recording- and AI-safe restart gates.
  - **Ad-hoc signed builds** automatically use `manual-package` mode and open the matching `.dmg` download from GitHub Releases.
- Startup and Settings → Updates both use the same main-process updater state machine.

## Still Best Validated Manually

These areas have code coverage and smoke coverage, but still need real-hardware checks after risky changes:

- mic + desktop sync on current macOS hardware
- first seconds of desktop audio after recording starts
- denied System Audio Recording / Screen Recording guidance
- helper backpressure/drop warnings
- quitting during an active recording

## Related Files

- `src/main.js` (composition root)
- `src/main/recorder-service.js`
- `src/main/device-ipc.js`
- `src/renderer/app.js`
- `backend/audio/macos_recorder.py`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/macos_stereo_repair.py`
- `backend/audio/macos_stream_alignment.py`
- `swift/AudioCaptureHelper/Sources/main.swift`
