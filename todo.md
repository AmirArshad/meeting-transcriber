# Next Project Decision

Previous project plan was archived to `docs/internal/TODO_ARCHIVE_2026-05-18_LOCAL_AI_ADDONS.md`.

## Candidate projects

- [ ] Acoustic echo cancellation / echo suppression for speaker-use scenarios (cross-platform Windows + macOS).
- [ ] Upload audio files (`.mp3`, `.wav`, `.opus`) and process them through the same transcription/summary/history flow as recorded meetings.
- [ ] History chat over past meetings using the installed local summary runtime/model.

## Recommendation

- [ ] Start with **Acoustic echo cancellation / suppression** first.
  - Reason: highest recording/transcript quality impact for speaker users, and it improves core output quality before adding new ingestion/query features.

## Decision gate

- [ ] Confirm the next project to execute.
- [ ] Create a focused implementation plan once the project is chosen.

---

# Code review remediation (2026-05-19)

Source: main-flow security / performance / functional review (Electron + Python + AI add-ons), validated against the codebase 2026-05-19. Implement **one phase per PR or agent session**. Run validation after each phase before starting the next.

**Branch:** `chore/code-review-remediation`

**Validation summary:** ~47 of 50 items confirmed real. Three items rescoped (3.5 dropped, 5.1 split, 7.2 rejected). Highest-priority fixes: **5.3** (compute queue timeout), **1.2 / 1.4 / 1.14** (IPC trust + stderr redaction + `modelSize` allowlist), **2.1 + 2.4** (concurrent start race), **3.1–3.3** (path guards — safe; no legitimate caller passes paths outside recordings today).

**Global validation (after every phase):**

```bash
npm test
npm run test:python
```

**Manual smoke when a phase touches recording / IPC / paths:**

- `tests/manual/recording-smoke-checklist.md` (affected platform)
- Record → stop → transcribe → history entry
- If AI touched: `tests/manual/local-ai-addons-checklist.md`

**Agent rules:**

- Do not combine high-risk phases (6–7) with recorder path changes in one PR.
- Preserve stdout JSON recorder contract (`AGENTS.md`); update `main-process-helpers.js` + tests if parser changes.
- Path guards: grep all `electronAPI` call sites before rejecting paths in main.
- **4.6 is not Python-only:** ships with `src/main.js` + `src/main-process-helpers.js` + `tests/js/main-process-helpers.test.js` in the same PR.
- **Do not route `download-model` through `enqueueAiComputeAction`** — long HF downloads would block GPU work and trip the 15s validation wait timeout.

**Cross-cutting themes (batch when touching related files):**

1. **Sanitization** — `redactSensitiveText` is wired for AI progress JSON only; extend to stderr IPC (1.4), summary errors (1.5), persisted metadata (1.10), Python runners (1.11).
2. **IPC input validation** — renderer trust at boundaries: update URL (1.2), HF token (1.6), paths (3.x), `modelSize` (1.14), optional sender check (2.8).
3. **Lifecycle teardown** — disposer pattern: GPU interval (1.1), countdown interval (2.5), AI progress hide (1.12), quit aborts (2.7).

**Suggested agent order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 (7.x one item per PR). Within Phase 5, run **5.3 before 5.1**.

---

## Phase 1 — Low-risk hygiene (main + renderer)

**Risk:** Low | **Regression:** Unlikely on happy paths

**Elevated within phase (do early):** 1.2, 1.4, 1.14 — security-relevant IPC/sanitization.

