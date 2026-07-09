# Phase 0 smoke baseline

Design gate: `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md` Phase 0.0 / definition of done.

Checklist: `tests/manual/recording-smoke-checklist.md`

## Windows

- Status: **scheduled / not yet date-stamped in this PR**
- Date: _(fill after running the checklist on a Windows machine with real devices)_
- Notes: Run before Phase 1 merges that touch recorder/transcription paths. Abort conditions need a documented baseline, not memory.

## macOS

- Status: **explicitly deferred** (no Mac hardware available during Phase 7B merge)
- Date: _
- Notes: Batch with later macOS-sensitive phases (especially 3c / 7) if access remains scarce. Do not block Phase 0 merge solely on missing Mac hardware.
- Phase 7 PR B (#44) gate: when a Mac is available, run `tests/manual/recording-smoke-checklist.md` and `tests/manual/recording-transcription-regression-checklist.md`. Confirm desktop/browser speech appears in the transcript (not only meters/saved stereo channel) and `helperCaptureBackend` reports sensibly (`coreaudio_tap` expected on macOS 14.2+). Date-stamp this section after the run.
