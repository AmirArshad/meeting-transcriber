# Next Project Decision

Previous project plans:

- `docs/internal/TODO_ARCHIVE_2026-05-18_LOCAL_AI_ADDONS.md`
- `docs/internal/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md` (security/performance remediation — merged 2026-05-20)

## Candidate projects

- [ ] Acoustic echo cancellation / echo suppression for speaker-use scenarios (cross-platform Windows + macOS).
- [ ] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the same transcription/summary/history flow as recorded meetings.
- [ ] History chat over past meetings using the installed local summary runtime/model.

## Recommendation

- [ ] Start with **Acoustic echo cancellation / suppression** first.
  - Reason: highest recording/transcript quality impact for speaker users, and it improves core output quality before adding new ingestion/query features.

## Decision gate

- [ ] Confirm the next project to execute.
- [ ] Create a focused implementation plan once the project is chosen.

## Deferred architectural backlog (from remediation Phase 7)

See `docs/internal/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md` § Phase 7 for full notes. Highlights:

- [ ] Stream-to-disk during capture (long-recording memory)
- [ ] Packaged Swift helper: skip `which()` when `AVANEVIS_PACKAGED=1`
- [ ] Optional: stricter device validation toggle; scan lock/idempotency improvements
