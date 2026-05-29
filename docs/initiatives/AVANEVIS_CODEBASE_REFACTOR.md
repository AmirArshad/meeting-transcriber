# AvaNevis Codebase Refactor Design

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

## Success Metrics

These are objective, verifiable exit conditions for the initiative as a whole. "Easier to maintain" is otherwise unmeasurable, so each phase must move toward these targets, not away from them.

- No single source file exceeds 1,500 lines after its owning phase completes. Current offenders to bring under the limit: `src/main.js` (~5,074), `src/renderer/app.js` (~5,063), `src/ai-addon-setup.js` (~3,066), `src/main-process-helpers.js` (~1,729). Recorder and `backend/meeting_manager.py` files should trend down even where a hard 1,500 cap is impractical for hardware-sensitive loops.
- No net loss of automated test coverage; every phase adds or preserves the characterization tests that gate it.
- Zero changes to public IPC names, recorder stdout/stderr contracts, Python CLI/JSON outputs, meeting metadata shape, or AI add-on setup semantics, as enforced by the Phase Exit Checklist.
- Every new JS entry file is covered by `node --check` (see Execution Rules) so syntax validation cannot silently drift.

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
8. Every new JS entry file that is not exercised by `node --test` must be added to the `test:syntax` chain in `package.json` in the same PR that introduces it. The `test:syntax` script is currently a hardcoded list (`src/main.js`, `src/preload.js`, `src/renderer/app.js`, `src/renderer/history-detail-helpers.js`) and will silently miss new files — treat keeping it current as a non-optional exit-checklist item. Prefer converting `test:syntax` to a directory glob during Phase 8 so it cannot drift.
9. Renderer helpers attach to the global scope (for example `root.recordingStateHelpers = ...`). Every new renderer module must attach under a unique, descriptive global name, must not overwrite an existing global, and must be added to `src/renderer/index.html` before any file that consumes it. Verify uniqueness when adding each file.
10. Each renderer/main split must keep `AGENTS.md` accurate. If a phase moves files referenced by the Architecture Map or changes any invariant, update `AGENTS.md` in the same PR — not only when an invariant changes.

### Abort conditions

The initiative's defining constraint is "no regressions." If a phase produces any of the following, revert the PR rather than fixing forward:

- a failing automated test that was passing before the phase, that the phase did not intend to change;
- any manual smoke-checklist regression on an affected platform;
- any observed change to a preserved contract in the Invariants section.

Re-attempt the phase as a fresh, smaller PR after diagnosing the cause. Do not stack fixes on top of a phase that broke a contract.

## How To Implement Each Extraction (Read This First)

This section is the mechanical recipe. Every extraction in this doc follows one of two patterns below. Do not invent a third pattern. Copy these templates verbatim and only change the names.

### Definition: what "behavior-preserving extraction" means here

1. Cut a group of declarations out of the large source file.
2. Paste them into a new module, unchanged (same names, same signatures, same logic — character for character).
3. Re-export them from the original file (the "facade") so every existing caller keeps working with zero changes.
4. Do not edit any call site, IPC channel, CLI argument, or test in the same PR. If a caller needs to change, the extraction is wrong — stop and reconsider the grouping.

A correct extraction PR has this shape: one new file added, one source file shrunk, the new file's symbols re-exported from the old path, and (for new standalone JS files) one `package.json` / `index.html` line added. Tests are unchanged and still pass because the public surface is identical.

### Pattern A — Node/CommonJS module (everything under `src/main-process/`, `src/main/`, `src/ai-addon/`, and Python)

Used for files loaded with `require(...)` in the main process, and for Python modules imported normally.

New module `src/main-process/example-helpers.js`:

```js
'use strict';

function doThing(input) {
  // ... moved verbatim from src/main-process-helpers.js ...
}

module.exports = { doThing };
```

Facade `src/main-process-helpers.js` keeps re-exporting the moved symbol so existing `require('./main-process-helpers')` callers are untouched:

```js
const { doThing } = require('./main-process/example-helpers');
// ... near the bottom, the existing module.exports object keeps listing doThing ...
module.exports = {
  // ...all previously exported names, unchanged...
  doThing,
};
```

Rule: the keys of the facade's `module.exports` object must stay byte-for-byte identical before and after the PR. Diff the export list to confirm nothing was added or removed.

