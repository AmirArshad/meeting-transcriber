---
name: release-runbook
description: Turn a release or multi-phase implementation plan into a token-optimized sequence of copy-paste build, diff-only review, and checkpoint prompts with provider-agnostic model and reasoning guidance for 1, 2, or 3+ AI subscriptions. Use when planning release execution, splitting big phases into small slices, or generating sequenced multi-agent prompts.
---

# Release Runbook

Generate a complete, copy-paste-ready sequence of micro-slice **Build**, **Diff-Only Review**, and **Checkpoint** prompts from an implementation plan, optimized for quality and token usage across whatever AI subscriptions and model tiers the user currently has.

## 1. Collect Missing Inputs (Briefly)

Check the conversation and plan first. Only ask for what is missing (at most 1 short message):

1. **Source plan & target release branch** (e.g., `docs/superpowers/plans/YYYY-MM-DD-vX.Y-release-plan.md`, `release/X.Y`).
2. **Active subscriptions & available model tiers** — never assume specific vendors or model names. Ask which 1, 2, or 3+ subscriptions/tools the user currently has (e.g., Claude, Codex, Antigravity/Gemini, Cursor, OpenCode, etc.) and which models correspond to their **Fast**, **Balanced**, and **Deep Reasoning** tiers.
3. **Workspace style** — single checkout (one slice at a time) or parallel Git worktrees (e.g., T3 Code, Conductor, native worktrees).

## 2. Slice the Plan for Minimal Token Burn

Split phases into **micro-slices (~120–400 diff lines each)** grouped into **2–4 Waves** ending in **Integration Checkpoints**:

- **Keep slices single-surface and file-disjoint:** Split cross-stack features cleanly (`backend/algorithm` → `IPC/persistence/guardrails` → `renderer UI`) so no single session bloats its context window or causes merge conflicts in large files.
- **Mark parallelism explicitly:** Note which slices in a wave can run in parallel worktrees vs which depend on an earlier slice merging into the release branch first.
- **Isolate dependency/lockfile sweeps:** Dependency and lockfile slices MUST run in the main checkout (or an isolated install), never in a worktree with symlinked `node_modules` or `.venv`.
- **Batch expensive gates:** Each slice runs ONLY its 5–15 s focused tests + syntax checks. Run the full suite (`npm run test:all`) once per Wave Checkpoint (2–4 times total, logging verbose output to ignored files).
- **Script mechanical fetches:** For release checksums, Hugging Face SHAs, or API metadata, instruct the slice prompt to run a short script rather than pasting raw JSON into context.

## 3. Route Capability Tiers & Reasoning Levels (Provider-Agnostic)

First assign every build and review step to an abstract **Capability Tier + Reasoning Level**, then map those tiers onto the user's actual subscriptions:

| Tier | Reasoning | Use For |
|---|---|---|
| **Fast / Cheap** | `Low` | Trivial mechanical slices (~100–150 L), pure CSS/copy tweaks, Checkpoint test/doc runners, scripted catalog/notice wiring, routine UI diff reviews, and applying concrete review fixes. |
| **Balanced** *(default ~70%)* | `Medium` | Standard multi-file vertical slices (~200–300 L), UI/renderer wiring, runtime pin integration, and standard diff-only reviews. |
| **Strict / Surgical** | `Medium`–`High` | Strict IPC/schema/persistence contracts, exact math/bounds, fail-closed security gates, supply-chain/allowlist audits, and bug-hunting diff reviews. |
| **Deep Reasoning** *(use sparingly)* | `High` | Concurrency/locking/process-slot races, complex retrieval/routing algorithms, and adversarial guardrail reviews. |

### Subscription Load-Balancing Rules

- **1 subscription:** Balance across its Fast / Balanced / Deep tiers. Run fresh-thread diff-only review using a stronger or stricter tier on medium/high-risk slices only.
- **2 subscriptions (A + B):** Alternate build slices across A and B (~50/50 quota split) and assign **cross-provider** diff-only review (`A builds → B reviews`, `B builds → A reviews`) to catch model blind spots.
- **3+ subscriptions (A + B + C):** Assign natural specialties (e.g., A for deep algorithms/UI, B for strict contracts/backend, C for independent adversarial reviews and quota overflow) so no subscription hits rate limits and high-risk slices get a third-party review.
- **Skip separate AI review** on trivial mechanical slices (~120 L, low risk) — tell the user to eyeball the diff and merge.
- **Never recommend `xhigh` / `Max` thinking** on fixed-quota plans for 200–400 line slices; drop back to **`Low`** thinking whenever pasting review findings back into a builder thread to apply fixes.

## 4. Emit the Sequenced Runbook

Read [references/prompt-templates.md](references/prompt-templates.md) before writing the output so every prompt matches the exact format and token-budget guardrails.

Deliver **one complete, start-to-finish runbook** with **zero unfilled placeholders**:

1. **Step 0 (One-time setup):** Exact git commands to cut/push the release branch, plus an idempotent worktree dependency-symlink snippet if the repo uses gitignored `node_modules`/`.venv` (flagging dependency slices as main-repo-only).
2. **Wave & Routing Summary Table:** Slice ID · Branch · Build (`Provider · Model · Thinking`) · Review (`Provider · Model · Thinking`) · Focused Gate.
3. **Numbered Execution Sequence** interleaving **Build → Review → Merge note → Checkpoint** in exact order:
   - Every **Build Prompt** pins: exact branch cut from the release branch, exact Task/section + exact files/line ranges to read, explicit *"Do not touch unrelated files"*, exact critical edge cases/invariants, exact focused test command (`no test:all`), commit instruction, and `git diff <release>...HEAD --stat` report.
   - Every **Review Prompt** runs in a **fresh thread** and pins: `git diff <release>...<slice-branch>` (excluding lockfiles on dependency sweeps), 3 concrete slice-specific checks, *"Output ONLY `APPROVE` or a numbered list of concrete findings (`file:line` + exact fix)"*, and *"Do not read unrelated files or run tests unless reproducing a bug."*
   - Every **Checkpoint Prompt** runs the full suite once (logging verbose output), updates `todo.md`/status docs, and lists a brief manual/hardware smoke checklist.

## 5. Optional Plan & Status Sync

If the user also asks to persist the execution strategy into the release plan and `todo.md`:
- Add the Wave diagram, Micro-Slice Routing Matrix, and Token-Budget Guardrails to the plan document.
- Update `todo.md` with per-wave slice checkboxes.
- Stage, commit, and push only when explicitly authorized.
