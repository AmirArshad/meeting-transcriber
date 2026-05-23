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
| #5 | soxr 0.3.7 → 1.1.0 | Phase 2 |
| #9 | pytest ≥9 | Phase 3 |
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

Recording/desktop audio paths require a built app under `dist/` (dev `npm start` is not valid for audio QA on this machine).

```bash
npm run build:mac:dir   # macOS: dist/mac-arm64/AvaNevis.app
# or npm run build:dir on Windows → dist/win-unpacked/
```

- [x] Launch **built** app from `dist/` — Settings opens, no startup errors.
- [x] `tests/manual/recording-smoke-checklist.md` § Cross-platform (launch → record → stop → transcribe → save) using the **packaged** binary.

**Merge gate:** ✅ Automated green; packaged smoke passed.

---

## Phase 1b — Installer slimming (unused Python pins)

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

- [ ] **Remove `soxr` from macOS build pins** (`requirements-macos-build.txt`, `requirements-macos.txt`, `requirements-common.txt` if mac-only parity). macOS never imports `backend/audio/processor.py` (Windows-only resampling path). ~2 MB + cleaner pins.
- [ ] **Try removing `scipy` from `requirements-windows-build.txt`** (and `requirements-windows.txt`). App uses **soxr** only (`processor.py`); scipy was replaced per `docs/design/INSTALLER_PERFORMANCE_IMPROVEMENTS.md`. Re-run `prepare-build` on Windows, measure `dist/win-unpacked` size, transcribe smoke.
- [ ] Record **before/after** `du -sh build/resources/python` and packaged app size in a short note (commit message or `docs/development/` one-liner).

### Medium confidence — validate with packaged smoke

- [ ] **Try removing `scipy` from `requirements-macos-build.txt`** (~112 MB in site-packages). No `import scipy` in `backend/`; comment claims lightning-whisper-mlx needs it — verify with MLX transcribe on short clip after `npm run build:mac:dir`. If import fails at runtime, revert and document actual transitive requirement.
- [ ] **Trial drop explicit transitive-only pins** on one platform (e.g. `tiktoken`, `regex`, `networkx`, `sympy` already pruned post-install on mac) — prefer `pip install` resolving from minimal direct deps, then diff lock/pins. Higher engineering cost; do only if high-confidence trims succeed.

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
npm run build:mac:dir    # macOS
# npm run build:dir    # Windows
```

- [ ] App launches from `dist/` with no Python import errors on startup.
- [ ] Record → stop → transcribe → save (cross-platform checklist minimum).
- [ ] **macOS only if scipy removed:** MLX transcription on short meeting.
- [ ] **Windows only if scipy removed:** faster-whisper transcription on short meeting.

**Merge gate:** `prepare-build` succeeds; site-packages size reduced or unchanged; packaged smoke passes on affected platform(s).

---

## Phase 2 — soxr 1.x (audio resampling)

**Scope:** `soxr==0.3.7` → `1.1.0` (Dependabot PR #5). Single integration point: `backend/audio/processor.py` (`soxr.resample(..., quality='VHQ')`).

- [ ] Update `soxr` pin in all `requirements*.txt` and both `requirements-*-build.txt`.
- [ ] Regenerate `legal/PYTHON-BUNDLED-PACKAGES.md`.
- [ ] Confirm packaged build still installs soxr wheel on Windows + macOS (`npm run prepare-build` smoke or CI `build:dir` / `build:mac:dir`).

**Automated (required):** Phase 1 commands plus CI packaged-build smoke jobs if touched.

**Manual smoke (required — audio quality):**

- [ ] `tests/manual/recording-smoke-checklist.md` § **Windows** (WASAPI loopback + mix balance).
- [ ] If macOS dev box available: § **macOS** first bullet (mic + desktop while system audio plays).
- [ ] Compare saved recording sample rate / length vs pre-upgrade on same machine (no truncated tail).

**Merge gate:** No resample crashes; no obvious pitch/tempo artifacts on Windows loopback path.

---

## Phase 3 — Dev tooling (pytest 9)

**Scope:** `requirements-dev.txt` only (Dependabot PR #9). No packaged runtime change.

- [ ] Bump `pytest>=9.0.3` in `requirements-dev.txt`.
- [ ] Fix any test API deprecations if CI reports failures.

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
- [ ] Consider pinning `soxr` major in Dependabot (`@dependabot ignore` removed for soxr after Phase 2 proves stable).

---

## Execution order

1. Phase 1 → merge to `master` ✅ (smoke done on branch)  
2. Phase 1b → merge → packaged smoke per platform touched  
3. Phase 2 → merge → audio smoke (Windows-focused; mac may drop soxr pin in 1b first)  
4. Phase 3 → merge  
5. Phase 4 → merge → full smoke  
6. Phase 5 → continuous  

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
