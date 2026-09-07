# Agent Setup Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Share cache-stable instructions and on-demand canonical skills across Codex, Claude Code, OpenCode and Cursor without losing safeguards.

**Architecture:** Root AGENTS.md is the sole always-on authority; CLAUDE.md imports it. Existing contracts own detailed rules; canonical skills remain in .agents with Claude links only.

**Tech Stack:** Markdown, portable YAML, POSIX sh, PowerShell, Python validation; existing npm application checks.

## Global Constraints

No commits or staging. No routine delegation. Preserve all procedures, licenses and hard constraints. No volatile values in always-on files. Retain existing sections' content in one maintained owner before deleting old text. Fixed root order is identity, quick commands, repo map, invariants/do-not, working agreements, skills index, deeper-doc paths.

## Verified tool behavior

Live primary documentation fetched before design. Unknown behavior is explicitly unverified, never invented.

| Tool | Instructions / order / budget | Skills / links / duplicates | Frontmatter / imports |
|---|---|---|---|
| Codex | Global override or AGENTS, then root-to-cwd override/AGENTS (one per directory); 32 KiB combined default; start under nested paths to discover their instructions | .agents/skills along cwd-to-root, user .agents, admin/system; follows skill links; equal names can both appear | name and description required; native invocation policy in agents/openai.yaml; no documented instruction include syntax |
| Claude Code | Managed/user and ancestor CLAUDE.md plus local overlays; root-to-cwd concatenation; descendant files on read; unscoped rules startup, paths rules conditional; target <200 lines, skips files >4 MiB | Project/user .claude/skills, enterprise/plugins; follows links and deduplicates real targets; enterprise > personal > project, plugins namespaced | name/description plus documented extensions including argument-hint and disable-model-invocation; literal @AGENTS.md imports at launch, up to five levels |
| OpenCode | Local upward AGENTS preferred over CLAUDE; global config AGENTS before Claude fallback; instructions config adds unconditional text; no documented fixed byte cap | .agents/.claude/.opencode skills along cwd-to-worktree plus global directories; live binary lists 16 project skills; duplicate/link probes recorded below | name/description required, license/compatibility/metadata recognized, unknown fields ignored; no automatic @file imports; config instructions supports globs/URLs |
| Cursor | Root/nested AGENTS and user/team rules; scoped .mdc attaches by glob; nested rules more specific; no documented fixed byte cap or total ordering across all sources | .agents/.cursor plus .claude/.codex compatibility roots, global equivalents; duplicate-name and symlink semantics not specified on fetched page | name/description required; paths, disable-model-invocation, icon, color, metadata documented; .mdc @filename references; undocumented field rejection is unverified |

Sources: [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Claude memory](https://code.claude.com/docs/en/memory), [Claude skills](https://code.claude.com/docs/en/skills), [OpenCode rules](https://opencode.ai/docs/rules/), [OpenCode skills](https://opencode.ai/docs/skills/), [Cursor rules](https://cursor.com/docs/rules), [Cursor skills](https://cursor.com/docs/skills).

Use name/description/metadata everywhere, retain disable-model-invocation only for existing explicit-only skills (Claude/Cursor honor it, OpenCode ignores it; Codex uses native policy). Move handoff argument hint into metadata/body so it survives portably; license file remains intact and metadata points to it. No claim that every unknown field is rejected/ignored identically.

### Task 1: Audit and content ledger

Files: docs/development/AGENT_SETUP_AUDIT.md, this plan. Inventory tracked instruction/support files, inspect manifest commands, scan all references. Record before editing. Map old root sections to existing contracts with exact text comparisons; retain recent contract-only changes.

### Task 2: Canonical content and adapters

Files: AGENTS.md, CLAUDE.md, existing contracts, BACKEND.md, TESTING.md, .cursor/rules, opencode.json, .agents/README.md, .claude/README.md, README.md, archive README/references, skills frontmatter, skills-lock.json. Preserve 16 skill bodies; normalize frontmatter and manual invocation policy. Rename the archived CLAUDE.md to an inert name without staging. Do not use git mv because the user's no-staging constraint takes priority and no skill location changes.

### Task 3: Portable discovery setup

Files: scripts/agents/link_skills.sh, link_skills.ps1, validation script/tests, .gitignore, .gitattributes, .claude/skills links. Refuse real dirs, repair expected stubs, remove stale links, verify exact target and resolved SKILL.md. PowerShell falls back to junctions and sets skip-worktree on tracked symlink entries. Test missing, wrong, dangling, stale, real-directory and spaced-path cases in temporary fixtures.

### Task 4: Verification and bug review

Check skill frontmatter/index, preservation ledger, all links and references, no unconditional Cursor rules/config clones, clean index. Run syntax and relevant tests; run full npm test:all if available for final evidence. Run installed OpenCode debug discovery without model calls; test aliases and duplicate names in isolated fixtures. Review scripts for failure cleanup and Windows path handling. Report macOS/native Windows execution as untested if unavailable; do not infer hardware acceptance.
