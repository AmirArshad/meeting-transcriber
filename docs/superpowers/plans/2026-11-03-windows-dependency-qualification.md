# Windows Dependency Qualification Implementation Plan

> **For agentic workers:** Execute inline by default.

**Goal:** Qualify and apply outstanding Windows dependency updates supported by native evidence.

**Architecture:** Compare isolated old and candidate runtime wheels with cached models and real fixtures, preserving offline, CUDA 12, and telemetry boundaries. Update build pins and inventory only for candidates that meet their gates; record results and unresolved qualification limits.

**Tech Stack:** Windows x64, Python 3.11, CTranslate2, ONNX Runtime, Electron and GitHub Actions.

## Global Constraints

Preserve privacy, Python 3.11, Windows 10/11 support, packaged isolation and managed runtime identity. Do not claim unrun hardware or installer checks.

### Task 1: Qualify native candidates

**Files:** `requirements-windows-build.txt`, `docs/development/contracts/local-ai.md`, `scripts/` existing qualification tools.

**Implementation:** Compare CTranslate2 4.8.2 and 4.8.5 CPU/CUDA inference and clean process shutdown using isolated actual wheels; assess ONNX telemetry and hf-xet download constraints before any change.

**Validation:** Native offline inference, device and process exit checks; Windows dependency closure and inventory audit.

### Task 2: Apply and validate qualified upgrades

**Files:** `requirements-windows-build.txt`, `legal/PYTHON-BUNDLED-PACKAGES.md`, `docs/development/DEPENDENCY_SWEEP_2026-11-03.md`, `todo.md` as needed.

**Implementation:** Update only qualified pins and document evidence and remaining limits. Preserve generated resource invalidation and package contracts.

**Validation:** `npm run test:all`, Windows package build where feasible, final diff inspection and post-push CI monitoring.