- [x] **1.1** Clear GPU install progress interval on failure (`src/renderer/app.js` `installGPUAcceleration` — use `finally { clearInterval(...) }`; mirror FTUE ~1022).
- [x] **1.2** Bind `download-update` IPC to `pendingUpdateInfo` only; drop renderer `downloadUrl` param from preload (`src/main.js`, `src/preload.js`, `src/updater.js`). Reject when `pendingUpdateInfo == null`.
- [x] **1.3** Cap stdout/stderr buffer growth in main Python spawns and updater HTTP (`src/main.js`, `src/main-process-helpers.js` if shared helper extracted). **Caveat:** cap stderr/log freely; for result-JSON stdout (transcription, stop recording) use hard `maxBuffer` + reject — do not truncate mid-JSON.
- [x] **1.4** Sanitize `transcription-progress`, `model-download-progress`, and `gpu-install-progress` with `redactSensitiveText` before IPC (`src/ai-progress-sanitizer.js`). Prefer line-chunked redaction so split tokens across buffer boundaries are not missed.
- [x] **1.5** Use `summarizeSummaryValidationError` (or shared `summarizeAiBackendError`) for summary failure messages (`src/main.js` ~3448+); redact metadata-phase errors too.
- [x] **1.6** Validate HF token format in `store-diarization-token` IPC (`isLikelyHuggingFaceToken` from `ai-addon-setup.js`); trim before check; return structured error for renderer.
- [x] **1.7** Gate DevTools (and optionally reload/forceReload) behind `!app.isPackaged` or `AVANEVIS_ENABLE_DEVTOOLS=1` (`src/main.js` menu).
- [x] **1.8** Remove preload startup `console.log` (`src/preload.js` — only log in dev if needed).
- [x] **1.9** Remove dead `offUpdateAvailable` from preload (unused; `onUpdateAvailable` already returns a disposer). Do not “fix” with `removeAllListeners`.
- [x] **1.10** Redact HF tokens in persisted meeting AI `error` fields (`backend/meeting_manager.py`; align with `diarization_pipeline._safe_message`).
- [x] **1.11** Share redaction helper in `summary_runner.py` with diarization (e.g. `backend/common/sensitive_text.py`; fold `hf_model_downloader` duplicate regex).
- [x] **1.12** Clear `hideAiAddonProgressSoon` timeouts on new progress / teardown — per-feature timer map (`src/renderer/app.js`).
- [x] **1.13** Home-tab `copyTranscript` clipboard `.catch` + user feedback (match history copy); guard empty text.
- [x] **1.14** Allowlist `modelSize` on all transcription IPCs: `check-model-downloaded`, `download-model`, `transcribe-audio`, `transcribe-audio-with-speakers` (`src/main.js` + `src/main-process-helpers.js`; central `ALLOWED_WHISPER_MODELS` / `normalizeModelSize`). *Moved forward from Phase 6 — flows to filesystem patterns and Python `--model` with no validation today.*

**Phase 1 tests:** extend `tests/js/main-process-helpers.test.js` / `tests/js/ai-addon-*.test.js` for sanitization, URL binding, and `modelSize` rejection.

---

## Phase 2 — Recording lifecycle guards (main + renderer)

**Risk:** Medium | **Regression:** Stuck “can’t record” if process refs not cleared

**Elevated within phase:** 2.1 + 2.4 — concurrent start is reachable via renderer double-click during preflight.

- [ ] **2.1** Reject `start-recording` when `pythonProcess` active or `recordingStopPromise` in flight; guard **before** `powerSaveBlocker.start` (`src/main.js`). Return `{ code: 'RECORDER_BUSY', ... }` for renderer to ignore vs alert.
- [ ] **2.2** Always clear `pythonProcess` on all exit paths: add `pythonProcess.on('error', …)` → same cleanup as `close`; audit `failActiveRecording` (emit-only today). Capture local `proc` in handlers so concurrent overwrite (2.1) cannot target wrong PID.
- [ ] **2.3** Merge duplicate `pythonProcess.on('close')` handlers — `clearTimeout(timeoutHandle)` inside the single handler (`src/main.js` ~2865, ~2934).
- [ ] **2.4** Renderer: set `recordingState` to `'starting'` **before** `runRecordingPreflightChecks` `await`; extend `getRecordButtonAction` / button UI for busy state (`src/renderer/app.js`, `recording-state-helpers.js`). Prefer new `'starting'` over reusing `'initializing'`.
- [ ] **2.5** Renderer: cancellable `startCountdown` (return `{ promise, cancel }`); clear interval on retry/failure and in `setRecordingState('idle')` (`app.js` ~1873–1998).
- [ ] **2.6** Renderer: session epoch for `onRecordingFailed` — ignore stale failures; do not force `idle` during `stopping`/`transcribing` without main ack (`app.js` ~1691+). Keep `sessionId` on IPC only — **not** in recorder stdout JSON.
- [ ] **2.7** Quit path: abort all `aiAddonSetupAbortControllers`, `activeSummaryGeneration?.controller.abort(...)`, then brief drain/kill AI children (`src/main.js` `before-quit` ~1646+). Extend intercept path if setup/summary in flight.
- [ ] **2.8** Optional: `ipcMain` sender check `event.sender === mainWindow.webContents` (wrap high-risk handlers only; do not blanket-wrap without audit).

**Phase 2 manual:** double-click Start during preflight; quit during recording; quit during transcription.

---

## Phase 3 — Path enforcement (main + Python)

**Risk:** Medium | **Regression:** False rejections if call sites pass paths outside recordings

**Prerequisite:** Grep all `addMeeting`, `transcribeAudio`, `add-meeting`, `transcribe-audio` call sites. **Validated:** every current caller already passes paths under `userData/recordings`; rejection-by-default is safe.

