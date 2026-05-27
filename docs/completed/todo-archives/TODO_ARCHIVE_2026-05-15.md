# Todo Archive - 2026-05-15

Archived while creating branch `upgrade/electron-latest` for the Electron upgrade effort.

The root `todo.md` was reset to a focused Electron upgrade checklist. This file preserves the retired planning context so the root todo can remain current and actionable.

## Archived Post-Merge CI Follow-Up

Status at archive time: complete locally.

- [x] Identify failing CI job: `Test Electron Frontend & Build Smoke` on Windows.
- [x] Reproduce Node 18 Windows wildcard failure for `node --test tests/js/*.test.js`.
- [x] Update JS test script and CI to avoid shell/Node-version-dependent globs.
- [x] Validate with Node 18 and local Node.

Files:

- `package.json`
- `.github/workflows/ci.yml`

## Archived Pre-Merge Review Follow-Up

Source branch: `fix/full-audit-remediation`

Review baseline: full diff `master...fix/full-audit-remediation` at `d407cfb`

Status at archive time: automated remediation work was complete. Remaining notes were manual validation reminders from the already-merged remediation branch.

The detailed historical remediation archive remains in `docs/completed/FULL_AUDIT_REMEDIATION_ARCHIVE.md`.

### Completed Second-Pass Review Fixes

- Normalize MLX transcription segments.
- Preserve recordings when quitting mid-recording.
- Keep delete retryable when files are locked.
- Finish recorder stdout JSON migration.
- Fix model-cache detection and packaged dependency determinism.
- Clean up low-risk review findings.

### Completed Blocker And High-Priority Fixes

- Make WAV fallback recordings work end-to-end.
- Clear stale recorder state after unexpected post-start exit.
- Make meeting deletion transactional.

### Completed Medium-Priority Fixes

- Prevent stale macOS helper files from leaking into Windows packages.
- Use the shipped Swift helper for macOS Screen Recording preflight.
- Preserve the first actionable Swift startup error.
- Remove the startup update notification timing race.
- Make Python test commands and docs Windows-safe.

### Completed Low-Priority And Coverage Fixes

- Reduce corrupt metadata backup spam.
- Align updater docs with the shipped manual-download behavior.
- Backfill regression tests for stale resources, recorder exit handling, WAV fallback, startup update listener timing, and delete-save failure behavior.

### Prior Validation Notes

Automated validation listed as complete in the retired root todo:

- `npm test`
- `npm run test:python`
- Python compile checks for backend files
- `git diff --check`
- `npm run build:dir`
- macOS build dependency download check
- Windows artifact check for stray `bin/audiocapture-helper`

Manual validation reminders that were still listed in the retired root todo:

- Verify a WAV fallback recording still transcribes and saves to history.
- Verify an unexpected recorder failure leaves the app recoverable and does not poison stop/quit behavior.
- Verify denied Screen Recording guidance comes from the helper-backed macOS preflight path.
- Verify the startup update banner still appears on slow init and can reappear after a later manual check.
- Verify mic/desktop sync and first-audio preservation on macOS.
- Verify corrupt metadata produces a single backup per incident.

These manual reminders are not carried into the active Electron upgrade todo unless they overlap with upgrade smoke validation.