### Pattern B — Renderer browser global (everything under `src/renderer/`)

The renderer has no bundler; files are plain `<script>` tags. Each helper file uses the existing dual-mode factory wrapper (works as both a `<script>` global and a `require()` for tests). Copy `src/renderer/history-detail-helpers.js` lines 1-8 as your template:

```js
(function initExampleHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.exampleHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildExampleHelpers() {
  function formatThing(value) {
    // ... moved verbatim ...
  }
  return { formatThing };
}));
```

Then, in this exact order:

1. Add `<script src="example-helpers.js"></script>` to `src/renderer/index.html` BEFORE the `<script src="app.js"></script>` line and before any other file that uses it.
2. In `src/renderer/app.js`, near the top where the other helpers are destructured (see app.js line 10 `const { getRecordButtonAction } = window.recordingStateHelpers;`), add `const { formatThing } = window.exampleHelpers;` and delete the original in-file definition of `formatThing`.
3. Add the new file to the `test:syntax` chain in `package.json` (see Execution Rule 8).

Global names already taken (do not reuse): `recordingStateHelpers`, `historyDetailHelpers`, `updateNotificationHelpers`.

### Test pattern for any extracted pure helper

Create `tests/js/example-helpers.test.js` using `node:test` (matches the existing suite — see `tests/js/history-detail-helpers.test.js`):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatThing } = require('../../src/renderer/example-helpers');

