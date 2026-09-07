# AvaNevis Agent Guide

AvaNevis is a privacy-first Electron desktop application that records microphone and desktop audio and transcribes locally with Whisper. It uses Electron 44, plain HTML/CSS/JavaScript, Python 3.11 subprocesses, a Swift audio helper and a Rust Speakrs CLI; it has JS and Python regression suites plus manual hardware checks. This is the canonical always-on guide for Codex, Cursor, OpenCode and Claude Code through the root CLAUDE.md import.

## Quick commands

Run from the repository root unless a directory is specified. Use npm and the committed package-lock.json; use a repo-local Python 3.11 .venv.

| Task | Command / expected signal |
|---|---|
| Node install | `npm ci` — installs locked dependencies |
| Python environment, Linux/macOS | `python3.11 -m venv .venv` |
| Python environment, Windows | `py -3.11 -m venv .venv` |
| Python install, Linux | `.venv/bin/python -m pip install -r requirements-linux.txt -r requirements-dev.txt` |
| Python install, macOS | `.venv/bin/python -m pip install -r requirements-macos.txt -r requirements-dev.txt` |
| Python install, Windows PowerShell | `.venv/Scripts/python.exe -m pip install -r requirements-windows.txt -r requirements-dev.txt` |
| Run / dev | `npm start` / `npm run dev` — opens Electron; audio requires a desktop session |
| JS syntax / regression | `npm run test:syntax` / `npm test` — exit 0 |
| Python regression / syntax | `npm run test:python` / `npm run test:python-syntax` — exit 0 |
| Full pre-PR gate | `npm run test:all` — exit 0; hardware acceptance remains manual |
| Windows / macOS / Linux installers | `npm run build` / `npm run build:mac` / `npm run build:linux` on the matching host — artifacts in dist/ |
| Device smoke | `python backend/device_manager.py` with .venv active — device JSON; requires hardware |
| Swift helper, macOS | `swift build -c release --arch arm64` inside swift/AudioCaptureHelper |
| Agent setup checks | `python scripts/agents/validate_setup.py` — exit 0 |

There is no dedicated lint, typecheck or automated end-to-end npm target. CI's optional Python lint is `flake8 backend --count --select=E9,F63,F7,F82 --show-source --statistics`; install flake8 explicitly if using it. Build prerequisites, signing flags and fresh-machine testing live in README.md and docs/development/TESTING.md.

## Repo map

- Read `src/main.js` for lifecycle, tray, quit drain and service wiring; keep it a composition root. Platform/update channels still registered there are deliberate exceptions.
- Follow `src/renderer/app.js` → `window.electronAPI` in `src/preload.js` → owning `src/main/` service → `src/main/python-runtime.js` → Python. Read both process sides for contract changes.
- Start recorder work in `src/main/recorder-service.js` and `backend/audio/`; persistence in `backend/meeting_manager.py` and `backend/meetings/`.
- Read `src/main/transcription-service.js`, `backend/transcription/`, `src/ai-addon/`, `backend/diarization/` and `backend/summaries/` for local AI.
- Read `build/prepare-resources.js`, `build/download-manifest.js`, package.json and `.github/workflows/` for packaging. Native helpers live in `swift/AudioCaptureHelper/` and `native/speakrs-cli/`.
- Put pure renderer logic in `src/renderer/*-helpers.js` with matching `tests/js/*-helpers.test.js`; retain plain JS and explicit platform modules. Python is spawned per invocation, not a server.

## Invariants / do-not

- Never add cloud processing, telemetry, background uploads, embedded/proxied secrets or hidden downloads. Model/add-on setup is explicit; summaries are user-triggered. User tokens stay in safeStorage and validated stdin boundaries.
- Store recordings, metadata and derived AI sidecars in Electron userData, never the repo. Preserve locks, atomic writes, recovery, stop/discard distinctions and graceful degradation.
- Target Windows 10/11 x64, macOS 14+ with arm64-only packages, and Linux x86_64 Core Beta. Preserve Windows faster-whisper, Apple Silicon MLX and Linux CPU transcription with optional managed CUDA 12.
- Linux device IDs are opaque strings; never parseInt them. A managed CUDA tree makes transcription fail-closed; preserve Repair/Uninstall escape paths and component gates. Linux speaker identification is Speakrs-only, CUDA-only; summaries need their own CUDA gate. Never add CPU/cloud fallbacks for those add-ons.
- Preserve supported Omarchy/CachyOS Hyprland/Wayland/PipeWire versus experimental distro/desktop tiers. Use compatibility evidence for acceptance claims; never infer hardware success from CI.
- Change IPC owner, preload, every renderer caller and characterization tests together. Preserve facade export key sets and AI_ADDON_PROGRESS_CHANNEL / AI_ADDON_CANCEL_CODE values.
- Do not hand-edit generated build/resources, dist, native targets, Swift .build, caches or local data. Change manifests and regenerate deliberately; update lockfiles only with authorized dependency work. Never commit secrets or machine-local settings.
- Read the relevant contract before editing its surface; detailed contracts are canonical, not optional background:

