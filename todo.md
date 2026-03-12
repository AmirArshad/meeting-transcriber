# Pre-Merge Review Follow-Up

Branch: `fix/full-audit-remediation`
Review baseline: full diff `master...fix/full-audit-remediation` at `d407cfb`

Status: active. This file now tracks the unresolved tasks from the 2026-03-12 full MR review reset.

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

- blocker: 1 end-to-end regression to fix before merge.
- high: 2 correctness/data-integrity issues.
- medium: 5 important regression follow-ups.
- low: 3 cleanup, docs, and coverage follow-ups.

## Blocker

### 1. Make WAV fallback recordings work end-to-end

- [ ] Stop forcing transcription inputs from `.wav` back to `.opus` when WAV is the real fallback output.
- [ ] Verify fallback outputs can still be transcribed and saved into meeting history end-to-end.
- [ ] Add regression coverage for compressor/integrity fallback through transcription and history save.

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

- [ ] Treat a recorder close after startup as recorder death, not a still-live session.
- [ ] Clear `pythonProcess` and `recordingStartTime`, then surface a renderer-visible failure/warning.
- [ ] Add regression coverage for stop/quit behavior after a crashed recorder.

Files:

- `src/main.js`
- `src/main-process-helpers.js`
- `src/renderer/app.js`
- `tests/js/main-process-helpers.test.js`

Affects:

- Windows
- macOS

### 3. Make meeting deletion transactional

- [ ] Avoid ghost metadata if meeting files are deleted but `meetings.json` fails to save.
- [ ] Reorder delete flow or add rollback/recovery so metadata and files stay consistent.
- [ ] Add regression coverage for metadata-save failure during delete.

Files:

- `backend/meeting_manager.py`
- `tests/python/test_meeting_manager.py`

Affects:

- Windows
- macOS

## Medium

### 4. Prevent stale macOS helper files from leaking into Windows packages

- [ ] Invalidate `build/resources/bin` on manifest changes across platforms, or gate packaging so Windows cannot ship a stale helper.
- [ ] Add regression coverage for platform-switch stale-resource cleanup.
- [ ] Strengthen packaging verification so Windows artifacts can be checked for stray helper files.

Files:

- `build/prepare-resources.js`
- `package.json`
- `.github/workflows/ci.yml`
- `tests/js/build-resource-manifest.test.js`

Affects:

- Windows packaging

### 5. Use the shipped Swift helper for macOS Screen Recording preflight

- [ ] Route Screen Recording preflight through `audiocapture-helper --check-permission`.
- [ ] Keep PyObjC checking only as fallback when the helper is unavailable.
- [ ] Add regression coverage that preflight matches the runtime helper path.

Files:

- `src/main.js`
- `backend/audio/swift_audio_capture.py`
- `backend/check_permissions.py`
- `tests/python/test_screencapture_helper.py`

Affects:

- macOS

### 6. Preserve the first actionable Swift startup error

- [ ] Keep `permission_denied` / `capture_start_failed` classification authoritative when multiple helper errors are emitted.
- [ ] Avoid overwriting specific startup failures with a later generic `Failed to start capture` message.
- [ ] Add regression coverage for duplicate helper startup errors.

Files:

- `swift/AudioCaptureHelper/Sources/main.swift`
- `backend/audio/swift_audio_capture.py`
- `backend/audio/macos_recorder.py`
- `tests/python/test_screencapture_helper.py`

Affects:

- macOS

### 7. Remove the startup update notification timing race

- [ ] Ensure the delayed startup auto-check still reaches the renderer when initialization is slow.
- [ ] Keep later `Help > Check for Updates...` notifications repeatable in the same session.
- [ ] Add integration-style coverage for early main-process emission and late renderer subscription.

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

- [ ] Replace hardcoded `python3` npm test usage with a Windows-safe approach, or stop claiming the npm script is cross-platform.
- [ ] Align docs and agent guidance with the real supported commands.
- [ ] Re-check README and testing/build docs for any remaining Windows command drift.

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

- [ ] Avoid producing repeated `meetings.corrupt.*.json` backups during one scan-plus-list refresh cycle.
- [ ] Add regression coverage for repeated reads of the same corrupt metadata file.

Files:

- `backend/meeting_manager.py`
- `src/renderer/app.js`
- `tests/python/test_meeting_manager.py`

Affects:

- Windows
- macOS

### 10. Align updater docs with the shipped manual-download behavior

- [ ] Update README wording so it describes update checking plus manual browser download, not true auto-install.
- [ ] Keep updater feature docs explicit about the current manual-download flow.

Files:

- `README.md`
- `docs/features/FEATURE_AUTO_UPDATER.md`

Affects:

- Windows
- macOS

### 11. Backfill uncovered regression tests from this review

- [ ] Add coverage for platform-switch stale `build/resources/bin` cleanup.
- [ ] Add coverage for unexpected recorder exit after startup.
- [ ] Add coverage for the WAV fallback transcription/history path.
- [ ] Add coverage for the startup update listener race.
- [ ] Add coverage for delete save failure / ghost meeting metadata.

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

- [ ] `npm test`
- [ ] `python3 -m pytest tests/python`
- [ ] `python3 -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py`
- [ ] `swift build -c release --arch arm64`
- [ ] `npm run build:mac:dir`
- [ ] Confirm CI still passes the Windows packaging smoke path after the stale-`bin` fix.

### Manual product validation

- [ ] Verify a WAV fallback recording still transcribes and saves to history.
- [ ] Verify an unexpected recorder failure leaves the app recoverable and does not poison stop/quit behavior.
- [ ] Verify denied Screen Recording guidance comes from the helper-backed macOS preflight path.
- [ ] Verify the startup update banner still appears on slow init and can reappear after a later manual check.
- [ ] Verify mic/desktop sync and first-audio preservation on macOS.
- [ ] Verify corrupt metadata produces a single backup per incident.
- [ ] Verify Windows artifacts do not ship a stray `bin/audiocapture-helper`.

## Suggested Execution Order

1. Fix the WAV fallback path, unexpected recorder-exit cleanup, and transactional delete behavior.
2. Fix stale packaging invalidation and the macOS helper permission/startup-error gaps.
3. Fix the startup update race and Windows test-command/docs drift.
4. Clean up corrupt-metadata backup noise, updater docs wording, and missing regressions.
5. Re-run automated validation, then complete targeted manual checks before merge.
