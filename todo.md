# AvaNevis release status

Latest published version: **[v3.1.0](https://github.com/AmirArshad/meeting-transcriber/releases/tag/v3.1.0)**, November 22, 2026.
See the [release notes](docs/releases/v3.1.0.md) and [qualification record](docs/development/V3_1_QUALIFICATION.md) for shipped scope and accepted limits.

## Status

### v3.2.0 release plan · 2026-11-22

Planned on `release/3.2` (not yet cut; latest code commit `51c49b5`): [v3.2.0 release plan](docs/superpowers/plans/2026-11-22-v3.2-release-plan.md) · [qualification record](docs/development/V3_2_QUALIFICATION.md). Delivered via **10 micro-slices across 3 integration checkpoints** (Waves A–C) to keep diffs ~120–400 lines, optimize review/build token budgets across Antigravity (`Neon`/`Argon`/`Terra`) and Codex (`Sol`) via `t3code`, and batch full-suite runs to checkpoints:

- [x] **Wave A (Slices A1–A4 → Checkpoint 1):** `npm run test:all` exit `0` on `release/3.2` (`76f03e8`: JS `1,381 passed, 0 failed, 1 skipped`; Python `992 passed, 8 skipped`; JS/Python syntax clean).
  - [x] **A1** — ≥5 s speaker audio samples + `"Sample"` caption below preview buttons (`#8`, `#9`).
  - [x] **A2** — Always-available Summary format dropdown + decoupled `ai.summary.template` persistence (`#10`).
  - [x] **A3** — Device compatibility fit states (`likely_fits`/`tight`/`unknown`), Gemma 4 12B 12 GB calibration with nominal-tier tolerance (`12,282 MiB`), and hardened Linux `nvidia-smi` probe (`#1`, `#2`).
  - [x] **A4** — Unload-before-download confirmation prompt (`unloadLoadedModel: true` + `SUMMARY_MODEL_LOADED_IN_MEMORY`) and unload UI state sync (`#6`).
- [x] **Wave B (Slices B1–B3 → Checkpoint 2):** `npm run test:all` exit `0` on `release/3.2` (`1ee861a`: JS `1,389 passed, 0 failed, 1 skipped`; Python `999 passed, 8 skipped`; JS/Python syntax clean).
  - [x] **B1** — Python 3-tier Chat context router (direct full-transcript fit, `lastQuestion` follow-up resolution, adaptive caps, rolling compaction) + granular timestamp chunks (`#3`, `#4`, `#11`).
  - [x] **B2** — General chat mode backend (`scope.type = 'none'`), fail-closed verifier guardrails, and helpful grounded `insufficient_evidence` handling (`#5`, `#11`).
  - [x] **B3** — Chat renderer UI (`General chat`, Clear recording context, `Title · Summary` pills, notice recovery buttons) (`#5`, `#11`).
- [ ] **Wave C (Slices C1–C3 → Checkpoint 3 & Release Cut):**
  - [ ] **C1 (runtime & Inkling 2 Mini):** Shared `b12631` archives are pinned across all three platforms; Linux Gemma 4 uses the CUDA 12.8 build; macOS arm64 `b12631` Metal **Inkling 2 Mini** setup, Grounded/General Chat, and English summary deadline check passed (`51c49b5`, after reasoning-mode fix). Windows/macOS Gemma 4 `b12631` adoption, Windows/Linux Inkling qualification, and a pre-release runtime re-check remain open. [Qualification record](docs/development/V3_2_QUALIFICATION.md)
  - [ ] **C2 (Bonsai & peer catalog):** All 5 peer/Bonsai slots (`bonsai-2-9b-q2-0`, `bonsai-2.5-27b-q2-0`, `ministral-3-14b`, `gemma-4-26b-a4b`, `qwen3.8-27b`) are pinned and enabled for device-gated Chat setup (`#7`), with `bonsai-2.5-27b-q2-0` replacing `bonsai-2-27b-q2-0` while preserving legacy installed `bonsai-2-27b-q2-0` profiles and migrating uninstalled Chat threads. Both **Bonsai 2** sizes (`9B` and retired `27B`) passed 32k Chat on Linux CUDA and macOS Metal (plus macOS English summary deadline check); native 32k checks for **`bonsai-2.5-27b-q2-0`**, Windows checks, native checks for `ministral-3-14b` / `gemma-4-26b-a4b` / `qwen3.8-27b`, and cross-platform summary language qualification remain open. [Qualification record](docs/development/V3_2_QUALIFICATION.md)
  - [ ] **C3 (dependencies & audits — must be re-run before release):** Initial sweep (`785a868`: `dompurify 3.5.0`, `filelock 4.3.0`, `hashbrown 0.17.2`, SBOM, contracts) and partial Linux/macOS pre-cut gates ([Linux `735bd5d`](docs/development/V3_2_QUALIFICATION.md#task-53-integrated-pre-release-gate-2026-11-22), [macOS `51c49b5`](docs/development/V3_2_QUALIFICATION.md#macos-arm64-qualification-2026-11-23)) passed on pre-cut `3.1.0` artifacts. The full dependency/advisory sweep and local runtime pin check must be redone before cutting `v3.2.0`.

**Remaining before `v3.2.0` release**

- [ ] **Re-run dependency & security sweep before release:** Repeat live upstream checks and audits before cutting `v3.2.0` to pick up any newer releases, patches, or advisories published since the 2026-11-22 sweep:
  - **Electron:** Re-check `npm view electron dist-tags` for stable `46.x` (held on `46.0.0-alpha.11`); if upgraded, re-audit Linux `safeStorage` provider prefix mapping / `v10` fixed-key rejection and re-run `tests/fixtures/electron/token-migration-smoke.js` on Linux, Windows, and macOS.
  - **Bundled binaries:** Re-check matched cross-platform **FFmpeg** (`shaka-project/static-ffmpeg-binaries` + `GyanD/codexffmpeg` + `ffmpeg.org` source `> 8.1.2`), **CPython** (`astral-sh/python-build-standalone` `>= 3.11.18`), and `pip` (`>= 26.3`).
  - **npm, Python & Rust:** Re-check npm packages/overrides, Python build pins & held upgrades (`onnxruntime`, `ctranslate2`, `pyobjc-*`, security/patch pins), and Rust (`speakrs` `0.8.0` vs `=0.7.0` + `Cargo.lock` patch updates). Re-run GitHub Dependabot alert check, `npm audit` & `npm audit --omit=dev`, `scripts/check-build-requirements-closure.py` (Windows, macOS, Linux), `scripts/pip_audit_inventory.py` (+ vulnerable canary), `cargo audit --deny warnings`, and `npm run legal:sbom` if Python pins change.
- [ ] **Re-check local model runtimes before release:** Re-check upstream `ggml-org/llama.cpp` releases beyond `b12631` (and other managed local AI runtimes, including Speakrs, Parakeet, Pyannote, and Linux CUDA runtime components) for newer stable builds or fixes affecting Inkling 2 Mini, Bonsai 2 / 2.5, Gemma 4, Qwen 3.8, or Ministral 3. If any runtime pin changes, re-verify SHA-256 digests, asset IDs, Linux ELF closure, CLI/server flags, and native smokes.
- [ ] **Windows 10/11 x64 native qualification (entire native gate open):**
  - Run `npm run test:all`, `python3 scripts/agents/validate_setup.py`, and `tests/fixtures/electron/token-migration-smoke.js` (`DPAPI`).
  - Build and verify the Windows installer (`npm run build` + `verify-windows-installer.ps1`).
  - Run native CUDA `b12631` (or refreshed runtime) setup, Chat, Job Object exit, and cancellation checks for Bonsai 2 9B, Bonsai 2.5 27B, Gemma 4 E4B/12B (for unified runtime adoption), and available larger models (`ministral-3-14b`, `gemma-4-26b-a4b`, `qwen3.8-27b`, `inkling-2-mini` on 24+ GiB CUDA).
  - Complete interactive v3.2 desktop acceptance (device fit badges, unload-before-download modal, Chat direct fit / follow-ups / granular timestamps / General Chat guardrails, ≥5 s speaker samples + `"Sample"` label, always-available Summary format dropdown).
  - If qualifying held Python upgrades, run Windows active ETW telemetry verification (`onnxruntime`) and CPU/CUDA Whisper parity (`ctranslate2`).
- [ ] **macOS arm64 remaining qualification:**
  - Complete microphone-only and mixed-source (mic + system audio) hardware capture acceptance with macOS microphone TCC permission granted.
  - Run native Metal checks for `bonsai-2.5-27b-q2-0`, `ministral-3-14b`, `gemma-4-26b-a4b`, `qwen3.8-27b`, and Gemma 4 E4B/12B on `b12631` (or refreshed runtime) for unified runtime adoption.
  - Complete interactive v3.2 desktop UI acceptance across Settings, History, Prepare summary, and Chat.
  - If qualifying `pyobjc` `13.x`, run ScreenCaptureKit / CoreAudio permission smoke.
- [ ] **Linux x86_64 (CachyOS / Omarchy) remaining qualification:**
  - Re-run `npm run test:all`, `npm run build:linux`, and `npm run verify:linux:packaged` after `51c49b5` and any refreshed dependency/runtime updates (prior Linux gate was at `735bd5d`).
  - Complete interactive desktop acceptance on CachyOS/Omarchy (RTX 4070 `12,282 MiB` device fit + Gemma 4 12B, Bonsai 2.5 27B 32k setup/Chat/VRAM floor measurement, unload-before-download modal, Chat modes/citations/follow-ups, ≥5 s speaker samples + `"Sample"` label, Summary format picker).
  - Run 16–24+ GiB Linux CUDA checks for `ministral-3-14b` (32k), `gemma-4-26b-a4b`, `qwen3.8-27b`, and `inkling-2-mini`, or document as explicitly accepted hardware limits.
  - If qualifying held Python upgrades, run Linux `strace --check-network` VAD parity (`onnxruntime`) and CPU/CUDA Whisper parity (`ctranslate2`).
- [ ] **Runtime consolidation, summary language policy & doc sync:**
  - Decide Gemma 4 E4B/12B promotion from `b12606` to the unified `llama.cpp` runtime on macOS and Windows once native checks pass.
  - Complete cross-platform summary language qualification (`src/summary-language-policy.js`, currently `summary-language-v4`) for Inkling 2 Mini, Bonsai 2 9B, Bonsai 2.5 27B, Gemma 4 E4B/12B (Windows/Linux CUDA), and peers — or keep unverified combinations gated as documented limits.
  - Evaluate or formally defer optional KV-cache quantization (`-fa on --cache-type-k q8_0 --cache-type-v q8_0`) from Task 2.1.
  - `docs/development/LOCAL_AI_MODEL_CATALOG.md` and `docs/development/contracts/local-ai.md` are synced for `inkling-2-mini`'s `b12631` reasoning flags (`--reasoning auto`, `reasoningEffort: 'minimal'`, `reasoningBudget: 256`); re-sync catalog and canonical contracts if runtime or dependency pins change during the pre-release refresh.
- [ ] **Release-version (`3.2.0`) cut & publication:**
  - Record final cross-platform evidence and any explicitly accepted limits in `docs/development/V3_2_QUALIFICATION.md`.
  - Write curated release notes in `docs/releases/v3.2.0.md` and update `docs/initiatives/ROADMAP.md` and `todo.md`.
  - On release-cut authorization: bump `package.json` and `package-lock.json` from `3.1.0` to `3.2.0`, re-run final `npm run test:all`, `python3 scripts/agents/validate_setup.py`, security audits, `npm run legal:release-assets` (`3.2.0` legal archive), and release-version `3.2.0` package builds/verifiers (replacing pre-cut `3.1.0` artifacts).
  - Merge `release/3.2` into `master` via PR with green CI and push the authorized `v3.2.0` tag.

### v3.1.0 release cut · 2026-11-22

Version bumped from `3.0.0` to `3.1.0` on `release/3.1` with curated [v3.1.0 release notes](docs/releases/v3.1.0.md), preparing the PR merge into `master` and `v3.1.0` release tag. All five v3.1 phases (streaming grounded Chat & retrieval hardening, 11 recording tags & tag-aware summary templates, non-destructive speaker naming with voice previews, multi-model Summaries & Chat library with single-slot memory release, and Phase 5 dependency/security sweep) plus cross-view UI polish (`5103884`, `14a9a57`) and documentation synchronization (`fec16f1`) are included. Upstream holds remain Electron `46.0.0-alpha.11`, matched FFmpeg `8.1.2`, gated Inkling 2 Mini, and optional unsigned Windows / ad-hoc macOS signing (`vars.REQUIRE_SIGNED_RELEASE` unset/false). Open cross-platform hardware/desktop gates recorded in [V3_1_QUALIFICATION.md](docs/development/V3_1_QUALIFICATION.md) are accepted as documented v3.1.0 limits. Final pre-PR local gates on `release/3.1` (`3.1.0`): `npm run test:all` exit 0 (`JS 1,357 passed, 0 failed, 1 skipped`; `Python 990 passed, 8 skipped`; syntax clean), `python3 scripts/agents/validate_setup.py` exit 0, `npm audit --omit=dev` & `npm audit` (`0 vulnerabilities`), and `npm run legal:release-assets` exit 0 (`avanevis-legal-3.1.0.zip` + `ffmpeg-8.1.2.tar.xz`).

### v3.1 Windows 11 partial qualification · 2026-11-22

On `release/3.1` `1749a04` plus the fixes described in the qualification record, the full suite, unsigned Windows installer build, packaged CUDA/CPU Whisper, mixed WASAPI capture, DPAPI migration, Speakrs setup and Qwen 9B/4B desktop smokes passed. Live Chat exposed and drove a fix for answer truncation and flattened Markdown; a misleading speaker setup message was also corrected. The full Windows and cross-platform release gates remain open; see the [qualification record](docs/development/V3_1_QUALIFICATION.md#windows-11-partial-qualification-2026-11-2122) for scope and limits.

### v3.1 Phase 5 dependency sweep & macOS qualification · 2026-11-21

Phase 5 dependency upgrades, security audits, and macOS arm64 host qualification
were completed on `chore/v3.1-phase5-dependencies` and merged into `release/3.1`
(`a432f4f`; `package.json` remains at `3.0.0` pending cross-platform qualification
and release cut authorization).

- **Updates applied:** npm `overrides` (`brace-expansion@1` `1.1.22`, `brace-expansion@2` `2.1.8`, `undici@7` `7.30.2`); Python 3.11 patch pins (`av==18.1.1`, `PyYAML==6.0.4`, `pydantic==2.14.4`, `pydantic-core==2.50.5`, `certifi==2026.11.20` + `>=2026.11.20` floors, macOS `regex==2026.11.19`); Rust `1.89.0` patch updates in `native/speakrs-cli/Cargo.lock` and `native/speakrs-cpu-smoke/Cargo.lock`; regenerated `legal/PYTHON-BUNDLED-PACKAGES.md` (68 direct pins); and Phase 1 Chat inline-citation prompt/repair hardening (`backend/history_qa/qa_runner.py`, `backend/history_qa/citation_verifier.py`, `tests/python/test_history_qa.py`) caught by live Qwen3.5 9B qualification.
- **Holds verified:** Electron stays `46.0.0-alpha.11` (no stable 46.x on npm); FFmpeg stays `8.1.2` (`shaka-project` tops at `n8.1.2-2`); CPython `3.11.18+20261110` & `pip` `26.3` already current; `llama.cpp` pins & Inkling 2 Mini gate unchanged (`b12608` still predates fix `690b87d8`); Python ceilings, `onnxruntime==1.31.1`, `ctranslate2==4.8.5`, `pyobjc-*==12.2.2`, Parakeet/Pyannote locks, `linux-cuda-runtime-catalog.js`, and `speakrs =0.7.0` held pending target-platform qualification.
- **Audits & macOS arm64 verification:** GitHub open PRs/alerts `0`; `npm audit` & `npm audit --omit=dev` `0 vulnerabilities`; `check-build-requirements-closure.py` `ok` (Win/Mac/Linux); `pip-audit` `0` findings across all 3 build files, 3 Parakeet locks, `bootstrap`, and `darwin-arm64` pyannote closure (`94` distributions), with `8` expected findings on the canary; `cargo audit --deny warnings` `0` findings on both lockfiles; `npm run test:all` exit `0` (`JS 1,349 passed / 3 skipped`, `Python 988 passed / 6 skipped`, syntax clean); `validate_setup.py` exit `0`; `build:mac:dir` + `verify:mac:packaged` exit `0`; Electron 46 token smoke passed; and isolated Task 5.4 packaged-resource qualification (Qwen3.5 9B Chat Q&A suite, 11 tags & 6 templates, speaker naming/WebVTT `<v Alice>`, and process-slot release/removal) passed. See [V3_1_QUALIFICATION.md](docs/development/V3_1_QUALIFICATION.md#phase-5-dependency-sweep-audits--macos-arm64-qualification-2026-11-21).
- **Remaining at this phase:** Native Windows 10/11 x64 and CachyOS/Omarchy Linux x86_64 builds, audits, and Task 5.4 hardware/packaged qualification; final interactive desktop UI pass; version bump to `3.1.0`, `docs/releases/v3.1.0.md`, PR merge, and authorized release tag. The later CachyOS results below close part of this list.

### v3.1 CachyOS partial qualification · 2026-11-21

On `release/3.1` `a432f4f`, the full suite passed after fixing a Linux test fixture, and the AppImage, pacman and deb builds and packaged verifier passed. Linux audits, isolated keyring migration, synthetic PipeWire capture, CPU/CUDA Whisper, Qwen CUDA runtime and an indexed all-recordings Q&A smoke also passed. Interactive native desktop access was unavailable; the remaining Linux hardware and Task 5.4 flows, Windows qualification, macOS desktop pass and release cut remain open. See the [qualification record](docs/development/V3_1_QUALIFICATION.md#cachyos-partial-qualification-2026-11-21) for scope and limits.

### v3.1 Phase 4 model library · 2026-11-21

The model library, scoped selection, process-exit admission and managed removal
were implemented on `codex/v3.1-phase4-model-library` and merged into `release/3.1` (`c54a437`). Gemma 4 archive and weight verification,
32k Metal smokes and isolated two-model installation and removal are recorded in
the [Phase 4 qualification record](docs/development/V3_1_QUALIFICATION.md).
Inkling's exact IQ4_NL weights passed 32,768-token Metal setup validation
with a local build of the loop-layer fix. The Apple Silicon gate requires a
published archive containing the fix and native checks on that archive.
Windows and Linux CUDA acceptance and host-specific memory limits remain open.

**Post-v3.1 follow-up · Inkling 2 Mini**

- [ ] Pin a published Apple Silicon Metal runtime containing the initial Inkling support and loop-layer scale fix. Repeat native checks at 32,768 tokens with the exact release archive before enabling Chat.
- [ ] Qualify Windows CUDA and managed Linux CUDA independently with compatible builds. Enable Chat on each platform after its native checks pass.
- [ ] Resolve the indeterminate English language check with production CLI flags and verify that structured summaries preserve deadlines such as “before Tuesday.” Enable summary languages only after they pass on the target platform.

### v3.1 Phase 3 speaker labels · 2026-11-21

Implemented on `feat/v3.1-phase3-speaker-labels` from `e5502d1`.
History, Activity, and Prepare summary share speaker excerpts and timestamped
voice previews. Metadata edits preserve the source transcript and its sidecars
while updating search, Chat attribution, summaries, and exports.

The integrated gate passed on macOS 26.7.3 arm64 with 1,285 JavaScript tests
passed and 3 skipped, 959 Python tests passed and 10 skipped, and both syntax
checks passed. An isolated Electron run used the two-speaker fixture and local
Qwen to verify naming, clearing, preview, search, citation playback, summary
attribution and rename detection, and Markdown, text, SRT, and WebVTT export.
The Prepare summary dialog was checked at 320 and 1,200 CSS pixels, including
missing audio and untimed speaker text. A same-content re-transcription commit
cleared the overlay and rejected a prior-attempt edit. Windows and Linux
interactive and packaged acceptance remain open.

### v3.1 Phase 2 review fixes · 2026-11-21

All 12 review findings are addressed on `feat/v3.1-phase2-tags-templates`.
The integrated `npm run test:all` exited 0 on macOS with 1,275 JavaScript tests
passed and 3 skipped, 951 Python tests passed and 10 skipped, and both syntax
checks passed.

### v3.0 release plan · 2026-11-20

Phased implementation plan on `release/3.0`: [v3.0.0 release plan](docs/superpowers/plans/2026-11-20-v3.0-release-plan.md) · [v3.0 qualification record](docs/development/V3_0_QUALIFICATION.md).

**Release direction, 2026-11-21 (v3.0.0 ship):** Version bumped from `2.12.0` to `3.0.0` on `release/3.0` with curated [v3.0.0 release notes](docs/releases/v3.0.0.md). Upstream holds rechecked on 2026-11-21: Electron stays on qualified `46.0.0-alpha.11` (stable 46.x still unpublished; `latest: 45.4.1`, `alpha-46-x-y: 46.0.0-alpha.12`), FFmpeg stays on matched `8.1.2` (`shaka-project` still tops at `n8.1.2-2`), and `npm audit --omit=dev` / `npm audit` report `0 vulnerabilities`. Signing and notarization are intentionally optional for v3.0.0 (no Windows/Apple signing accounts yet; `vars.REQUIRE_SIGNED_RELEASE` unset/false, ad-hoc macOS `.dmg` manual updater fallback active). All remaining manual/hardware qualification gates (Windows 10, macOS 15, isolated Keychain migration, permission-prompt variants, gated Pyannote, natural-speech Speakrs separation, and live signed updater verification) are explicitly accepted by the user as documented v3.0.0 limits. Final pre-PR local gates on `release/3.0` (`3.0.0`): `npm run test:all` exit 0 (JS `1,250 passed, 0 failed, 1 skipped`; Python `919 passed, 8 skipped`; syntax clean), `python3 scripts/agents/validate_setup.py` exit 0, and `npm run legal:release-assets` exit 0.

Progress across mandatory post-v2.12 gates and v3.0 feature tracks:

- [x] **Task 1.1 — History metadata lock contention (`75a7c28`):** Slow recorder-temp cleanup & filesystem/duration scans run outside `meetings.json.lock` under dedicated `scan_recovery.lock`; atomic Phase A/C reconciliation and multi-process contention tests pass on Linux.
- [x] **Task 1.2 — Caption-scale timing sidecars + SRT & WebVTT export (`534007e`):** Schema-v1 `{stem}.captions.json` bound by `sourceTranscriptHash` across faster-whisper, MLX Whisper, Parakeet, and guided transcription; pure SRT/WebVTT/TXT serializers, hash-verified export IPC, and format-picker UI (offline Whisper fixture -> `.captions.json` -> `.srt`/`.vtt` + `CAPTIONS_STALE` + delete verified on CachyOS Linux).
- [x] **Task 2.1 — Bundled CPython `3.11.18+20261110` on Windows & macOS (`333ceef`):** Live SHA-256s verified (`5ca7e23b...` Windows, `73f1ed14...` macOS); `build/prepare-resources.js` ported to traversal-guarded `.tar.gz` extraction + isolated Windows `python311._pth`. Windows and macOS packaged runtime smokes passed; platform-specific qualification limits remain in the [record](docs/development/V3_0_QUALIFICATION.md).
- [x] **Task 2.2 — Upstream holds & audit checks (2026-11-20):** Live upstream checks confirm Electron 46 stable is not yet published (latest stable `45.4.1`, `46.0.0-alpha.12` latest alpha -> hold on qualified `46.0.0-alpha.11`), FFmpeg matched > `8.1.2` is not yet available across all 3 OSes (`shaka-project` tops at `n8.1.2-2` which is still `8.1.2` -> hold on `8.1.2`), and both `npm audit --omit=dev` and `npm audit` report `0 vulnerabilities` with `picomatch@4.0.7`.
- [ ] **Task 5.3 — CachyOS qualification at `363f71b`:** Integrated suite, audits, rebuilt packages, isolated keyring migration, offline CUDA repair/uninstall and fail-closed admissions, two-speaker synthetic CUDA run, packaged updater service tests, Q&A GPU service smoke and recorder loss harness passed. Live AppImage update, interactive citation playback and natural-speech quality remain open; see the [qualification record](docs/development/V3_0_QUALIFICATION.md).
- [ ] **Task 5.2 — macOS partial qualification:** Integrated suite, ad-hoc DMG/ZIP build, physical capture modes, recorder SIGKILL recovery, app-driven Metal Whisper/Parakeet and Speakrs, renderer exports, History search, Qwen summary and Q&A citation playback passed on macOS 26. A recovered-duration defect was fixed and retested. Signing, notarization, macOS 15, permission variants, Keychain migration, Pyannote and natural-speech gates remain open; see the [qualification record](docs/development/V3_0_QUALIFICATION.md).
- [ ] **Windows 11 partial qualification at `552dd06`:** Full suite, unsigned NSIS build, packaged Python isolation and CPU/CUDA Whisper, fixture import, search and SRT/WebVTT export, unattended mic-only capture, virtual-device recorder recovery, and synthetic DPAPI migration passed. Windows 10, spoken and physical system capture, full add-on lifecycles, signed installer and update gates remain open; see the [qualification record](docs/development/V3_0_QUALIFICATION.md).
- [x] **Windows 11 follow-up, 2026-11-21:** Packaged Speakrs 0.7.0 CUDA returned one label on the 14.2245 s Hazel/Zira fixture and two labels with 8/8 correct turn midpoints on a 39.093875 s George/Zira synthetic fixture in both annotation modes. Representative-speech acceptance remains open. Fixed legacy interrupted captures that recovered without a transcription handoff and displayed `0:00`. The previous packaged backend reproduced `0:00` on the same recovered Opus, and the current isolated development renderer showed `0:06` in History and meeting details. Focused Python passed 142 tests, the full gate passed (JS 1,238 passed / 5 skipped, Python 917 passed / 9 skipped), and setup validation passed. See the [qualification record](docs/development/V3_0_QUALIFICATION.md#windows-11-follow-up-at-578d4dd-plus-the-recovery-fix--2026-11-21).
- [ ] **Task 2.3 — Windows Authenticode & macOS Developer ID signing/notarization wiring:** Repo-side hooks, preflight wrappers, verifier scripts, unit tests, and `.github/workflows/build-release.yml` wiring complete on `release/3.0`; **needs signing secrets and native Windows/macOS runs**.
- [x] **Modern in-app auto-updater (Phase 3):** Signed differential in-app download (`electron-updater@6.8.11`, `build.publish` GitHub metadata, macOS `zip` + `dmg` targets, `.blockmap` + `latest*.yml` release staging), main-process `updater-service.js` state machine with monotonic `seq`, atomic `userData/updater-preferences.json` (`autoDownload: false` default), cancellable downloads, recording/import/summary-metadata/AI-safe **Restart to Update** gate, Linux `pacman`/`.deb` manual-package detection + copyable install command, and non-intrusive left-rail circular-progress indicator, anchored release-notes popover (`STRICT_DOMPURIFY_CONFIG`), and Settings → Updates card. _(Repo implementation and unit/characterization suites verified on CachyOS Linux; live signed in-place Windows NSIS / macOS Squirrel.Mac / Linux AppImage updates pending Task 2.3 signing credentials and target-host acceptance.)_
- [x] **Local History search & Q&A with timestamp citations (Phase 4 · `5827ac5`, `23a9aaf`, `bbeba81`, `a9fb129`, `36f243d`):** Disposable local SQLite FTS5 full-text search index across transcripts/summaries (zero AI add-on required) with instant timestamp jump, plus left-rail threaded `Chat` workspace powered by lazy loopback `llama-server` (`llama-cli` fallback), manual & automatic VRAM/memory unloads, bundled `marked@18.2.1` + `dompurify@3.4.18` strict XSS-safe Markdown rendering, and fail-closed clickable citations that seek playback to the exact timestamp. _(Verified on CachyOS Linux including real local Qwen `llama-server` smoke and packaged Linux artifacts; interactive desktop UX pass + Windows/macOS host checks pending.)_

### Mandatory gates (accepted limits for v3.0.0; open for post-v3.0.0)

Unchecked items below represent documented v3.0.0 coverage limits explicitly accepted by the user on 2026-11-21 and deferred for post-v3.0.0 verification.

- [ ] Upgrade and qualify bundled CPython to 3.11.18 or newer on Windows and
  macOS. _(Repo port to Astral `3.11.18+20261110` implemented in `333ceef`;
  Windows & macOS host `prepare-build`, startup, transcription, Metal, and
  add-on closure verification pending on target hosts.)_
- [x] Fix the History metadata lock contention during long recorder recovery
  scans, preserving recovery and atomicity guarantees. Add a regression for a
  concurrent metadata operation during slow recovery. _(Committed in `75a7c28`.)_
- [ ] Complete Windows physical-device recording and end-to-end add-on
  setup/repair acceptance, including gated Pyannote with an authorized test
  token, and qualify Windows 10 as well as Windows 11.
- [ ] Qualify macOS 15 on Apple Silicon, isolated Keychain migration and
  permission-prompt variants.
- [ ] Move from the Electron 46 prerelease to a suitable stable Electron build
  and qualify all platforms. Recheck Linux keyring provider mapping and fixed-key
  rejection, and token migration on Linux, Windows and macOS. _(Hold on
  `46.0.0-alpha.11`: npm still has no stable 46.x release as of 2026-11-20;
  recheck before tagging v3.0.0.)_
- [ ] Qualify the Linux managed CUDA repair/uninstall escape paths and the
  separate transcription, Speakrs and summary admission gates. Preserve the
  intentional platform-specific recording behavior when desktop audio is lost.
  _(CachyOS disposable-profile CUDA lifecycle and gate smokes plus the Linux
  recorder loss harness passed; see qualification record for test limits.)_
- [ ] Update and qualify FFmpeg on all three platforms with pinned binaries and
  corresponding source; verify import decoding, recording finalization and recovery.
  _(Hold on matched `8.1.2`: Shaka binary provider tops at `n8.1.2-2` = `8.1.2`
  as of 2026-11-20; Linux `8.1.2` legal staging and decode/import/recovery
  tests pass.)_
- [x] Preserve caption-scale timing tied to committed transcripts, provide a
  path for older meetings, and ship accurate SRT and WebVTT exports together.
  _(Committed in `534007e` and verified with offline fixture on CachyOS; repeat
  manual spot-checks on Windows and macOS hosts.)_
- [x] Resolve the development packaging graph's picomatch audit finding with a
  compatible qualified dependency update and verify production and full audits.
  _(Resolved cleanly: `npm audit --omit=dev` and `npm audit` both report `0
  vulnerabilities` with `picomatch@4.0.7` as of 2026-11-20.)_
- [ ] **Optional post-account release signing (deferred for v3.0):** Windows
  Authenticode signing, macOS Developer ID signing/notarization, and macOS
  Squirrel.Mac in-app updater acceptance are optional for v3.0 while developer
  accounts are not yet enrolled. Repo wiring (`build/after-pack.js`,
  `build/mac-sign.js`, `scripts/check-*-signing-*.js`,
  `scripts/notarize-macos-dmg.sh`, `scripts/verify-*.{ps1,sh}`, and
  `build-release.yml`) is in place and auto-activates when secrets are added;
  set `vars.REQUIRE_SIGNED_RELEASE=true` to enforce fail-closed signed tags once
  credentials are configured.
- [ ] Test Speakrs multi-speaker separation with representative speech on each
  supported native platform and record the results.

### v2.12 released · 2026-11-19

[Release PR #154](https://github.com/AmirArshad/meeting-transcriber/pull/154) passed all 13 jobs and merged; the [tagged release workflow](https://github.com/AmirArshad/meeting-transcriber/actions/runs/44431149100) published all installers and legal assets. The user accepted the documented native coverage limits. The four superseded Dependabot PRs were closed and GitHub reported no open alerts after the merge.

- [x] [Design the History import flow](docs/superpowers/plans/2026-11-18-local-audio-import-design.md).
- [x] Import one local MP3, WAV or Opus into History and transcribe through Activity.
- [x] Apply #146, #147, #150 and #152, resolve the affected minimatch graph and re-query bot PRs and alerts after integration.
- [x] Record dependency candidates and holds in the [v2.12 qualification record](docs/development/V2_12_QUALIFICATION.md).
- [x] Build and verify the three Linux package layouts and exercise the AppImage on CachyOS with disposable profile and audio fixtures.
- [x] Qualify the Windows 11 package payload, disposable-profile upgrade, DPAPI and native dependencies. Fix and retest the Windows import commit and concurrent first-use writes.
- [x] Investigate the Windows pending-transcription banner. Cover the stale History snapshot in a regression and check Activity through a packaged recording.
- [x] Verify NSIS install, installed payload and uninstall on a disposable Windows runner.
- [ ] Finish the remaining Windows physical-device and add-on setup/repair acceptance.
- [x] Qualify the macOS arm64 package, upgrade and dependencies on macOS 26; Keychain migration and macOS 15 remain unverified.
- [ ] Preserve cue-scale timing in committed transcripts before shipping SRT and WebVTT together.

### Historical v2.11 release review follow-up

The [hosted release dry run](https://github.com/AmirArshad/meeting-transcriber/actions/runs/43787045494)
passed on `38fbea7` for Windows, macOS, all three Linux packages on Ubuntu 24.04,
Speakrs model checksums, and FFmpeg legal staging. The publication job was skipped.
The review called for rechecking Electron releases and npm availability before tagging. A runtime pin
change requires new qualification. The Windows pending-transcription banner and
remaining manual coverage gaps are in the
[qualification record](docs/development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md).

### Historical security maintenance after v2.11.0 · reviewed 2026-11-16

For subsequent decisions, including the Linux CPython update and the qualified Electron and Python package updates, see the [v2.12 qualification record](docs/development/V2_12_QUALIFICATION.md).

The review found no demonstrated exploit path through AvaNevis that warrants
delaying v2.11.0 for these updates. The following items describe the review at that time.

- [ ] **Electron:** Qualify a published Electron 46 build with Node 26.13.1
  or newer. The qualified `46.0.0-alpha.10` embeds Node 26.13.0. The November
  fixes are already on the 46 branch. The reviewed app paths do not run HTTP/2
  or TLS servers or mix HTTPS Agent certificate policies. Alpha.10 contains
  the exploited Chromium XML fix (CVE-2026-125350) and the revoked eMudhra RSA
  block in Chromium and Node. Recheck the Linux keyring provider mapping and
  fixed-key rejection against the new pin, then rerun token migration smokes.
  [Node advisories](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/),
  [Electron Node update](https://github.com/electron/electron/pull/55755),
  [Chromium fix](https://github.com/chromium/chromium/blob/159.0.8153.0/third_party/libxslt/chromium/0008-Fix-use-after-free-in-direct-pattern-match-cache.patch),
  [Electron certificate fix](https://github.com/electron/electron/pull/55741).
- [ ] **Bundled CPython:** Qualify 3.11.18 or newer on all three platforms,
  starting with Windows. The Windows embedded runtime is 3.11.9 and macOS/Linux
  use 3.11.17. They lack 3.11.18 fixes for eMudhra distrust in `ssl`, Expat, and
  `tarfile`. The Hugging Face HTTPS path uses patched certifi with native Xet
  disabled. Qualify the replacement Windows embedded layout, packaged
  transcription, and add-on setup before switching the release pins.
  [Runtime pins](build/download-manifest.js),
  [CPython security fixes](https://www.python.org/downloads/release/python-31118/).
- [ ] **Python package updates:** Review filelock (#146), numba/llvmlite (#147),
  torch (#150), and click (#152) against current advisories and packaged
  inventories. The November 16 `pip-audit` rerun found zero findings in the
  platform build pins, managed Parakeet locks, direct Pyannote pins, bootstrap
  pip, and local macOS payload inventory. The upstream PyTorch advisory lacks a
  package mapping and was identified separately. It covers attacker-controlled
  checkpoints loaded under Torch 2.14.1 and is fixed in 2.15.0. Packaging removes
  macOS build-time Torch 2.14.1, which was confirmed absent from the local app's
  import path. Optional Windows/macOS Pyannote pins Torch 2.13.0, outside this
  advisory's affected range. [PyTorch advisory](https://github.com/pytorch/pytorch/security/advisories/GHSA-v32g-mr63-3j83).

### Agent usage improvements — 2026-11-15

Audited repo instructions, builds and recent repo-specific Codex session evidence.
The [usage audit](docs/development/AGENT_USAGE_AUDIT.md) records duplicate personal
Superpowers workflows, large-context/parallel-work amplification and the limits
of token counters. Six core skills are now concise, verification reuses unchanged
inputs, and setup checks enforce instruction budgets and real invocation-policy
semantics. The ignored local Codex configuration disables the duplicate plugin;
the [setup guide](.agents/README.md) and tracked example cover other machines.
Setup/link tests pass (17); confirm plugin discovery after restarting Codex.

### Historical v2.11 proposal — 2026-11-10

The original provisional target **v2.11** was: upgrade to Speakrs 0.7 on Windows CUDA, Linux
CUDA and macOS CoreML; migrate safeStorage to its asynchronous API and target
the latest Electron 46; and take separately qualified, compatible dependency
updates. The file-level
scope, first Linux feasibility probe, and remaining platform gates are in the
[v2.11 plan](docs/superpowers/plans/2026-11-10-v2.11-speaker-upgrade.md).
Electron 45.2.3 is an interim branch change; the final target is 46.
As of 2026-11-10, Electron 46 is available only as a pre-release
(`46.0.0-alpha.8`). Speakrs remains at 0.5.0 in the product pending model
migration, Windows CUDA feasibility, quality and platform qualification.
Python modernization, AUR publishing, and notarization remain separate work.
On Linux, `npm run test:all` passed under an isolated X display: 1,133 JS and
852 Python passed, with 2 and 4 skips respectively; syntax checks passed.
`npm audit --audit-level=high` passed with six moderate packaging-toolchain
findings. Native installers and hardware checks for Electron 45.2.3 remain open.

### v2.11 dependency review · 2026-11-16

GitHub returned no open Dependabot alerts. Applied the pytest minimum 9.2.0
(#149) and pinned release action 3.0.4 (#151). The Electron 45.2.3 PR (#148)
would downgrade the qualified 46 alpha and was not applied. Deferred filelock
(#146), numba (#147), torch (#150), and click (#152): these affect packaged
Python closures and require platform and bundled inventory verification beyond
the available evidence. Their PR checks include Linux/Cargo failures and
cancelled macOS jobs. `npm audit --audit-level=high` passed with six moderate
minimatch findings in the build toolchain; the suggested forced fix changes
major packaging dependencies, so it was deferred pending compatibility testing.

### v2.11 acceptance · 2026-11-16

The user accepted the release with the documented qualification limits and
waived additional macOS-version and NVIDIA GPU-tier testing. Untested cases
remain identified as such in the [qualification record](docs/development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md).
Release preparation is recorded in the [v2.11.0 release notes](docs/releases/v2.11.0.md).
Publication requires a separately authorized tag; acceptance does not turn
unperformed checks into passing results.

### Historical v2.11 local release candidate · CachyOS, 2026-11-15

CachyOS built and verified the AppImage, pacman and deb candidates under the
existing app version. Native Speakrs 0.7 CUDA, disposable-profile repair and
removal, synthetic short and long guided transcription, PipeWire capture, and
the Electron 46 alpha secure-storage smoke ran locally. Subsequent Windows and
macOS checks and accepted limits are recorded below and in the qualification record.
The [qualification record](docs/development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md)
has the test evidence, hashes and pending gates.

### Historical v2.11 Windows qualification · 2026-11-15

The Windows RTX 4070 native loader is restricted to System32; a decoy test,
image-load trace, synthetic 0.5/0.7 comparison and packaged guided recording
passed. The unsigned local NSIS candidate built with Electron 46.0.0-alpha.10;
the full suite and disposable-profile DPAPI migration passed. Windows remains
open for integrated installer lifecycle, model repair/cancel/removal, offline
repeat, representative speech and other driver/GPU tiers. Settings also
overestimates the native model footprint by including legacy runtime bytes.
See the [qualification record](docs/development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md)
for evidence and next steps. macOS 15 arm64 remains open.

### Historical v2.11 Windows continuation · 2026-11-16

The rebuilt Windows candidate passed the full suite, packaged CLI loader trace,
scratch NSIS install/uninstall, synthetic legacy-profile repair and a longer
packaged guided CUDA run. Controlled service checks covered cancellation,
failure/retry, no-downloader repeat and removal. The Speakrs model footprint
estimate is corrected. Natural multi-speaker audio, independently isolated
offline execution, other GPU/driver tiers and macOS 15 arm64 remain open; the
[qualification record](docs/development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md)
distinguishes the evidence from these remaining release gates.

### Historical v2.11 plan review — 2026-11-15

Plan review only; no product implementation or new platform acceptance.
The [revised plan](docs/superpowers/plans/2026-11-10-v2.11-speaker-upgrade.md)
starts on CachyOS with the Linux CUDA probe and parallel preparation when
requested. Native Windows CUDA and macOS CoreML remain required. Live npm verification found latest 46 **46.0.0-alpha.10** (official
prerelease dated November 12) and stable **45.3.2**; the November 10 versions and
test counts above are historical. The plan specifies direct-file model setup,
transactional activation, complete async-token migration, separate CPU CI smoke,
and native loader/signing/quality checks. All 69 distinct required native model
leaves were downloaded and hashed for planning; this is not inference evidence.
The v2.11 minimum is **macOS 15 on Apple Silicon**, matching the upstream
CoreML asset target. Native macOS 15 packaged validation remains open, along
with Windows CUDA loading, driver-tier and real key-store migration checks.
Upstream CoreML assets still require qualification, and no re-export is planned.

### v2.10.2 certificate-trust maintenance — 2026-10-20

Release branch: `release/2.10.2`. Electron 44.9.2, certifi 2026.10.19,
pip 26.2.2 and Rust webpki updates cover bundled trust paths. Standalone
Python pip is replaced, optional runtime identities require repair, and native
Xet downloads are disabled in favor of the patched HTTP transport.
Local validation passes (1,130 JS / 848 Python tests, plus syntax checks;
2 JS / 8 Python skips). [PR #134](https://github.com/AmirArshad/meeting-transcriber/pull/134)
tracks native CI and integration. Installer publication is tracked by the
[tag release](https://github.com/AmirArshad/meeting-transcriber/releases/tag/v2.10.2)
and the release workflow; see the maintenance evidence for qualification limits.

### macOS FFmpeg 8.1.2 gate — 2026-10-17

The last open October host gate is closed on this Mac (macOS 26.7.1 arm64,
Node 26.12.0, repo `.venv` Python 3.11.17, `master` `b1960a3`). The prepared
FFmpeg reports `n8.1.2` and its SHA-256 `e7b9fcd9…14b22` matches the
`ffmpegMac` manifest pin. Recorder CLI runs used the repo backend with
`AVANEVIS_FFMPEG` pointed at that binary (the same method as the Windows
gate; no installer was rebuilt): mic+desktop 11.2 s, desktop-only 8.0 s,
mic-only 5.9 s, all through `post_processing_complete` with `Integrity check:
OK (opus)`; cancel returned `{ success: true, cancelled: true }` and left no
Opus. A SIGKILLed capture recovered 6.06 s through
`audio.capture_recovery` with `ffprobe` hidden from `PATH`: `OK (ffmpeg
decode)`, `verify opus` skipped, and the capture was removed only after that
decode. The fixture encoded to Opus with a clean null decode, and
`meeting_manager.py scan` on the recovered file reported `scanned: 1`,
`added: 1`. Limits: the CoreAudio tap delivered silence in this session
(buffers flowing, peak 0.0) in both the dev and packaged recorders, so
desktop-content capture was not re-qualified here; the mic track carried
real fixture audio (peak −10 dB) and desktop capture itself was qualified
on 2026-10-09. Full manual checklists were not repeated.

### Windows ONNX follow-up — 2026-10-13

The Windows base ONNX 1.31.0 candidate passed native ETW qualification: 20 events
in the unsuppressed control, zero with pre-import suppression, and matching CPU
VAD results against 1.30.0. The internal suppression signal has telemetry-only
production uses in the pinned upstream source. Both Python spawn and standalone
import boundaries enforce it. Hostile-environment regressions and the full local
gate passed (1,127 JS / 849 Python; 2 / 7 skipped).
[Final native qualification](https://github.com/AmirArshad/meeting-transcriber/actions/runs/38398973062)
passed all 13 jobs, including the actual application startup guard and Windows
NSIS install/bundled ONNX 1.31.0 import/uninstall. This supersedes the historical
Windows hold below. No user-side Windows task remains for this base update; see the
[maintenance record](docs/development/DEPENDENCY_MAINTENANCE_2026-10.md#windows-onnx-follow-up--2026-10-13).

### Remaining dependency qualification — 2026-10-13

Electron-builder 26.17.0 passed native NSIS install/uninstall and read-only DMG
payload verification; the existing Linux package checks also passed. A default-off
manual CI mode retains those installer checks. Linux ONNX Runtime
1.31.0 matches the prior CPU VAD probabilities/boundaries with no network
syscalls under an enforced pre-import 1DS telemetry opt-out. Windows remains
1.30.0: its candidate wheel has legacy TraceLogging and lacks that opt-out.
The existing moderate npm exception and hardware/signing limits remain.

Local full gate: 1,127 JS passed / 2 skipped; 849 Python passed / 7 skipped;
syntax clean. Focused privacy/packaging, Bash/PowerShell parsing, Linux/Windows
dependency closure and audit checks passed. [Native installer CI on 8172ecb](https://github.com/AmirArshad/meeting-transcriber/actions/runs/38392212924)
passed all 13 jobs before advancing remote master. CI now also checks native
Linux VAD network syscalls with automatic CI suppression disabled. Details are in the
[maintenance record](docs/development/DEPENDENCY_MAINTENANCE_2026-10.md#held-update-qualification--2026-10-13).

### Dependabot follow-up — 2026-10-13

Reviewed the initial seven dependency PRs, four newly unblocked proposals,
and every remaining base build pin. Applied filelock 4.1.1, pycparser 3.11,
tokenizers 0.23.3, regex 2026.9.29, the coordinated MLX/MLX Metal 0.32.3 pair,
Torch 2.14.1 only in the pruned macOS build closure, and the reviewed
Rust-toolchain action SHA. Managed AI runtimes retain their qualified pins.
Electron-builder 26.17.0, ONNX Runtime 1.31.0 and CTranslate2 4.8.3 remain
held for the qualification described in the maintenance record. Existing
Python 3.11/API ceilings remain. Future MLX updates are grouped.

Local `npm run test:all` passed: 1,126 JS passed / 2 skipped and 848 Python
passed / 7 skipped; syntax checks passed. Linux and Windows build-pin closure
checks passed; all three Python inventories have zero audit findings.
[Combined CI on 6de9143](https://github.com/AmirArshad/meeting-transcriber/actions/runs/38381564578)
passed all 13 jobs, including Windows/macOS/Linux packaging and audits, before
the first batch was pushed to `master`; the post-push run also passed all 13.
The second batch passed the same local full gate and all three Python audits;
its final cross-platform evidence is available through the commit's CI checks.
Review details and limits are in the
[October maintenance record](docs/development/DEPENDENCY_MAINTENANCE_2026-10.md#dependabot-follow-up--2026-10-13).

### Dependency maintenance — 2026-10-08

October 2026 dependency maintenance is on `master`. The decisions, evidence, exceptions
and holds are in [DEPENDENCY_MAINTENANCE_2026-10.md](docs/development/DEPENDENCY_MAINTENANCE_2026-10.md).
The macOS host gate passed on 2026-10-09. The CachyOS Linux
host gate below was run on 2026-10-08, and the FFmpeg 8.1.2 rebuild was
checked on the CachyOS test host on 2026-10-09. The Windows FFmpeg 8.1.2
recording check passed on 2026-10-09. Those host gates were not a merge requirement.

- **Security closures:**
  - Parakeet macOS lock: msgpack 1.2.3 and urllib3 2.8.0, regenerated from real wheels. Old runtimes require repair and are pruned.
  - Bootstrap pip 26.2.1.
  - rustls 0.23.45.
  - pyannote 4.0.7 with Torch 2.13.0, torchaudio 2.11.0 and TorchCodec 0.16.0; the resolved Windows closure has 0 findings. Old installs report out of date.
- **Other updates:**
  - Electron 44.7.0.
  - Compatible Python pins, including Numba/llvmlite as a pair on macOS and CTranslate2 4.8.2 on Windows and Linux.
  - macOS and Linux CPython 3.11.17+20261003, with hashes and attestations verified.
  - FFmpeg 8.1.2 on Windows, macOS, and Linux, with the matching source pin. Gyan has no 8.0.3 build, and 8.1.2 is the matching newer set.
- **Held:**
  - Windows embedded Python stays 3.11.9; its layout is a separate task.
  - electron-builder stays 26.16.1, with a dated sprintf-js exception.
- **Recurrence prevention:**
  - Dependabot covers Cargo and Actions, with groups and Python 3.11 ceilings.
  - CI adds read-only permissions and a weekly scan; Linux, Parakeet, pyannote-closure and Cargo audits; a vulnerable-fixture canary; SHA-pinned Actions; and test installs constrained to the build pins.
  - New inventory extractor and audit wrapper, with tests.
- **Evidence:** `npm run test:all` exited 0, with 1,114 JS passed / 4 skipped and 835 Python passed / 8 skipped.
- **Windows host gate, 2026-10-08:** packaged Electron 44.7.0 installer built and the unpacked app launched. A short WASAPI recording transcribed on CUDA with the packaged CTranslate2 4.8.2 stack. Speakrs CUDA and a Qwen summary ran. Real pyannote diarization is still open: no user token or cached gated model on this profile. Full manual checklists were not run.
- **Linux host gate, 2026-10-08 (CachyOS test host):** `master` `127f8db`. After `npm ci` and aligning the repo venv to the Linux build pins, JS was 1,122 passed / 2 skipped on Electron 44.7.0 and Python was 837 passed / 7 skipped. Packaged CPython 3.11.17 suite exited 0. AppImage, pacman, and deb built and verified; the unpacked app and the AppImage launched. A short PipeWire recording transcribed on managed CUDA. Isolated CTranslate2 4.8.2 matched the packaged 4.8.1 CUDA and CPU transcripts, so the Linux pin then moved to 4.8.2. The unchanged Parakeet CUDA runtime and installed Speakrs both ran on CUDA. Details and limits are in the maintenance record. Omarchy, a system package install, Qwen, and the long recording rows were not run.
- **macOS host gate, 2026-10-09 (Apple Silicon test host):** `master` `1b9f02d`. macOS 26.7.1 arm64, Node 26.11.0. After `npm ci` and aligning the repo venv to the macOS build pins (Numba 0.68.0, llvmlite 0.50.0, MLX 0.32.2), JS was 1,120 passed / 4 skipped on Electron 44.7.0 and Python was 835 passed / 9 skipped. The macOS build-pin closure check passed. `npm run build:mac` packaged Electron 44.7.0, CPython 3.11.17 and FFmpeg n8.0.1, and `npm run verify:mac:packaged` passed. Packaged CoreAudio-tap capture covered mic+desktop, desktop-only, mic-only, cancel and SIGKILL. MLX Whisper small transcribed the desktop file offline (`metal` / `float16`). Parakeet repair from the old lock to `3a1dae0f…` reached `ready` on Metal in an isolated profile and transcribed that file (`metal` / `float32`); the everyday profile was left on the old runtime. pyannote qualification exited 0 with `device: mps` and 0 audit findings. Speakrs CoreML and a Qwen balanced summary ran. The packaged app launched. Full manual checklists were not run. Details are in the maintenance record.
- **Done 2026-10-09:** the dependency graph, Dependabot alerts, and Dependabot security updates are enabled.
- **Linux FFmpeg 8.1.2 gate, 2026-10-09 (CachyOS test host):** `master` `a5e53ca`. Kernel `7.2.9-2-cachyos`, Hyprland 0.56.2, PipeWire 1.6.9, RTX 4070, driver 615.78.08, Node 26.11.1. The repo venv was already on the Linux build pins, including CTranslate2 4.8.2. With a temporary Electron float rule, JS was 1,126 passed / 2 skipped; Python was 848 passed / 7 skipped, and syntax passed. One combined run failed seven Python tests only because `HF_HUB_OFFLINE=1` was still set; the clean rerun passed. The Linux closure check passed. `pip-audit` on `requirements-linux-build.txt` reported 0 findings. `npm run build:linux` packaged Electron 44.7.0, CPython 3.11.17, CTranslate2 4.8.2 and FFmpeg n8.1.2, and `npm run verify:linux:packaged` passed. Unpacked and AppImage safeStorage smokes exited 0 (`gnome_libsecret`, `roundTrip: true`). Short PipeWire recordings covered mic+desktop, desktop-only, mic-only and cancel. Interrupted-capture recovery deleted the capture only after an FFmpeg 8.1.2 Opus decode; an empty capture was kept. Fixture import scan added one meeting. Packaged Whisper Small transcribed an isolated-sink fixture recording on CUDA (`float16`) and CPU (`int8`). Speakrs, Parakeet, Qwen, a visible window, a system package install, and the long recording rows were not run. macOS still needs this FFmpeg 8.1.2 check. Details are in the maintenance record.
- **Windows FFmpeg 8.1.2 gate, 2026-10-09 (Windows test host):** `master` `ddbb1ea`. Windows 11 Pro x64, build 10.0.26300, RTX 4070, driver 617.42, Node 22.15.0, npm 10.9.2. The repo venv is Python 3.11.9. `dist/win-unpacked` from 2026-10-08 still contains FFmpeg 8.0.1 and packaged CTranslate2 4.8.2; this pass did not rebuild the installer. The pinned Gyan 8.1.2 essentials zip verified as `db580001…a2ec`. Recorder CLI used that `ffmpeg.exe` through `AVANEVIS_FFMPEG`, with no sibling ffprobe. `backend/device_manager.py` exit 0. WASAPI USB webcam mic and HDMI monitor loopback selected; device volumes were left unchanged. The fixture `tests/fixtures/speakrs-two-speaker-16k.wav` played on the default output. Mic + desktop: 11.264 s, 203,175 bytes, mic max 0.140, desktop max 0.518, Opus 48 kHz stereo, stop stages through `post_processing_complete`, capture removed. Desktop only: 7.864 s, mic max 0.000, desktop max 0.499. Mic only: 5.461 s, desktop max 0.000, mic max 0.166. Cancel returned `{ success: true, cancelled: true }` and left no Opus. With a host PATH `ffprobe.exe` (2025-11-17 git build) present, one recovery probed then decoded a second time and still removed the capture. With that directory off PATH, SIGKILL recovery wrote a 3.755 s Opus file, reported `OK (ffmpeg decode)`, skipped `finalize_stage verify opus`, and deleted the capture only after that decode. An empty capture failed with `No mic audio was captured` and the directory stayed. FFmpeg 8.1.2 encoded the fixture to Opus (119,532 bytes), a null decode succeeded, and `meeting_manager.py scan` reported `scanned: 1`, `added: 1`. Packaged Whisper Small, `HF_HUB_OFFLINE=1`, transcribed the desktop-only file on CUDA (`float16`) and CPU (`int8`). Both transcripts begin `Design review starts at 10, and I prepared the agenda. Thanks, Hazel.` Speakrs, Qwen, Parakeet, a visible window, an NSIS install, and the long recording rows were not run. macOS still needs this FFmpeg 8.1.2 check. Details are in the maintenance record.

### Release readiness and publication path — 2026-10-04

v2.10.0 implementation, manual acceptance and adversarial-review fixes are
complete. All eight jobs in [CI on d168284](https://github.com/AmirArshad/meeting-transcriber/actions/runs/37193783409)
passed, including Windows/macOS/Linux build smoke and dependency audits.
Package/lockfile versions agree at 2.10.0; app/updater versions use
`app.getVersion()`. Release notes were checked against `v2.9.0..master` and
current README/roadmap/guide pointers refreshed. No in-scope blocker remains.

The user authorized an annotated `v2.10.0` tag and release build on 2026-10-04.
Tag push triggers `build-release.yml`, which verifies Speakrs artifacts, builds
and checks Windows/macOS/Linux installers, then publishes the GitHub Release
with curated notes and legal assets. Publication remains dependent on that run.
Deferred work below remains outside v2.10; no new hardware claims are added.

### Adversarial v2.10 RC review fixes — 2026-10-03

All three findings and their regression recommendations are addressed: Parakeet
compute verifies catalog hashes before probing/execution with trusted fingerprint
caching; transcript commit invalidates obsolete speaker metadata and summary
loading requires speaker-sidecar hash provenance; capture recovery durably retains
and replays exact selections until metadata acknowledgement. Failed retries keep
previous outputs. Added 12 JS and 7 Python regression cases, including real FFmpeg
promotion followed by process-response loss and restart discovery.

`npm run test:all` passed with repo-local Python 3.11.16; final JS evidence is
1,097 passed / 2 skipped. After installing the existing Linux pulsectl dependency,
the refreshed full Python suite passed 825 / 7 skipped. Syntax and diff checks
passed. Native GPU, real Speakrs/model and platform-specific acceptance were not
repeated; prior user-confirmed hardware evidence remains the acceptance basis.

### Manual acceptance and review handoff — 2026-10-03

The user confirmed all remaining checks were completed manually and good.
Parakeet release acceptance and the last Linux microphone-volume bullet are
closed by user sign-off, retaining current gain behavior. Release preparation is
complete pending adversarial code review. Commit and push on `master` are now
authorized; tag/release publication is not. See the
[manual acceptance record](docs/development/V2_10_LINUX_RELEASE_QUALIFICATION.md).

### Initial automated Linux release preparation — 2026-10-03

Version metadata was prepared as 2.10.0 on `master` for review.
Linux AppImage/pacman/deb builds and packaged verification passed. Baseline/final
regression gates passed; final source gate is 1,085 JS / 818 Python with 2 / 7
skips. Fixed Parakeet memory-error classification before stderr truncation and
persisted actionable guidance without changing runtime/fallback policy.

Real packaged-backend checks passed Qwen English/Spanish and prior-output
preservation, disconnected-network Parakeet CUDA short/repeated inference,
bounded allocation failure preservation, live backend capture recovery, and
controlled capture. Scoped package/profile upgrade evidence is bounded separately.
These are not packaged-renderer UI acceptance. Native desktop control is disabled,
and noninteractive sudo cannot perform a normal system-package upgrade. Source
volume stayed 48%; the reported reset cause remains unresolved, so no gain remedy
was added. Affected acceptance checkboxes were initially left open; the later user
manual sign-off above supersedes that status.

The initial automated pass left the candidate awaiting manual acceptance. See the
[dated Linux evidence and blockers](docs/development/V2_10_LINUX_RELEASE_QUALIFICATION.md)
and [candidate release notes](docs/releases/v2.10.0.md). Windows/macOS historical
results remain unchanged; their deferred checks are not qualified by CachyOS.
No staging, commits, pushes, tags, publication or workflow dispatch occurred.

### Merge scope update — 2026-10-01

Complete available Mac validation and merge the Qwen language branch to `master`.
Linux runtime/hardware checks are deferred until before the v2.10 release and
do not block this merge. The four deferred Parakeet lifecycle checks and Linux
microphone-volume investigation remain release work.

### Mac Qwen validation — 2026-10-01

English/Spanish full-runner and packaged-UI summaries passed on Apple M4 Pro /
macOS 26.7.1. Integration paths passed 9/9 and the near-budget Chinese probe
passed. Packaged build/verification and post-execution signatures passed. Fixed
Windows/Linux test fixtures that inherited the Mac architecture; `test:all`
passed 1,080 JS / 816 Python, with 4 / 9 existing platform/environment skips.
Regeneration confirmation/cancel and restart preservation passed.
[Evidence and limits](docs/development/V2_10_SUMMARY_QUALIFICATION.md).

### Mac dependency audit repair — 2026-10-01

PR #108 exposed three urllib3 2.7.0 advisories inherited from `master` in the
packaged Mac requirements. Updated the pin to 2.8.0 and regenerated the legal
inventory. Pinned-requirements audit, full regressions, fresh Mac package/build
verification, packaged English/Spanish generation and post-execution signatures
passed. Installed Qwen/Parakeet runtime pins stay unchanged. See the summary
evidence for the rebuilt artifact/report hashes.

### User scope update — 2026-09-30

Whisper Large v3 needs a quick functional smoke before exposure, not a
per-platform quality, timing, or memory qualification campaign. Users decide
whether Large suits their machine. Qwen language behavior needs practical
checks with the current model on one runtime, without repeating language-quality
evaluation per OS. These decisions supersede the qualification depth in the
older designs and status prose below. Keep existing runtime integrity/admission,
explicit downloads, cancellation, and preservation of recordings and prior output.

Recording and post-stop encoding assessment is dropped from v2.10. Keep the
Linux microphone-volume investigation. The four deferred Parakeet lifecycle
checks remain release work; this scope update does not waive them.

v2.10 is partly implemented. No-hardware UX and Whisper choice policy Slice A
have shipped. Parakeet is merged on `master`; its Windows packaged lifecycle
passed on 2026-09-30. Its checkbox stays open until the four deferred lifecycle
checks are recorded.

- Designs exist for inference performance, optional Parakeet, Whisper
  language/model policy, summarisation languages/models, and Settings /
  navigation / shortcuts.
- Whisper choice policy Slice A shipped in PR #102: Persian is off new
  choices; Tiny/Base are retired; Small is the floor; pending jobs keep their
  saved language/model. Slice B (Large v3) is implemented in the workspace and
  passed a quick Windows download/offline transcription smoke on 2026-09-30;
  [results](docs/development/V2_10_LANGUAGE_MODEL_QUALIFICATION.md). Slice C
  (other language removals) was dropped on 2026-09-29.
- Settings, navigation, keyboard shortcuts, and click-away meeting rename
  shipped in PR #103. The AvaNevis rail logo shipped in PR #104.
- Apple Silicon inference qualification (2026-09-14) retained current Opus
  encoding, Whisper defaults, and 32k summary context. No production change.
  Further inference-default changes were dropped on 2026-09-29.
- Linux Parakeet CachyOS CUDA 12 meeting screening is complete
  (2026-09-22). The uncontended batches defer Parakeet against Whisper Small
  and record a speed-versus-VRAM tradeoff against Whisper Medium, with WER
  effectively tied. Evidence is in
  [PARAKEET_COMPATIBILITY.md](docs/development/PARAKEET_COMPATIBILITY.md).
- The approved [three-platform Parakeet plan](docs/superpowers/plans/2026-09-22-parakeet-three-platform-gpu.md)
  supersedes the prior qualification prerequisite. On 2026-09-22, a pinned
  isolated install on an Apple M4 Pro passed live Metal admission and offline
  inference on a 14.22-second local English fixture. The app's compute queue
  and guarded meeting commit saved a timestamped transcript with `mps` /
  `float32` provenance and retained source audio. A retry with the runtime
  unavailable failed closed and kept the prior transcript/audio. This was a
  service-level smoke, not a renderer or packaged-app test. On 2026-09-23, a
  packaged CachyOS RTX 4070 smoke installed and validated managed CUDA 12,
  activated Parakeet, survived app restart with Whisper's English Small
  preference intact, and completed a 14.22-second local English fixture with
  `cuda` / `float32` provenance and retained playable source audio. Linux
  packaged build verification passed for AppImage, pacman, and deb; this is a
  bounded short-clip smoke, not completion of the remaining lifecycle checks.
  On 2026-09-24 a dev-electron lifecycle on the same CachyOS host covered setup
  cancel/repair/validate/remove,
  quit/resume, seams on a repeated short clip, guided Speakrs and guidance
  fallback, runtime-loss fail-closed, and an explicit Whisper retry. On
  2026-09-25 the same dev-electron lifecycle passed on an Apple M4 Pro: Metal
  `mps` / `float32` for Parakeet, `mps` / `float16` for the explicit Whisper
  Small retry, and the same exceptions. On 2026-09-25 the same dev-electron
  lifecycle passed on Windows 11 x64 with an RTX 4070: CUDA `cuda` /
  `float32` for Parakeet, `cuda` / `float16` for the explicit Whisper Small
  retry, and the same exceptions. The first Windows probe failed closed until
  the isolated interpreter loaded the standard-library DLL directory and
  preloaded the pinned CUDA 12 libraries. On 2026-09-29 the same lifecycle
  passed in a packaged arm64 app on the Apple M4 Pro: Metal `mps` /
  `float32` for Parakeet, `mps` / `float16` for the explicit Whisper Small
  retry, and the same exceptions. Network disconnect, memory pressure,
  live recording recovery, and packaged update survival were not run. The
  Windows packaged lifecycle passed on 2026-09-30 after two embedded-Python
  launch fixes, covering setup/activation, restart, quit/resume, cancellation,
  seams, guided work/fallback, runtime loss, explicit Whisper retry, and removal.
  The four deferred checks remain open. Details are in the plan.
- On 2026-09-29, v2.10 dropped extra transcription-language removals,
  alternative summary-model evaluation, and further inference-default changes.
  Apple Silicon already rejected lower Opus effort, MLX decode changes, and a
  smaller summary context. Windows and Linux inference defaults are not being
  pursued.
- Remaining committed work: Parakeet acceptance gates and the Linux
  microphone-volume investigation. Qwen summary-language support is implemented
  in the workspace with bounded one-runtime evidence (2026-09-30).
- CI audit repair — 2026-09-30: the latest pre-Large CI run failed npm audits
  on vulnerable override pins. Updated only brace-expansion, fast-uri and undici
  patch pins and regenerated the lockfile. Clean `npm ci`, zero-vulnerability
  `npm audit --audit-level=high`, `test:all`, Windows `build:dir` and packaged
  Speakrs/layout checks passed locally before commit/push.

## Historical next step after v2.10.0

This section predates v2.10.3. The current next-version scope is recorded at
the top of this file and in the v2.11 plan.

v2.10.0 is tagged, and October dependency maintenance is on `master`. Dependabot
alerts and security updates are enabled. No tag or release-workflow action remains.

Still open, and already recorded below: AUR publishing, Apple notarization, and the
preflight trusted-sender note; Windows embedded Python 3.11.9; and real Windows pyannote diarization, which still
needs a user token and the gated model. (The sprintf-js exception was retired
on 2026-10-17 by the global-agent 4 override; the zip RustSec ignores in
`native/speakrs-cli/.cargo/audit.toml` are due for review by 2027-01-31.)
Python modernization is a separate branch,
not work on `master`. The October host gates did not repeat the
full manual checklists. The macOS FFmpeg 8.1.2 gate closed on 2026-10-17, so the
post-v2.10 maintenance on `master` is ready to ship as a patch release.
v2.10.1 release prep landed on 2026-10-17 (version 2.10.1 in
`package.json`/lockfile, release notes, full gate 1,125 JS / 847 Python
passing on this Mac). The first prep CI run failed only the cargo-audit
job on RustSec advisories published after the previous green run; the
rustls 0.23.46 bump, dated zip audit ignores, and the global-agent 4
override that retires the sprintf-js exception followed the same day.
CI passed all 13 jobs on the fix commit, the annotated `v2.10.1` tag was
pushed, and the release workflow published
[AvaNevis v2.10.1](https://github.com/AmirArshad/meeting-transcriber/releases/tag/v2.10.1)
with all platform installers. The sequencing
below records the earlier implementation order.

## How to sequence the work (historical)

Settings, click-away rename, and the transcription **policy** change (Persian /
Tiny / Base off new choices) did not wait on hardware investigations. Whisper
Large passed its quick functional smoke on 2026-09-30; Qwen languages need practical checks
on one runtime without repeated quality evaluation per OS. Extra language removals,
alternative summary models, and inference-default changes were dropped on
2026-09-29. The approved Parakeet plan allows implementation before the
remaining host checks while retaining live GPU admission.

1. **Shipped without hardware qualification:** Settings presentation, keyboard
   shortcuts, click-away rename, and the curated Whisper choice list (Slice A).
2. **Active Parakeet implementation:** Complete guided transcription, engine
   activation and recovery UI, packaging/legal/contracts, and the remaining
   lifecycle checks in the approved three-platform plan. The CachyOS, Mac, and
   Windows dev-electron lifecycles and the packaged Mac lifecycle have passed.
   The Windows packaged lifecycle passed on 2026-09-30; the four deferred
   Parakeet release checks remain. The Linux microphone-volume investigation
   remains on its matching release machine. Qwen summary-language checks and
   matching are complete in the workspace, with bounded evidence recorded
   separately. Details and hosts
   are in the [plan index](docs/superpowers/plans/2026-09-06-v2.10.md).
3. **Implement with focused checks:** Large v3 is implemented and its Windows
   download/cache reuse and ordinary/guided-window smoke passed on 2026-09-30;
   summary-language support is implemented with passing practical checks
   on one runtime.

Keep recordings, transcripts, tokens, scratch reports, and user paths out of
git. Public qualification notes should identify hardware class, OS, app
revision, and artifact hashes — not home directories or meeting content.

## v2.10 scope — committed

### Transcription and language support

Design: [Language/model policy and Whisper Large](docs/superpowers/plans/2026-09-07-language-model-policy-whisper-large.md).
Slice A (curated choices) shipped in PR #102 without Large. Slice B (Large v3)
is implemented in the workspace with a passing Windows functional smoke and
regressions; [evidence and limits](docs/development/V2_10_LANGUAGE_MODEL_QUALIFICATION.md).
Slice C (other language removals) was dropped from
v2.10 on 2026-09-29; the languages still listed stay.

- [x] Remove Farsi/Persian from the language list because of poor observed performance.
- [x] Add Whisper Large (v3) as a transcription model option, keeping Small default.
  Implemented inline on 2026-09-30: canonical v3 runtime/cache/lock identity for
  `large` and `large-v3`, explicit preload, offline ordinary/guided compute and
  saved-preference restoration. Windows 11 / RTX 4070 short-fixture smoke passed
  on CUDA/float16. `npm run test:all` passed (1,062 JS / 734 Python; 4 / 8 skips).
  No performance/memory studies or per-OS qualification campaign.
- [x] Remove Tiny and Base model options; Small becomes the smallest available Whisper model.
- [x] Add optional English-only Parakeet transcription in Settings for Windows CUDA, Apple Silicon Metal, and Linux managed CUDA. The approved [three-platform plan](docs/superpowers/plans/2026-09-22-parakeet-three-platform-gpu.md) governs implementation. The Mac service-level smoke, the CachyOS, Mac, and Windows dev-electron lifecycles, and the packaged Mac lifecycle passed. The Windows packaged lifecycle passed on 2026-09-30. Network disconnect, memory pressure, live recording recovery, and packaged update survival were closed by user-reported manual acceptance on 2026-10-03; see the dated Linux qualification record. Do not claim a speed, memory, or accuracy win from these runs.

### Summarisation

Design: [Qwen language support and alternative summarisation models](docs/superpowers/plans/2026-09-07-summary-languages-and-models.md).
Slice A is implemented in the workspace with practical checks on the installed
Qwen3.5 9B model and one Windows CUDA runtime;
[evidence and limits](docs/development/V2_10_SUMMARY_QUALIFICATION.md).
Alternative-model evaluation (slice B) remains out of v2.10.

- [x] Explore which languages the current Qwen summarisation model actually supports.
  15/15 synthetic generation fixtures passed for the 11 retained IDs, including
  Chinese/Panjabi script cases and Portuguese variants. Local classifier controls
  passed 15/15 language cases and 2/2 indeterminate short/mixed cases.
- [x] Enable summarisation only for the supported languages retained by the product.
  `en/es/fr/de/zh/ja/it/pa/hi/ko/pt` are enabled for the installed 9B model under
  the existing runtime gates. Replacement entries and removed/unknown IDs are
  unavailable; no model selector, downloads or new runtime policy.
- [x] Ensure Qwen summary output matches the language of the transcript.
  Confirm transcript language against its hash; propagate it through chunk,
  merge, JSON repair and grounded regeneration. Local input/prose checks fail
  closed with the existing bounded repair budget. Localized Markdown and
  language/model/policy provenance are saved without changing meeting language.
  Real two-chunk/merge, repair/retry, sidecar and negative checks passed. Focused
  regressions and `npm run test:all` passed; prior-summary, queue/cancel/quit and
  finalization protections remain covered.
  Adversarial-review follow-up (2026-09-30): localized denial guards now reject
  all 13 retained-language/script examples with one shared retry and prior-file
  protection. Policy v2 uses unrestricted actual-language classification and
  explicit predominant-share admission; Marathi was a demonstrated v1 false
  positive. Five neighbor controls reject closest supported confirmations;
  balanced input fails admission, and the above-floor names-only control is
  indeterminate. Every regeneration opens an editable confirmation dialog.
  Short Chinese/Hindi and predominant Spanish/Hindi Concise checks pass;
  corrected chunk/merge/repair/sidecar paths pass 9/9. `test:all`: 1,079 JS and
  814 Python passed (4/8 existing skips), both syntax gates passed.
  Evidence now distinguishes pipeline
  self-classification from manual content inspection and Windows-only coverage.
  The near-full Chinese chunk failure was reproduced and traced to character
  undercounting: 55,814 runtime input tokens exceeded the unchanged 32,768
  context. The fix committed as `7496cfb` estimates UTF-8 bytes and bounds quoted
  repair output to 12,000 bytes. The near-budget Chinese check, the original
  input through three chunks/merge, and a forced near-budget JSON repair passed.
  `test:all`: 1,079 JS / 817 Python passed, with 4 / 8 existing skips and both
  syntax gates passing. Estimates remain heuristic; arbitrary oversized segments
  and large merges are not qualified. Apple Silicon English/Spanish functional
  smokes passed on 2026-10-01.
  Linux CUDA English/Spanish functional smokes passed on 2026-10-03; remaining
  packaged UI acceptance was confirmed manually by the user. See the evidence document for report
  hashes and limits.

### Settings and navigation UX

Design: [Settings, navigation and keyboard shortcuts](docs/superpowers/plans/2026-09-07-settings-navigation-shortcuts.md).
This slice does not wait on model investigations. Removing Speakrs must
preserve any saved Hugging Face token; token deletion applies only to
Pyannote removal.

- [x] On Linux, remove or redesign the clickable Speakrs tab when Speakrs is the only available speaker-identification engine.
- [x] Preserve saved Hugging Face tokens when removing Speakrs and remove token warnings from its confirmation; token deletion and warnings apply only to Pyannote removal.
- [x] Revisit Setup / Install Model / Remove Model terminology in favor of clearer feature enable/disable language, without changing underlying functionality.
- [x] Add timestamps to the AI Add-ons log in Settings.
- [x] Improve the Record navigation icon so it does not imply that clicking it starts recording.
- [x] Consider removing the inactive microphone icon at the top and using that visual position for the Record page icon.
- [x] Add the AvaNevis app logo above the Record page icon in the rail. Decorative only; Record keeps the microphone treatment.

### Meeting and keyboard UX

- [x] Save a meeting rename when the user clicks away while editing. Shipped in PR #103; not part of the Settings/shortcuts plan.
- [x] Add cross-platform keyboard shortcuts that avoid system shortcut conflicts, including start recording, stop recording, and navigation to Record, History, and Settings. Design is in the Settings/shortcuts plan; remaining packaged acceptance was confirmed manually by the user on 2026-10-03.

### Linux microphone volume

- [x] Investigate Linux input-volume defaults: determine why some PipeWire/PulseAudio setups reset the microphone to 50%, measure capture/transcription impact, and assess a safe app-side or setup-side remedy without unexpectedly changing user device settings. Linux desktop session only. Investigation recorded on 2026-10-03: measured source volume stayed 48%, reset attribution was not established, and current gain behavior was retained. The user confirmed manual checks were good and accepted closure; no device-gain remedy was added.

## Deferred beyond v2.10

- [x] Perform a live CachyOS/Omarchy install smoke; verified working on the supported Linux setup.
- [ ] Claim `avanevis-bin` on the AUR and revisit AUR publishing automation later, likely around/after v3 rather than in v2.10.
- [ ] Revisit Apple Developer signing/notarization later, likely around/after v3 and only when enrollment/timing make it worthwhile; retain ad-hoc macOS packaging checks meanwhile.
- [ ] Revisit the pre-existing `run-recording-preflight` trusted-renderer-sender observation only as a separate security task.
- [ ] Modernize Python to current 3.11 practice on its own branch: builtin generics, orderly imports, and a committed Ruff/basedpyright standard. Formatting and annotations first. Exception handling, file lifetime, and subprocess calls stay a later reviewed slice. Brief: [Python modernization](docs/superpowers/plans/2026-10-09-python-modernization.md).

## Release history

- **v2.10.1 — released 2026-10-17:** History interaction fixes, faster post-stop finalization, October 2026 dependency/security maintenance (Electron 44.7.0, FFmpeg 8.1.2, ONNX Runtime 1.31 telemetry suppression, Pyannote 4.0.7 closure, rustls 0.23.46, sprintf-js exception retired) with all host gates closed.

- **v2.10.0 — release-ready; tag-driven publication:** optional Parakeet, Whisper Large v3, checked Qwen summary languages, Settings/navigation UX, integrity/provenance/recovery fixes and dependency pins.

- **v2.9.0 — released:** Electron 44.1.0, dependency hygiene, reliability follow-through, Omarchy-inspired UI refresh, Linux CUDA/AI gates, and explicit Mic + Desktop / Mic Only / Desktop Only capture modes.
- **v2.8.0 — released:** Linux Core Beta for Omarchy 4 and CachyOS x86_64 Hyprland/Wayland + PipeWire.

## Agent setup maintenance

- [x] Canonical four-tool instructions and skill links — implemented and preservation-audited; see [audit](docs/development/AGENT_SETUP_AUDIT.md).
