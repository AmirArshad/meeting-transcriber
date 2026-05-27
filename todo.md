# Dependency upgrade program (active)

Working branch: `chore/phased-dependency-upgrades` (cut from `master` after security hardening `15add55`).

Goal: stay current on dependencies without breaking recording, transcription, packaging, or local AI add-ons. Merge **one phase per PR**; run automated tests plus the manual smoke sections listed under each phase before merging to `master`.

Dependabot PRs (reference only — merge via phase branches, not blindly):

| PR | Package | Target phase |
|----|---------|----------------|
| #2 | filelock + certifi (group) | Phase 1 — **done** (close PR) |
| #6 | more-itertools | Phase 1 — **done** (close PR) |
| #7 | click | Phase 1 — **done** (close PR) |
| #8 | idna | Phase 1 — **done** (close PR) |
| #5 | soxr 0.3.7 → 1.1.0 | Phase 2 — **done** (close PR) |
| #9 | pytest ≥9 | Phase 3 — **done** (close PR) |
| #3 | numpy 1.26 → 2.x | Phase 4 |
| #4 | scipy 1.11 → 1.17 | Phase 4 |

---

## Phase 0 — Security baseline (done on `master`)

- [x] Pin `filelock==3.20.3` in `requirements-*-build.txt`; floor `>=3.20.3` in dev/platform requirements.
- [x] Move Whisper download locks out of `/tmp` into user-private cache lock dirs.
- [x] CI: `npm audit --audit-level=high` (fail build).
- [x] CI: `pip-audit` on platform runners (`security-audit` matrix: npm / macOS pins / Windows pins).
- [x] Add `.github/dependabot.yml` (weekly npm + pip; review before merge).

**Automated:** `npm test`, `npm run test:python`, `npm audit`, `pip-audit -r requirements-macos-build.txt` (macOS), Windows equivalent.

---

## Phase 1 — Low-risk runtime utilities + npm patches ✅

**Status:** Complete (packaged smoke passed). Merge to `master` when ready. Close Dependabot PRs #2, #6, #7, #8.

**Scope:** Transitive / small packages with minimal app surface area.

