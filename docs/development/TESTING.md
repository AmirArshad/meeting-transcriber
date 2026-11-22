# Testing Guide

This document explains how to set up and run the regression test suite on a new machine.

## What Exists Today

The current test setup is intentionally small and fast. It focuses on high-value regression coverage for pure logic and process contracts.

It includes:

- JavaScript tests for main-process helpers, Pattern C service behavioral/deps tests (recorder, transcription, audio import, summary, History search, History Q&A, chat thread store, model library & single-slot process runner, auto-updater), renderer helper suites (tags, speaker labels, chat, subtitle exports, model library UI), IPC/compute-queue source-scan characterization, and facade export snapshots
- JavaScript syntax checks for **all** `.js` files under `src/` (recursive glob via `scripts/check-js-syntax.js`)
- Python unit tests for backend modules (`meeting_manager` / `meetings/`, SQLite FTS5 `history_index`, `history_qa` retrieval & citation verifier, tag-aware summary templates & language checks, sensitive-text redaction, recorder & spool recovery helpers, captions, diarization/Speakrs utilities)
- Recursive Python syntax checks under `backend/` (`npm run test:python-syntax`)
- Manual checklists for hardware-dependent recording and local AI flows

It does not yet include full end-to-end recorder automation with real audio devices.

## Prerequisites

- Node.js 22.12+; Node 24 is used in CI
- Python 3.11 recommended

Verify versions:

```bash
node --version
```

macOS:

```bash
python3 --version
```

Windows:

```powershell
py -3.11 --version
```

## Install Test Dependencies

### Node.js dependencies

```bash
npm ci
```

### Python test dependencies only

#### Windows

```powershell
py -3.11 -m pip install -r requirements-dev.txt
```

#### macOS

```bash
python3 -m pip install -r requirements-dev.txt
```

#### Linux

```bash
python3 -m pip install -r requirements-dev.txt
```

### Python app + test dependencies

Install the platform runtime requirements plus the test requirements if you also want to run the desktop app locally.

#### Windows

```bash
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt
```

#### macOS

```bash
python3 -m pip install -r requirements-macos.txt -r requirements-dev.txt
```

#### Linux

```bash
python3 -m pip install -r requirements-linux.txt -r requirements-dev.txt
```

## Run Tests

### JavaScript regression tests + syntax checks

```bash
npm test
```

This runs:

- `npm run test:syntax`
- `npm run test:js`

### Python Regression Tests

Use this for routine validation; it selects `py -3.11` on Windows and `python3` on macOS/Linux when available.

Cross-platform wrapper:

```bash
npm run test:python
```

Recursive Python syntax check (all packages under `backend/`, including `meetings/`, `summaries/`, `diarization/`, `common/`):

```bash
npm run test:python-syntax
```

Direct commands are still useful when debugging interpreter-specific issues.

macOS:

```bash
python3 -m pytest tests/python
```

Windows:

```powershell
py -3.11 -m pytest tests/python
```

### Run everything

The audio-import regressions generate real fixtures with FFmpeg. Use an FFmpeg
build with MP3, Opus and FLAC encoders and an Ogg muxer on `PATH`, or set
`AVANEVIS_TEST_FFMPEG` to the prepared binary. The packaging jobs use the
manifest-pinned binary from `build/resources/ffmpeg`.

```bash
npm run test:all
```

## Windows Example Setup

From a clean Windows machine:

```powershell
npm ci
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt
npm run test:all
```

If you only want the regression suite and not the full runtime stack:

```powershell
npm ci
py -3.11 -m pip install -r requirements-dev.txt
npm test
npm run test:python
```

## Manual Recorder Validation

The automated suite does not replace hardware validation.

Before and after recorder changes, run the manual smoke checklist:

- `tests/manual/recording-smoke-checklist.md`
- `tests/manual/recording-transcription-regression-checklist.md`

This is especially important for:

- macOS desktop audio capture
- macOS desktop-audio-to-transcript validation, especially browser/YouTube speech through the CoreAudio tap path
- macOS System Audio Recording and Screen Recording fallback permission flows
- long recording stop/drain behavior
- quit during active recording
- Windows loopback recording

## Regression themes

When changing IPC, recording, or local AI behavior, run `npm run test:all` and consult root [`AGENTS.md`](../../AGENTS.md). High-value automated areas:

| Area | Examples |
|------|----------|
| Recorder stdout | `parseRecordingStopResult`, `parseRecorderStdoutChunk`, `success: false` fixtures, `tests/js/recorder-event-contract.test.js` |
| Main services | `tests/js/*-service.behavioral.test.js`, `recorder-service.deps.test.js`, IPC contract snapshots |
| Meeting paths | Recordings-dir guards, symlink rejection, `collectPythonProcessOutput` JSON limits |
| Compute queue | `runWallClockComputeAction`, `compute-queue-membership.test.js`, transcription/diarization/summary timeouts |
| Updates | `pendingUpdateInfo`-only download, `https:` replay validation |
| Privacy | `backend/common/sensitive_text.py`, redacted progress and AI error fields |

