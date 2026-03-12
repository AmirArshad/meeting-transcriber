# Full Audit Remediation Archive

Archived on 2026-03-12 after a full PR review of `fix/full-audit-remediation`.

This archive summarizes the old root `todo.md`, which had grown into a mostly completed execution log. The active, pre-merge remediation checklist now lives in the root `todo.md`.

## Why this was archived

- The old checklist mostly tracked completed batch work and historical validation notes.
- The branch now needs a short, current list of unresolved pre-merge issues.
- Detailed checkbox-by-checkbox history remains available in git history for prior revisions of `todo.md` on this branch.

## Completed work captured by the archived plan

- Batch 0: regression test foundation using `pytest`, JS `node:test`, CI wiring, and manual smoke documentation.
- Batch 1: macOS recorder and Swift helper contract hardening, structured stdout events, startup truthfulness, and stop/drain fixes.
- Batch 2: multichannel resampling repair, shared Opus fallback handling, atomic meeting metadata writes, transactional add flow, corruption recovery, and scan/import ID fixes.
- Batch 3: transcription runtime cleanup for faster-whisper lock handling, MLX cache behavior, language propagation, stdout/stderr contracts, and shared transcriber interfaces.
- Batch 4: graceful quit handling, recording preflight wiring, safer renderer DOM/file URL behavior, stronger CI, release workflow aggregation, and checksum-verified build downloads.
- Batch 5: isolated lifecycle state tests, recorder contract cleanup, and regression checklists/fixtures.
- Batch 6: real macOS permission preflight, PyObjC fallback alignment, and output-device messaging and doc refresh.
- Batch 7: lazy transcript loading and renderer history/detail updates.
- Batch 8: recording memory/performance work, Windows callback contention reduction, and timeline optimization.
- Batch 9: build resource invalidation scaffolding, Swift helper path discovery, and window icon path cleanup.
- Batch 10: updater and release asset naming alignment.
- Batch 11: preload listener wrappers, `backend/device_manager.py` cleanup, and documentation refresh.
- Batch 12: local validation passes for JS tests, Python tests, Python compile checks, Swift helper build, and unsigned `build:mac:dir`.

## Validation baseline at archive time

- `npm test`
- `python3 -m pytest tests/python`
- `python3 -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py`
- `swift build -c release --arch arm64`
- `npm run build:mac:dir`

## What moved to the new active todo

- Remaining unresolved findings from the full PR review.
- Manual validation still required before merge.
- Build, macOS helper, meeting-history, and renderer follow-up fixes that were not truly complete.

The new root `todo.md` is now the source of truth for pre-merge remediation work.
