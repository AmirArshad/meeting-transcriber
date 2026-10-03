# v2.10 Adversarial Fixes Implementation Plan

> **For agentic workers:** Execute inline. No delegation is authorized.

**Goal:** Address all three review findings and their regression recommendations, then commit and push.

**Architecture:** Verify pinned Parakeet content at compute admission using process-local fingerprint evidence. Invalidate speaker metadata atomically with transcript replacement and bind speaker sidecars to transcript hashes. Persist recovery selections before capture cleanup and replay them until metadata acknowledges them.

**Tech Stack:** Electron/plain JavaScript, Python 3.11, Node test runner, pytest.

## Global Constraints

- No cloud processing, telemetry, uploads, hidden downloads, or new dependencies.
- Preserve exact saved engine/model/language selections and prior outputs on failure.
- Work inline; preserve GitHub slug AmirArshad/meeting-transcriber.
- Use repo-local Python 3.11; run the full pre-commit gate and inspect the diff.

### Task 1: Verified compute admission

Modify `src/main/parakeet-setup.js` and `src/main/transcription-service.js`. Add catalog hash verification before the live probe, retaining evidence only for unchanged path/size/mtime fingerprints and scanning the runtime tree every time. Keep explicit validation full-hash.
Test `tests/js/parakeet-setup.test.js` and `tests/js/transcription-service-admission.test.js`: same-size runtime/model/VAD corruption, ordinary/guided rejection before execution, no fallback, previous outputs retained.

### Task 2: Current speaker source

Modify `backend/meeting_manager.py`, `src/main/transcription-service.js`, and `backend/summaries/summary_runner.py`. Clear obsolete diarization in the transcript metadata transaction; bind new speaker sidecars to the committed transcript hash and require that hash when loading summary text.
Test `tests/python/test_transcription_engine_metadata.py`, `tests/js/transcription-service-admission.test.js`, and `tests/python/test_summary_runner.py`: unavailable diarization after successful retry, mismatched/legacy sidecars, matching sidecars, failed retries retaining prior output.

### Task 3: Durable recovery selection

Modify `backend/audio/capture_recovery.py`, `backend/audio/streaming_post_processor.py`, and `src/main/recorder-service.js`. Write atomic handoffs before cleanup, discover them on restart, acknowledge individually only after the request is durable. Keep failures retryable and protect recordings-root path boundaries.
Test `tests/python/test_capture_recovery.py` and recorder recovery/selection JS suites: process-response loss, multiple captures, staging/ack failure and replay.

### Validation

Run focused suites per change, then `npm run test:all` with Python 3.11 on PATH. Inspect final diff and `git diff --check`; commit a precise message and push the current branch to origin.
