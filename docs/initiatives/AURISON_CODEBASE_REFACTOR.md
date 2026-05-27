# Aurison Codebase Refactor Design

## Status

Proposed. Execute as small, behavior-preserving PRs. Do not combine broad refactors with feature work, dependency upgrades, IPC changes, recorder contract changes, or build packaging changes unless a phase explicitly calls for it.

## Context

The codebase has accumulated several large orchestration files that are difficult to maintain safely:

| Area | Current hotspot | Main issue | Refactor risk |
| --- | --- | --- | --- |
| Renderer | `src/renderer/app.js` | UI state, recording, transcription, history, settings, AI add-ons, GPU controls, summaries, and updates are in one file. | High |
| Main process | `src/main.js` | Electron lifecycle, IPC, Python process control, recorder/transcriber orchestration, AI queues, GPU setup, file export, updates, and meeting management are coupled. | High |
| Main helpers | `src/main-process-helpers.js` | Many unrelated helper groups share one file, but most are pure and already tested. | Low |
| AI add-on setup | `src/ai-addon-setup.js` | Setup, validation, downloads, cancellation, manifests, checksums, and archive extraction are bundled together. | Medium |
| Meeting history | `backend/meeting_manager.py` | Metadata store, path safety, scan/import, sidecar handling, delete transactions, and CLI are combined. | Medium/High |
| Recorders | `backend/audio/windows_recorder.py`, `backend/audio/macos_recorder.py`, `backend/audio/swift_audio_capture.py` | Platform-specific capture and post-processing are operationally sensitive and hardware-dependent. | High |
| Transcribers | `backend/transcription/faster_whisper_transcriber.py`, `backend/transcription/mlx_whisper_transcriber.py` | Formatting, timestamp, cache, model, and CLI concerns overlap. | Medium |

The goal is to reduce file size and coupling without changing user-visible behavior.

## Goals

- Make large files easier to navigate, test, and upgrade.
- Preserve every runtime contract that the app depends on.
- Create smaller domain modules with stable facades during the transition.
- Increase characterization coverage before moving sensitive orchestration code.
- Make future changes lower-risk by isolating IPC, renderer UI logic, subprocess orchestration, recorder output parsing, meeting metadata, and AI setup concerns.

## Non-goals

- Do not rewrite the app architecture in one pass.
- Do not introduce a bundler or framework migration during this refactor.
- Do not rename IPC channels during early phases.
- Do not change recorder stdout/stderr contracts.
- Do not change meeting metadata shape, transcript formats, model cache rules, or AI add-on setup semantics.
- Do not reintroduce real-time audio mixing.

## Risk Levels

| Level | Meaning | Required validation |
| --- | --- | --- |
| Low | Mostly pure helper extraction or file move behind an unchanged facade. | Focused unit tests plus `npm test` or `npm run test:python`. |
| Medium | Stateful code is moved, but external contracts remain unchanged. | Relevant unit tests, full affected-suite tests, and targeted manual review. |
| High | Cross-process, hardware, packaging, IPC, recorder, transcription, safe-path, or compute-queue behavior can regress. | Full automated tests plus manual smoke on affected platform. |

## Invariants To Preserve

- IPC names and payload/result shapes must remain aligned across `src/main.js`, `src/preload.js`, and `src/renderer/app.js`.
- Recorder control messages remain structured stdout JSON: `levels`, `event`, `warning`, `error`.
- Recorder stderr remains debug-only and must not drive startup/control flow.
- Windows recorder final JSON continues to use `audioPath`.
- macOS recorder final JSON continues to use `outputPath`; main process continues accepting both.
- Audio capture keeps separate mic/desktop recording followed by post-processing mix.
- Output remains 48 kHz, stereo, mono-compatible, and Opus-compressed through ffmpeg.
- Swift helper stdout remains raw interleaved float32 PCM; helper JSON status remains stderr-only.
- Diarization and summary setup remain explicit, catalog-driven, local-only, token-safe, and serialized.
- Heavy compute remains serialized through the main-process compute queue.
- Whisper cache completeness and offline env behavior stay aligned between JS and Python.
- Meeting metadata keeps locked atomic writes, corrupt backups, duplicate prevention, safe sidecar paths, and transactional add/delete behavior.