- [ ] **3.1** `addMeetingToHistory` / `add-meeting`: `assertSafeExistingRecordingAudioPath` + transcript markdown guard before spawn (`src/main.js` ~444+).
- [ ] **3.2** `transcribe-audio`: after `resolveTranscriptionAudioFile`, call `assertSafeExistingRecordingAudioPath`; always resolve against `getRecordingsDir()` (drop `path.dirname(audioFile)` branch for absolutes) (`src/main.js` ~2953; match guided ~3059).
- [ ] **3.3** `meeting_manager.add_meeting`: require resolved paths under `recordings_dir`; reject `..` escapes — use existing `_is_recordings_path` (`backend/meeting_manager.py`).
- [ ] **3.4** `add_meeting`: fail fast if audio/transcript missing; optional bounded retry for transcript only (race with AV); document that renderer saves transcript before `addMeeting` (`backend/meeting_manager.py`).
- [ ] **3.5** Regression test: `parseRecordingStopResult` / `findRecorderResultPayload` always expose `audioPath` for Windows (`audioPath`) and macOS (`outputPath`) recorder payloads (`tests/js/main-process-helpers.test.js`). *Replaces dropped item “renderer `audioPath || outputPath`” — main already normalizes at `src/main.js:174–200`; renderer reads only `result.audioPath`.*
- [ ] **3.6** Tests: path rejection in `tests/python/test_meeting_manager.py` (repath `_create_source_files` into recordings dir); JS helper tests if extended.

**Phase 3 manual:** full record → stop → transcribe → save; scan/import if used.

---

## Phase 4 — Python recorder correctness (Windows + macOS)

**Risk:** Medium | **Regression:** Trimmed tail audio (macOS flag); stricter failure surfaces

**Quick win:** 4.3 (one-line lock on Windows final JSON).

- [ ] **4.1** Windows: on any `start_recording` failure, set `is_recording = False` and stop/close partial streams (`windows_recorder.py` ~424–520).
- [ ] **4.2** Windows: `cleanup()` stop/close streams before `pa.terminate()` (`windows_recorder.py` ~857+).
- [ ] **4.3** Windows: emit final result via `_send_json_message` (lock + flush); keep `audioPath` shape (`windows_recorder.py` ~967).
- [ ] **4.4** macOS: gate mic callback on `_get_running()` (`macos_recorder.py` ~572+).
- [ ] **4.5** macOS: lock `ChunkedAudioBuffer` or `to_array()` copy; join mic thread before read; fix `_abort_startup` vs callback race (`chunked_audio_buffer.py`, `macos_recorder.py`).
- [ ] **4.6** macOS: empty mic → `success: false` + structured error; **omit bogus `outputPath`** (`macos_recorder.py` ~804+, ~1223+). **Same PR:** widen `findRecorderResultPayload` / `parseRecordingStopResult` in `src/main-process-helpers.js` + `src/main.js`; add tests for `success: false` result shape.
- [ ] **4.7** macOS (+ optional Windows): validate `mic_device_id` in range and `max_input_channels > 0` after enumeration (`macos_recorder.py`, `device_manager.py`).
- [ ] **4.8** Swift: batch-drain stderr after `select` ready; bump join timeout for final `capture_stats` (`swift_audio_capture.py`). Do not drop `type: error` / `warning` messages.
- [ ] **4.9** Tests: Windows `audioPath` result in `tests/js/main-process-helpers.test.js`; `success: false` variant; Python compile + manual smoke both platforms.

**Phase 4 manual:** `tests/manual/recording-smoke-checklist.md` on Windows and macOS; mic permission denied on macOS.

---

## Phase 5 — AI concurrency, errors, and archive hardening

**Risk:** Medium–high | **Regression:** Queue stall without timeouts; slower parallel ops

**Order within phase:** **5.3 → 5.1 → 5.2 → …** (timeout before adding more queue consumers).

- [ ] **5.3** Wall-clock timeout + process kill for hung compute jobs (`createAsyncActionQueue` per-job wrapper + `terminateProcessBestEffort`). Per-type limits (e.g. summary 90m, diarization 30m). **Highest priority in this phase** — one hung child currently stalls the queue for the rest of the session.
- [ ] **5.1** Route **`transcribe-audio` only** through `enqueueAiComputeAction` (`src/main.js` ~2953). **Do not** enqueue `download-model` on the GPU queue — use separate download serialization or leave off-queue. *Validated: guided transcription, diarize, and summary already use the compute queue.*
- [ ] **5.2** Setup validation vs compute: replace 15s false-failure with blocking wait + progress, or queue-depth check before smoke test; document policy in new `AGENTS.md` § GPU compute serialization (5.9).
- [ ] **5.4** Summary metadata failure: staging paths (`.summary.json.tmp`) + rename on success, or delete sidecars on `update-ai` failure (`src/main.js` ~3443+).
- [ ] **5.5** ZIP extraction: reject symlink entries (UNIX `externalFileAttributes`); mirror tar link-target checks (`ai-addon-archive-helpers.js`, `ai-addon-zip-extractor-worker.js` + tests).
- [ ] **5.6** MLX cache completeness: non-empty `weights.npz` and `config.json` (align `main-process-helpers.js` / `AGENTS.md`) (`mlx_whisper_transcriber.py`).
- [ ] **5.7** faster-whisper cache dir: exact folder name match, not substring (update JS + Python + `tests/python/test_transcriber_helpers.py`, `tests/js/main-process-helpers.test.js`).
- [ ] **5.8** Optional: pass HF token to validation spawn via stdin instead of env — lower priority; Windows/macOS exposure is limited.
- [ ] **5.9** Add `AGENTS.md` § **GPU compute serialization and timeouts**: handlers on compute queue (after 5.1: transcribe + diarize + guided + summary), validation wait policy, wall-clock kills (5.3).

