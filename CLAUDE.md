@AGENTS.md

# Claude Code notes

Root `AGENTS.md` is the single source of truth for architecture and invariants. Keep this file thin.

- Cursor-scoped checklists live in `.cursor/rules/*.mdc`. When editing matching areas, read the relevant rule file.
- Shared project skills live in `.agents/skills/*/SKILL.md` (preferred over duplicating into `.claude/skills/`).
- Shared Claude path-scoped rules (optional) may live under `.claude/rules/` and should be committed.
- Personal Claude settings stay in `.claude/settings.local.json` and `CLAUDE.local.md` (gitignored).
- Do not duplicate `AGENTS.md` content here.
