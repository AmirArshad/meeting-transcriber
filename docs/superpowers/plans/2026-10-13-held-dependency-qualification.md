# Held Dependency Qualification Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Qualify the remaining electron-builder and ONNX Runtime proposals and ship only updates supported by fresh evidence.

**Architecture:** Enforce ONNX Runtime's documented process-start telemetry opt-out before native import and qualify the CPU VAD using the already bundled model. Add an optional CI installer qualification mode that builds and checks Windows NSIS and macOS DMG artifacts on their native runners; Linux retains its existing full package checks. No release is published.

**Tech Stack:** Electron 44, electron-builder 26, Python 3.11, ONNX Runtime, GitHub Actions, Bash and PowerShell.

## Global Constraints

- Never add cloud processing, telemetry, background uploads, embedded/proxied secrets or hidden downloads.
- Target Windows 10/11 x64, macOS 14+ with arm64-only packages, and Linux x86_64 Core Beta.
- Keep managed Speakrs/Parakeet artifact pins and runtime gates unchanged.
- User authorization for safe updates, commit and push persists; work inline.

---

### Task 1: Enforce and qualify ONNX telemetry suppression

**Files:** `src/main/python-runtime.js`, `backend/transcription/__init__.py`, `tests/js/ai-addon-privacy-hardening.test.js`, `tests/python/test_transcription_privacy.py`, `scripts/qualify-onnx-vad.py`, `.github/workflows/ci.yml`, `requirements-linux-build.txt`, `requirements-windows-build.txt`, `docs/development/contracts/local-ai.md`.

**Implementation:** Force `ORT_DISABLE_TELEMETRY=1` for ordinary and isolated Python children, after caller overrides/unsets, and for standalone transcription package imports before optional native imports. Compare ONNX Runtime 1.30.0 and 1.31.0 VAD probabilities and speech boundaries on the real two-speaker fixture and silence, using the bundled Silero model and CPU provider. Check the actual candidate native wheels and Linux network syscalls with suppression enabled. Adopt 1.31.0 only where qualification passes. The downloaded Windows 1.31.0 wheel lacks the opt-out and retains TraceLogging, so Windows remains 1.30.0; Linux passes the opt-out and actual VAD/network checks.

**Validation:** Focused JS/Python privacy tests, actual native VAD comparisons, Linux network tracing, all target dependency closure/audits and `npm run test:all`.

### Task 2: Qualify electron-builder installers on native CI

**Files:** `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `scripts/verify-windows-installer.ps1`, `scripts/verify-macos-installer.sh`, `tests/js/speakrs-packaging.test.js`.

**Implementation:** Apply the reviewed 26.17.0 package/lock proposal. Add a default-off manual CI input to build NSIS and DMG installers without publishing. Verify the Windows silent install, installed resource layout and uninstall in the disposable CI runner. Verify the DMG and the signed app mounted read-only, reusing existing package verification. Preserve ordinary CI behavior and the existing moderate advisory exception.

**Validation:** Focused packaging tests, script syntax where available, full gate, native installer qualification dispatch and Linux package checks.

### Task 3: Record and integrate the qualified result

**Files:** `docs/development/DEPENDENCY_MAINTENANCE_2026-10.md`, `todo.md`.

**Implementation:** Record source evidence, exact qualification outcomes and remaining hardware/signing limits. Commit and push validated changes, verify final CI and local/remote equality, and close superseded Dependabot PRs.

**Validation:** Final diff check, fresh full gate, installer CI conclusions and clean master synchronized with origin.
