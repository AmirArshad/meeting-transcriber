# CI Failures Implementation Plan

> **For agentic workers:** Execute inline by default.

**Goal:** Fix the shared failures in the latest GitHub Actions runs.

**Architecture:** Repair the isolated recorder test double and update vulnerable pinned dependencies without weakening audit or runtime integrity checks. The Parakeet wheel catalog is regenerated from verified wheel bytes; assess the Rust transitive dependency against the upstream API and toolchain.

**Tech Stack:** Python 3.11, npm, Rust, GitHub Actions.

## Global Constraints

Preserve supported platform behavior, locked dependency closures, local-only AI, and existing CI security gates.

### Task 1: Recorder test isolation

**Files:** `tests/python/test_capture_spool_task8_review.py`.

**Implementation:** Make the constructor test supply a PyAudio implementation even when an earlier test left a mock without that attribute.

**Validation:** Run the Python regression suite.

### Task 2: Dependency audit findings

**Files:** `requirements*.txt`, `package.json`, `package-lock.json`, `build/parakeet/macos-metal.lock.json`, and, if required, `native/speakrs-cli/`.

**Implementation:** Update affected Python and npm pins, regenerate the wheel inventory with its integrity checks, and resolve the Rust zip advisory without weakening the audit gate.

**Validation:** Run dependency audits, locked dependency checks, Rust checks, and `npm run test:all`. Report platform or hardware verification that is unavailable locally.