## Execution Rules

1. One phase per PR unless a change is purely mechanical and tightly coupled.
2. Add or strengthen characterization tests before moving high-risk code.
3. Keep the old public module as a facade when splitting a large file.
4. Move code first; improve logic later in a separate PR.
5. Keep script loading order explicit for renderer helper files.
6. Run the validation gate listed for each phase before moving on.
7. Update `todo.md` when a phase starts, completes, or is intentionally deferred.

## Phase 0: Characterization Tests

Risk: Medium overall, with high-risk coverage targets.

Purpose: lock down current behavior before splitting stateful modules.

### 0.1 IPC contract snapshot

Risk: Medium.

Steps:

1. Add a JS test that extracts or imports the preload API mapping from `src/preload.js`.
2. Assert every `window.electronAPI` invoke wrapper maps to a known `ipcMain.handle` channel.
3. Assert renderer-used event listener helpers are exposed by preload.
4. Assert all existing channel names remain unchanged.

Validation:

```bash
npm test
```

### 0.2 Compute queue membership tests

Risk: High.

Steps:

1. Characterize that `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, and `generate-summary` run through the compute queue.
2. Characterize that `download-model` and AI add-on setup downloads do not use the compute queue.
3. Characterize timeout behavior for active child registration and cleanup if a helper can be tested without spawning real Python work.

Validation:

```bash
npm test
```

### 0.3 Renderer helper characterization

Risk: Medium.

Steps:

1. Add focused tests for pure renderer state/render helpers before extracting them from `src/renderer/app.js`.
2. Cover recording button states, summary button states, AI add-on prompt gating, transcript rendering, and settings persistence where feasible.
3. Prefer tests around pure functions rather than full DOM integration unless the DOM behavior is the contract.

Validation:

```bash
npm test
```

### 0.4 Recorder event contract tests

Risk: High.

Steps:

1. Add Python or JS characterization tests for recorder stdout event shapes if recorder emitters will be extracted.
2. Confirm startup events, warning events, error events, level events, and final result payloads remain parseable by existing JS helpers.
3. Confirm stderr text is not used as recorder control flow.

Validation:

```bash
npm test
npm run test:python
```

## Phase 1: Split `src/main-process-helpers.js`

Risk: Low.

Purpose: create a safe extraction pattern with existing tests.

Steps:

1. Create smaller domain files under `src/main-process/`.
2. Move helper groups without changing function signatures.
3. Keep `src/main-process-helpers.js` as the facade that re-exports the same symbols.
4. Run tests after each helper group moves.

Suggested modules:

| New module | Contents | Risk |
| --- | --- | --- |
| `src/main-process/compute-timeout-helpers.js` | compute timeout labels and wall-clock action wrapper | Low |
| `src/main-process/url-and-legal-helpers.js` | file URL, trusted URL, legal notice path helpers | Low |
| `src/main-process/transcription-model-helpers.js` | model size normalization, cache dirs, cache completeness | Low |
| `src/main-process/transcription-runtime-helpers.js` | transcriber module names, CLI args, runtime env | Low |
| `src/main-process/cuda-runtime-helpers.js` | CUDA profile, install args, status parsing, fallback decisions | Medium |
| `src/main-process/ai-progress-helpers.js` | AI progress parsing, sanitization, backend error summaries | Medium |
| `src/main-process/path-safety-helpers.js` | safe recordings path and audio/transcript resolution | Medium |
| `src/main-process/recorder-output-helpers.js` | recorder stdout parsing, stop result normalization, close actions | Medium |
| `src/main-process/recording-preflight-helpers.js` | permission and preflight report helpers | Medium |

Validation:

```bash
npm test
```

## Phase 2: Slim `src/renderer/app.js`

Risk: Medium overall. Individual recording/transcription flow extraction is High.

Purpose: reduce renderer file size without changing UI behavior or adding a build step.

Steps:

1. Keep the current plain HTML/script architecture.
2. Extract low-risk pure helpers first.
3. Add new files to `src/renderer/index.html` in dependency order.
4. Update `package.json` syntax checks as new standalone files are added.
5. Leave highly stateful recording/transcription orchestration until the end.

Suggested extraction order:

| Change | New file | Risk |
| --- | --- | --- |
| Move `AudioVisualizer` class | `src/renderer/audio-visualizer.js` | Low |
| Move common DOM helpers | `src/renderer/dom-helpers.js` | Low |
| Move date, duration, status, and filename formatters | `src/renderer/formatters.js` | Low |
| Move settings load/save/apply helpers | `src/renderer/settings-helpers.js` | Medium |
| Move transcript/Markdown rendering helpers | `src/renderer/transcript-rendering-helpers.js` | Medium |
| Move meeting list/detail pure helpers | extend `src/renderer/history-detail-helpers.js` or add `history-list-helpers.js` | Medium |
| Move summary UI state helpers | `src/renderer/summary-ui-helpers.js` | Medium |
| Move AI add-on settings UI helpers | `src/renderer/ai-addon-ui-helpers.js` | Medium |
| Move GPU settings UI helpers | `src/renderer/gpu-settings-helpers.js` | Medium |
| Extract recording controller | `src/renderer/recording-controller.js` | High |
| Extract transcription/history save controller | `src/renderer/transcription-controller.js` | High |

Validation:

```bash
npm test
```

Manual validation for high-risk renderer phases:

```text
tests/manual/recording-smoke-checklist.md
```

## Phase 3: Split `src/main.js` Into Services

Risk: High.

Purpose: isolate IPC registration and process orchestration while preserving the public IPC surface.

Steps:

1. Introduce registration functions that receive dependencies explicitly.
2. Keep channel names, payloads, return shapes, and renderer API names stable.
3. Start with lower-risk handlers and leave recorder lifecycle last.
4. Avoid changing Python spawn args/env while moving code.

Suggested services:

| Service | Contents | Risk |
| --- | --- | --- |
| `src/main/python-runtime.js` | Python path resolution, env construction, tracked spawn helpers | High |
| `src/main/meeting-manager-client.js` | CLI wrappers for list/get/add/update/delete/scan | Medium |
| `src/main/device-ipc.js` | device validation, disk/audio output checks, audio warmup | Medium |
| `src/main/file-export-ipc.js` | transcript and speaker segment save handlers | Medium |
| `src/main/gpu-runtime-service.js` | GPU/CUDA check, install, repair, uninstall | High |
| `src/main/ai-compute-queue.js` | compute queue, abortable actions, timeout wiring | High |
| `src/main/ai-addon-ipc.js` | AI add-on status, token, setup, cancel, validate, remove | High |
| `src/main/transcription-service.js` | model preload, transcription, guided transcription, retry | High |
| `src/main/summary-service.js` | summary generation/cancellation orchestration | High |
| `src/main/recorder-service.js` | recording preflight, start, stop, quit-during-recording | High |

Validation:

```bash
npm test
npm run test:python
```

Manual validation for recorder/transcription service phases:

```text
tests/manual/recording-smoke-checklist.md
tests/manual/recording-transcription-regression-checklist.md
```

## Phase 4: Split `src/ai-addon-setup.js`

Risk: Medium.

Purpose: make AI add-on setup easier to update without changing catalog-driven behavior.

Steps:

1. Keep `src/ai-addon-setup.js` as the exported facade.
2. Extract manifest load/save/update helpers.
3. Extract progress and cancellation helpers.
4. Extract download, redirect, checksum, and allowlist helpers.
5. Extract archive extraction/runtime install helpers.
6. Extract diarization setup and summary setup flows last.

Suggested modules:

| New module | Risk |
| --- | --- |
| `src/ai-addon/manifest-store.js` | Medium |
| `src/ai-addon/progress-events.js` | Medium |
| `src/ai-addon/download-helpers.js` | Medium |
| `src/ai-addon/archive-install.js` | High |
| `src/ai-addon/diarization-setup.js` | High |
| `src/ai-addon/summary-setup.js` | High |

Validation:

```bash
npm test
```

Manual validation:

```text
tests/manual/local-ai-addons-checklist.md
```

## Phase 5: Python Low-Risk Common Helpers

Risk: Medium overall.

Purpose: remove duplicated deterministic logic before touching orchestration.

Suggested changes:

| Change | New module | Risk |
| --- | --- | --- |
| Extract transcript timestamp/segment/Markdown helpers | `backend/transcription/formatting.py` | Low |
| Extract shared structured event emitters | `backend/common/events.py` | Medium |
| Extract Hugging Face env/cache primitives carefully | `backend/common/hf_runtime.py` | Medium |
| Extract device enumeration normalization helpers | `backend/device_platforms.py` or `backend/device_helpers.py` | Low |
| Extract diarization/audio prep helpers | `backend/diarization/audio_prep.py` | Medium |
| Extract summary sidecar writer helpers | `backend/summaries/sidecar_io.py` | Low |

Validation:

```bash
npm run test:python
python -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py
```

## Phase 6: Decompose `backend/meeting_manager.py`

Risk: Medium/High.

Purpose: isolate metadata, path safety, storage, scan/import, and delete transactions.

Suggested order:

| Change | Risk |
| --- | --- |
| Extract pure transcription and AI metadata normalization | Medium |
| Extract safe path and sidecar reference helpers | High |
| Extract scan/import filename parsing and audio selection | Medium |
| Extract locked atomic JSON store | High |
| Extract delete tombstone/rollback helpers | High |
| Keep CLI wrapper thin and unchanged | Medium |

Validation:

```bash
npm run test:python
```

Focus tests:

```text
tests/python/test_meeting_manager.py
```

## Phase 7: Recorder And Swift Helper Cleanup

Risk: High.

Purpose: reduce recorder file size without changing audio behavior.

Allowed early extractions:

| Change | Risk |
| --- | --- |
| Extract shared WAV writing helpers | Medium |
| Extract shared padding/alignment helpers | Medium |
| Extract Opus compression/report wrapper | Medium |
| Extract macOS desktop diagnostics payload construction | High |
| Extract macOS one-sided stereo repair helper without threshold changes | High |
| Extract Swift helper byte/sample/frame alignment helpers | High |
| Extract Swift helper status payload application | High |

Do not initially extract or redesign the whole recording loop, `_mix_and_save`, `_process_and_save`, callback timing, or subprocess lifecycle.

Validation:

```bash
npm test
npm run test:python
python backend/device_manager.py
```

Manual validation:

```text
tests/manual/recording-smoke-checklist.md
tests/manual/recording-transcription-regression-checklist.md
```

macOS helper validation on Mac:

```bash
swift build -c release --arch arm64
npm run build:mac:dir
```

## Phase 8: Build, CI, And Documentation Cleanup

Risk: Medium.

Purpose: make the new layout first-class in local and CI validation.

Steps:

1. Update `package.json` syntax checks for any new JS entry files that are not covered by `node --test`.
2. Update CI syntax checks if new backend directories need explicit compilation.
3. Update `AGENTS.md` only when invariants or validation expectations change.
4. Update design docs and `todo.md` after each completed phase.
5. Consider adding a lightweight architecture map after the refactor stabilizes.

Validation:

```bash
npm run test:all
```

Packaging validation when resource paths or build scripts are touched:

```bash
npm run prepare-build
npm run build:dir
npm run build:mac:dir
```

## Phase Exit Checklist

Each phase should answer yes to these questions before merge:

- Are public IPC names unchanged?
- Are Python CLI arguments and JSON outputs unchanged unless explicitly planned?
- Are recorder stdout/stderr contracts unchanged?
- Are meeting metadata paths and sidecar references still safe?
- Are token values still kept out of logs, metadata, transcripts, progress events, and manifests?
- Did the relevant automated tests pass?
- Was the manual smoke checklist run for high-risk recorder, transcription, GPU, or packaging changes?