| Surface | Read first |
|---|---|
| Recorder, capture, discard, spools, recovery | `docs/development/contracts/recording.md` |
| AI add-ons, tokens, downloads, queues, quit, GPU/cache policy | `docs/development/contracts/local-ai.md` |
| Prepared resources, installers, signing, tray | `docs/development/contracts/packaging.md` |
| Swift helper or macOS desktop audio | `docs/development/contracts/macos-audio.md` |
| Meeting metadata, scan/import, rename | `docs/development/contracts/meeting-persistence.md` |
| Main/preload/renderer, exports, cross-cutting change checklists | `docs/development/contracts/ipc.md` |

## Working agreements

- Work inline; ask before delegation. Keep plans concise and file-level. Do not add per-step TDD, commit or handoff ceremonies unless requested or justified by high-risk behavior.
- Preserve operational behavior before reducing complexity; prefer extraction behind stable interfaces, explicit platform differences and intentional graceful degradation.
- Use the smallest relevant tests while iterating; run `npm run test:all` before any PR and for cross-cutting, recorder, persistence, packaging or security changes. Use real third-party types/asset bytes where fakes could hide behavior.
- Inspect the final diff and fresh evidence before claiming completion. Do not re-review unchanged work after feedback unless a material change introduces risk.
- Do not stage, commit, push or publish without user authorization. Authorization to edit does not authorize these actions.
- Do not edit AGENTS.md, adapters or skill wiring during ordinary feature work; change them only for an explicitly requested instruction/setup task. Keep runtime facts in contracts and task status in todo.md.
- Trust runtime scripts, tests and compatibility evidence over stale prose. Resolve documentation conflicts at the canonical contract; inspect Electron and Python before changing cross-process behavior.

## Skills index

Canonical bodies are `.agents/skills/<name>/SKILL.md`. Read only the selected skill. Explicit-only skills below must never auto-run; tool-specific discovery does not grant permission to publish, discard or delegate.

| Skill | Trigger |
|---|---|
| writing-plans | A spec or multi-step task needs a concise file-level plan |
| executing-plans | Implement an existing written plan inline |
| finishing-a-development-branch | Tested work needs an integration or cleanup decision |
| verification-before-completion | Before claiming completion, a fix or passing checks |
| systematic-debugging | Investigate a bug, failed test or unexpected behavior |
| requesting-code-review | A targeted review would materially reduce risk |
| gh-fix-ci | Diagnose failing GitHub Actions checks for a PR |
| gh-address-comments | Address GitHub PR review or issue comments |
| security-best-practices | Explicitly requested security best-practices review |
| security-threat-model | Explicitly requested repository threat model |
| grill-me | Explicitly requested design interview |
| grill-with-docs | Explicitly requested design interview with ADR/glossary capture |
| handoff | Explicitly requested conversation handoff |
| to-spec | Explicitly requested spec synthesis and issue publication |
| skill-creator | Author or update a project skill |
| frontend-design | Visual-system, layout, HTML or CSS work in src/renderer |

## Pointers to deeper docs

- README.md
- .agents/README.md
- docs/development/TESTING.md
- docs/development/BACKEND.md
- docs/development/BUILD_INSTRUCTIONS.md
- docs/development/INSTALLER_IMPLEMENTATION.md
- docs/development/LOCAL_AI_MODEL_CATALOG.md
- docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md
- docs/development/ADVERSARIAL_REVIEW_PROMPTS.md
- docs/guides/LINUX_EXPERIMENTAL.md
- tests/manual/recording-smoke-checklist.md
- tests/manual/local-ai-addons-checklist.md
