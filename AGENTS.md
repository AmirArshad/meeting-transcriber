# AvaNevis Agent Guide

AvaNevis records and transcribes locally: Electron, plain HTML/CSS/JS, Python 3.11 subprocesses, Swift audio and Rust Speakrs CLI. Canonical guide; CLAUDE.md imports it. Runtime pins: package.json/native manifests. Platform rules: contracts below.

## Quick commands

Run from the repository root unless a directory is specified. Use npm and the committed package-lock.json; use a repo-local Python 3.11 .venv.

| Task | Command / expected signal |
|---|---|
| Node install | `npm ci` — installs locked dependencies |
| Run / dev | `npm start` / `npm run dev` — opens Electron; audio requires a desktop session |
| JS syntax / regression | `npm run test:syntax` / `npm test` — exit 0 |
| Python regression / syntax | `npm run test:python` / `npm run test:python-syntax` — exit 0 |
| Full pre-PR gate | `npm run test:all` — exit 0; hardware acceptance remains manual |
| Windows / macOS / Linux installers | `npm run build` / `npm run build:mac` / `npm run build:linux` on the matching host — artifacts in dist/ |
| Agent setup checks | `python3 scripts/agents/validate_setup.py` — exit 0 (Windows: `py -3.11`) |

No lint/typecheck/E2E npm target. Setup and native checks: README.md and docs/development/TESTING.md. Install dependencies only when needed.

## Repo map

- `src/main.js`: lifecycle, tray, quit drain and wiring; keep it a composition root.
- Follow `src/renderer/app.js` → `window.electronAPI` in `src/preload.js` → owning `src/main/` service → `src/main/python-runtime.js` → Python. Read both process sides for contract changes.
- Start recorder work in `src/main/recorder-service.js` and `backend/audio/`; persistence in `backend/meeting_manager.py` and `backend/meetings/`.
- Local AI: `src/main/transcription-service.js`, `backend/transcription/`, `src/ai-addon/`, `backend/diarization/`, `backend/summaries/`.
- Packaging: `build/prepare-resources.js`, `build/download-manifest.js`, package.json, `.github/workflows/`. Native: `swift/AudioCaptureHelper/`, `native/speakrs-cli/`.
- Pure renderer logic: `src/renderer/*-helpers.js`, matching `tests/js/*-helpers.test.js`. Keep plain JS and explicit platforms. Python is spawned per invocation.

## Invariants / do-not

- Never add cloud processing, telemetry, background uploads, embedded/proxied secrets or hidden downloads. Model/add-on setup is explicit; summaries are user-triggered. User tokens stay in safeStorage and validated stdin boundaries.
- Store recordings, metadata and derived AI sidecars in Electron userData, never the repo. Preserve locks, atomic writes, recovery, stop/discard distinctions and graceful degradation.
- Preserve Windows 10/11 x64, macOS arm64 and Linux x86_64 targets. The packaging contract owns the current macOS minimum. Preserve Windows faster-whisper, Apple Silicon MLX and Linux CPU transcription with optional managed CUDA 12.
- Linux device IDs are opaque strings; never parseInt them. A managed CUDA tree makes transcription fail-closed; preserve Repair/Uninstall escape paths and component gates. Linux speaker identification is Speakrs-only, CUDA-only; summaries need their own CUDA gate. Never add CPU/cloud fallbacks for those add-ons.
- Preserve supported Omarchy/CachyOS Hyprland/Wayland/PipeWire versus experimental distro/desktop tiers. Use compatibility evidence for acceptance claims; never infer hardware success from CI.
- Change IPC owner, preload, every renderer caller and characterization tests together. Preserve facade export key sets and AI_ADDON_PROGRESS_CHANNEL / AI_ADDON_CANCEL_CODE values.
- Do not hand-edit generated build/resources, dist, native targets, Swift .build, caches or local data. Change manifests and regenerate deliberately; update lockfiles only with authorized dependency work. Never commit secrets or machine-local settings.
- Read the applicable canonical contract before editing:

| Surface | Read first |
|---|---|
| Recorder, capture, discard, spools, recovery | `docs/development/contracts/recording.md` |
| AI add-ons, tokens, downloads, queues, quit, GPU/cache policy | `docs/development/contracts/local-ai.md` |
| Prepared resources, installers, signing, tray | `docs/development/contracts/packaging.md` |
| Swift helper or macOS desktop audio | `docs/development/contracts/macos-audio.md` |
| Meeting metadata, scan/import, rename | `docs/development/contracts/meeting-persistence.md` |
| Main/preload/renderer, exports, cross-cutting change checklists | `docs/development/contracts/ipc.md` |

## Working agreements

- Work inline; delegate only when explicitly requested. Risk alone is not permission. Keep plans file-level; routine builds/small fixes need only a short inline plan. No automatic planning/review/TDD/handoff chain.
- Preserve behavior before simplifying; prefer extraction behind stable interfaces and explicit platforms.
- Use focused tests while iterating. Run `npm run test:all` on final integrated inputs before any PR and for cross-cutting, recorder, persistence, packaging or security behavior changes. Instruction/docs/setup-only edits use their relevant checks. Use real types/asset bytes where fakes hide behavior.
- Reuse passing evidence while code, dependencies and relevant environment are unchanged, including at commit/push time. Fresh does not mean same-message. Inspect the final diff; repeat checks/review only for changed inputs or unresolved concerns. One lead owns full-suite/installer gates in authorized parallel work.
- Search paths/symbols before large reads. Load applicable contracts once; read long plans by constraints, sequencing and current tasks. Parse lockfile keys instead of dumping files. Skip generated/ignored trees unless diagnosing them.
- Capture verbose build/test output to ignored local logs, preserve the real exit code, and read summaries/failure excerpts. Use completion notifications or blocking waits instead of repeated short polls. Run one build per output tree; rebuild only for changed inputs or a specific unresolved check.
- Stage/commit/push/publish only with user authorization; editing permission is not enough.
- Do not edit AGENTS.md, adapters or skill wiring during ordinary feature work; change them only for an explicitly requested instruction/setup task. Keep runtime facts in contracts and task status in todo.md.
- Trust scripts/tests and compatibility evidence over stale prose; resolve conflicts at the canonical contract.

## Skills index

Canonical bodies: `.agents/skills/<name>/SKILL.md`. Load matching skills once; prefer repo adaptations to global duplicates. Explicit-only skills must not auto-run. Discovery grants no publish/discard/delegation permission. Plugin setup: `.agents/README.md`.

| Skill | Trigger |
|---|---|
| writing-plans | Requested plan or substantive multi-file design |
| executing-plans | Implement a supplied/resumed written plan |
| finishing-a-development-branch | Explicitly requested integration/cleanup decision |
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

## Deeper docs

Hardware acceptance: tests/manual/recording-smoke-checklist.md and tests/manual/local-ai-addons-checklist.md. Status: todo.md. Agent setup/usage: .agents/README.md.
