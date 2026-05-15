# Pre-Merge Review Follow-Up

Branch: `fix/full-audit-remediation`
Review baseline: full diff `master...fix/full-audit-remediation` at `d407cfb`

Status: second-pass pre-merge fixes complete on Windows. macOS/manual validation remains before merge.

Archive: previous root `todo.md` snapshots and earlier remediation history live in `docs/internal/FULL_AUDIT_REMEDIATION_ARCHIVE.md`.

## Working Rule

- Update this `todo.md` whenever task status changes, major progress is made, or execution order changes.
- Do not mark an item done until the code change and the most relevant automated/manual validation are both complete.
- Keep fixes targeted. Preserve the reviewed invariants below unless all dependent code, tests, and docs are updated together.

## Reviewed Invariants To Preserve

- Hybrid recorder contract: structured stdout messages (`levels`, `event`, `warning`, `error`) plus stderr compatibility output.
- Final result compatibility: Windows final JSON uses `audioPath`, macOS final JSON uses `outputPath`, and Electron still accepts both.
- Post-stop mixing architecture stays intact; do not reintroduce real-time cross-stream mixing.
- Privacy-first/local-only behavior stays intact; no telemetry, uploads, or cloud transcription.
- Packaged macOS builds stay Apple Silicon only.

## Severity Summary

- blocker: 0 unresolved automated-code items; manual WAV fallback smoke remains.
- high: 0 unresolved automated-code items.
- medium: 0 unresolved automated-code items; macOS build/manual checks remain.
- low: 0 unresolved automated-code items.

## Second-Pass Review Fixes

### 12. Normalize MLX transcription segments

- [x] Support list/tuple segment shapes from `lightning_whisper_mlx.transcribe_audio`.
- [x] Add Python regression coverage for list-shaped MLX segments.

Files:

- `backend/transcription/mlx_whisper_transcriber.py`
- `tests/python/test_transcriber_helpers.py`

### 13. Preserve recordings when quitting mid-recording

- [x] Use the graceful stop result before quitting.
- [x] Save a placeholder transcript and meeting-history entry when transcription cannot run before quit.

Files:

- `src/main.js`

### 14. Keep delete retryable when files are locked

- [x] Move meeting files to tombstones before metadata commit.
- [x] Restore tombstoned files if metadata save fails.
- [x] Keep metadata intact when a locked file cannot be prepared for deletion.
- [x] Add Python regression coverage for file-delete and metadata-save failures.

Files:

- `backend/meeting_manager.py`
- `tests/python/test_meeting_manager.py`

### 15. Restore recorder stderr startup compatibility

- [x] Re-add legacy stderr parsing for startup progress and `Recording started!`.
- [x] Add JS helper coverage for legacy stderr startup fallback.

Files:

- `src/main.js`
- `src/main-process-helpers.js`
- `tests/js/main-process-helpers.test.js`

### 16. Fix model-cache detection and packaged dependency determinism

- [x] Detect current `Systran/faster-whisper-*` Hugging Face cache directories.
- [x] Keep legacy `guillaumekln` detection as fallback.
- [x] Add pinned packaged-build requirement files for Windows and macOS resource preparation.
- [x] Track pinned build requirements in the resource manifest.

Files:

- `src/main-process-helpers.js`
- `tests/js/main-process-helpers.test.js`
- `build/prepare-resources.js`
- `requirements-windows-build.txt`
- `requirements-macos-build.txt`
- `tests/js/build-resource-manifest.test.js`

### 17. Clean up low-risk review findings

- [x] Avoid optional Swift values in `capture_stats` JSON.
- [x] Remove trailing whitespace flagged by `git diff --check`.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`
- `docs/features/MACOS_AUDIO_ARCHITECTURE.md`

## Blocker

### 1. Make WAV fallback recordings work end-to-end

- [x] Stop forcing transcription inputs from `.wav` back to `.opus` when WAV is the real fallback output.
- [x] Verify fallback outputs can still be transcribed and saved into meeting history end-to-end through automated path coverage.
- [x] Add regression coverage for compressor/integrity fallback through transcription and history save.

Files:

- `src/main.js`
- `backend/audio/compressor.py`
- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`
- `tests/python/test_compressor.py`
- `tests/python/test_meeting_manager.py`

Affects:

- Windows
- macOS

## High

### 2. Clear stale recorder state after unexpected post-start exit

- [x] Treat a recorder close after startup as recorder death, not a still-live session.
- [x] Clear `pythonProcess` and `recordingStartTime`, then surface a renderer-visible failure/warning.
- [x] Add regression coverage for stop/quit behavior after a crashed recorder.

Files:

- `src/main.js`
- `src/main-process-helpers.js`
- `src/renderer/app.js`
- `tests/js/main-process-helpers.test.js`

Affects:

- Windows
- macOS

### 3. Make meeting deletion transactional

- [x] Avoid ghost metadata if meeting files are deleted but `meetings.json` fails to save.
- [x] Reorder delete flow or add rollback/recovery so metadata and files stay consistent.
- [x] Add regression coverage for metadata-save failure during delete.

Files:

- `backend/meeting_manager.py`
- `tests/python/test_meeting_manager.py`

Affects:

- Windows
- macOS

## Medium

### 4. Prevent stale macOS helper files from leaking into Windows packages

- [x] Invalidate `build/resources/bin` on manifest changes across platforms, or gate packaging so Windows cannot ship a stale helper.
- [x] Add regression coverage for platform-switch stale-resource cleanup.
- [x] Strengthen packaging verification so Windows artifacts can be checked for stray helper files.

Files:

