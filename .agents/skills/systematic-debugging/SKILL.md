---
name: systematic-debugging
description: Use to investigate a reproducible bug, failed test or unexplained behavior before proposing a fix. A routine successful build does not need this workflow.
---

# Systematic Debugging

Find evidence for the cause before changing code. Keep the investigation proportional to the failure.

1. **Locate the failure.** Read the error and relevant log excerpt, inspect recent changes, and identify the owning layer. Reproduce with the smallest applicable command. An existing failed build/test log can establish the baseline; do not rerun an expensive unchanged build just to obtain the same error.
2. **Trace the cause.** Follow inputs across the relevant process boundary and compare a working path. Read the applicable contract. Add targeted instrumentation only if the existing evidence cannot locate the failure; keep secrets and user recordings out of logs.
3. **Test one hypothesis.** State the suspected cause and what would confirm it. Make the smallest relevant experiment. If it fails, revise the hypothesis rather than stacking speculative fixes. After repeated failed attempts, reassess the approach and report a concrete blocker when needed.
4. **Fix and verify.** For behavioral bugs, add a focused regression that distinguishes the failure from the intended behavior when practical. Existing reproductions, schema checks or command-level checks can suffice for environment/configuration/documentation issues. Run the focused check, inspect the diff, then apply the root guide's final validation scope.

Do not prescribe red/green/revert cycles for every edit, run full installers after each hypothesis, or claim hardware acceptance from mocks. Preserve fail-closed behavior and graceful degradation. If the available evidence cannot establish the cause, say what is known and what evidence is missing.

Read these resources only for the named problem:
- `root-cause-tracing.md`: a failure originates far upstream in a call chain.
- `condition-based-waiting.md`: a demonstrated timing race needs condition-based synchronization.
- `defense-in-depth.md`: a proven invalid input needs guards at multiple real trust boundaries.

Historical pressure tests, examples and `CREATION-LOG.md` are skill-maintenance resources, not required reading during a build.
