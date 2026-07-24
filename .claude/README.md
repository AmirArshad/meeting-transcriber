# Claude Code project config

Commit-able Claude Code artifacts live here:

- `rules/` — `.md` rules. **A rule without a `paths:` frontmatter field loads on every request**; add `paths:` to scope it to matching files.
- `skills/` — the only place Claude Code discovers project skills. This repo instead keeps skills in `.agents/skills/` and routes to them from root `CLAUDE.md`; see the table there.

Local-only (gitignored): `settings.local.json`, and root `CLAUDE.local.md`.

Entry point is root `CLAUDE.md`, which imports `AGENTS.md`. Do not add a `.claude/CLAUDE.md` as well — both would load.
