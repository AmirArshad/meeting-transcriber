@AGENTS.md

# Claude Code notes

`AGENTS.md` (imported above) is the single home for architecture, invariants, and change checklists. Do not duplicate it here.

## Project skills — Claude Code cannot auto-discover them

**Verified:** Claude Code discovers skills only from `.claude/skills/`, `~/.claude/skills/`, plugins, and enterprise paths. It does **not** scan the general `.agents/skills/` tree, so the skills in the table below must be opened with Read. The official `frontend-design` skill is also directly installed at `.claude/skills/frontend-design/SKILL.md` and can be discovered normally for renderer visual work.

When a task below matches, read the file, then follow it:

| Read this file | When |
|---|---|
| `.agents/skills/systematic-debugging/SKILL.md` | Any bug, test failure, or unexpected behavior — before proposing a fix |
| `.agents/skills/verification-before-completion/SKILL.md` | Before claiming work is complete, fixed, or passing |
| `.agents/skills/writing-plans/SKILL.md` | A spec or multi-step task exists and no plan is written yet |
| `.agents/skills/executing-plans/SKILL.md` | A written plan exists and you are implementing it |
| `.agents/skills/finishing-a-development-branch/SKILL.md` | Implementation done and tests pass; deciding merge vs PR vs cleanup |
| `.agents/skills/requesting-code-review/SKILL.md` | A targeted review would materially reduce risk |
| `.agents/skills/gh-fix-ci/SKILL.md` | Debugging failing GitHub Actions checks on a PR |
| `.agents/skills/gh-address-comments/SKILL.md` | Working through review or issue comments on a PR |
| `.agents/skills/security-best-practices/SKILL.md` | The user explicitly asks for a security best-practices review |
| `.agents/skills/security-threat-model/SKILL.md` | The user explicitly asks to threat model the repo or a path |
| `.agents/skills/skill-creator/SKILL.md` | Authoring or updating a project skill |
| `.claude/skills/frontend-design/SKILL.md` | Visual-system, layout, CSS, or HTML work under `src/renderer/` |

On explicit request only — never auto-invoke: `grill-me`, `grill-with-docs`, `handoff`, `to-spec` (all under `.agents/skills/<name>/SKILL.md`).

Rationale for keeping the tree at `.agents/skills/` and paying for this router: Cursor and OpenCode read it there, and one router beats a duplicated 10k-word skill tree. See `.agents/README.md`.

## Claude-specific config

- `.claude/rules/*.md` are supported when present. **Gotcha:** a rule file **without** a `paths:` frontmatter field loads on *every* request. Always add `paths:` unless you genuinely want it always-on.
- `.cursor/rules/*.mdc` are **not** read by Claude Code. They are thin pointers into `AGENTS.md` anyway, so nothing is missing.
- Personal settings stay in `.claude/settings.local.json` and `CLAUDE.local.md` (both gitignored).