test('formatThing preserves existing behavior', () => {
  assert.equal(formatThing('x'), 'expected');
});
```

For Python, add a `tests/python/test_<module>.py` using the existing `unittest`/pytest style already present in that directory.

### What is "pure" vs "stateful" (decides Low vs High risk)

- **Pure / safe to move first:** functions that only use their arguments and return a value — formatters, parsers, validators, path builders, math/alignment helpers. They never touch `document`, `window` DOM nodes, module-level mutable state, `ipcMain`, child processes, or files.
- **Stateful / move last:** functions that read or write DOM nodes, module-scoped variables (e.g. `currentMeeting`, `recordingState`, queue objects), spawn processes, register IPC handlers, or perform file IO. These keep their behavior only if the shared state moves with them or is passed in explicitly.

When unsure whether a function is pure, grep its body for `document.`, `window.` (other than `window.electronAPI` calls which are allowed in controllers), a module-level `let`, `ipcMain`, `spawn`, or `fs.`. Any hit means treat it as stateful.

## Phase 0: Characterization Tests

Risk: Medium overall, with high-risk coverage targets.

Purpose: lock down current behavior before splitting stateful modules.

The compute-queue-membership tests (0.2) are a mandatory blocker for Phase 3, and the recorder-event-contract tests (0.4) are a mandatory blocker for Phase 7. Those two suites must exist and pass before the dependent phase begins; do not treat them as optional "where feasible" work.

Existing infrastructure to build on (do not reinvent): `tests/js/main-process-helpers.test.js` and `tests/js/recording-state-helpers.test.js` already characterize recorder-output parsing and record-button state — extend these rather than starting fresh. The recorder stdout/stderr contract is documented in `AGENTS.md` ("Recorder startup and progress use structured stdout JSON"). The compute-queue membership is documented in `AGENTS.md` ("GPU compute serialization and timeouts"). Use those sections as the source of truth for the assertions.

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

### Exact symbol inventory for Phase 1

`src/main-process-helpers.js` currently exports the symbols below. Move each to the module named, then re-export all of them from the facade (Pattern A). The facade's `module.exports` key set must not change. If a symbol depends on another (e.g. a CUDA parser used by a fallback decision), keep both in the same module or import across modules — never duplicate. Shared constants used by multiple modules (`AI_COMPUTE_TIMEOUT_MS`, `CUDA_RUNTIME_PROFILES`, `ALLOWED_WHISPER_MODELS`) live with their primary module and are imported where needed.

| Target module | Symbols to move |
| --- | --- |
| `compute-timeout-helpers.js` | `AI_COMPUTE_TIMEOUT_MS`, `getTranscriptionComputeTimeoutMs`, `formatComputeTimeoutLabel`, `runWallClockComputeAction`, `getGuidedTranscriptionTimeoutMinutes` |
| `url-and-legal-helpers.js` | `buildFileUrl`, `isTrustedExternalUrl`, `resolveExternalUrl`, `getLegalNoticesPath` |
| `transcription-model-helpers.js` | `ALLOWED_WHISPER_MODELS`, `normalizeModelSize`, `matchesFasterWhisperCacheFolderName`, `cacheContainsModel`, `cacheContainsCompleteFasterWhisperModel`, `cacheContainsCompleteMacMLXModel`, `cacheContainsCompleteTranscriptionModel`, `getMacMLXModelStorageDirs`, `getModelDownloadCacheDir`, `getMacMLXCacheDir`, `getModelDownloadPatterns`, `buildModelDownloadCheck`, `isModelDownloadErrorOutput` |
| `transcription-runtime-helpers.js` | `getTranscriberModule`, `buildPythonModuleArgs`, `buildTranscriptionCliArgs`, `buildTranscriberArgs`, `buildGuidedTranscriptTempPath`, `runGuidedTranscriptionProcess`, `buildHuggingFaceOfflineEnv`, `buildTranscriptionRuntimeEnv`, `buildDiarizationOutputPath` |
| `cuda-runtime-helpers.js` | `CUDA_RUNTIME_PROFILES`, `getCudaRuntimeProfile`, `getCudaRuntimeProfiles`, `getSupportedTranscriptionCudaProfileIds`, `getRequiredCudaRuntimeDlls`, `getTranscriptionCudaPackages`, `buildTranscriptionCudaInstallArgs`, `buildTranscriptionCudaUninstallArgs`, `buildUnsupportedCudaPythonMessage`, `getPythonSitePackagesCandidates`, `getPyTorchCudaBinCandidates`, `classifyCudaProbeStatus`, `resolveCudaInstalledProfile`, `cudaStatusNeedsGpuRuntimeEnsure`, `selectGpuInstallModeForCudaStatus`, `getGpuRuntimeEnsurePlan`, `shouldForceCpuTranscriptionFromCudaStatus`, `isRetryableCudaTranscriptionError`, `parseCheckCudaStatus`, `isSupportedCudaInstallPythonVersion`, `parsePythonVersion`, `PYTORCH_CUDA_BIN_DIRS`, `GPU_RUNTIME_ACTION_TIMEOUT_MS` |
| `ai-progress-helpers.js` | `parseAiBackendProgressLine`, `summarizeAiBackendError`, `redactSensitiveText`, `createLineChunkRedactor`, `splitBufferedLines`, `dedupeMessages` |
| `path-safety-helpers.js` | `isPathInsideDirectory`, `resolveExistingRealPath`, `isSafeRecordingsAudioPath`, `isSafeRecordingsJsonPath`, `isSafeRecordingsMarkdownPath`, `isSafeRecordingsPath`, `resolveTranscriptionAudioFile` |
| `recorder-output-helpers.js` | `classifyRecorderStdoutChunk`, `parseRecorderStdoutChunk`, `parseRecorderMessageLine`, `normalizeRecorderLevels`, `getRecorderCloseAction`, `getRecorderEventAction`, `findRecorderResultPayload`, `getRecorderResultAudioPath`, `normalizeRecordingStopPayload`, `parseRecordingStopResult`, `getRecordingStopTimeout`, `resolveStopTimeoutAction`, `getQuitInterceptState`, `buildRecorderBusyResponse`, `isRecorderBusy`, `appendCappedSpawnLogBuffer`, `appendSpawnJsonResultBuffer`, `SPAWN_LOG_BUFFER_MAX_CHARS`, `SPAWN_JSON_RESULT_BUFFER_MAX_CHARS`, `UPDATER_HTTP_RESPONSE_MAX_CHARS` |
| `recording-preflight-helpers.js` | `buildRecordingPreflightReport`, `buildPermissionErrorMessage`, `buildQuitRecordingDialogOptions`, `buildDesktopAudioAvailabilityError`, `buildMacOSPermissionCheckFailureStatus`, `MACOS_PERMISSION_CHECK_TIMEOUT_MS` |

Note: the list above is the export surface captured at planning time. Before starting, re-read the actual `module.exports` block at the bottom of `src/main-process-helpers.js` and reconcile any drift; the authoritative list is the code, not this table. Any symbol not placed above goes to the closest-matching module, and the facade must still re-export it.

### Phase 1 definition of done

- `src/main-process-helpers.js` is reduced to facade `require`s plus the unchanged `module.exports` object.
- The exported key set is identical to before (verify with a diff of the export block).
- `tests/js/main-process-helpers.test.js` passes unchanged (it imports from the facade path).
- `npm test` is green.

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
4. Update `package.json` syntax checks as new standalone files are added (see Execution Rule 8).
5. Leave highly stateful recording/transcription orchestration until the end.

Prior extractions already exist and follow the target pattern: `src/renderer/recording-state-helpers.js`, `src/renderer/history-detail-helpers.js`, and `src/renderer/update-notification-helpers.js` (each with its own test under `tests/js/`). Extend these where a new helper belongs to an existing module instead of creating a duplicate. Note that `recording-state-helpers.js` and `update-notification-helpers.js` are loaded in `index.html` but are not currently in the `test:syntax` chain — add them when touching that script.

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

### Exact function inventory for Phase 2 (from `src/renderer/app.js`)

Line numbers are approximate (planning-time snapshot); locate by function name, not by line. Move the pure functions first using Pattern B. Leave everything in the "stateful — extract last" list inside `app.js` until the controller extractions.

**Pure / safe (move first, in this rough grouping):**

| Destination | Functions to move from `app.js` |
| --- | --- |
| `formatters.js` | `formatTimestamp`, `formatDate`, `formatRelativeDate`, `formatStatusLabel`, `formatBytes`, `formatAiAddonProgressText` |
| `dom-helpers.js` | `clearElement`, `setPlaceholder`, `createSvgElement`, `createDeleteIcon`, `populateSelect` |
| `transcript-rendering-helpers.js` | `renderInline`, `isHr`, `renderMarkdownInto`, `renderSummaryMarkdown` (the pure markdown→DOM-fragment parts; keep any function that reads module state in app.js) |
| `summary-ui-helpers.js` (pure parts) | `getSummaryButtonMeetingId`, `isMeetingTranscriptionRetryable`, `getMeetingTranscriptionStatusMessage` |
| `ai-addon-ui-helpers.js` (pure parts) | `isAiAddonTerminalStatus`, `isAiAddonProgressPhase`, `setStatusBadge` |

**Stateful — extract last (these read/write module state or DOM and belong to the High-risk controllers):** `startRecording`, `stopRecording`, `handleRecordButtonClick`, `setRecordingState`, `updateButtonUI`, `updateControlsState`, `startCountdown`, `cancelActiveCountdown`, `runRecordingPreflightChecks`, `startTimer`, `stopTimer` → `recording-controller.js`; `transcribeAudio`, `retryMeetingTranscription`, `maybeRunDiarizationAfterTranscription`, `saveGuidedDiarizationMetadata`, `saveDiarizationFailureMetadata`, `generateSummaryForMeeting`, `cancelSummaryGeneration`, `writeTranscriptMarkdown` → `transcription-controller.js`.

Do not move `init`, `setupEventListeners`, or any `setup*`/`wire*` function — these are the app bootstrap and must stay in `app.js`.

### Phase 2 definition of done (per sub-step)

- The moved function's body is byte-identical to the original.
- `app.js` destructures it from the new global at the top and no longer defines it.
- The new file is in `index.html` (before `app.js`) and in `test:syntax`.
- A `tests/js/<file>.test.js` covers at least the previously-implicit behavior of each moved pure function.
- `npm test` is green; for the High-risk controller steps, the recording smoke checklist is also run.

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

Because eight of the ten services below are High risk, run this phase as three sequential sub-phases rather than one PR. Each sub-phase is its own PR with its own validation gate:

- **Phase 3a (foundation):** `python-runtime.js`, `meeting-manager-client.js`, `device-ipc.js`, `file-export-ipc.js`. Establishes the dependency-injection pattern on the least dangerous handlers.
- **Phase 3b (AI/GPU surface):** `gpu-runtime-service.js`, `ai-compute-queue.js`, `ai-addon-ipc.js`. Depends on 3a's `python-runtime.js`.
- **Phase 3c (recorder/transcription lifecycle):** `transcription-service.js`, `summary-service.js`, `recorder-service.js`. Highest risk; recorder lifecycle is extracted last and gated on the Phase 0.2 compute-queue and 0.4 recorder-event tests.

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

### IPC channel ownership map (authoritative for Phase 3)

`src/main.js` registers the channels below via `ipcMain.handle('<channel>', ...)`. Each handler moves into the service named, exposed as a `register<Service>(ipcMain, deps)` function called from `main.js` during startup. The channel string, its payload, and its return shape must not change. After the move, `main.js` should contain the `register*` calls and shared startup wiring, not the handler bodies.

| Service | IPC channels it owns |
| --- | --- |
| `python-runtime.js` | none directly — exports `resolvePythonPath`, `buildPythonEnv`, and tracked-spawn helpers consumed by every other service via `deps` |
| `meeting-manager-client.js` | `list-meetings`, `get-meeting`, `delete-meeting`, `scan-recordings`, `add-meeting`, `update-meeting`, `update-meeting-ai` |
| `device-ipc.js` | `validate-devices`, `check-disk-space`, `check-audio-output`, `get-audio-devices`, `warm-up-audio-system`, `get-macos-permission-status` |
| `file-export-ipc.js` | `save-transcript-file`, `save-speaker-segments-file`, `save-transcript-as`, `open-legal-notices` |
| `gpu-runtime-service.js` | `check-gpu`, `check-cuda`, `install-gpu`, `ensure-compatible-gpu-runtime`, `uninstall-gpu` |
| `ai-compute-queue.js` | none directly — owns `aiComputeActionQueue`, `runWallClockComputeAction` wiring, `createAbortableComputeAction`, `waitForAiComputeQueueIdle`; consumed by transcription/summary/ai-addon services |
| `ai-addon-ipc.js` | `get-ai-addon-status`, `store-diarization-token`, `get-diarization-token-status`, `delete-diarization-token`, `setup-diarization`, `cancel-diarization-setup`, `validate-diarization-setup`, `remove-diarization-setup`, `setup-summary-model`, `cancel-summary-model-setup`, `validate-summary-model`, `remove-summary-model` |
| `transcription-service.js` | `check-model-downloaded`, `download-model`, `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, `retry-transcription` |
| `summary-service.js` | `generate-summary`, `cancel-summary-generation` |
| `recorder-service.js` | `run-recording-preflight`, `start-recording`, `stop-recording`, plus the `before-quit`/quit-during-recording interception logic |

