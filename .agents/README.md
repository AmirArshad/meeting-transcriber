# Project Agent Skills

Skills are folders with a `SKILL.md` (Agent Skills open standard).

**Discovery is not uniform — verify before assuming.** Claude Code does **not** scan `.agents/skills/`; its skill paths are `.claude/skills/`, `~/.claude/skills/`, plugins, and enterprise locations (confirmed against its docs, and by the repo's skills being absent from a live session's skill list). Root `CLAUDE.md` therefore carries a small router table that names each skill file for Claude Code to Read. Cursor and OpenCode discovery of this path has **not** been verified in this repo — if a skill silently never fires in one of them, that is the first thing to check.

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

## Intentionally removed

Aggressive Superpowers routers (`using-superpowers`, `brainstorming`, forced TDD), browser/MCP packs, and other high auto-trigger / large-body skills. Re-add surgically later if a workflow needs them.

Provenance: root `skills-lock.json`. Refresh kept skills with `npx skills update` when desired.

Do not duplicate this tree into `.claude/skills/` or `.cursor/skills/`. Duplicating ~10k words of skill bodies costs nothing in always-on context (bodies load on demand) but guarantees drift between two copies. The router table in root `CLAUDE.md` is the cheaper fix.

## Local modifications vs upstream

Every skill here is vendored, with an upstream `computedHash` in root `skills-lock.json`. Editing one breaks that hash and `npx skills update` will overwrite the edit. Locally modified skills are marked `"localModified": true` in the lock file — re-apply those changes by hand after any update.