- `build/prepare-resources.js`
- `package.json`
- `.github/workflows/ci.yml`
- `tests/js/build-resource-manifest.test.js`

Affects:

- Windows packaging

### 5. Use the shipped Swift helper for macOS Screen Recording preflight

- [x] Route Screen Recording preflight through `audiocapture-helper --check-permission`.
- [x] Keep PyObjC checking only as fallback when the helper is unavailable.
- [x] Add regression coverage that preflight matches the runtime helper path.

Files:

- `src/main.js`
- `backend/audio/swift_audio_capture.py`
- `backend/check_permissions.py`
- `tests/python/test_screencapture_helper.py`

Affects:

- macOS

### 6. Preserve the first actionable Swift startup error

- [x] Keep `permission_denied` / `capture_start_failed` classification authoritative when multiple helper errors are emitted.
- [x] Avoid overwriting specific startup failures with a later generic `Failed to start capture` message.
- [x] Add regression coverage for duplicate helper startup errors.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/macos_recorder.py`
- `tests/python/test_screencapture_helper.py`

Affects:

- macOS

### 7. Remove the startup update notification timing race

- [x] Ensure the delayed startup auto-check still reaches the renderer when initialization is slow.
- [x] Keep later `Help > Check for Updates...` notifications repeatable in the same session.
- [x] Add integration-style coverage for early main-process emission and late renderer subscription.

Files:

- `src/main.js`
- `src/preload.js`
- `src/renderer/app.js`
- `src/renderer/update-notification-helpers.js`
- `tests/js/update-notification-helpers.test.js`

Affects:

- Windows
- macOS

### 8. Make Python test commands and docs truly Windows-safe

- [x] Replace hardcoded `python3` npm test usage with a Windows-safe approach, or stop claiming the npm script is cross-platform.
- [x] Align docs and agent guidance with the real supported commands.
- [x] Re-check README and testing/build docs for any remaining Windows command drift.

Files:

- `package.json`
- `README.md`
- `docs/development/TESTING.md`
- `docs/development/BUILD_INSTRUCTIONS.md`
- `AGENTS.md`
- `CLAUDE.md`

Affects:

- Windows

## Low / Follow-Up

### 9. Reduce corrupt metadata backup spam

- [x] Avoid producing repeated `meetings.corrupt.*.json` backups during one scan-plus-list refresh cycle.
- [x] Add regression coverage for repeated reads of the same corrupt metadata file.

Files:

- `backend/meeting_manager.py`
- `src/renderer/app.js`
- `tests/python/test_meeting_manager.py`

Affects:

- Windows
- macOS

### 10. Align updater docs with the shipped manual-download behavior

- [x] Update README wording so it describes update checking plus manual browser download, not true auto-install.
- [x] Keep updater feature docs explicit about the current manual-download flow.

Files:

- `README.md`
- `docs/features/FEATURE_AUTO_UPDATER.md`

Affects:

- Windows
- macOS

### 11. Backfill uncovered regression tests from this review

- [x] Add coverage for platform-switch stale `build/resources/bin` cleanup.
- [x] Add coverage for unexpected recorder exit after startup.
- [x] Add coverage for the WAV fallback transcription/history path.
- [x] Add coverage for the startup update listener race.
- [x] Add coverage for delete save failure / ghost meeting metadata.

Files:

- `tests/js/build-resource-manifest.test.js`
- `tests/js/main-process-helpers.test.js`
- `tests/js/update-notification-helpers.test.js`
- `tests/python/test_compressor.py`
- `tests/python/test_meeting_manager.py`

Affects:

- Windows
- macOS

## Validation Baseline From The Review

- [x] `npm test`
- [x] `python3 -m pytest tests/python`
- [x] `python3 -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py`
- [x] `swift build -c release --arch arm64`
- [x] `npm run build:mac:dir`

## Validation Gate Before Merge

### Automated re-run after fixes

- [x] `npm test`
- [x] `npm run test:python`
- [x] `python -c "import py_compile, pathlib; [py_compile.compile(str(path), doraise=True) for pattern in ('backend/*.py','backend/audio/*.py','backend/transcription/*.py') for path in pathlib.Path().glob(pattern)]"`
- [x] `git diff --check`
- [x] `npm run build:dir`
- [x] `python -m pip download --only-binary=:all: --python-version 311 --platform macosx_14_0_arm64 --implementation cp --abi cp311 -r requirements-macos-build.txt`
- [x] Re-ran `npm run build:dir` after expanding pinned transitive build requirements.
- [ ] `swift build -c release --arch arm64`
- [ ] `npm run build:mac:dir`
- [x] Confirm CI still passes the Windows packaging smoke path after the stale-`bin` fix.

### Manual product validation

- [ ] Verify a WAV fallback recording still transcribes and saves to history.
- [ ] Verify an unexpected recorder failure leaves the app recoverable and does not poison stop/quit behavior.
- [ ] Verify denied Screen Recording guidance comes from the helper-backed macOS preflight path.
- [ ] Verify the startup update banner still appears on slow init and can reappear after a later manual check.
- [ ] Verify mic/desktop sync and first-audio preservation on macOS.
- [ ] Verify corrupt metadata produces a single backup per incident.
- [x] Verify Windows artifacts do not ship a stray `bin/audiocapture-helper`.

## Suggested Execution Order

1. Fix the WAV fallback path, unexpected recorder-exit cleanup, and transactional delete behavior.
2. Fix stale packaging invalidation and the macOS helper permission/startup-error gaps.
3. Fix the startup update race and Windows test-command/docs drift.
4. Clean up corrupt-metadata backup noise, updater docs wording, and missing regressions.
5. Re-run automated validation, then complete targeted manual checks before merge.
