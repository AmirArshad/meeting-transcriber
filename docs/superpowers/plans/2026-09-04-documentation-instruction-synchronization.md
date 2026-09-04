# Documentation and Instruction Synchronization Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Align public documentation, manual checklists, and agent instructions with the completed v2.9 Linux-AI implementation while preserving the pending Windows x64 Task 5 acceptance gate.

**Architecture:** Separate current branch capability from release claims and historical Core Beta evidence. Replace the monolithic always-on agent guide with a compact safety/index layer and path-scoped canonical contracts, while keeping every privacy, security, recorder, packaging, persistence, and platform invariant.

**Tech Stack:** Markdown documentation, JSON configuration, Cursor/Claude/OpenCode instruction routing.

## Global Constraints

- Do not claim Task 5 or the branch is accepted; Windows x64 never-installed Speakrs validation remains required.
- Do not represent an unbuilt v2.9 release artifact as shipped.
- Preserve all hard privacy, token, supply-chain, recorder-control, data-loss, packaging, and platform safeguards.
- Preserve dated Core Beta evidence as historical evidence rather than rewriting it as current behavior.

---

### Task 1: Align public Linux capability and version copy

**Files:**
- Modify: `README.md`
- Modify: `docs/guides/LINUX_EXPERIMENTAL.md`
- Modify: `docs/guides/README.md`

**Implementation:** Describe CPU as the default Linux transcription path and CUDA-only add-ons as conditionally available only after managed CUDA admission. State the CachyOS RTX 4070 evidence boundary, link the compatibility matrix, and keep Task 5 pending Windows x64. Correct the macOS minimum badge and Electron version. Add the Linux guide to the guide index.

**Validation:** Search for obsolete blanket claims that all Linux add-ons are disabled, CPU-only, or lack `speakrs-cli`; retain them only when explicitly labeled v2.8/Core Beta historical evidence.

### Task 2: Reframe historical initiatives and current work tracking

**Files:**
- Modify: `docs/initiatives/LINUX_SUPPORT.md`
- Modify: `docs/initiatives/README.md`
- Modify: `docs/initiatives/ROADMAP.md`
- Modify: `todo.md`
- Modify: `docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`

**Implementation:** Add a current-status banner and an explicit evidence authority to the Linux support plan. Label its old Phase 6–9 proposal as superseded historical planning. Correct roadmap/index claims that Linux and the queue are future work. Retain the authoritative Task 5 and Task 6 statuses in `todo.md` and the matrix, only clarifying historical baselines where needed.

**Validation:** Verify every current Task 5 reference says Windows x64 is the remaining formal gate and no document calls the overall branch accepted.

### Task 3: Synchronize manual QA scope

**Files:**
- Modify: `tests/manual/linux-experimental-beta-checklist.md`
- Modify: `tests/manual/recording-smoke-checklist.md`
- Modify: `tests/manual/local-ai-addons-checklist.md`

**Implementation:** Keep Core Beta capture QA distinct from CUDA/AI add-on QA. Remove universal disabled-add-on expectations from current-branch checklists, point add-on coverage to the local-AI checklist, and add the exact pending Windows Task 5 negative-case instructions.

**Validation:** Search the checklists for stale “Do not start Phases 6–9” and blanket disabled-add-on requirements.

### Task 4: Layer agent instructions without losing safeguards

**Files:**
- Modify: `AGENTS.md`
- Add: `docs/development/contracts/recording.md`
- Add: `docs/development/contracts/local-ai.md`
- Add: `docs/development/contracts/packaging.md`
- Add: `docs/development/contracts/macos-audio.md`
- Add: `docs/development/contracts/meeting-persistence.md`
- Add: `docs/development/contracts/ipc.md`
- Modify: `.cursor/rules/*.mdc`
- Add: `.claude/rules/*.md`
- Modify: `CLAUDE.md`, `.agents/README.md`, `opencode.json`

**Implementation:** Keep AGENTS as a concise always-on safety baseline and contract index. Move detailed operational invariants into the named canonical contracts, and point scoped tool rules to those contracts. Make OpenCode configuration and prose agree about which skills/rules it loads. Keep optional workflow skills distinct from mandatory safety contracts.

**Validation:** Confirm every former AGENTS invariant is present once in AGENTS or a linked contract; verify all new links resolve; inspect instruction configuration and JSON syntax.

### Task 5: Documentation verification

**Files:** all modified documentation and instruction files.

**Implementation:** Run focused searches for stale acceptance and stale Linux capability copy, inspect the final diff, and run JSON parsing for `opencode.json`.

**Validation:** `git diff --check`; `node -e "JSON.parse(require('fs').readFileSync('opencode.json','utf8'))"`; targeted `rg` searches; Markdown link checker if available without fetching network resources.
