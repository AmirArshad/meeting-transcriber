# macOS urllib3 audit repair implementation plan

> **For agentic workers:** Execute inline. Do not delegate.

**Goal:** Clear the inherited macOS Python audit failure before merging Qwen language support.

**Architecture:** Update the packaged Mac urllib3 pin from 2.7.0 to the audited fixed 2.8.0. Existing resource-manifest invalidation regenerates the bundled runtime and legal inventory; Qwen code and installed add-on runtimes are unchanged.

**Tech Stack:** Python 3.11, pip-audit, Electron arm64 packaging.

## Global constraints

Preserve explicit downloads, runtime integrity, offline compute and signed-resource immutability. Defer Linux hardware validation until before v2.10 release. Do not change Parakeet runtime locks or unrelated dependencies.

### Task 1: Update and validate the Mac packaged pin

**Files:** `requirements-macos-build.txt`, generated legal inventories if changed, `todo.md`, `docs/development/V2_10_SUMMARY_QUALIFICATION.md`.

**Implementation:** Change urllib3 to 2.8.0, install that version in the local verification venv, regenerate prepared resources through the build script, and record the CI finding and resulting evidence.

**Validation:** `.venv/bin/python -m pip_audit -r requirements-macos-build.txt`, `npm run test:all`, `npm run build:mac:dir`, `npm run verify:mac:packaged`, bundled urllib3 version, strict signatures and the existing packaged English/Spanish smoke. Inspect the final diff, update PR #108 and merge after validation.
