# Testing Guide

This document explains how to set up and run the regression test suite on a new machine.

## What Exists Today

The current test setup is intentionally small and fast. It focuses on high-value regression coverage for pure logic and process contracts.

It includes:

- JavaScript tests for main-process helper logic
- JavaScript syntax checks for key Electron files
- Python unit tests for pure backend modules
- A manual smoke checklist for hardware-dependent recording flows

It does not yet include full end-to-end recorder automation with real audio devices.

## Prerequisites

- Node.js 18+
- Python 3.11 recommended

Verify versions:

```bash
node --version
python3 --version
```

On Windows, use `py -3.11` if available.

## Install Test Dependencies

### Node.js dependencies

```bash
npm install
```

### Python test dependencies only

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

### Python regression tests

```bash
python3 -m pytest tests/python
```

Or use:

```bash
npm run test:python
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
py -3.11 -m pytest tests/python
```

## Manual Recorder Validation

The automated suite does not replace hardware validation.

Before and after recorder changes, run the manual smoke checklist:

- `tests/manual/recording-smoke-checklist.md`
- `tests/manual/recording-transcription-regression-checklist.md`

This is especially important for:

- macOS desktop audio capture
- Screen Recording permission flows
- long recording stop/drain behavior
- quit during active recording
- Windows loopback recording

## CI Coverage

CI currently runs:

- Python unit tests
- Python syntax checks
- JavaScript tests
- JavaScript syntax checks
- Swift helper build check on macOS

## Troubleshooting

### `python3: No module named pytest`

Install the test requirements:

```bash
python3 -m pip install -r requirements-dev.txt
```

### `numpy` or `soxr` import failures

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
