# Agent setup audit and migration evidence

Baseline inventory, captured before edits. Tokens are a bytes/4 estimate, not a tokenizer measurement. All listed entries are files; no nested application package instruction boundaries are needed. Electron, Python, Rust and Swift form one shipped application, not independently governed monorepo packages.

## Verified discovery and design

See the implementation plan for live documentation sources, discovery decisions, and limitations. Installed binaries: Codex CLI 0.153.4, Claude Code 2.1.263, OpenCode 1.18.29, Cursor Agent 2026.09.02-c22c1a3. `opencode debug skill` found all 16 project skills plus one built-in before edits. Runtime log/cache paths were redirected to temporary XDG directories because the sandbox cannot write the user's default log directory. No model invocation or repository upload was needed.

## Baseline inventory

| Path | Bytes | Approx tokens | Reader today | Tracked |
|---|---:|---:|---|---|
| `package.json` | 8854 | 2214 | On demand only | yes |
| `README.md` | 26894 | 6724 | On demand only | yes |
| `CLAUDE.md` | 2820 | 705 | Claude startup | yes |
| `AGENTS.md` | 45273 | 11319 | Codex, Cursor, OpenCode; Claude import | yes |
| `tests/fixtures/README.md` | 430 | 108 | On demand only | yes |
| `swift/AudioCaptureHelper/Package.swift` | 997 | 250 | On demand only | yes |
| `skills-lock.json` | 4118 | 1030 | On demand only | yes |
| `requirements.txt` | 790 | 198 | On demand only | yes |
| `requirements-windows.txt` | 1110 | 278 | On demand only | yes |
| `requirements-windows-build.txt` | 934 | 234 | On demand only | yes |
| `requirements-macos.txt` | 1035 | 259 | On demand only | yes |
| `requirements-macos-build.txt` | 2182 | 546 | On demand only | yes |
| `requirements-linux.txt` | 950 | 238 | On demand only | yes |
| `requirements-linux-build.txt` | 844 | 211 | On demand only | yes |
| `requirements-dev.txt` | 56 | 14 | On demand only | yes |
| `requirements-common.txt` | 342 | 86 | On demand only | yes |
| `opencode.json` | 246 | 62 | On demand only | yes |
| `native/speakrs-cli/Cargo.toml` | 1034 | 259 | On demand only | yes |
| `.agents/skills/writing-plans/plan-document-reviewer-prompt.md` | 1713 | 429 | On demand only | yes |
| `.agents/skills/writing-plans/SKILL.md` | 4923 | 1231 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.claude/skills/frontend-design/SKILL.md` | 8260 | 2065 | Claude/Cursor/OpenCode discovery (duplicate) | yes |
| `.agents/skills/verification-before-completion/SKILL.md` | 4201 | 1051 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.claude/skills/frontend-design/LICENSE.txt` | 10174 | 2544 | On demand only | yes |
| `.claude/README.md` | 604 | 151 | On demand only | yes |
| `.agents/skills/to-spec/SKILL.md` | 3073 | 769 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.cursor/rules/validation-and-ci.mdc` | 726 | 182 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/transcription-model-cache.mdc` | 717 | 180 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/renderer-patterns.mdc` | 664 | 166 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/recorder-stdout-contract.mdc` | 738 | 185 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/python-backend.mdc` | 564 | 141 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/meeting-metadata.mdc` | 672 | 168 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/macos-swift-helper.mdc` | 690 | 173 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/local-ai-addons.mdc` | 758 | 190 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/frontend-design-skill.mdc` | 534 | 134 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/electron-ipc.mdc` | 665 | 167 | OpenCode startup; Cursor matching paths | yes |
| `.cursor/rules/cursor-workspace.mdc` | 1685 | 422 | OpenCode startup; Cursor startup | yes |
| `.cursor/rules/build-packaging.mdc` | 586 | 147 | OpenCode startup; Cursor matching paths | yes |
| `.agents/skills/finishing-a-development-branch/merge-locally.md` | 1286 | 322 | On demand only | yes |
| `.agents/skills/finishing-a-development-branch/discard.md` | 1050 | 263 | On demand only | yes |
| `.agents/skills/finishing-a-development-branch/SKILL.md` | 6422 | 1606 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `docs/README.md` | 2710 | 678 | On demand only | yes |
| `docs/completed/README.md` | 1274 | 319 | On demand only | yes |
| `.agents/skills/systematic-debugging/test-pressure-3.md` | 2692 | 673 | On demand only | yes |
| `.agents/skills/systematic-debugging/test-pressure-2.md` | 2283 | 571 | On demand only | yes |
| `.agents/skills/systematic-debugging/test-pressure-1.md` | 1900 | 475 | On demand only | yes |
| `.agents/skills/systematic-debugging/test-academic.md` | 653 | 164 | On demand only | yes |
| `.agents/skills/systematic-debugging/root-cause-tracing.md` | 5316 | 1329 | On demand only | yes |
| `.agents/skills/systematic-debugging/find-polluter.sh` | 1528 | 382 | On demand only | yes |
| `.agents/skills/systematic-debugging/defense-in-depth.md` | 3650 | 913 | On demand only | yes |
| `.agents/skills/systematic-debugging/condition-based-waiting.md` | 3516 | 879 | On demand only | yes |
| `.agents/skills/systematic-debugging/condition-based-waiting-example.ts` | 5054 | 1264 | On demand only | yes |
| `.agents/skills/systematic-debugging/SKILL.md` | 10007 | 2502 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/systematic-debugging/CREATION-LOG.md` | 4257 | 1065 | On demand only | yes |
| `docs/initiatives/README.md` | 2046 | 512 | On demand only | yes |
| `.agents/skills/executing-plans/SKILL.md` | 2077 | 520 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `docs/completed/todo-archives/README.md` | 429 | 108 | On demand only | yes |
| `.agents/README.md` | 2776 | 694 | On demand only | yes |
| `docs/completed/audits/README.md` | 321 | 81 | On demand only | yes |
| `.agents/skills/grill-me/SKILL.md` | 147 | 37 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `docs/completed/archive/CLAUDE.md` | 18638 | 4660 | Claude on descendant file read or launch here (hazard) | yes |
| `.agents/skills/skill-creator/SKILL.md` | 18664 | 4666 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/skill-creator/LICENSE.txt` | 11358 | 2840 | On demand only | yes |
| `docs/guides/README.md` | 442 | 111 | On demand only | yes |
| `.agents/skills/gh-address-comments/SKILL.md` | 1278 | 320 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/gh-address-comments/LICENSE.txt` | 11357 | 2840 | On demand only | yes |
| `.agents/skills/skill-creator/scripts/quick_validate.py` | 3293 | 824 | On demand only | yes |
| `.agents/skills/skill-creator/scripts/init_skill.py` | 14483 | 3621 | On demand only | yes |
| `.agents/skills/skill-creator/scripts/generate_openai_yaml.py` | 6614 | 1654 | On demand only | yes |
| `.agents/skills/gh-address-comments/scripts/fetch_comments.py` | 6537 | 1635 | On demand only | yes |
| `.agents/skills/skill-creator/agents/openai.yaml` | 192 | 48 | On demand only | yes |
| `.agents/skills/skill-creator/references/openai_yaml.md` | 2130 | 533 | On demand only | yes |
| `.agents/skills/gh-address-comments/agents/openai.yaml` | 303 | 76 | On demand only | yes |
| `.agents/skills/security-threat-model/references/security-controls-and-assets.md` | 1680 | 420 | On demand only | yes |
| `.agents/skills/security-threat-model/references/prompt-template.md` | 12642 | 3161 | On demand only | yes |
| `.agents/skills/gh-fix-ci/SKILL.md` | 3651 | 913 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/gh-fix-ci/LICENSE.txt` | 10776 | 2694 | On demand only | yes |
| `.agents/skills/gh-fix-ci/scripts/inspect_pr_checks.py` | 15222 | 3806 | On demand only | yes |
| `.agents/skills/security-best-practices/references/python-flask-web-server-security.md` | 31748 | 7937 | On demand only | yes |
| `.agents/skills/security-best-practices/references/python-fastapi-web-server-security.md` | 44926 | 11232 | On demand only | yes |
| `.agents/skills/security-best-practices/references/python-django-web-server-security.md` | 38661 | 9666 | On demand only | yes |
| `.agents/skills/security-best-practices/references/javascript-typescript-vue-web-frontend-security.md` | 31445 | 7862 | On demand only | yes |
| `.agents/skills/security-best-practices/references/javascript-typescript-react-web-frontend-security.md` | 41686 | 10422 | On demand only | yes |
| `.agents/skills/security-best-practices/references/javascript-typescript-nextjs-web-server-security.md` | 43423 | 10856 | On demand only | yes |
| `.agents/skills/security-best-practices/references/javascript-jquery-web-frontend-security.md` | 33581 | 8396 | On demand only | yes |
| `.agents/skills/security-best-practices/references/javascript-general-web-frontend-security.md` | 38638 | 9660 | On demand only | yes |
| `.agents/skills/security-best-practices/references/javascript-express-web-server-security.md` | 49357 | 12340 | On demand only | yes |
| `.agents/skills/security-best-practices/references/golang-general-backend-security.md` | 38659 | 9665 | On demand only | yes |
| `.agents/skills/frontend-design/SKILL.md` | 8260 | 2065 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/frontend-design/LICENSE.txt` | 10174 | 2544 | On demand only | yes |
| `.agents/skills/security-threat-model/agents/openai.yaml` | 254 | 64 | On demand only | yes |
| `.agents/skills/security-threat-model/SKILL.md` | 5561 | 1391 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/security-threat-model/LICENSE.txt` | 10776 | 2694 | On demand only | yes |
| `.gitignore` | 810 | 203 | On demand only | yes |
| `.agents/skills/gh-fix-ci/agents/openai.yaml` | 302 | 76 | On demand only | yes |
| `backend/requirements.txt` | 310 | 78 | On demand only | yes |
| `.agents/skills/security-best-practices/LICENSE.txt` | 10776 | 2694 | On demand only | yes |
| `.agents/skills/security-best-practices/SKILL.md` | 8612 | 2153 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/security-best-practices/agents/openai.yaml` | 237 | 60 | On demand only | yes |
| `.agents/skills/requesting-code-review/code-reviewer.md` | 5213 | 1304 | On demand only | yes |
| `.agents/skills/grill-with-docs/SKILL.md` | 245 | 62 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/requesting-code-review/SKILL.md` | 2787 | 697 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.agents/skills/handoff/SKILL.md` | 879 | 220 | Codex/Cursor/OpenCode discovery; Claude manual router | yes |
| `.github/workflows/ci.yml` | 15106 | 3777 | On demand only | yes |
| `.github/workflows/build-release.yml` | 15361 | 3841 | On demand only | yes |
| `.opencode/FAST_DEFAULTS.md` | 311 | 78 | OpenCode startup | yes |

Absent: AGENTS.override.md, nested AGENTS.md, CLAUDE.local.md, .claude/rules, .claude/agents, shared Claude settings, .cursor/skills, .cursorrules, .opencode/skills, .opencode/agents, .codex/skills, .github/copilot-instructions.md, .mcp.json, .gitattributes, CONTRIBUTING, GETTING-STARTED, pyproject.toml, Makefile, justfile, turbo/nx, Docker Compose. Personal ignored overlays are not an instruction authority for this migration. No secret contents were inspected.

## Conflicts and disposition before editing

- AGENTS.md was 45,273 bytes / approximately 11,319 tokens, including a 35+ KB HTML comment. Codex documents a 32 KiB default instruction budget. Existing contract files total only about 5.5 KB; the comment is not an exact duplicate. Preserve every detailed section in its corresponding canonical contract before removing the comment.
- `.agents/README.md` says “Do not duplicate the general skill tree” but permits a frontend copy. The two frontend SKILL.md files and licenses are byte-identical (verify with the content checker); replace that copy with a link. No canonical skills move or disappear, so `git mv` is unnecessary for skills.
- Root AGENTS.md says OpenCode does not load the general skill tree. Installed `opencode debug skill` lists all 16 canonical skills. Correct the discovery documentation.
- `opencode.json` loads `.cursor/rules/*.mdc` via `instructions`; `.cursor/rules/cursor-workspace.mdc` says root AGENTS.md is already in context. Remove that extra unconditional loading and the duplicate workspace router. Keep permissions and output limits.
- `.opencode/FAST_DEFAULTS.md` says its rules already live in AGENTS.md. Remove it and its sole configuration reference; preserve work-inline and small-test-first in AGENTS.md.
- Cursor routers refer to headings inside the root HTML comment. Point them to real contract files; move their unique validation/doc-map guidance to human docs.
- `docs/completed/archive/CLAUDE.md` claims it is “not auto-loaded by any tool”. Claude's documented descendant loading contradicts that. Rename it to AGENT_GUIDE.md and preserve its historical body, with a corrected archive warning.
- Manual-only skill knobs are not enforced by OpenCode. Preserve explicit-request triggers in descriptions and AGENTS.md; keep Claude/Cursor invocation control and add Codex native invocation policy. Retain all existing procedures and licenses.

## Always-on versus on-demand

Keep identity, verified commands, repo map, privacy/data-integrity boundaries, platform gates, stable interfaces, working agreements and a 16-entry skill index always-on. Move detailed recorder, IPC, AI/queue/cache, persistence, Swift and packaging rules to their existing contracts. Put renderer/Python conventions in BACKEND.md and ipc.md; detailed validation in TESTING.md. Keep historical acceptance dates and detector detail in on-demand platform contract guidance. Do not manufacture generic skills or per-package AGENTS.md files.

## Planned tree

AGENTS.md; CLAUDE.md import; .agents/skills/* canonical; .claude/skills/* relative links; existing glob-only .cursor/rules; opencode.json settings only; scripts/agents/link_skills.sh and link_skills.ps1 plus validation; .agents/README.md setup guide; existing contracts expanded; audit and plan in docs. No extra .cursor/.opencode skills trees.

## Cross-platform risks

Use POSIX sh without GNU-only readlink -f/find predicates; explicit LF for sh. Native Windows requires symlink privileges or PowerShell junction fallback. Recognize Git symlink text stubs only when their exact expected content matches. Refuse real directory replacement, handle dangling entries without trailing-slash globs, and never recurse through links during cleanup. Junction skip-worktree state is local and only possible after links are tracked. WSL Linux-filesystem checkouts keep real symlinks even when accessed over UNC; separate this from native tools resolving Linux absolute targets.

## Working defaults

- Work inline. Do not delegate routine inspection, small edits, focused tests, or plan self-review to a subagent. Ask before launching one; reserve it for an explicitly requested independent review or a genuinely high-risk cross-process, concurrency, persistence, packaging, security, or platform boundary.
- Do not re-review work after feedback unless a material change introduced new risk.
- Keep plans concise and file-level. Add per-step TDD scripts, commit instructions, or handoff workflow only when asked or when the behavior is high-risk.
- Prefer extracting behind stable interfaces over rewriting flows; keep platform differences explicit rather than abstracted away; preserve the intentional graceful degradation in handlers rather than hard-failing.
- When simplifying, preserve current operational behavior first, then reduce complexity.
- Trust runtime scripts and CI over stale docs. When docs disagree with this file on a cross-process contract, this file wins. Inspect both the Electron and Python side before changing any cross-process contract.

## Documentation map retained from workspace router

| Need | Read |
|------|------|
| Local dev, `.venv`, install, build commands | `README.md` |
| Test setup on a new machine | `docs/development/TESTING.md` |
| Packaging and installers | `docs/development/BUILD_INSTRUCTIONS.md`, `docs/development/INSTALLER_IMPLEMENTATION.md` |
| Backend module layout | `docs/development/BACKEND.md` |
| AI catalog pins | `docs/development/LOCAL_AI_MODEL_CATALOG.md` |
| v2.9 dependency evidence | `docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md` |
| Speakrs soak / quality notes | `docs/development/SPEAKRS_BENCHMARKS.md` |
| Third-party notices / About credits | `THIRD_PARTY_NOTICES.md`, Settings About in `src/renderer/index.html` |
| Recorder stdout JSON migration history | `docs/completed/json-based-events.md` |
| macOS capture — **planned**, not shipped | `docs/initiatives/MACOS_AUDIO_ARCHITECTURE.md` |
| Encode / Whisper / llama speed — **planned spike**, not v2.9 | `docs/initiatives/LOCAL_INFERENCE_PERFORMANCE.md` |
| Meeting history user-facing behavior | `docs/guides/MEETING_TRANSCRIPTION.md` |
| Manual QA (hardware-dependent) | `tests/manual/recording-smoke-checklist.md`, `tests/manual/local-ai-addons-checklist.md` |
| Adversarial review prompts | `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md` |

## Content relocation ledger

Each section body below was copied byte-for-byte as UTF-8 text from the old root (outer whitespace trimmed). The validation tool compares HEAD with its destination. Existing contract summaries and their newer desktop-only/CUDA-admission safeguards were retained.

| Old section | New owner | SHA-256 of relocated body |
|---|---|---|
| Recorder stdout control | `docs/development/contracts/recording.md` | `e6b7e7cd548c71dd4e0ba4c26e613b80edf0572a95b03c2a2688014b617b1e4e` |
| Recording data-loss guards | `docs/development/contracts/recording.md` | `c1bedbec6a35d8444afff99fee4b81baf4ea29074311310bcbf1262f362154a4` |
| Platform traps | `docs/development/contracts/packaging.md` | `1fc9575674361e4afde17443589cc170ffa0ddc85cb75e8074767bdf849fbd3e` |
| Post-processing mix architecture | `docs/development/contracts/recording.md` | `8f00f7bd768ea547ee19462115706b35b30c8051222c2a631b82c533d58ddb75` |
| Privacy is a hard constraint | `docs/development/contracts/local-ai.md` | `08dee6b8dc5c2f5ce54b0bc3a02e0aa85f25f4be07acb50c84c22f5275529c9f` |
| Local AI add-ons: catalog-driven and explicit | `docs/development/contracts/local-ai.md` | `bd29f661833c45f269a00cb9676c69f5f52fbbd16184f87c3dd38cf22b58bed4` |
| Summary finalization must not be interrupted | `docs/development/contracts/local-ai.md` | `2a3a7fefca3bca1fd36f9969449b82f6ea4c19314f90ddeb6656b8ef46c7c0bd` |
| Quit drain | `docs/development/contracts/local-ai.md` | `5e14d3c906dc72fe48256ce5ddb48fce66c2db38a9397f59c2ea3043303b3ae3` |
| Transcription model cache and offline runtime | `docs/development/contracts/local-ai.md` | `a3e2d3306a48db2f4bc7725008930957bf2d67e3ccd854e55a36b7e36955d0f9` |
| GPU compute serialization and timeouts | `docs/development/contracts/local-ai.md` | `d0e2820148cd05e1a3e30f39428596825b48d593af51480b58dc65a029d86411` |
| Meeting metadata persistence | `docs/development/contracts/meeting-persistence.md` | `a452b52453770ec328712da72f13b3abf3dd5b8cc7129cdde806f7b5b4777dfd` |
| macOS desktop audio capture | `docs/development/contracts/macos-audio.md` | `c88b7ef32393db0d29c654da7ce348ce3864c432063ec02229f48b765ae5682f` |
| Build packaging | `docs/development/contracts/packaging.md` | `9fbf9190532d1fbf1c07bb8bab90b23e1944dd28566a46edc1916c8a0b98f3ac` |
| Renderer conventions | `docs/development/contracts/ipc.md` | `726788955a6e31c48607ee60be71213b23ac1d491d0c7824f4d5967ebf5f618c` |
| Python backend | `docs/development/BACKEND.md` | `b7148b9716cafd35eb2fd42e419eecf4ec49c629076095d4232f15b44ce2a306` |
| Cross-cutting change checklists | `docs/development/contracts/ipc.md` | `292639d9b2aba78ed7a6b1c6b291079e9bb424ede100397e515895f86c76a2c2` |
| Validation | `docs/development/TESTING.md` | `e02f463a7e3af4d7994a79d6073cdc9f7269b7751bed00eedd19798b2b07c3b8` |
| Maintenance hotspots | `docs/development/BACKEND.md` | `11ffbd7d64347b8545064d27fa75388a520c5a8adb7cc23cdfd89ddfd1d6e3ba` |
| Working defaults | `docs/development/AGENT_SETUP_AUDIT.md` | `8edab4d6efa4016d4d0b906803835550c175f3e083a167fd1bb6ae51cc4ca64a` |
| Platform targets | `docs/development/contracts/local-ai.md` | `27a497a549bfe1d94515112b4f0a9fa1aa78948b18a382145d72b167afd08357` |
| IPC ownership and facade exports | `docs/development/contracts/ipc.md` | `f31b2bcea0a8a3588c75c49b3dfcbe05efb027d6ab82970e424d1930c0a0ee69` |

## Completion evidence

- `python scripts/agents/validate_setup.py --migration-check`: 16 canonical skills, links, index entries, YAML frontmatter, commands and adapters validated; all skill bodies and relocated instruction sections match HEAD.
- `python -m unittest scripts.agents.test_link_skills`: 7 tests passed, covering missing, idempotent, dangling, wrong, stale, stub and refusal cases.
- `sh scripts/agents/link_skills.sh --check`: all 16 Claude skill links verified on Linux.
- `opencode debug skill`: 16 unique project skills loaded from `.agents/skills/`, with no duplicate or load errors.
- `npm run test:all`: 937 JavaScript tests passed with 1 skipped; 656 Python tests passed with 7 skipped; Python syntax passed.
- `git diff --check`: no whitespace errors; the Git index remained unchanged.

Linux verification is complete for repository setup and automated tests. macOS behavior is covered by the POSIX implementation but was not executed on macOS. Native Windows symlink/junction behavior was reviewed and fixture-tested where portable, but requires a native Windows smoke after the links are tracked. WSL-on-Linux-filesystem follows the verified POSIX path; a `/mnt/c` checkout retains the documented Windows filesystem constraints. Hardware capture and installer acceptance were outside this instruction-only migration.