Full remediation checklist (archived): [`docs/completed/todo-archives/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md`](../completed/todo-archives/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md).

## CI Coverage

CI currently runs (`.github/workflows/ci.yml`):

- Python unit tests and recursive syntax checks on Windows and macOS (`test-backend-windows`, `test-backend-macos`), including the native Windows ONNX ETW telemetry + CPU VAD qualification check
- JavaScript regression tests, syntax checks, Speakrs CLI unit tests + CPU smoke, and packaged Windows dir smoke (`test-frontend`)
- Swift helper build, Speakrs CLI tests + CPU smoke, and packaged macOS app/DMG verification (`test-backend-macos`)
- Ubuntu Linux packaging job (`test-packaging-linux`): `npm run test:all`, resource preparation, AppImage + pacman + experimental deb, `scripts/verify-linux-packaging.js` (bundled Python/ffmpeg/backend/`speakrs-cli`, static AppImage runtime, pacman `.PKGINFO`, Debian control)
- Security & dependency audits (`security-audit`, `optional-runtime-audit`, `pyannote-closure-audit`, `cargo-audit`): `npm audit`, build-requirements closure check, `pip-audit` across build pins / Parakeet locks / pyannote closure, and `cargo audit --deny warnings`
- Documentation checks (`validate-docs`): markdownlint and link checks

Linux Core Beta hardware smoke (Omarchy/CachyOS Pulse/PipeWire recording, packaged AppImage Settings/legal-notices/CPU transcription) is manual — see `tests/manual/recording-smoke-checklist.md` and `docs/initiatives/LINUX_SUPPORT.md`. Friend distro/desktop coverage is `tests/manual/linux-experimental-beta-checklist.md`. The Phase 3 60-minute soak was cancelled 2026-08-27 (not run). Ubuntu 24.04 desktop recording/`safeStorage` smoke is still open.

## Troubleshooting

### `python3: No module named pytest`

Install the test requirements:

```bash
python3 -m pip install -r requirements-dev.txt
```

### `numpy` or `soxr` import failures

`soxr` is bundled on **Windows and macOS** packaged builds (`requirements-*-build.txt`) because shared spool finalization imports `processor.StatefulResampler`. Local macOS/Windows CI still needs it for `tests/python/test_processor.py` via `requirements-dev.txt` (not `requirements-macos.txt`).

Reinstall the Python test requirements:

```bash
python3 -m pip install -r requirements-dev.txt
```

### Windows uses `py` instead of `python3`

Use:

```powershell
py -3.11 -m pytest tests/python
```

### Recorder behavior passes tests but fails on real hardware

That can still happen. Run the manual smoke checklist in `tests/manual/recording-smoke-checklist.md`.
If the change touches recorder failure handling or process messaging, also compare output against the representative fixtures in `tests/fixtures/`.

## Validation

Check commands per toolchain — full setup lives in `README.md`:

- JS: `npm test` (regression suite + `node --check` over all `src/**/*.js`)
- Python: `npm run test:python`, `npm run test:python-syntax`
- Everything: `npm run test:all`
- Agent setup / instructions: `python3 scripts/agents/validate_setup.py` (Windows: `py -3.11`)
- Device smoke: `python backend/device_manager.py`
- macOS helper: `swift build -c release --arch arm64` inside `swift/AudioCaptureHelper`

**Which one to run.** Start with the smallest relevant command. Escalate to `npm run test:all` when the change is cross-cutting, or touches recorder, persistence, packaging, or security — and always before opening a PR. These two rules do not conflict: small-first is for iterating, `test:all` is the pre-PR gate.

Hardware-dependent paths are covered by manual checklists, not CI: `tests/manual/recording-smoke-checklist.md` and `tests/manual/local-ai-addons-checklist.md`. Targeted adversarial review prompts: `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md`.

**Fakes must model the real dependency.** A green suite is not evidence when the test double is shaped more conveniently than the library. The 2026-08-28 Linux pre-merge review found three defects hidden this way — `is_pulse_port_unavailable` matched every `FakePort` and no real `pulsectl.EnumValue`, and no tray test ever decoded an actual image file. When a helper interprets a third-party object or a shipped asset, assert against the real type (`pytest.importorskip`) or the real bytes, not only a hand-written stand-in.

CI runs JS + Python tests, recursive backend `compileall`, JS syntax checks, manifest tests, and packaged-build smoke — **not** full end-to-end with real audio devices. Characterization gates worth knowing about: IPC/compute-queue source scans and facade export snapshots in `tests/js/`, plus recorder stdout contracts in `tests/js/recorder-event-contract.test.js` and `tests/python/test_recorder_event_contract.py`.

Non-obvious validation targets: transcript JSON shape still matches renderer expectations; complete-cache detection stays aligned across JS and Python; add-on status still covers `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, `unsupported`; Windows speaker prompts stay behind CUDA readiness; summary setup cancellation removes partial files **without** deleting a previously valid install.