- [x] Bump `certifi`, `idna`, `click`, `more-itertools` in `requirements-*-build.txt` (match Dependabot pins).
- [x] Bump `filelock` 3.20.3 → 3.29.0 in build pins (PR #2); keep `>=3.20.3` floor in dev requirements.
- [x] `adm-zip` / `electron` patch already on `master` (`^0.5.17`, `^42.2.0`).
- [x] Regenerate `legal/PYTHON-BUNDLED-PACKAGES.md` (`node scripts/generate-python-sbom.js`).
- [x] Dependabot: ignore `numpy` / `scipy` **major** until Phase 4.

**Files:** `requirements-*-build.txt`, `legal/PYTHON-BUNDLED-PACKAGES.md`, `.github/dependabot.yml`.

**Automated (required):**

```bash
npm test
npm run test:python
npm audit --audit-level=high
# macOS: .venv/bin/pip-audit -r requirements-macos-build.txt
```

**Manual smoke (light) — use packaged app, not `npm start`:**

Do **not** use `npm start` / `npm run dev` for dependency-phase smoke. Dev mode uses repo `.venv` Python and different paths; recording/transcription QA must hit the **bundled** runtime from `dist/`.

```bash
npm run prepare-build
npm run build:mac:dir   # macOS → dist/mac-arm64/AvaNevis.app
# or
npm run build:dir       # Windows → dist/win-unpacked/AvaNevis.exe
```

**Launch the built binary** (quit any dev instance first):

- **Windows:** `dist\win-unpacked\AvaNevis.exe` (Explorer double-click or `Start-Process .\dist\win-unpacked\AvaNevis.exe` from repo root)
- **macOS:** open `dist/mac-arm64/AvaNevis.app`

**Minimum pass** (`tests/manual/recording-smoke-checklist.md`): Cross-platform § (launch → record → stop → transcribe → save) plus **Windows** § (mic + WASAPI loopback, balanced mix). Optional for Phase 1: full macOS/Windows sections.

- [x] Launch **built** app from `dist/` — Settings opens, no startup errors. (macOS)
- [x] Launch **built** app from `dist\win-unpacked\AvaNevis.exe` — Settings opens, no startup errors. (Windows)
- [x] `tests/manual/recording-smoke-checklist.md` § Cross-platform + § Windows using the **packaged** binary. (Windows)

**Merge gate:** ✅ Automated green; packaged smoke passed (macOS + Windows).

---

## Phase 1b — Installer slimming (unused Python pins) ✅

**Status:** Complete. Windows `scipy` removed; macOS `soxr` removed; macOS `scipy` investigated (cannot drop from bundle — see size notes). Merge when ready. Size notes: `docs/development/INSTALLER_SIZE_NOTES.md`.

**Scope:** Shrink bundled Python in `dist/` without changing product features. Almost all installer weight is `build/resources/python` (~1 GB macOS) + ffmpeg (~76 MB macOS), not npm. Diarization, summaries, and Whisper weights stay **out** of the default installer (userData / cache) — no change needed there.

**Audit reference (macOS build sizes observed):** `torch` ~368 MB, `mlx` ~178 MB, `scipy` ~112 MB, `llvmlite`/`numba` ~144 MB, `numpy` ~60 MB — only `scipy` and `soxr` on mac look unused by app code.

### Not bloat (do not remove)

- **npm:** `adm-zip` (runtime), `electron` / `electron-builder` (dev/build only) — already minimal.
- **ffmpeg binary** — required for Opus post-processing after recording.
- **macOS Swift helper** — required for desktop audio.
- **torch + mlx + lightning-whisper-mlx** — macOS Apple Silicon transcription stack (large but intentional).
- **faster-whisper + ctranslate2 + soxr** — Windows transcription + resampling.
- **pip on macOS bundle** — intentional for optional diarization setup into userData.
- **ffmpeg source `.tar.xz`** — **not** in default app; only `npm run legal:release-assets` (compliance). Shipped `legal/` is notices + JSON only.
- **Whisper model pre-bundle** — skipped unless `DOWNLOAD_MODELS=true` (Windows); macOS uses MLX cache on first use.

### High confidence — do first

- [x] **Remove `soxr` from macOS build pins** (`requirements-macos-build.txt`, `requirements-macos.txt`, `requirements-common.txt`). macOS never imports `backend/audio/processor.py` (Windows-only resampling path).
- [x] **Remove `scipy` from `requirements-windows-build.txt`** and `requirements-windows.txt`. App uses **soxr** only (`processor.py`).
- [x] Record **before/after** sizes in `docs/development/INSTALLER_SIZE_NOTES.md`.

### Medium confidence — validate with packaged smoke

- [x] **Try removing `scipy` from `requirements-macos-build.txt`** (~112 MB). **Result:** No bundle savings — `lightning-whisper-mlx==0.0.10` always pulls `scipy`. Explicit pin kept for reproducible builds; documented in `INSTALLER_SIZE_NOTES.md`.
- [ ] **Trial drop explicit transitive-only pins** — deferred (Phase 5 / future trim pass).

### Low priority — small or diminishing returns

- [ ] **PyObjC `Cocoa` / `Quartz`** in mac pins — not directly imported; test removal with `pip check` + SCK fallback smoke if pursued.
- [ ] **Further torch pruning** — `prepare-resources.js` already removes `torchgen`, tests, `caffe2`, etc.; expect small gains only.
- [ ] **Windows `onnxruntime` / `tokenizers` / `av`** — faster-whisper transitive; only removable if a slimmer faster-whisper install graph is confirmed.

### Probably not worth chasing soon

- **numba / llvmlite** on mac — MLX/torch transitive; graph surgery only.
- **Bundled mac `torch`** — required for lightning-whisper-mlx unless transcription architecture changes.
- **npm lockfile transitive bulk** — dev/CI only.

**Files:** `requirements-macos-build.txt`, `requirements-windows-build.txt`, loose `requirements-*.txt`, `legal/PYTHON-BUNDLED-PACKAGES.md`, optionally `requirements-macos.txt` comments (scipy/soxr notes).

**Automated (required):**

```bash
npm test
npm run test:python
npm audit --audit-level=high
# After pin changes: npm run prepare-build (platform-native host)
```

**Manual smoke — packaged app only (not `npm start`):**

```bash
npm run prepare-build
npm run build:mac:dir    # macOS → dist/mac-arm64/AvaNevis.app
npm run build:dir        # Windows → dist/win-unpacked/AvaNevis.exe
```

Launch `AvaNevis.exe` / `AvaNevis.app` from `dist/` — not `npm start`.

- [x] App launches from `dist/` with no Python import errors on startup. (Windows, post–1b+2 rebuild)
- [x] Record → stop → transcribe → save (Windows, post–1b+2 rebuild).
- [x] **Windows:** faster-whisper + `soxr==1.1.0` packaged smoke passed (2026-05-27).
- [ ] **macOS:** launch + short MLX transcribe after `build:mac:dir` (soxr removed from bundle; scipy unchanged). Same checklist as Phase 1 on a Mac before merge if not already done on branch.

**Merge gate:** ✅ Windows — `prepare-build` + packaged smoke passed. macOS — CI `build:mac:dir` + backend tests; optional Mac manual smoke before merge.

---

## Phase 2 — soxr 1.x (audio resampling) ✅

**Status:** Complete. Windows bundled `soxr==1.1.0`; macOS has no bundled soxr (N/A). Close Dependabot PR #5.

**Scope:** `soxr==0.3.7` → `1.1.0` (Dependabot PR #5). Single integration point: `backend/audio/processor.py` (`soxr.resample(..., quality='VHQ')`).

- [x] Update `soxr` pin in Windows / dev `requirements*.txt` and `requirements-windows-build.txt` (removed from macOS pins in Phase 1b).
- [x] Regenerate `legal/PYTHON-BUNDLED-PACKAGES.md`.
- [x] Confirm packaged build installs `soxr` 1.1.0 wheel on Windows (`npm run prepare-build` + `build:dir`).

**Automated (required):** Phase 1 commands plus CI packaged-build smoke jobs if touched.

**Manual smoke (required — audio quality):**

- [x] `tests/manual/recording-smoke-checklist.md` § **Windows** (WASAPI loopback + mix balance; 2026-05-27).
- [ ] **macOS:** § first bullet only if validating a Mac build (no soxr in mac bundle; recording path unchanged).
- [x] Windows: no truncated tail / obvious pitch artifacts observed in smoke.

**Merge gate:** ✅ Windows — resample path OK with `soxr` 1.1.0.

---

## Phase 3 — Dev tooling (pytest 9) ✅

**Status:** Complete. Close Dependabot PR #9. No packaged runtime change; merge with 1b+2.

**Scope:** `requirements-dev.txt` only (Dependabot PR #9). No packaged runtime change.

- [x] Bump `pytest>=9.0.3` in `requirements-dev.txt`.
- [x] Fix any test API deprecations if CI reports failures. (`npm run test:python` — 224 passed)

**Automated (required):**

```bash
npm run test:python
npm test
```

**Manual smoke:** None (dev-only).

**Merge gate:** Full Python + JS test suites pass.

---

## Phase 4 — ML stack: NumPy 2 + SciPy (coordinated)

**Scope:** **Do not merge Dependabot #3 or #4 alone.** Upgrade as one coordinated change:

- `numpy==1.26.4` → 2.x
- `scipy==1.11.4` → version compatible with NumPy 2
- Re-validate pins: `lightning-whisper-mlx`, `mlx`, `torch`, `numba`, `llvmlite`, `faster-whisper`, `ctranslate2`, `onnxruntime` (Windows)

**Pre-work:**

- [ ] Research compatible versions for Apple Silicon MLX path and Windows faster-whisper path (check upstream release notes / issue trackers).
- [ ] Create Phase 4 branch from latest `master` after Phases 1–3 merged.

**Implementation:**

- [ ] Update `requirements-macos-build.txt` and `requirements-windows-build.txt` together.
- [ ] Align loose floors in `requirements-macos.txt` / `requirements-windows.txt` where needed.
- [ ] Run full `npm run prepare-build` locally or rely on CI packaged smoke.
- [ ] Regenerate SBOM; update `THIRD_PARTY_NOTICES.md` if versions shift materially.

**Automated (required):**

```bash
npm run test:all
npm run prepare-build   # before release-minded merge
```

CI: `test-backend-macos`, `test-backend-windows`, `test-frontend` build smoke, `security-audit` matrix.

**Manual smoke (required — full product):**

- [ ] `tests/manual/recording-smoke-checklist.md` — full macOS + Windows + Cross-platform sections.
- [ ] `tests/manual/recording-transcription-regression-checklist.md` (minimum regression pass).
- [ ] macOS: MLX transcription (small model preload + transcribe short clip).
- [ ] Windows: faster-whisper transcription (CPU or CUDA if available).
- [ ] Optional add-ons (if installed on test machine): `tests/manual/local-ai-addons-checklist.md` § diarization/summary smoke subset.

**Merge gate:** Transcription works on both platforms; packaged app builds; no new `pip-audit` / `npm audit` high findings.

---

## Phase 5 — Ongoing hygiene

- [ ] Review open Dependabot PRs weekly; map each to Phase 1–4 rules (reject isolated numpy/scipy majors).
- [ ] After Phase 4, allow Dependabot patch/minor on numpy/scipy within compatible ranges.
- [ ] Document final pinned versions in `docs/development/LOCAL_AI_MODEL_CATALOG.md` only if ML pins change behavior.
- [x] Re-enabled Dependabot patch/minor for `soxr` and `pytest` (removed from `.github/dependabot.yml` ignore list after Phases 2–3).

---

## Post-dependency project — Transcription retry and recording recovery

**Plan:** `docs/design/TRANSCRIPTION_RETRY_RECOVERY.md`

**Trigger:** A completed 92-minute Windows recording was preserved on disk, but faster-whisper failed during CUDA segment processing with `cublas64_12.dll` missing from the packaged runtime. The app did not save the recording to History because transcription failed before `addMeeting`.

**Scope:**

- [ ] Verify CUDA runtime DLL loadability, not just CUDA device presence.
- [ ] Add explicit transcriber `--device auto|cpu|cuda` support.
- [ ] Retry known CUDA runtime transcription failures once on CPU.
- [ ] Persist completed recordings to History even when transcription fails.
- [ ] Add History retry action for failed or pending transcriptions.
- [ ] Extend scan/import to recover audio-only recordings with placeholder transcripts.

**Validation:**

- [ ] Automated: `npm test`, `npm run test:python`.
- [ ] Windows packaged smoke: healthy CUDA transcribes on GPU.
- [ ] Windows packaged smoke: broken CUDA runtime falls back to CPU and saves transcript.
- [ ] Recovery smoke: existing `.opus` without transcript appears in History and can be retried.

---

## Execution order

1. Phase 1 → merge to `master` ✅ (smoke done on branch)  
2. Phase 1b + 2 + 3 → ready to merge ✅ (Windows packaged smoke done; macOS CI + optional Mac manual)  
3. Phase 4 → merge → full smoke  
4. Phase 5 → continuous  
5. Transcription retry and recording recovery → implement from `docs/design/TRANSCRIPTION_RETRY_RECOVERY.md`

---

# Next Project Decision (deferred)

Previous project plans:

- `docs/internal/TODO_ARCHIVE_2026-05-18_LOCAL_AI_ADDONS.md`
- `docs/internal/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md` (security/performance remediation — merged 2026-05-20)

## Candidate projects (after dependency program)

- [ ] Acoustic echo cancellation / echo suppression for speaker-use scenarios (cross-platform Windows + macOS).
- [ ] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the same transcription/summary/history flow as recorded meetings.
- [ ] History chat over past meetings using the installed local summary runtime/model.

## Recommendation

- [ ] Start with **Acoustic echo cancellation / suppression** first.
  - Reason: highest recording/transcript quality impact for speaker users, and it improves core output quality before adding new ingestion/query features.

## Decision gate

- [ ] Confirm the next project to execute after dependency phases complete.
- [ ] Create a focused implementation plan once the project is chosen.

## Deferred architectural backlog (from remediation Phase 7)

See `docs/internal/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md` § Phase 7 for full notes. Highlights:

- [ ] Stream-to-disk during capture (long-recording memory)
- [ ] Packaged Swift helper: skip `which()` when `AVANEVIS_PACKAGED=1`
- [ ] Optional: stricter device validation toggle; scan lock/idempotency improvements
