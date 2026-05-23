# Dependency upgrade program (active)

Working branch: `chore/phased-dependency-upgrades` (cut from `master` after security hardening `15add55`).

Goal: stay current on dependencies without breaking recording, transcription, packaging, or local AI add-ons. Merge **one phase per PR**; run automated tests plus the manual smoke sections listed under each phase before merging to `master`.

Dependabot PRs (reference only — merge via phase branches, not blindly):

| PR | Package | Target phase |
|----|---------|----------------|
| #2 | filelock + certifi (group) | Phase 1 |
| #6 | more-itertools | Phase 1 |
| #7 | click | Phase 1 |
| #8 | idna | Phase 1 |
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

## Phase 1 — Low-risk runtime utilities + npm patches

**Scope:** Transitive / small packages with minimal app surface area. Close or cherry-pick Dependabot PRs #2, #6, #7, #8.

- [ ] Bump `certifi`, `idna`, `click`, `more-itertools` in `requirements-*-build.txt` (match Dependabot pins).
- [ ] Optional: bump `filelock` 3.20.3 → latest patch in `python-runtime-pins` group (PR #2); keep `>=3.20.3` floor.
- [ ] Bump `adm-zip` and `electron` patch (`package.json` + `npm install` + lockfile).
- [ ] Regenerate `legal/PYTHON-BUNDLED-PACKAGES.md` (`node scripts/generate-python-sbom.js`).
- [ ] Tune Dependabot: ignore `numpy` / `scipy` **major** until Phase 4 (optional `.github/dependabot.yml` ignore rules).

**Files:** `requirements-*-build.txt`, `package.json`, `package-lock.json`, `legal/PYTHON-BUNDLED-PACKAGES.md`, optionally `.github/dependabot.yml`.

**Automated (required):**

```bash
npm test
npm run test:python
npm audit --audit-level=high
```

**Manual smoke (light):**

- [ ] `npm start` — app launches, Settings opens.
- [ ] Cross-platform item from `tests/manual/recording-smoke-checklist.md` § Cross-platform (launch → record → stop → transcribe → save).

**Merge gate:** All automated green; light manual pass on one platform (dev machine).

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

1. Phase 1 → merge → smoke  
2. Phase 2 → merge → audio smoke  
3. Phase 3 → merge  
4. Phase 4 → merge → full smoke  
5. Phase 5 → continuous  

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
