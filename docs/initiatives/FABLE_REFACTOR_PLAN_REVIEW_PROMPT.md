Review the AvaNevis codebase refactor plan and approach. Be critical: look for missing risks, over-scoping, wrong phase order, weak gates, and places where “behavior-preserving extraction” is likely to fail in practice.

> **Historical prompt (pre-merge).** Captured for the Fable review before Phase 0 on branch `refactor/codebase-phase-0`. The refactor is **complete** (2026-07-09); see `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md` Status and root `todo.md`. Do not treat the branch/line-count context below as current.

## Context
AvaNevis is a privacy-first Electron + Python desktop app (Windows + Apple Silicon macOS) for local meeting recording/transcription. Hotspots *at review time* were huge orchestration files (~5k-line main.js / app.js, ~3k ai-addon-setup.js, ~1.7k main-process-helpers.js). We want safer maintainability without changing product behavior.

We are on branch `refactor/codebase-phase-0`. Next intended work is Phase 0 characterization tests, then phased extractions. Multi-tool agent guidance is wired via root `AGENTS.md` (Cursor / OpenCode / Claude Code via thin `CLAUDE.md` `@AGENTS.md`).

## Primary docs to read
1. `docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md` — full design (goals, non-goals, invariants, extraction patterns, Phases 0–8, exit checklist)
2. `todo.md` — at review time, active sequencing under “Next: AvaNevis Codebase Refactor” (now marked complete; residual smoke debt remains)
3. `AGENTS.md` — especially invariants for recorder stdout JSON, IPC, compute queue membership/timeouts, AI add-ons, meeting metadata, packaging

Skim only as needed for risk judgment: `src/main.js`, `src/renderer/app.js`, `src/preload.js`, `src/main-process-helpers.js`, `src/ai-addon-setup.js`, `backend/meeting_manager.py`.

## Project skills (use sparingly)
Skills live in `.agents/skills/*/SKILL.md`. This repo keeps a lean set to avoid token burn. Load a skill only if it clearly improves the review — do not chain skills or invent work to exercise them.

Useful if needed:
- `grill-me` / `grill-with-docs` — pressure-test the plan (manual-style skills)
- `writing-plans` / `verification-before-completion` — plan quality and exit gates
- `security-best-practices` / `security-threat-model` — only if you find concrete security risks in the split plan
- `requesting-code-review` — structure of your review output
- `skill-creator` — only if you recommend a new AvaNevis-specific skill
- `handoff` — only if you produce a handoff doc for a follow-up implementation session

Do not load browser/MCP/TDD/superpowers-style workflows; they are not installed.

## What I want from you
1. Verdict: is this plan sound enough to execute as written, or should we change course before Phase 0?
2. Biggest risks / failure modes (especially Phase 0 → 3 → 7 gating).
3. Phase order critique: what should move earlier/later, what can parallelize safely, what is too ambitious for one PR.
4. Characterization-test gaps: what Phase 0 should lock down that the doc under-specifies.
5. Extraction-pattern critique: facade + verbatim move — where that breaks down in Electron/renderer/Python here.
6. Concrete recommendations: keep / change / drop / add (prioritized).
7. A short “do this first” checklist for Phase 0 only.
8. Optional: which installed project skills (if any) you actually used and whether we should add AvaNevis-specific skills (e.g. recorder-contract, refactor-phase, validate).

## Constraints to respect in your review
- One phase per PR unless purely mechanical
- Move code first; don’t mix with features, dependency upgrades, IPC renames, recorder contract changes, or packaging changes
- Preserve IPC names/shapes, recorder stdout JSON control flow, post-stop mix architecture, local-only AI add-ons, compute-queue membership
- Abort/revert on contract or smoke regressions rather than fix-forward
- Target: no source file over ~1,500 lines after its owning phase
- Prefer a concise review; do not dump large skill bodies into the answer

Do not implement anything. Review only.
