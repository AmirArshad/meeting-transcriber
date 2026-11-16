---
name: requesting-code-review
description: Use for a requested code review or a concrete high-risk change where targeted review materially reduces risk. Routine task completion does not trigger a separate review workflow.
---

# Requesting Code Review

Review proportionately and inline by default. Ask before delegating; review need is not permission to spawn a worker.

1. Scope the review to the actual changed files and requirements. Inspect the working diff for uncommitted work; use the real implementation base for committed changes, not an assumed `HEAD~1` or `origin/main`.
2. Check behavior, process contracts, privacy/data integrity, error paths and meaningful test evidence. Prioritize concrete defects over style preferences.
3. Fix blocking issues and verify affected behavior. Report findings with file locations and reasons. If none remain, say so with the validation scope.

For an explicitly authorized independent reviewer, use `code-reviewer.md` as a scoped template. Send the requirements, exact paths/base and available test evidence; do not copy the whole conversation. The lead owns integrated verification. Request another review only if a material change introduces a new risk, not after each task or minor correction.
