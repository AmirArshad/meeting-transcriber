# Dependency Sweep Implementation Plan

> **For agentic workers:** Execute inline by default.

**Goal:** Review every open Dependabot branch and update compatible dependencies while preserving privacy and platform behavior.

**Architecture:** Inventory proposed updates and current registries, assess release notes and target-specific constraints, then update explicit pins and lockfiles in coherent groups. Preserve the existing CI fixes, runtime integrity checks, Python 3.11 and GPU privacy contracts; hold changes requiring evidence that cannot be obtained on this host.

**Tech Stack:** Electron, npm, Python 3.11, Rust, GitHub Actions.

## Global Constraints

No cloud processing, telemetry, hidden downloads, relaxed integrity checks, commits or publishing. Preserve Windows, macOS and Linux runtime contracts and distinguish automated checks from hardware acceptance.

### Task 1: Dependency inventory and low-risk updates

**Files:** `requirements*.txt`, `build/parakeet/macos-metal.lock.json`, `native/speakrs-cli/Cargo.lock`, `.github/workflows/ci.yml`, `.github/workflows/build-release.yml`, `tests/js/speakrs-packaging.test.js`, `tests/js/linux-packaging.test.js`.

**Implementation:** Compare all open Dependabot proposals, refresh compatible security and maintenance pins, regenerate the wheel inventory from real bytes, review action commits and refresh pinned-action assertions.

**Validation:** Check target dependency closures, Python inventories, npm and Cargo audits, workflow tests and Cargo tests.

### Task 2: Electron and packaging compatibility

**Files:** `package.json`, `package-lock.json`, `src/preload.js`, `tests/js/` Electron fixtures, `docs/development/contracts/packaging.md`, `README.md` as needed.

**Implementation:** Review Electron 45 breaking changes and electron-builder 26.18, exercise the actual sandboxed preload, and update only where supported by evidence. Record native installer and hardware checks still required.

**Validation:** Run the full regression gate under a virtual display, focused Electron and packaging checks, and inspect the final diff.
