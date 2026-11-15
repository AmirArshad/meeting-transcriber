---
name: verification-before-completion
description: Use before claiming completion or preparing an authorized commit or PR. Check evidence for the current inputs without repeating unchanged successful checks.
---

# Verification Before Completion

Evidence must support the exact claim. Fresh means it covers the current code, dependencies and relevant environment, not that the command ran in the same message.

1. Identify the checks required for the changed surface using `AGENTS.md`. Use focused tests during iteration. Instruction/setup-only changes use setup validation; cross-cutting, recorder, persistence, packaging and security behavior require `npm run test:all`, as does any PR.
2. Run missing checks after the last relevant change. Reuse successful checks from this task if their inputs have not changed. Do not rerun simply because the user now authorizes a commit/push, a skill is invoked, or a final answer is due. A merge, dependency update or relevant environment change may invalidate earlier evidence.
3. Confirm completion and exit status. Read the summary and failures; retain verbose output locally and inspect relevant excerpts. Do not infer success from a running process, a tail without its exit code, or another agent's assertion.
4. Inspect the final diff and `git diff --check`. Match implemented behavior to the request and report actual commands/results, skips and unresolved gates.

Syntax checks do not prove a build; unit tests do not prove native GPU/audio/keyring acceptance. A focused check proves its scope, not the full suite. For a behavioral regression, prefer a test that demonstrates the original failure, without mechanically reverting working changes solely to satisfy a ceremony.

For long commands, capture output to a local log, preserve the real exit code and wait for completion. Use completion notifications or a blocking wait; avoid repeated short polling. Keep one owner for the integrated full suite and each installer build. Do not run overlapping builds that mutate the same output tree.
