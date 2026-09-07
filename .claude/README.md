# Claude Code adapter

Root `CLAUDE.md` imports `AGENTS.md`. Project skills are relative links to the canonical `.agents/skills/` tree, not copies. Setup, Windows junction fallback and verification are documented in [the agent setup guide](../.agents/README.md).

Personal settings belong in ignored `settings.local.json` and root `CLAUDE.local.md`. Do not add another `.claude/CLAUDE.md`. If path-scoped `.claude/rules/*.md` are introduced, supply `paths` frontmatter; unscoped rules load unconditionally. Keep shared workflow prose in its canonical owner.
