# Project agent setup

Root `AGENTS.md` is the canonical always-on guide. Its fixed order is identity, quick commands, repo map, invariants/do-not, working agreements, skills index, deeper-doc paths. Edit it only for explicit instruction work; keep dates, task status, machine paths and generated inventories out. Detailed cross-process rules live in `docs/development/contracts/`; skill bodies load on demand.

## Layout and tools

- **Codex CLI / IDE:** discovers root AGENTS.md and canonical `.agents/skills/*/SKILL.md` natively. Start at the repository root. Use `/skills` to inspect discovery or `$name` to select a skill. Home instructions and skills can also affect the session.
- **Claude Code:** root CLAUDE.md contains the literal `@AGENTS.md` import. `.claude/skills/<name>` links to `../../.agents/skills/<name>`. Restart after bootstrapping, inspect `/context`, and invoke `/name`. Personal skills can override project names; plugins are namespaced. Do not add another `.claude/CLAUDE.md` or copy skill bodies.
- **OpenCode:** reads AGENTS.md and `.agents/skills/` natively. `opencode.json` contains settings/permissions only; do not load Cursor rules through `instructions`. Run `opencode debug skill` to inspect discovery; no model call is needed.
- **Cursor:** reads AGENTS.md and `.agents/skills/` natively. `.cursor/rules/*.mdc` contains only glob-scoped contract/skill pointers. Inspect Customize → Skills after reopening the workspace. No `.cursor/skills/` or `.opencode/skills/` mirrors are needed.

All 16 existing skills remain; the authoritative name/trigger index is in AGENTS.md. Generic routers, forced brainstorming/TDD and browser/MCP packs previously removed from this repo remain absent. This migration creates no new workflow skills. The four explicit-only helpers (`grill-me`, `grill-with-docs`, `handoff`, `to-spec`) keep Claude/Cursor `disable-model-invocation`; Codex uses `agents/openai.yaml` policy. OpenCode ignores that extension, so the canonical index and descriptions also state explicit-only use. This is a workflow instruction, not an access-control boundary.

Use portable name/description/metadata frontmatter. Descriptions are unquoted scalars without colon-space or angle brackets. License and handoff hint metadata remain available; LICENSE.txt files are unchanged. Existing licenses and repo adaptations must survive updates. `skills-lock.json` records upstream provenance; `localModified` is a human warning, not proof that an updater will protect edits. Review upstream changes into the canonical tree, reapply local changes, then rerun setup and validation. Do not run a bulk skills installer that replaces links with copies.

Tool-specific subagent definitions, if needed later, belong separately in `.claude/agents/` and `.opencode/agents/`; their frontmatter is incompatible. Do not symlink those definitions. No such directories are needed now.

## Linux and macOS

From a fresh checkout at the repository root:

```sh
sh scripts/agents/link_skills.sh
sh scripts/agents/link_skills.sh --check
npm ci
python3 scripts/agents/validate_setup.py
python3 scripts/agents/test_link_skills.py
```

The linker requires only POSIX sh, ln, readlink and basic POSIX utilities, including BSD userland. It is idempotent, refuses real directories, repairs exact Git link stubs, removes stale links and detects dangling links. The validator uses Python 3 and the existing npm-installed js-yaml parser. No global skill installer is required. Existing real copies cause a refusal; compare and preserve local edits before removing those copies explicitly.

## Windows native

Preferred: enable Developer Mode (or use an elevated shell), then clone with real symlinks:

```powershell
git -c core.symlinks=true clone https://github.com/AmirArshad/meeting-transcriber.git
Set-Location meeting-transcriber
git config core.symlinks true
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agents/link_skills.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agents/link_skills.ps1 --check
npm ci
py -3.11 scripts/agents/validate_setup.py
py -3.11 scripts/agents/test_link_skills.py
```

In an existing clone, start with `git config core.symlinks true`; the script replaces exact symlink text stubs without rewriting unrelated files. Without symlink privilege the same PowerShell script falls back to directory junctions. For already tracked mode-120000 skill links it sets `git update-index --skip-worktree`; this is local index metadata and stages no content. Untracked links cannot receive that flag; the script warns to rerun after the migration is committed. After pulling added/removed skills, rerun setup and `--check`. Junctions use absolute local targets, so rerun after moving the checkout. To resume Git management of a junction entry, remove that junction only (never recursively delete its target), then run `git update-index --no-skip-worktree -- .claude/skills/<name>` and rerun the linker.

Git Bash's default `ln -s` can copy instead of linking. If using Git Bash with symlink privilege:

```sh
MSYS=winsymlinks:nativestrict sh scripts/agents/link_skills.sh
sh scripts/agents/link_skills.sh --check
```

Use PowerShell checks for junction checkouts; the POSIX check intentionally requires relative symbolic links. Script LF endings are pinned in `.gitattributes`. Git's mode-120000 symlink blobs bypass text/eol conversion; no broad normalization or binary policy was introduced.

## Windows through WSL

Clone on WSL's Linux filesystem and run the Linux commands inside WSL. Linux symlink creation/checking is unaffected when that checkout is viewed from Windows via `\\wsl.localhost\<distribution>\...` (UNC). This does not guarantee a native Windows agent resolves every Linux target; run agents inside WSL for that route. A checkout on `/mnt/c` instead inherits NTFS/DrvFS and Windows link constraints; use the native setup route or move the checkout onto the WSL filesystem.

## Verification and maintenance

Run `python3 scripts/agents/validate_setup.py` (Windows `py -3.11 ...`) and the link tests after changing setup. During this migration only, add `--migration-check` to compare skill bodies and relocated sections with HEAD. It never stages or changes Git content. Restart tool sessions after changes; existing sessions may retain earlier metadata. Global duplicate skills and trust/settings overrides are environment concerns, not something this repo can silently remove.

The [audit](../docs/development/AGENT_SETUP_AUDIT.md) records before/after evidence, preservation hashes, per-tool limits and platform verification gaps. The [implementation plan](../docs/superpowers/plans/2026-09-07-agent-setup.md) cites the live documentation. Prompt-cache hit rate depends on each tool's full prompt construction; this setup reduces stable prefix size but does not claim a measured cache-hit percentage.
