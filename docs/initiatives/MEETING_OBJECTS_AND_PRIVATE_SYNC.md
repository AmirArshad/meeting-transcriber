# Meeting objects and private sync — future initiative

**Status:** Exploration only. Not scheduled for v2.9.0.

## Intent

Let a person optionally store a complete meeting object in private storage they control, then make it available to their other AvaNevis instances. A meeting object may eventually contain the recording, transcript, speaker segments, generated summary, and the minimum metadata needed to relate those artifacts.

This remains compatible with AvaNevis’s privacy model only if it is explicit, opt-in, user-controlled, and has no background upload or hosted AvaNevis backend. Local recording and local transcription stay the default and must work offline.

## v2.9.0 boundary

v2.9.0 may establish visual layout boundaries only:

- keep a stable, accessible meeting-detail action region;
- keep Record, History, and Settings as the existing navigation model;
- use semantic containers that a future action can inhabit without reworking the page hierarchy.

v2.9.0 must not add a sync button, account, provider integration, authentication, cloud endpoint, network request, background job, synchronization state, database field, meeting metadata schema change, or upload queue.

## Questions to resolve before implementation

1. Which storage providers and protocols are acceptable, and how does the person own and revoke access?
2. What client-side encryption, key recovery, and device trust model preserves privacy without an AvaNevis-hosted service?
3. What is the versioned meeting-object manifest and artifact-integrity model?
4. How do conflicts, partial downloads, deletion, retention, and offline edits behave across devices?
5. Which artifacts are user-selectable for transfer, and how is transfer always explicit and visible?
6. What threat model, consent language, and platform-specific secure-storage behavior are required before any provider or credential code exists?

## Entry criteria for a future release

Before implementation begins, write a threat model, storage-provider decision record, schema and migration design, explicit transfer UX, offline/error behavior, and tests for encryption boundaries, conflict resolution, and no-background-upload behavior. Review all new IPC and persistence surfaces against the local-only default.