**Phase 5 manual:** `tests/manual/local-ai-addons-checklist.md`; overlapping transcribe + diarize; confirm model download still works during transcription.

---

## Phase 6 — Performance and UX (renderer + main)

**Risk:** Low–medium | **Regression:** Search feels delayed; less frequent disk sync

- [ ] **6.1** Debounce meeting search input (150–300 ms); cache lowercased query (`app.js` ~1587+).
- [ ] **6.2** `loadMeetingHistory({ scan })`: skip `scanRecordings()` except launch / explicit refresh (`app.js` ~1533+).
- [ ] **6.3** Audio visualizer: stop rAF loop when `document.hidden`; skip redraw when levels unchanged (`app.js` ~3973+). Drawing already skips when hidden; rAF still runs today.
- [ ] **6.4** Normalize `meetingId` to string once in `selectMeeting` so downstream `===` is safe (`app.js`). Backend returns strings today; inconsistency is latent.
- [ ] **6.5** Chunked transcript rendering — **optional / profile first**; only if large meetings show jank (`app.js` ~549+). No observed bug at typical sizes.
- [ ] **6.6** Markdown links for AI content: restrict to `https:` and `mailto:` only (`app.js` ~354+). `javascript:` already blocked by CSP in `index.html`; tighten AI-rendered path and drop relative `href` branches.
- [ ] **6.7** `handleDismissUpdate`: clear `currentUpdateInfo`; `replayPendingUpdateNotification` require `https:` on `downloadUrl` (`update-notification-helpers.js`, `app.js`).

*`modelSize` allowlist moved to Phase 1 item 1.14.*

---

## Phase 7 — High-risk / architectural (separate PRs per item)

**Risk:** High | **Do not batch with phases 3–4**

**Do soon (smaller items):** 7.5 (PATH `which()` in packaged builds), then 7.1 (memory) when long meetings are a product priority.

- [ ] **7.1** Stream-to-disk during capture — design doc first; feature flag; long-recording manual test. **Preserve:** post-processing mix (separate mic/desktop files), WASAPI timestamp sidecar for desktop gaps, macOS one-sided stereo repair. **Pre-fix:** stop float64 upcast in Swift `samples_to_frames` (halves desktop RAM). Est. ~8 GB RSS macOS / ~2.8 GB Windows for 2 h today.
- [ ] **7.2** **Rejected:** merging setup download queue with GPU compute queue — causes UX deadlock (transcription blocks model download). **Replace with:** gate `validateDiarizationRuntime` / `validateSummaryRuntimeSmoke` on `activeAiComputeAction` ref so smoke tests cannot run concurrently with summary/diarization/transcribe — only after 5.3 stable.
- [ ] **7.3** Device validation strict mode — **opt-in Settings toggle only**; keep fail-open default (`validate-devices` `valid: true` on timeout). Strict would block BT/VM/virtual mics without measured rollout.
- [ ] **7.4** `scan_and_sync_recordings`: prefer **idempotent scan keys** + document outer caches as perf-only (`meeting_manager.py`); avoid full-scan FileLock hold (10s timeout risk on large libraries). Add concurrent `add_meeting` regression test.
- [ ] **7.5** Packaged Swift helper: skip `shutil.which("audiocapture-helper")` when `AVANEVIS_PACKAGED=1` (set from `src/main.js`); keep `which()` for dev/`npm start` only (`swift_audio_capture.py`).

---

## Phase completion tracker

| Phase | Focus | Status |
|-------|--------|--------|
| 1 | Hygiene + `modelSize` allowlist (1.14) | Complete |
| 2 | Recording lifecycle | Not started |
| 3 | Path enforcement | Not started |
| 4 | Recorder correctness | Not started |
| 5 | AI concurrency & archives (5.3 before 5.1) | Not started |
| 6 | Performance & UX | Not started |
| 7 | Architectural | Not started |

**Suggested agent order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 (7.x one item per PR; **7.2 is the narrow compute-busy gate, not queue merge**).
