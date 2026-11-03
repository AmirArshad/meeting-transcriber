# hf-xet 1.8.0 Qualification Plan

> **For agentic workers:** Execute inline. Do not delegate without authorization.

**Goal:** Assess the candidate dependency independently of the disabled-Xet transport policy.

**Architecture:** Trace user-triggered Hub and non-Hub downloads, exercise real wheels with the pinned Hub under the application's environment, and record platform-specific evidence. Advance pins only if all requested gates are met; otherwise retain them and record blockers.

**Tech Stack:** Python 3.11, Electron, Hugging Face Hub, native platform wheels and existing regression suites.

## Global Constraints

- Stay on master; preserve disabled Xet, TLS verification, token boundaries and explicit downloads.
- Use native evidence where platform matters; do not claim untested paths.

### Qualification

**Files:** `backend/transcription/`, `backend/summaries/hf_model_downloader.py`, `src/ai-addon/`, `src/main/python-runtime.js`, `requirements-*-build.txt`, `build/parakeet/macos-metal.lock.json`, relevant regression tests.

**Implementation:** Inspect actual paths and inventories; test candidate wheels and dependency closure on available native hosts, including integrity, cache, cancellation and token boundaries. Change pins and generated inventory only on complete evidence.

**Validation:** Focused tests and `npm run test:all`; review final diff and CI for the exact pushed commit.

### Evidence

**Files:** `docs/development/DEPENDENCY_SWEEP_2026-11-03.md`.

**Implementation:** Record actual tests, blocked gates, and separate requirements for native Xet TLS and packaged qualification.

**Validation:** Cross-check claims against commands and outputs; inspect final diff.
