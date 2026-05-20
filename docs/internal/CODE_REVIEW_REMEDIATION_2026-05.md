# Code Review Remediation (May 2026)

This document summarizes the security, reliability, and performance hardening merged to `master` in May 2026. It is aimed at developers and reviewers; the full phased checklist lives in [`TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md`](TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md).

Canonical runtime invariants are in root [`AGENTS.md`](../../AGENTS.md).

## What shipped

### Security and privacy

- **IPC input validation:** Whisper `modelSize` allowlist; Hugging Face token format check on save; recordings-path guards in main and `meeting_manager` (symlinks and paths outside `userData/recordings` rejected).
- **Update downloads:** `download-update` uses main-process `pendingUpdateInfo` only — the renderer cannot pass an arbitrary URL. Replay/dismiss paths validate trusted GitHub release URLs.
- **Sensitive text redaction:** Progress stderr to renderer (line-chunked), summary errors, persisted meeting AI `error` fields, and shared Python helper `backend/common/sensitive_text.py`.
- **Trusted renderer sender:** High-risk IPC handlers verify `event.sender === mainWindow.webContents` (recording, transcription, diarization, summaries, meeting mutations, token storage, update download).
- **Archive extraction:** ZIP symlink entries rejected (in addition to existing tar traversal checks).
- **DevTools / reload:** Packaged builds hide DevTools and reload menu entries unless `AVANEVIS_ENABLE_DEVTOOLS=1`.

### Recording lifecycle

- **Concurrent start guard:** `RECORDER_BUSY` when a recorder or stop workflow is already active; renderer `starting` state and session IDs ignore stale `recording-failed` events.
- **Recorder correctness:** Windows stream cleanup on failed start; macOS mic callback gated on running state; threaded `ChunkedAudioBuffer`; empty mic returns structured `success: false` without a bogus output path; Swift stderr batch-drain for final stats.
- **Stop result parsing:** `parseRecordingStopResult` normalizes Windows `audioPath` and macOS `outputPath`; handles `success: false` payloads.

### Local AI compute

- **Single compute queue** for `transcribe-audio`, guided transcription, diarization, and summary generation (not model download).
- **Wall-clock timeouts** with process kill via `runWallClockComputeAction` so hung Python children cannot block the queue for the rest of the session.
- **Setup validation** waits for the compute queue to idle instead of failing after 15 seconds.
- **Summary sidecars:** write to `.tmp` files, atomic rename on success, cleanup of staging and promoted files on failure.
- **Cache detection:** Exact Hugging Face hub folder names for faster-whisper; non-empty MLX `weights.npz` and `config.json`.

### Performance and UX

- Debounced meeting search; filesystem scan only on launch and explicit history refresh.
- Audio visualizer pauses its animation loop when idle/hidden and restarts on new level updates.
- Capped spawn stdout/stderr and updater HTTP response size; JSON-result stdout rejects overflow instead of truncating.

## Validation

```bash
npm test
npm run test:python
```

Manual smoke when touching recording or AI: `tests/manual/recording-smoke-checklist.md`, `tests/manual/local-ai-addons-checklist.md`.

## Not shipped (Phase 7 backlog)

- Stream-to-disk during capture (memory for multi-hour sessions)
- Optional HF token via stdin for setup validation smoke tests
- Packaged Swift helper PATH `which()` skip
- Strict device-validation toggle; large-library scan lock improvements

Track these in root `todo.md` under **Deferred architectural backlog**.
