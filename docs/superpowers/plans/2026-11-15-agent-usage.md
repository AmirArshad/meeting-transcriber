# Agent Usage Improvements Implementation Plan

> **For agentic workers:** Execute inline. Delegate only when the user explicitly requests it.

**Goal:** Reduce avoidable agent context and repeated work during builds without weakening application verification.

**Architecture:** Keep the existing canonical guide, on-demand contracts and shared skill links. Remove conflicting workflow demands, disable the duplicate Superpowers plugin for this checkout, and enforce small instruction budgets with the existing setup validator.

**Tech Stack:** Markdown, Codex TOML configuration, skill YAML metadata, Python setup checks.

## Global Constraints

- Preserve privacy, native platform gates, package integrity and application behavior.
- Keep changes inline and preserve existing local settings and all skill licenses/resources.
- Use focused setup checks for instruction-only changes; retain the full application gate for runtime/cross-cutting changes and PRs.
- Commit and push only the tracked improvements to the current branch, as requested; keep machine settings and raw session logs local.

---

### Task 1: Record evidence and clarify the working guide

**Files:** `AGENTS.md`, `.agents/README.md`, `docs/development/AGENT_USAGE_AUDIT.md`, `todo.md`.

**Implementation:** Record aggregate evidence from recent repo-specific sessions, distinguish cached input from billing, and explain the authorized parallel workload. Specify bounded reads, one owner for full verification, evidence reuse for unchanged inputs, completion-driven build waits, and existing build-cache behavior. Remove stale version claims in favor of authoritative manifests/contracts.

**Validation:** Inspect paths, commands and final diff; run the setup validator after Task 3.

### Task 2: Remove workflow amplification

**Files:** `.agents/skills/{writing-plans,executing-plans,systematic-debugging,verification-before-completion,requesting-code-review,finishing-a-development-branch}/SKILL.md`, `.agents/skills/finishing-a-development-branch/agents/openai.yaml`, `.agents/skills/skill-creator/SKILL.md`, `skills-lock.json`, `.codex/config.example.toml`, local ignored `.codex/config.toml`.

**Implementation:** Replace repetitive generic workflows with concise repo-specific procedures. Narrow triggers, remove mandatory skill chaining and same-message retesting, retain evidence and Git safety, and make branch-decision guidance explicit-only. Route skill authoring to the repo validator, since the bundled generic helper rejects supported manual-invocation metadata. Preserve upstream hashes and mark local adaptations. Disable only `superpowers@openai-curated-remote` for this checkout, preserving its existing local sandbox setting; provide the portable override as a tracked example.

**Validation:** Parse frontmatter/policies with real js-yaml and TOML with Python 3.11; check all canonical links. Verify the local override structurally; a fresh Codex session is needed to confirm runtime discovery.

### Task 3: Guard against instruction growth

**Files:** `scripts/agents/validate_setup.py`, `scripts/agents/test_validate_setup.py`.

**Implementation:** Enforce an 8 KiB root-guide budget and 3 KiB per hot-path workflow skill, plus a 12 KiB combined workflow budget. Validate explicit invocation policies as YAML rather than substring matching. Add fixture tests for oversize instructions and malformed/false-looking policy values.

**Validation:** `python3 -m unittest scripts.agents.test_validate_setup scripts.agents.test_link_skills`; `python3 scripts/agents/validate_setup.py`; `sh scripts/agents/link_skills.sh --check`; `git diff --check`. Report measured byte reductions, then commit and push the scoped changes.
