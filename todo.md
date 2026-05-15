# Electron Upgrade Plan

Branch: `upgrade/electron-latest`

Status: planning complete. Dependency upgrades have not started yet.

Goal: upgrade to the latest stable, trustworthy Electron release while preserving the app's local-only recording/transcription behavior and packaged Windows/macOS builds.

## Current Baseline

- Installed Electron: `28.3.3`
- Latest stable Electron observed from npm: `42.1.0`
- Installed electron-builder: `24.13.3`
- Latest stable electron-builder observed from npm: `26.8.1`
- CI frontend job currently uses Node `18`
- Root JS test command now avoids Windows/Node 18 wildcard expansion issues by using default Node test discovery

## Working Rules

- Keep this file current whenever task status changes, major progress is made, or execution order changes.
- Keep changes targeted and reviewable; separate planning, dependency upgrade, compatibility fixes, and validation where practical.
- Preserve recorder stdout JSON contracts and Python process IPC behavior unless explicitly changed with matching tests.
- Preserve local-only/privacy-first behavior: no telemetry, no cloud transcription, no surprise background uploads.
- Do not treat `npm audit fix --force` as safe; apply dependency changes intentionally and inspect generated lockfile changes.

## Phase 0 - Branch And Planning Hygiene

- [x] Create dedicated branch `upgrade/electron-latest`.
- [x] Archive old root todo/plan content under `docs/internal/TODO_ARCHIVE_2026-05-15.md`.
- [x] Replace root `todo.md` with this focused Electron upgrade plan.
- [ ] Commit planning and CI test-runner cleanup before starting dependency upgrades.

## Phase 1 - Version And Release Research

- [ ] Confirm the current stable npm dist-tag for `electron` before installing.
- [ ] Confirm the current stable npm dist-tag for `electron-builder` before installing.
- [ ] Review Electron breaking changes from 29 through the target major version.
- [ ] Check target Electron platform support against our targets: Windows 10/11 x64 and macOS 13+ Apple Silicon.
- [ ] Decide CI Node target: prefer Node 24 if the toolchain passes, fall back to Node 22 only if needed.
- [ ] Check whether newer `actions/checkout` and `actions/setup-node` majors are available to reduce GitHub's Node 20 action-runtime warning.

## Phase 2 - Dependency Upgrade

- [ ] Update `electron` to the latest stable release.
- [ ] Update `electron-builder` to the latest stable release.
- [ ] Regenerate `package-lock.json` with a normal install, not a forced audit fix.
- [ ] Update CI Node versions after validating the chosen Node runtime.
- [ ] Re-run `npm audit --audit-level=high` and record any remaining advisories.

## Phase 3 - Electron Compatibility Review

- [ ] Verify main-process startup, single-instance behavior, tray behavior, quit handling, and menu actions.
- [ ] Verify `BrowserWindow` security settings still behave as expected: `nodeIntegration: false`, `contextIsolation: true`, and preload access through `contextBridge`.
- [ ] Evaluate whether `sandbox: true` is now practical without breaking preload APIs.
- [ ] Verify local `loadFile(...)` renderer loading and file URL behavior for recordings/history.
- [ ] Verify all `shell.openExternal(...)` paths are explicit and safe.
- [ ] Verify IPC handler names and preload bridge APIs remain stable for the renderer.
- [ ] Verify custom updater behavior and release asset matching still work.

## Phase 4 - Packaged Build Compatibility

- [ ] Verify Windows packaged resource layout still includes Python, ffmpeg, backend files, and no stale macOS helper.
- [ ] Verify macOS packaged resource layout still includes Python, ffmpeg, and `bin/audiocapture-helper`.
- [ ] Verify macOS hardened runtime, entitlements, and helper binary packaging still work with the new builder.
- [ ] Verify `artifactName` output still matches updater expectations.
- [ ] Verify build resource invalidation still works after dependency changes.

## Phase 5 - Automated Validation

- [ ] `npm test`
- [ ] `npm run test:python`
- [ ] `python -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py`
- [ ] `npm run build:dir`
- [ ] `npm run build:mac:dir` on macOS or CI
- [ ] `swift build -c release --arch arm64` inside `swift/AudioCaptureHelper` on macOS or CI
- [ ] GitHub Actions CI passes on Windows and macOS

## Phase 6 - Manual Smoke Validation

- [ ] Launch dev app on Windows.
- [ ] Launch packaged Windows app.
- [ ] Start and stop a recording on Windows.
- [ ] Confirm Windows meeting history can play/open the saved recording and transcript.
- [ ] Launch dev app on macOS Apple Silicon.
- [ ] Launch packaged macOS app.
- [ ] Start and stop a recording on macOS with microphone and desktop audio.
- [ ] Confirm macOS permission guidance still works for denied or missing permissions.
- [ ] Confirm model preload/transcription still works on the target platform.
- [ ] Confirm update-check UI still opens the browser to the expected release page.

## Phase 7 - Release Readiness

- [ ] Update docs if install/build/test commands change.
- [ ] Update `AGENTS.md` and `CLAUDE.md` together if agent guidance changes.
- [ ] Confirm no new network behavior was introduced beyond explicit update/model/build downloads.
- [ ] Confirm no secrets, local build outputs, or downloaded runtimes are staged.
- [ ] Prepare a concise upgrade summary and residual-risk note before PR/merge.

## Known Risk Areas

- Electron 42 may include breaking changes across many major versions; review release notes before fixing symptoms ad hoc.
- `electron-builder` 26 may change packaging defaults, signing behavior, artifact names, or resource handling.
- Enabling stricter renderer sandboxing may break preload code if done without targeted changes.
- Packaged Python/resource path assumptions are sensitive; validate both dev and packaged modes.
- macOS helper packaging is high-risk because it depends on Swift build output, entitlements, and `extraResources` layout.

## Definition Of Done

- Electron and electron-builder are upgraded to current stable versions or a clearly justified stable target.
- CI uses a supported Node version, and JS tests keep avoiding Windows shell glob expansion.
- Automated tests and packaged smoke builds pass.
- Manual recording/transcription smoke validation is complete on affected platforms.
- Any remaining security advisories are documented with a rationale or follow-up task.
