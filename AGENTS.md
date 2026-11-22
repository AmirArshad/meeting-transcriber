# AvaNevis Agent Guide

AvaNevis records mic/desktop audio, imports audio files, and transcribes locally: Electron, plain HTML/CSS/JS, Python 3.11 subprocesses, Swift audio and Rust Speakrs CLI. Canonical guide; CLAUDE.md imports it. Runtime pins: package.json/native manifests. Platform rules: contracts below.

## Quick commands

Run from repo root unless noted. Use npm with committed package-lock.json and repo-local Python 3.11 .venv.

| Task | Command / expected signal |
|---|---|
| Node install | `npm ci` — installs locked dependencies |
| Run / dev | `npm start` / `npm run dev` — opens Electron; audio requires a desktop session |
| JS syntax / regression | `npm run test:syntax` / `npm test` — exit 0 |
| Python regression / syntax | `npm run test:python` / `npm run test:python-syntax` — exit 0 |
| Full pre-PR gate | `npm run test:all` — exit 0; hardware acceptance remains manual |
| Windows / macOS / Linux installers | `npm run build` / `npm run build:mac` / `npm run build:linux` on the matching host — artifacts in dist/ |
| Agent setup checks | `python3 scripts/agents/validate_setup.py` — exit 0 (Windows: `py -3.11`) |

No lint/typecheck/E2E npm target. Setup/native checks: README.md and docs/development/TESTING.md. Install deps only when needed.

## Repo map

- `src/main.js`: lifecycle, tray, quit drain, wiring; keep it a composition root.
- Follow `src/renderer/app.js` → `window.electronAPI` in `src/preload.js` → `src/main/` service → `src/main/python-runtime.js` → Python. Read both sides for contract changes.
- Capture, persist, search, updates (`src/main/`): `recorder-service.js` (`backend/audio/`), `audio-import-service.js`, `backend/meeting_manager.py` (`backend/meetings/`), `history-search-service.js` (`backend/search/`), `updater-service.js`.
- Local AI (`src/main/` + `src/ai-addon/`): `transcription-service.js` (`backend/transcription/`), `backend/diarization/`, `summary-service.js` (`backend/summaries/`), `history-qa-service.js` (`backend/history_qa/`), `summary-process-slot.js`.
- Packaging: `build/prepare-resources.js`, `build/download-manifest.js`, package.json, `.github/workflows/`. Native: `swift/AudioCaptureHelper/`, `native/speakrs-cli/`.
- Pure renderer logic: `src/renderer/*-helpers.js` with `tests/js/*-helpers.test.js`. Keep plain JS and explicit platforms. Python spawns per call.

## Invariants / do-not

- Never add cloud processing, telemetry, background uploads, embedded/proxied secrets or hidden downloads. Model/add-on setup is explicit; summaries are user-triggered. Tokens stay in safeStorage and validated stdin boundaries.
- Store recordings, metadata, FTS5 search, Chat threads and AI sidecars in Electron userData, never the repo. Preserve locks, atomic writes, recovery, non-destructive speaker names/tags and stop/discard distinctions.
- One model process runs at a time (`src/main/summary-process-slot.js`), releasing before switching, setup tests or removal. Keep citations verified against retrieved transcripts.
- Preserve Windows 10/11 x64, macOS arm64 and Linux x86_64 targets (packaging owns macOS minimum), plus Windows faster-whisper, Apple Silicon MLX and Linux CPU transcription with optional managed CUDA 12.
- Linux device IDs are opaque strings; never parseInt them. A managed CUDA tree makes transcription fail-closed; keep Repair/Uninstall and component gates. Linux speaker ID is Speakrs-only, CUDA-only; Summaries & Chat need their own CUDA gate. Never add CPU/cloud fallbacks for those add-ons.
- Keep supported Omarchy/CachyOS Hyprland/Wayland/PipeWire distinct from experimental tiers. Use compatibility evidence for acceptance claims; never infer hardware success from CI.
- Change IPC owner, preload, every renderer caller and characterization tests together. Keep facade export key sets and AI_ADDON_PROGRESS_CHANNEL / AI_ADDON_CANCEL_CODE values.
- UI/docs use `recording`/`audio`/`Summaries & Chat` in plain copy; internal modules, IPC, DOM IDs and on-disk `meetings.json`/`meeting_*` names stay until a dedicated refactor.
- Never hand-edit generated build/resources, dist, native targets, Swift .build, caches or local data. Update manifests/lockfiles deliberately; never commit secrets or machine-local settings.
- Read the applicable canonical contract before editing:

| Surface | Read first |
|---|---|
| Recorder, capture, discard, spools, recovery | `docs/development/contracts/recording.md` |
| AI add-ons, tokens, downloads, queues, quit, GPU/cache policy | `docs/development/contracts/local-ai.md` |
| Prepared resources, installers, signing, tray | `docs/development/contracts/packaging.md` |
| Swift helper or macOS desktop audio | `docs/development/contracts/macos-audio.md` |
| Recording/meeting metadata, tags, speakers, scan/import, search | `docs/development/contracts/meeting-persistence.md` |
| Main/preload/renderer, exports, cross-cutting change checklists | `docs/development/contracts/ipc.md` |

## Working agreements

- Work inline; delegate only when requested. Risk alone is not permission. Keep plans file-level; small fixes need a short inline plan. No automatic planning/review/TDD/handoff chain.
- Preserve behavior before simplifying; extract behind stable interfaces and explicit platforms.
- Iterate with focused tests; run `npm run test:all` before any PR and for cross-cutting, recorder, persistence, packaging or security changes. Instruction/docs/setup edits use their own checks. Use real types/bytes where fakes hide behavior.
- Reuse passing evidence while code, deps and env are unchanged, including at commit/push. Inspect the final diff; repeat checks only for changed inputs or unresolved concerns. One lead owns full-suite/installer gates in parallel work.
- Search paths/symbols before large reads; load contracts once. Read long plans by constraints, sequence and current tasks; query lockfile keys instead of dumping files. Skip generated/ignored trees unless diagnosing them.
- Log verbose build/test output to ignored files, keep exit code, read summaries/failures. Wait for completion rather than short polls. Run one build per output tree unless inputs change.
- Stage/commit/push/publish only with user authorization; editing permission is not enough.
- Edit AGENTS.md, adapters or skill wiring only for explicit instruction/setup work. Keep runtime facts in contracts and status in todo.md.
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
| requesting-code-review | Targeted review would materially reduce risk |
| gh-fix-ci | Diagnose failing GitHub Actions checks for a PR |
| gh-address-comments | Address GitHub PR review or issue comments |
| security-best-practices | Explicitly requested security practices review |
| security-threat-model | Explicitly requested repository threat model |
| grill-me | Explicitly requested design interview |
| grill-with-docs | Explicitly requested design interview with ADR/glossary capture |
| handoff | Explicitly requested conversation handoff |
| to-spec | Explicitly requested spec synthesis and issue publication |
| skill-creator | Author or update a project skill |
| release-runbook | Sequenced build/review prompts with model routing |
| frontend-design | Visual, layout, HTML or CSS work in src/renderer |

## Deeper docs

Hardware acceptance: tests/manual/recording-smoke-checklist.md and tests/manual/local-ai-addons-checklist.md. Status: todo.md. Agent setup/usage: .agents/README.md.
