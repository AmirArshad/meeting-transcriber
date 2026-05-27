# Testing Guide

This document explains how to set up and run the regression test suite on a new machine.

## What Exists Today

The current test setup is intentionally small and fast. It focuses on high-value regression coverage for pure logic and process contracts.

It includes:

- JavaScript tests for main-process helper logic (recorder stop payloads, compute timeouts, trusted update URLs, path guards, spawn output limits)
- JavaScript syntax checks for key Electron files
- Python unit tests for pure backend modules (`meeting_manager` path/symlink rules, sensitive-text redaction, recorder helpers, diarization/summary utilities)
- A manual smoke checklist for hardware-dependent recording flows

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
npm install
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

```bash
npm run test:all
```

## Windows Example Setup

From a clean Windows machine:

```powershell
npm install
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt
npm run test:all
```

If you only want the regression suite and not the full runtime stack:

```powershell
npm install
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

## Regression themes (May 2026 remediation)

When changing IPC, recording, or local AI behavior, run `npm run test:all` and consult root [`AGENTS.md`](../../AGENTS.md). High-value automated areas:

| Area | Examples |
|------|----------|
| Recorder stdout | `parseRecordingStopResult`, `parseRecorderStdoutChunk`, `success: false` fixtures |
| Meeting paths | Recordings-dir guards, symlink rejection, `collectPythonProcessOutput` JSON limits |
| Compute queue | `runWallClockComputeAction`, transcription/diarization/summary timeouts |
| Updates | `pendingUpdateInfo`-only download, `https:` replay validation |
| Privacy | `backend/common/sensitive_text.py`, redacted progress and AI error fields |

Full remediation checklist (archived): [`docs/completed/todo-archives/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md`](../completed/todo-archives/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md).

## CI Coverage

CI currently runs:

- Python unit tests
- Python syntax checks
- JavaScript tests
- JavaScript syntax checks
- Swift helper build check on macOS
- packaged Windows build smoke test
- packaged macOS build smoke test
- packaged macOS resource verification for helper, Python, and ffmpeg

## Troubleshooting

### `python3: No module named pytest`

Install the test requirements:

```bash
python3 -m pip install -r requirements-dev.txt
```

### `numpy` or `soxr` import failures

`soxr` is bundled only on **Windows** packaged builds. macOS dev/CI still needs it for `tests/python/test_processor.py` via `requirements-dev.txt` (not `requirements-macos.txt`).

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
If the change touches recorder failure handling or process messaging, also compare output against the representative fixtures in `tests/manual/fixtures/`.