Channels not listed (`get-pending-update-info`, `download-update`, `get-platform`, `get-arch`, `open-system-settings`, `get-system-info`) are small and may stay in `main.js` or move to a tiny `app-info-ipc.js`; treat as Low risk and do not block on them.

Critical rule for Phase 3: `download-model` lives in `transcription-service.js` but must NOT be enqueued on `aiComputeActionQueue` (see Invariants). Only `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, and `generate-summary` go through the compute queue. The Phase 0.2 test enforces this — confirm it still passes after the split.

### Phase 3 definition of done (per sub-phase)

- Every channel above is registered exactly once, with an unchanged name/payload/return shape.
- `src/preload.js` and `src/renderer/app.js` are NOT edited (the IPC surface is identical).
- `npm test` and `npm run test:python` are green; the Phase 0.1 IPC snapshot and 0.2 compute-queue tests pass.
- For 3c: the recording and recording-transcription manual checklists are run on the affected platform.

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

### Exact symbol inventory for Phase 4

`src/ai-addon-setup.js` exports the symbols below. Keep `src/ai-addon-setup.js` as the facade (Pattern A) re-exporting all of them — including the two channel/code constants `AI_ADDON_PROGRESS_CHANNEL` and `AI_ADDON_CANCEL_CODE`, which must keep their exact string values.

| Target module | Symbols to move |
| --- | --- |
| `manifest-store.js` | `saveAiAddonManifest`, `checkAiAddonSetupStatus`, `checkDiarizationDependencyCache`, `checkSummaryModelCache`, `checkSummaryRuntimeCache`, plus the cache-dir/path getters: `getDiarizationDependencySitePackagesDir`, `getDiarizationModelCacheDir`, `getSummaryArtifactPath`, `getSummaryModelCacheDir`, `getSummaryRuntimeArchivePath`, `getSummaryRuntimeDir`, `getSummaryRuntimeExecutablePath` |
| `progress-events.js` | `AI_ADDON_PROGRESS_CHANNEL`, `AI_ADDON_CANCEL_CODE`, `createAiAddonProgressEvent`, `isAiAddonCancelError`, `summarizePipProgress` |
| `download-helpers.js` | `downloadFile`, `downloadHuggingFaceSummaryArtifact`, `isAllowedDownloadUrl`, `isLikelyHuggingFaceToken`, `getDiarizationTokenStatus` |
| `archive-install.js` | `extractZipArchive`, `extractRuntimeArchive`, `extractTarGzArchive`, `validateTarListing` |
| `diarization-setup.js` | `buildDiarizationDependencyInstallArgs`, `installDiarizationDependencies`, `downloadDiarizationSourceArtifacts`, `setupDiarizationAddon`, `validateDiarizationSetup`, `removeDiarizationSetup`, `checkMacOSCompilerToolchain` |
| `summary-setup.js` | `setupSummaryModel`, `validateSummaryModel`, `removeSummaryModel` |

The token-safety invariant applies here: none of the download/setup helpers may log, persist, or echo token values. Confirm `tests/js/ai-addon-setup.test.js`, `ai-addon-archive-helpers.test.js`, and `ai-addon-token-store.test.js` pass unchanged.

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

The Low-risk subset of this phase (`backend/transcription/formatting.py`, `backend/summaries/sidecar_io.py`, and device enumeration normalization) is independent of the JS phases and may run early — in parallel with Phase 1 — since both are the safest work and build confidence before the High-risk Phase 3. The Medium-risk extractions (shared event emitters, HF env/cache primitives, diarization audio prep) should still wait until their consuming orchestration is stable.

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

### Concrete decomposition guidance for Phase 6

`backend/meeting_manager.py` is a single `MeetingManager` class plus a `main()` CLI at the bottom. Many methods are `@staticmethod` and already pure — extract those to free functions first; they are the Low/Medium-risk subset. Stateful methods that touch `self.recordings_dir`, the metadata file, or the `FileLock` are the High-risk subset and move last (or stay, with their logic delegated to extracted helpers).

| New module | Functions to extract (from `MeetingManager`) | Risk |
| --- | --- | --- |
| `backend/meetings/normalization.py` | the static/pure helpers: `_read_text_file`, `_read_transcript_text`, `_hash_text`, `_normalize_transcription_status`, `_normalize_transcription_error`, `_build_pending_transcript_placeholder`, `_strip_inline_transcript`, `normalize_text`, `parse_metadata` | Medium |
| `backend/meetings/paths.py` | `_is_recordings_path`, `_resolve_accessible_recordings_file`, `_normalize_sidecar_path`, `_normalize_ai_feature_metadata`, `_iter_ai_file_references`, `_meeting_file_references` | High |
| `backend/meetings/scan_import.py` | `_select_scannable_audio_files`, the filename-parsing/audio-selection portions of `scan_and_sync_recordings` | Medium |
| `backend/meetings/store.py` | `_metadata_guard`, `_load_meetings_unlocked`, `_save_meetings_unlocked`, `_save_meetings`, `_list_meetings_locked`, `_backup_corrupt_metadata` | High |
| `backend/meetings/delete_tx.py` | `delete_file_with_retry`, `tombstone_path_for`, `move_file_to_tombstone`, `restore_moved_files`, `_wait_for_file` | High |

`MeetingManager` keeps its public methods (`add_meeting`, `list_meetings`, `scan_and_sync_recordings`, `get_meeting`, `update_meeting`, `update_transcription`, `update_meeting_ai`, `delete_meeting`) and `main()` as the thin orchestration/CLI layer, delegating to the extracted helpers. The CLI JSON output shape and argument names must not change. Run `tests/python/test_meeting_manager.py` after every extraction.

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

1. Update `package.json` syntax checks for any new JS entry files that are not covered by `node --test`. Prefer converting the hardcoded `test:syntax` list into a directory glob over `src/` and `src/renderer/` so it can no longer drift as files are added.
2. Update CI syntax checks if new backend directories need explicit compilation, and keep CI's JS syntax coverage in parity with `test:syntax`.
3. Update `AGENTS.md` whenever invariants, validation expectations, or the Architecture Map file paths change.
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
- Were any new JS entry files added to the `test:syntax` chain (and CI syntax checks) in the same PR?
- Does every new renderer global use a unique name and load before its consumers in `index.html`?
- Is the owning file now within the 1,500-line target (or, for hardware-sensitive recorder loops, measurably smaller)?
- Was `AGENTS.md` updated if the phase moved files referenced by its Architecture Map?
