# Release Runbook Prompt Templates & Subscription Mapping

Use these exact templates when emitting a release runbook. Replace every `<...>` field with concrete values from the plan and repository — never leave unfilled placeholders in the final runbook.

## Table of Contents

- [Subscription Mapping Patterns (1, 2, or 3+ Plans)](#subscription-mapping-patterns-1-2-or-3-plans)
- [Step 0 — Branch & Optional Worktree Setup](#step-0--branch--optional-worktree-setup)
- [Build Prompt Template](#build-prompt-template)
- [Diff-Only Review Prompt Template](#diff-only-review-prompt-template)
- [Dependency Sweep Review Template](#dependency-sweep-review-template)
- [Checkpoint Prompt Template](#checkpoint-prompt-template)
- [Final Pre-Release Checkpoint Template](#final-pre-release-checkpoint-template)

---

## Subscription Mapping Patterns (1, 2, or 3+ Plans)

Map the four abstract tiers (`Fast`, `Balanced`, `Strict`, `Deep`) to whatever tools and models the user specifies:

- **1 Subscription (`Provider A` with Fast / Balanced / Deep models):**
  - Build trivial/mechanical + Checkpoints: `A · Fast · Low`
  - Build standard slices: `A · Balanced · Medium`
  - Build concurrency/algorithm slices: `A · Deep · High`
  - Review standard slices: fresh thread `A · Balanced · Low`
  - Review high-risk slices: fresh thread `A · Deep · High`
- **2 Subscriptions (`Provider A` + `Provider B`):**
  - Split build slices ~50/50 by strength (e.g., `A` for UI/multi-file/deep architecture, `B` for strict backend/IPC/edge-case slices; allow swapping on medium slices when one quota runs low).
  - Always cross-review: `A builds → B reviews`, `B builds → A reviews`.
- **3+ Subscriptions (`Provider A` + `Provider B` + `Provider C`):**
  - Route `A` and `B` across primary build lanes (parallelizable waves) and assign `C` to independent cross-provider reviews + overflow slices, rotating high-risk reviews across the strongest available reasoning model not used as builder.

---

## Step 0 — Branch & Optional Worktree Setup

```bash
git checkout master && git pull origin master
git checkout -b <release-branch>
git push -u origin <release-branch>
```

If the user runs parallel Git worktrees (e.g., T3 Code) in a repo with gitignored `node_modules` / `.venv`, include an idempotent setup script (for code slices only — never dependency/lockfile slices):

```bash
[ -e node_modules ] || ln -s <repo-abs-path>/node_modules node_modules
[ -e .venv ] || ln -s <repo-abs-path>/.venv .venv
```

---

## Build Prompt Template

Header format:
`### <N>. Build <SliceID> — <Short Title>`
`**<Provider> · \`<Model>\` · \`<Low|Medium|High>\` thinking** · <Worktree or Main repo | Main repo ONLY>`

```text
Cut `<slice-branch>` from `<release-branch>`<optional: (with <prereq> merged)> and implement ONLY Slice <SliceID> (<Task ref>) from `<plan-path>`.

Read ONLY <exact plan section(s) and contract section(s)> plus:
- `<file-1>` (<specific functions or line ranges>)
- `<file-2>` (<specific functions or line ranges>)
- `<focused-test-file(s)>`

Key invariants / edge cases:
- <concrete invariant or edge case 1>
- <concrete invariant or edge case 2>

Do not touch unrelated files. Run ONLY <exact syntax + focused test command(s)> (no full suite). Commit on `<slice-branch>` and report `git diff <release-branch>...HEAD --stat` + test results.
```

---

## Diff-Only Review Prompt Template

Header format:
`### <N>. Review <SliceID>`
`**<Provider> · \`<Model>\` · \`<Low|Medium|High>\` thinking** · Main repo (fresh thread)`

```text
Perform a concise, diff-only <optional: security/concurrency/adversarial/guardrail> review of `<slice-branch>` against `<release-branch>` (<Task ref> in `<plan-path>`).

Run `git diff <release-branch>...<slice-branch>` and review the diff directly (do not read unrelated files or run tests unless reproducing a bug).
Check specifically:
1. <slice-specific acceptance & edge-case check>
2. <hard invariant / security / fail-closed / contract parity check>
3. <focused test coverage check>

Output ONLY `APPROVE` or a numbered list of concrete findings (`file:line` + exact fix).
```

Follow immediately with a one-line merge reminder:
`*(If findings appear, paste them into the builder thread at \`Low\` thinking to patch, then merge \`<slice-branch>\` → \`<release-branch>\`.)*`

---

## Dependency Sweep Review Template

Same as Diff-Only Review, but exclude noisy lockfiles from the diff command so review tokens stay tiny:

```text
Run `git diff <release-branch>...<slice-branch> -- . ':!package-lock.json' ':!**/Cargo.lock' ':!yarn.lock' ':!pnpm-lock.yaml'` and review the diff directly.
```

---

## Checkpoint Prompt Template

Header format:
`### <N>. Checkpoint <K> — Wave <Letter> Full Gate`
`**<Provider> · \`<Model>\` · \`Low\` thinking** · Main repo on \`<release-branch>\``

```text
On `<release-branch>` (with <slices> merged), run `<full-test-command>` (log verbose output to an ignored file, keep exit code), confirm clean pass, and update `todo.md` to check off Wave <Letter> slices <slices>. Commit and push `<release-branch>`.
```

Follow with an optional 1–2 line manual/hardware spot-check note if UI, audio, or GPU behavior changed in that wave.

---

## Final Pre-Release Checkpoint Template

```text
On `<release-branch>` with all Waves merged, run the final <version> pre-release gate (<Task ref>):
1. Run `<full-test-command>` (log output to an ignored file, verify exit 0), `<setup-validator-command>`, `<security-audit-commands>`, and `<legal/release-asset-command>`.
2. Build and verify target packages on this host (`<build-and-verify-commands>`) and record exact evidence + any accepted limits in `<qualification-doc>` and `todo.md`.
3. Stop before bumping version files, merging to `master`, or tagging `<version>` — summarize gate results and wait for release-cut authorization.
```
