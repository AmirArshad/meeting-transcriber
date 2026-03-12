# Pre-Merge Remediation Plan

Branch: `fix/full-audit-remediation`

Status: active. This file now tracks only unresolved issues from the 2026-03-12 full PR review.

Archive: historical completed work moved to `docs/internal/FULL_AUDIT_REMEDIATION_ARCHIVE.md`.

## Working Rule

- Update this `todo.md` whenever task status changes, major progress is made, or execution order changes.
- Do not mark an item done until the code change and the most relevant automated/manual validation are both complete.

## Priority Summary

- P0: fix merge blockers that can cause stale builds, silent data loss, recorder races, or broken macOS behavior.
- P1: close correctness gaps and regressions that are user-visible but less catastrophic.
- P2: clean up coverage gaps and docs drift so the same bugs do not come back.

## P0 - Merge Blockers

### 1. Rebuild the Swift helper when source files change

- [x] Extend the resource manifest to hash the Swift helper source tree, not just `Package.swift`.
- [x] Ensure `npm run prepare-build` rebuilds `bin/audiocapture-helper` when any helper source changes.
- [x] Add regression coverage for resource invalidation on Swift source edits.

Files:

- `build/prepare-resources.js`
- `swift/AudioCaptureHelper/Sources/main.swift`
- `tests/js/build-resource-manifest.test.js`

### 2. Remove the moving-target `get-pip.py` build dependency

- [x] Stop pinning a checksum to the live `https://bootstrap.pypa.io/pip/get-pip.py` URL.
- [x] Replace it with a versioned, stable bootstrap strategy suitable for fresh macOS and Windows builds.
- [x] Update the build manifest tests for the new approach.

Files:

- `build/download-manifest.js`
- `build/prepare-resources.js`
- `tests/js/build-download-manifest.test.js`

### 3. Fix the stop/quit single-flight race in the main process

- [x] Keep `recordingStopPromise` authoritative until the original stop attempt fully settles.
- [x] Prevent a timed-out graceful quit from attaching duplicate stop listeners or sending a second `stop\n`.
- [x] Add regression coverage for quit-time timeout followed by another stop/quit attempt.

Files:

- `src/main.js`
- `src/main-process-helpers.js`
- `tests/js/main-process-helpers.test.js`

### 4. Surface Swift helper warning messages end-to-end

- [x] Parse helper `warning` messages in `backend/audio/swift_audio_capture.py`.
- [x] Propagate backpressure and writer-drain warnings through the macOS recorder and Electron UI.
- [x] Make dropped desktop-audio chunks visible in logs/UI instead of silently disappearing.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/macos_recorder.py`
- `src/main.js`

### 5. Fix macOS stream alignment so it uses comparable timestamps

- [x] Stop aligning mic and desktop audio using mismatched timestamp sources.
- [x] Use a shared capture reference or another trustworthy method that excludes helper transport delay.
- [ ] Re-validate that startup audio is preserved without introducing artificial mic/desktop desync.

Files:

- `backend/audio/macos_recorder.py`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/screencapture_helper.py`

### 6. Fix the corrupt-Opus fallback/import interaction

- [x] Ensure failed Opus outputs do not leave behind a bad `.opus` that recovery scan can later import.
- [x] Make scan/import prefer the healthy fallback file when both `.opus` and `.wav` variants exist.
- [x] Add regression coverage for integrity-failure fallback plus later scan/import.

Files:

- `backend/audio/compressor.py`
- `backend/meeting_manager.py`
- `tests/python/test_compressor.py`
- `tests/python/test_meeting_manager.py`

### 7. Fix the Swift permission-check handshake

