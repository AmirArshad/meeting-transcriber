# Dependency Security Maintenance Implementation Plan

> **For agentic workers:** Execute inline by default. Ask before delegation; this repository's working agreement applies.

**Goal:** Close known dependency-security gaps, update compatible dependencies, and establish coverage for packaged and optional runtimes.

**Architecture:** Treat the base application, platform Python distributions, and each optional AI runtime as separate tested dependency closures. Preserve existing IPC, packaging isolation, checksum verification and explicit setup contracts.

**Tech Stack:** Electron 44, plain JavaScript, Python 3.11, Rust Speakrs, Swift audio helper, CUDA 12 and Apple acceleration.

## Global constraints

- Keep Windows 10/11 x64, macOS 14+ arm64, Linux x86_64 Core Beta; retain Python 3.11 for this maintenance phase.
- No cloud processing, hidden downloads, telemetry, GPU-policy relaxation, model replacement or CPU fallback for gated add-ons.
- Do not stage, commit, push, publish, merge, close PRs or change remote repository settings without explicit authorization.
- Do not modify AGENTS.md, adapters or skill wiring. Work inline; ask before delegation.
- Do not hand-edit generated artifact bytes or invent hashes. Regenerate deliberately from verified source artifacts.

---

## Copy this prompt into the fresh session

```text
Implement the dependency maintenance recommendations in:
docs/development/DEPENDENCY_ASSESSMENT_2026-10-08.md

Read AGENTS.md, the assessment, and relevant packaging/local-ai/recording/IPC contracts first. Refresh the dated registry/advisory evidence and inspect the current Git status and open Dependabot PRs before editing. Work inline. I authorize dependency/code/test/CI/documentation edits and necessary local validation, but not staging, commits, pushes, publishing, PR merges/closures/comments, or remote repository setting changes. Preserve unrelated work.

Use a concise file-level plan and execute the immediate maintenance scope, in this order:

1. Fix security findings in optional/runtime dependencies. Regenerate the macOS Parakeet lock from real wheel bytes for urllib3 2.8.0 and msgpack 1.2.3 (or newer compatible patched releases), including all sizes/hashes/extracted inventories and install-identity invalidation. Upgrade bootstrap pip 26.0.1 to 26.2.1 with verified URL/hash. Update Rust rustls 0.23.43 to a patched compatible version (assessment target 0.23.45) without changing Speakrs/ORT unnecessarily. Qualify a coordinated patched pyannote/Torch/torchaudio/TorchCodec closure for Python 3.11, CUDA 12 and macOS MPS; do not independently choose latest versions. Torch 2.8.0 has multiple advisories, with fix floors through 2.13.0 and an advisory without a listed fix. Audit the complete resolved replacement and explicitly document unresolved advisories. Ensure obsolete installed add-ons require repair instead of remaining falsely ready. Preserve pinned model provenance and repair/uninstall escape paths.

2. Update Electron 44.1.0 to the current supported 44.x release (assessment target 44.7.0), package.json and package-lock.json together. Inspect PR #101's unrelated changes rather than merging it blindly. Keep adm-zip unless new evidence calls for an update. Investigate electron-builder 26.17.0 provenance: at assessment time its v26/latest tags disagreed and its GitHub release lookup was missing. Do not force npm's proposed 26.5.0 downgrade or run npm audit fix --force. Address the sprintf-js advisory through a verified compatible parent update or document a narrow expiring exception if no fix exists.

3. Apply compatible Python maintenance updates, prioritizing AnyIO 4.15.1, filelock 3.32.7, tokenizers 0.23.2, protobuf 7.36.2 and the small helper patches listed in the assessment. Coordinate Hugging Face hub 1.x, hf-xet and fsspec with offline/cache tests. Evaluate base onnxruntime 1.30.0 separately from native Speakrs and Parakeet GPU ORT. Update Numba/llvmlite only as a compatible pair (0.68.0/0.50.0 candidates). Audio/GPU/MLX patches require relevant platform smoke evidence. Respect artifact isolation when versions also appear in Parakeet locks.

4. Qualify newer Python 3.11 runtime distributions and FFmpeg artifacts. Python-build-standalone 20261003 has 3.11.17 candidates. macOS/Linux archive updates require matching wheel/OS checks; Windows embedded layout is a separate compatibility task, not a URL substitution. Preserve python311._pth/zip, stdlib extensions, packaged environment isolation, private Parakeet import roots and signed-bundle behavior. FFmpeg 8.0.3 is the conservative target; 8.1.3 is an alternative only with trusted matching platform binaries and validation. Update source/legal assets with binary pins. If this host cannot establish platform acceptance, complete reviewable code/preparation and record the precise remaining host gate.

5. Prevent recurrence. Extend .github/dependabot.yml to Cargo and GitHub Actions; group only coupled stacks and encode Python-3.11-compatible constraints. Expand .github/workflows/ci.yml with Linux, Parakeet, resolved pyannote, bootstrap/native catalog and Cargo security coverage, including scheduled scans. Add a reliable catalog-to-audit inventory extraction step with meaningful tests. Pin action commits after checking major-version runner requirements. Audit post-pruning release SBOMs plus separate optional-runtime inventories. Align development/CI constraints with packaged dependency resolution. Report the exact GitHub settings to enable dependency graph, alerts and security updates; do not change those remote settings without separate authorization.

Hold NumPy 2.5+, SciPy 1.18+, PyAV 19+, NetworkX 3.7 and librosa 1.x while Python 3.11 remains required. Hold Hugging Face hub 2.x while tokenizers requires <2, mpmath 1.4+ while SymPy requires <1.4, and independent tiktoken upgrades while lightning-whisper-mlx pins 0.3.3. Do not implement a Python-major migration, Whisper-engine replacement, CUDA-13 migration or broad native GPU/llama.cpp upgrade in this maintenance phase. Record a follow-up Python 3.13 qualification plan and compatibility blockers instead.

Use the current Dependabot PRs as evidence: #112 was green; #111 had Windows EPERM rename test failures; #109 has a real Numba/llvmlite conflict; #110/#93 require Python >=3.12. Recheck current status and investigate failures rather than assuming they are harmless.

Run focused tests during changes, then npm run test:all. Resolve/audit platform closures on matching hosts; build installers with publishing disabled, and inspect final diffs. Validate real wheel bytes/hashes, resource invalidation, offline inference, capture/recovery and affected GPU/Metal add-ons. Do not infer hardware success from CI or claim unavailable-host tests passed. Update todo.md with progress and concrete blockers. End with changes, fresh audit/test evidence, remaining risks and exact follow-up host actions. Do not stop after writing another plan; implement all safe, compatible work possible and isolate real blockers.
```

