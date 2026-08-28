# Project Agent Skills

Skills are folders with a `SKILL.md` (Agent Skills open standard).

**Discovery is not uniform — verify before assuming.** Claude Code does **not** scan `.agents/skills/`; its skill paths are `.claude/skills/`, `~/.claude/skills/`, plugins, and enterprise locations. Root `CLAUDE.md` therefore carries a small router table for the general project-skill set. The official `frontend-design` skill is the deliberate exception: `npx skills` copies its upstream body to both `.agents/skills/frontend-design/` and `.claude/skills/frontend-design/`, a scoped Cursor router loads the canonical copy for `src/renderer/**`, and OpenCode reads both the canonical skill path and the router via its committed configuration.

This repo keeps a **lean** set on purpose: avoid skills that auto-invoke on every turn or force heavy workflows (those burn tokens hard, especially on large models).

## Installed (kept)

| Skill | Why |
| --- | --- |
| `writing-plans` / `executing-plans` / `finishing-a-development-branch` | Multi-step work without always-on tax |
| `verification-before-completion` | Evidence before “done” claims |
| `systematic-debugging` | Root-cause debugging when something breaks |
| `requesting-code-review` | Structured review requests |
| `gh-fix-ci` / `gh-address-comments` | PR CI + review comment loops |
| `security-best-practices` / `security-threat-model` | Explicit security reviews only |
| `grill-me` / `grill-with-docs` / `handoff` / `to-spec` | Manual-only (`disable-model-invocation`) planning helpers |
| `skill-creator` | Author new project skills when needed |
| `frontend-design` | Official Anthropic guidance for deliberate visual-system and renderer UI work |

## Intentionally removed

Aggressive Superpowers routers (`using-superpowers`, `brainstorming`, forced TDD), browser/MCP packs, and other high auto-trigger / large-body skills. Re-add surgically later if a workflow needs them.

Provenance: root `skills-lock.json`. Refresh kept skills with `npx skills update` when desired.

Do not duplicate the general skill tree into `.claude/skills/` or `.cursor/skills/`. The vetted `frontend-design` copy is the one exception because direct Claude discovery is a stated cross-tool requirement; update it only with `npx skills update frontend-design --project --yes` so both official copies and `skills-lock.json` remain aligned. Cursor uses a short router instead of a second body copy.

## Local modifications vs upstream

Every skill here is vendored, with an upstream `computedHash` in root `skills-lock.json`. Editing one breaks that hash and `npx skills update` will overwrite the edit. Locally modified skills are marked `"localModified": true` in the lock file — re-apply those changes by hand after any update.