- [x] Remove the premature `permission_check:false` emission from the helper, or make the Python side ignore placeholder messages.
- [x] Return the real granted/denied result reliably.
- [x] Add regression coverage for granted and denied permission checks.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`
- `backend/audio/swift_audio_capture.py`
- `tests/python/test_screencapture_helper.py`

### 8. Preserve actionable desktop-start failures

- [x] Keep specific startup failure details from the Swift/PyObjC capture backends.
- [x] Surface permission-denied, timeout, and helper-specific messages through `MacOSAudioRecorder` and Electron.
- [x] Avoid collapsing everything to a generic desktop-start failure string.

Files:

- `backend/audio/swift_audio_capture.py`
- `backend/audio/screencapture_helper.py`
- `backend/audio/macos_recorder.py`
- `src/main.js`

### 9. Add macOS packaged-build coverage to PR CI

- [x] Exercise the macOS Electron packaging path in `.github/workflows/ci.yml`, not only in the release workflow.
- [x] Verify the packaged app still includes the helper and expected resources.
- [x] Keep the CI runtime practical while still catching packaging regressions before tag builds.

Files:

- `.github/workflows/ci.yml`
- `build/prepare-resources.js`
- `package.json`

## P1 - Correctness and User-Visible Regressions

### 10. Preserve legacy inline transcript fallback

- [x] When `transcriptPath` is missing or unreadable, fall back to inline transcript text for older meeting records if present.
- [x] Avoid regressing transcript availability for pre-lazy-load metadata.
- [x] Add regression coverage for legacy records with missing `.md` files.

Files:

- `backend/meeting_manager.py`
- `tests/python/test_meeting_manager.py`

### 11. Restore repeatable update notifications

- [x] Replace the one-shot renderer listener with behavior that still handles multiple `update-available` events in one app session.
- [x] Keep cleanup behavior safe on renderer teardown.
- [x] Add regression coverage for startup auto-check plus manual Help > Check for Updates.

Files:

- `src/preload.js`
- `src/renderer/app.js`
- `src/main.js`
- `tests/js/main-process-helpers.test.js`

### 12. Make meeting selection feel responsive again

- [x] Show meeting details immediately while transcript loading stays asynchronous.
- [x] Keep the race guard that prevents late transcript loads from overwriting a newer selection.

Files:

- `src/renderer/app.js`

## P2 - Coverage and Documentation Cleanup

### 13. Backfill missing regression tests for new helper/build contracts

- [x] Add tests for Swift helper warning parsing.
- [x] Add tests for the fixed permission-check contract.
- [x] Add tests for the stop/quit race.
- [x] Add tests for stale-helper invalidation when Swift source files change.

Files:

- `tests/js/main-process-helpers.test.js`
- `tests/js/build-resource-manifest.test.js`
- `tests/python/test_screencapture_helper.py`

### 14. Fix remaining docs drift introduced on this branch

- [x] Update Windows testing docs so they do not assume a `python3` alias exists.
- [x] Update build docs to match the current Windows installer naming convention.
- [x] Sanity-check any release/build docs touched by the checksum/bootstrap changes.

Files:

- `docs/development/TESTING.md`
- `docs/development/BUILD_INSTRUCTIONS.md`
- `package.json`

## Validation Gate Before Merge

### Automated

- [x] `npm test`
- [x] `python3 -m pytest tests/python`
- [x] `python3 -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py`
- [x] `swift build -c release --arch arm64`
- [x] `npm run build:mac:dir`

### Manual macOS

- [ ] Record mic + desktop audio with active system audio and verify sync is still correct.
- [ ] Verify the first seconds of desktop audio are preserved.
- [ ] Verify denied Screen Recording permission surfaces the correct guidance.
- [ ] Verify helper backpressure/drop warnings are visible when triggered or simulated.
- [ ] Verify quitting during recording does not create duplicate stop flows or lose audio.

### Manual data/history/update flows

- [ ] Verify integrity-fallback recordings do not get re-imported from a corrupt `.opus`.
- [ ] Verify legacy meetings with inline transcript text still show transcripts when the `.md` file is missing.
- [ ] Verify update banners can appear more than once in the same app session.

## Suggested Execution Order

1. Build pipeline blockers: stale helper rebuilds, `get-pip.py`, macOS CI packaging.
2. Recorder correctness blockers: stop race, helper warnings, permission handshake, desktop-start errors.
3. Audio/data integrity blockers: stream alignment, corrupt Opus fallback/import.
4. User-visible regressions: legacy transcripts, update notifications, meeting-selection responsiveness.
5. Coverage + docs cleanup, then full validation.