## File-level execution map

### Task 1: Security closures

Modify `build/parakeet/macos-metal.lock.json`, `build/download-manifest.js`, `native/speakrs-cli/Cargo.lock`, and `src/ai-addon-state.js`; update owning setup/runtime code only when required for repair or layout compatibility. Inspect `src/main/parakeet-runtime.js`, `src/ai-addon/diarization-setup.js` and their existing tests before choosing exact changed files. Add a reproducible lock-generation helper if no maintained generator exists; no fake wheel inventories.

Validation: `node --test tests/js/parakeet-locks.test.js tests/js/build-download-manifest.test.js`, relevant setup tests, platform dependency resolution/audits, `cargo test --locked` in native/speakrs-cli, and optional-runtime repair/offline hardware smokes.

### Task 2: Electron and compatible Python updates

Modify `package.json`, `package-lock.json`, appropriate `requirements-*-build.txt` and corresponding development constraint inputs. Update affected Parakeet locks deliberately, independently from base requirements. Preserve meaningful npm overrides until the replacement graph proves them unnecessary.

Validation: `npm ci`, npm audit, platform pip checks/audits and imports, focused recorder/transcriber/cache tests, then `npm run test:all` and matching-host packaged smoke tests.

### Task 3: Bundled interpreter/media qualification

Modify `build/download-manifest.js`, `build/prepare-resources.js`, `src/main/python-runtime.js` and private runtime handling only as needed; align `tests/js/build-download-manifest.test.js`, `tests/js/build-resource-manifest.test.js`, `tests/js/parakeet-locks.test.js`, and existing packaging/runtime tests. Inspect `scripts/generate-python-sbom.js`, `scripts/stage-release-legal-assets.js` and legal inputs when changing artifacts.

Validation: real archive hashes, interpreter version/import isolation, clean prepared-resource regeneration, post-pruning inventories, matching-host installer builds and the recording/add-on manual checklists. Do not erase historical compatibility evidence; add dated evidence.

### Task 4: Ongoing coverage

Modify `.github/dependabot.yml` and `.github/workflows/ci.yml`; update `.github/workflows/build-release.yml` for action/provenance alignment. Add a small dependency-inventory extraction script under `scripts/` and focused tests under `tests/js/` for JS/JSON catalog coverage, alias normalization and intentionally vulnerable fixtures. Prefer existing SBOM machinery where practical. Document maintenance decisions in this assessment or a successor and task status in `todo.md`.

Validation: parse workflow/config changes, run extraction against every real catalog, verify audit failures are not mistaken for zero findings, run full regressions and review the final diff. Remote admin settings remain an explicitly identified follow-up.
