# Project Agent Skills

Skills are folders with a `SKILL.md` (Agent Skills open standard). Agents discover them from `.agents/skills/` — nothing else is required beyond having the files in the repo.

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

Do not duplicate this tree into `.claude/skills/` or `.cursor/skills/` unless a tool fails to see `.agents/skills/`.
