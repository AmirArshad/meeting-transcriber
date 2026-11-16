# Project agent setup

Root `AGENTS.md` is the canonical always-on guide. Its fixed order is identity, quick commands, repo map, invariants/do-not, working agreements, skills index, deeper-doc paths. Edit it only for explicit instruction work; keep dates, task status, machine paths and generated inventories out. Detailed cross-process rules live in `docs/development/contracts/`; skill bodies load on demand.

## Layout and tools

- **Codex CLI / IDE:** discovers root AGENTS.md and canonical `.agents/skills/*/SKILL.md` natively. Start at the repository root. Use `/skills` to inspect discovery or `$name` to select a skill. Home instructions and skills can also affect the session.
- **Claude Code:** root CLAUDE.md contains the literal `@AGENTS.md` import. `.claude/skills/<name>` links to `../../.agents/skills/<name>`. Restart after bootstrapping, inspect `/context`, and invoke `/name`. Personal skills can override project names; plugins are namespaced. Do not add another `.claude/CLAUDE.md` or copy skill bodies.
- **OpenCode:** reads AGENTS.md and `.agents/skills/` natively. `opencode.json` contains settings/permissions only; do not load Cursor rules through `instructions`. Run `opencode debug skill` to inspect discovery; no model call is needed.
- **Cursor:** reads AGENTS.md and `.agents/skills/` natively. `.cursor/rules/*.mdc` contains only glob-scoped contract/skill pointers. Inspect Customize → Skills after reopening the workspace. No `.cursor/skills/` or `.opencode/skills/` mirrors are needed.

All 16 skills remain; the authoritative trigger index is in AGENTS.md. Generic routers and forced brainstorming/TDD packs are absent from the repo, but personal plugins can reintroduce them. The five explicit-only helpers (`grill-me`, `grill-with-docs`, `handoff`, `to-spec`, `finishing-a-development-branch`) use `disable-model-invocation` and Codex `agents/openai.yaml` policy. Keep explicit triggers in descriptions and the index too; tool support varies. These controls are workflow guidance, not an access-control boundary.

Use portable name/description/metadata frontmatter. Descriptions are unquoted scalars without colon-space or angle brackets. License and handoff hint metadata remain available; LICENSE.txt files are unchanged. Existing licenses and repo adaptations must survive updates. `skills-lock.json` records upstream provenance; `localModified` is a human warning, not proof that an updater will protect edits. Review upstream changes into the canonical tree, reapply local changes, then rerun setup and validation. Do not run a bulk skills installer that replaces links with copies.

Tool-specific subagent definitions, if needed later, belong separately in `.claude/agents/` and `.opencode/agents/`; their frontmatter is incompatible. Do not symlink those definitions. No such directories are needed now.

## Low-overhead Codex setup

Recent repo-specific sessions loaded `superpowers@openai-curated-remote` from the personal plugin cache, including a mandatory skill router, brainstorming and TDD. That duplicates and conflicts with the adapted project workflows. Use the project override in [`.codex/config.example.toml`](../.codex/config.example.toml): merge its plugin table into your ignored `.codex/config.toml`, preserving existing settings. Do not replace your file or edit the plugin cache.

```toml
[plugins."superpowers@openai-curated-remote"]
enabled = false
```

[Codex documents project plugin overrides](https://developers.openai.com/plugins/build/plugins#enable-or-disable-a-plugin-for-a-repo) for trusted projects. Restart Codex in this checkout and inspect `/plugins` and `/skills` to confirm the duplicate workflow is absent and project skills remain. This does not uninstall the plugin or change other repositories. A different marketplace ID or enforced workspace policy needs its own matching setting. Existing sessions can retain loaded instructions; a valid TOML file alone is not runtime-discovery proof. Keep machine sandbox, model and authentication settings out of Git.

## Build and context discipline

- Read root instructions once. Search filenames/symbols first, then relevant ranges. The 85 KB v2.11 plan and 0.7–1.3 MB Parakeet lockfiles are on-demand data, not startup instructions. Use plan headings/current status and JSON key queries instead of whole-file reads. Keep global constraints and applicable contracts in scope.
- Run focused checks during edits. One lead owns the integrated full suite and each installer; authorized workers run only their scoped checks. Reuse results until the tested inputs change. `npm test` already includes JS syntax, and `npm run test:all` includes `npm test`, Python regression and Python syntax.
- A build process consumes machine resources; model usage comes from the turns, reasoning, output/context and workers around it. Wait for completion notifications or use a suitably long blocking wait, rather than repeatedly asking for a few more log lines.
- Capture verbose output in ignored `logs/`, retain the exit code, and inspect a summary plus relevant failure context. Never treat the success of `tail`/`Get-Content` as the build result. Use a distinct log per run. For example, in Bash:

  ```bash
  mkdir -p logs
  log="logs/build-linux-$(date +%Y%m%d-%H%M%S)-$$.log"
  if npm run build:linux > "$log" 2>&1; then
    result=0
  else
    result=$?
  fi
  tail -n 60 "$log"
  exit "$result"
  ```

  Or Windows PowerShell:

  ```powershell
  New-Item -ItemType Directory -Force logs | Out-Null
  $log = "logs/build-windows-$(Get-Date -Format yyyyMMdd-HHmmss)-$PID.log"
  npm run build *> $log
  $result = $LASTEXITCODE
  Get-Content $log -Tail 60
  exit $result
  ```

- Keep prepared-resource integrity checks and native build caches. `prepare-build` already cleans `dist/`, and the resource manifest invalidates stale runtime inputs. Do not add routine cache deletion or overlapping builds. Use `build:dir` (Windows), `build:mac:dir` or `build:linux:dir` on the matching host when only an unpacked app is needed; installer acceptance still requires actual installers.
- For instruction-only changes, run the setup checks below. Do not build installers to validate Markdown. Application changes and all PRs retain their root-guide gates.

## Linux and macOS

From a fresh checkout at the repository root:

```sh
sh scripts/agents/link_skills.sh
sh scripts/agents/link_skills.sh --check
npm ci
python3 scripts/agents/validate_setup.py
python3 -m unittest scripts.agents.test_validate_setup scripts.agents.test_link_skills
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
py -3.11 -m unittest scripts.agents.test_validate_setup scripts.agents.test_link_skills
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

Run `python3 scripts/agents/validate_setup.py` (Windows `py -3.11 ...`) and the setup/link tests after changing instructions. The validator enforces an 8 KiB root guide, 3 KiB per core workflow skill and 12 KiB combined workflow budget, and checks manual invocation policies with real YAML parsing. Other domain resources stay on demand. The legacy `--migration-check` is only for the original relocation against its pre-migration HEAD; it deliberately rejects skill-body edits and is not a routine gate. Restart tool sessions after changes; existing sessions may retain earlier metadata.

The [audit](../docs/development/AGENT_SETUP_AUDIT.md) records before/after evidence, preservation hashes, per-tool limits and platform verification gaps. The [implementation plan](../docs/superpowers/plans/2026-09-07-agent-setup.md) cites the live documentation. Prompt-cache hit rate depends on each tool's full prompt construction; this setup reduces stable prefix size but does not claim a measured cache-hit percentage.

The follow-up [usage audit](../docs/development/AGENT_USAGE_AUDIT.md) separates observed session amplification from potential causes and records the current improvements.
