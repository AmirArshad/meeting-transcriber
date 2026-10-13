# Dependabot Maintenance Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Review all seven open Dependabot PRs, apply compatible updates, verify them, and commit and push the result to master as authorized.

**Architecture:** Preserve application interfaces and platform runtimes. Combine coupled MLX pins, update the reviewed Rust action together with its characterization test, and retain the documented electron-builder hold. Torch changes apply only to the macOS build dependency that is removed from the packaged runtime; managed AI environments retain their qualified versions.

**Tech Stack:** Electron 44, npm, Python 3.11, pip, GitHub Actions, Rust 1.88.0.

## Global Constraints

- Target Windows 10/11 x64, macOS 14+ with arm64-only packages, and Linux x86_64 Core Beta.
- Preserve locks, atomic writes, recovery, stop/discard distinctions and graceful degradation.
- No cloud processing, model downloads, runtime policy changes, or hardware acceptance claims.
- Work inline; the user authorized commit and push without further confirmation.

---

### Task 1: Apply compatible dependency proposals

**Files:** `requirements-common.txt`, `requirements-dev.txt`, `requirements.txt`, `requirements-{linux,macos,windows}.txt`, `requirements-{linux,macos,windows}-build.txt`.

**Implementation:** Accept filelock 4.0.12 after confirming the v4 protocol break affects unused SoftReadWriteLock; exercise real FileLock contention and recovery tests. Accept regex 2026.9.29; accept mlx and mlx-metal 0.32.3 together after checking adapter use against release changes. Accept Torch 2.14.1 solely as the pruned macOS build dependency. Preserve electron-builder 26.16.1 because its installer qualification hold remains unresolved.

**Validation:** Full regression gate, Python 3.11 wheel metadata checks, target build-pin closure checks, real filelock contention, tiktoken round trips, and cross-platform CI.

### Task 2: Update coupled automation and characterization

**Files:** `.github/workflows/ci.yml`, `.github/workflows/build-release.yml`, `.github/dependabot.yml`, `tests/js/speakrs-packaging.test.js`.

**Implementation:** Use reviewed dtolnay/rust-toolchain SHA e2a55d2ffb04f378e9626c28d38b36d230d1e12f and refresh provenance comments and test expectations. Retain Rust 1.88.0. Group minor/patch mlx and mlx-metal updates to prevent mismatched macOS pins.

**Validation:** `node --test tests/js/speakrs-packaging.test.js`, workflow YAML parsing, `npm run test:all`, and CI.

### Task 3: Record review evidence and integrate

**Files:** `docs/development/DEPENDENCY_MAINTENANCE_2026-10.md`, `todo.md`.

**Implementation:** Record all seven PR decisions, sources, verification results and platform limits. Inspect final diff, commit the dependency changes, validate the combined update in CI before advancing origin/master where practical, and reconcile superseded Dependabot PRs.

**Validation:** `git diff --check`, fresh full gate, GitHub CI conclusions, and local/remote commit equality after push.
