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

Source: main-flow security / performance / functional review (Electron + Python + AI add-ons). Implement **one phase per PR or agent session**. Run validation after each phase before starting the next.

**Branch:** `chore/code-review-remediation`

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

---

## Phase 1 — Low-risk hygiene (main + renderer)

**Risk:** Low | **Regression:** Unlikely on happy paths

- [ ] **1.1** Clear GPU install progress interval on failure (`src/renderer/app.js` `installGPUAcceleration` catch/finally; mirror FTUE pattern ~1022).
- [ ] **1.2** Bind `download-update` IPC to `pendingUpdateInfo` only; ignore renderer `downloadUrl` (`src/main.js`, `src/updater.js`).
- [ ] **1.3** Cap stdout/stderr buffer growth in main Python spawns and updater HTTP (`src/main.js`, `src/main-process-helpers.js` if shared helper extracted).
- [ ] **1.4** Sanitize `transcription-progress` and `model-download-progress` before IPC (`redactSensitiveText` / `ai-progress-sanitizer.js` rules).
- [ ] **1.5** Use `summarizeAiBackendError` + redaction for summary failure messages (`src/main.js` ~3448+).
- [ ] **1.6** Validate HF token format in `store-diarization-token` IPC (`isLikelyHuggingFaceToken` from `ai-addon-setup.js`).
- [ ] **1.7** Gate DevTools menu item behind `!app.isPackaged` or explicit dev flag (`src/main.js` menu).
- [ ] **1.8** Remove or gate preload `console.log` (`src/preload.js`).
- [ ] **1.9** Fix `offUpdateAvailable` to use disposer pattern instead of `removeAllListeners` (`src/preload.js`).
- [ ] **1.10** Redact HF tokens in persisted meeting AI `error` fields (`backend/meeting_manager.py`; align with `diarization_pipeline._safe_message`).
- [ ] **1.11** Share `_safe_message` redaction in `summary_runner.py` with diarization.
- [ ] **1.12** Clear `hideAiAddonProgressSoon` timeouts on new progress / teardown (`src/renderer/app.js`).
- [ ] **1.13** Home-tab `copyTranscript` clipboard `.catch` + user feedback (match history copy).

**Phase 1 tests:** extend `tests/js/main-process-helpers.test.js` / `tests/js/ai-addon-*.test.js` where sanitization or URL binding changes.

---

## Phase 2 — Recording lifecycle guards (main + renderer)

**Risk:** Medium | **Regression:** Stuck “can’t record” if process refs not cleared

- [ ] **2.1** Reject `start-recording` when `pythonProcess` active or `recordingStopPromise` in flight (`src/main.js`).
- [ ] **2.2** Always clear `pythonProcess` on `close` / `error` / `failActiveRecording` (audit all exit paths).
- [ ] **2.3** Merge duplicate `pythonProcess.on('close')` handlers into one (`src/main.js` ~2865, ~2934).
- [ ] **2.4** Renderer: set `recordingState` to `'starting'` before preflight `await`; ignore Start while busy (`src/renderer/app.js`, `recording-state-helpers.js`).
- [ ] **2.5** Renderer: disposer for countdown `setInterval` on retry/failure; call `stopTimer()` / `audioVisualizer.stop()` before retry (`app.js` ~1873–1998).
- [ ] **2.6** Renderer: session token for `onRecordingFailed` — ignore stale failures; don’t force idle during `stopping`/`transcribing` without main ack (`app.js` ~1691+).
- [ ] **2.7** Quit path: abort `aiAddonSetupAbortControllers`, cancel `activeSummaryGeneration`, drain/kill AI children before exit (`src/main.js` `before-quit` ~1646+).
- [ ] **2.8** Optional: `ipcMain` sender check `event.sender === mainWindow.webContents` (defense in depth).

**Phase 2 manual:** double-click Start during preflight; quit during recording; quit during transcription.

---

## Phase 3 — Path enforcement (main + Python)

**Risk:** Medium | **Regression:** False rejections if call sites pass paths outside recordings

**Prerequisite:** Grep all `addMeeting`, `transcribeAudio`, `add-meeting`, `transcribe-audio` call sites.

- [ ] **3.1** `addMeetingToHistory` / `add-meeting`: `assertSafeExistingRecordingAudioPath` + markdown guard before spawn (`src/main.js` ~444+).
- [ ] **3.2** `transcribe-audio`: always resolve under recordings + `assertSafeExistingRecordingAudioPath` (match guided path ~3059).
- [ ] **3.3** `meeting_manager.add_meeting`: require resolved paths under `recordings_dir`; reject `..` escapes (`backend/meeting_manager.py`).
- [ ] **3.4** `add_meeting`: fail or retry if audio/transcript missing (avoid broken history rows); document race with async transcript write.
- [ ] **3.5** Renderer defensive: `result.audioPath || result.outputPath` after stop (`app.js` ~2013+).
- [ ] **3.6** Tests: `tests/python/test_meeting_manager.py` for path rejection; `tests/js/main-process-helpers.test.js` if helpers extended.

**Phase 3 manual:** full record → stop → transcribe → save; scan/import if used.

---

## Phase 4 — Python recorder correctness (Windows + macOS)

**Risk:** Medium | **Regression:** Trimmed tail audio (macOS flag); stricter failure surfaces

- [ ] **4.1** Windows: on any `start_recording` failure, set `is_recording = False` and close partial streams (`windows_recorder.py` ~424–520).
- [ ] **4.2** Windows: `cleanup()` stop/close streams before `pa.terminate()` (`windows_recorder.py` ~857+).
- [ ] **4.3** Windows: wrap final JSON in stdout lock / `_send_json_message` (~967).
- [ ] **4.4** macOS: gate mic callback on `_get_running()` (`macos_recorder.py` ~572+).
- [ ] **4.5** macOS: lock or drain-before-`to_array()` for `ChunkedAudioBuffer` (coordinate with `chunked_audio_buffer.py`).
- [ ] **4.6** macOS: empty mic → structured stdout `error` / `success: false`; do not emit bogus `outputPath` (`macos_recorder.py` ~804+, ~1223+); align `src/main.js` parser if needed.
- [ ] **4.7** macOS: validate `mic_device_id` after enumeration (`macos_recorder.py`, `device_manager.py`).
- [ ] **4.8** Swift: rate-limit or drain stderr aggressively to avoid pipe stall (`swift_audio_capture.py`).
- [ ] **4.9** Update `tests/js/main-process-helpers.test.js` if stop/result parsing changes; Python compile + manual smoke both platforms.

**Phase 4 manual:** `tests/manual/recording-smoke-checklist.md` on Windows and macOS; mic permission denied on macOS.

---

## Phase 5 — AI concurrency, errors, and archive hardening

**Risk:** Medium–high | **Regression:** Slower parallel ops; queue deadlocks without timeouts

- [ ] **5.1** Route `transcribe-audio` and `download-model` through `enqueueAiComputeAction` (or shared GPU lock) (`src/main.js`).
- [ ] **5.2** Gate setup validation: no GPU smoke test on addon queue while compute queue busy (unify or block — document in `AGENTS.md`).
- [ ] **5.3** Wall-clock timeout + process kill for hung compute jobs (`createAsyncActionQueue` / per-job wrapper).
- [ ] **5.4** Summary metadata failure: delete orphan sidecars or transactional metadata+files (`src/main.js` ~3456+).
- [ ] **5.5** ZIP extraction: reject symlink entries / validate link targets like tar (`ai-addon-archive-helpers.js`, `ai-addon-zip-extractor-worker.js` + tests).
- [ ] **5.6** MLX cache completeness: non-empty file checks aligned with faster-whisper + `main-process-helpers.js` (`mlx_whisper_transcriber.py`).
- [ ] **5.7** faster-whisper cache dir matching: exact hub folder names vs substring (`faster_whisper_transcriber.py`).
- [ ] **5.8** Optional hardening: pass HF token to validation spawn without env (stdin/temp file) — lower priority.
- [ ] **5.9** Update `AGENTS.md` GPU serialization section when 5.1–5.2 land.

**Phase 5 manual:** `tests/manual/local-ai-addons-checklist.md`; attempt overlapping transcribe + diarize + summary setup.

---

## Phase 6 — Performance and UX (renderer + main)

**Risk:** Low–medium | **Regression:** Search feels delayed; less frequent disk sync

- [ ] **6.1** Debounce meeting search input (150–300 ms) (`app.js` ~1587+).
- [ ] **6.2** `loadMeetingHistory`: skip `scanRecordings()` except launch / explicit refresh (`app.js` ~1533+).
- [ ] **6.3** Audio visualizer: pause rAF when document hidden; lower FPS or skip redraw when levels unchanged (`app.js` ~3973+).
- [ ] **6.4** Normalize `meetingId` to string at selection and in summary comparisons (`app.js`).
- [ ] **6.5** Chunked transcript rendering for large meetings (`requestAnimationFrame` / collapse) — optional if needed after profiling.
- [ ] **6.6** Markdown links: restrict to `https:` and `mailto:` for AI-generated content (`app.js` ~354+).
- [ ] **6.7** `handleDismissUpdate`: clear `currentUpdateInfo`; validate full payload on replay (`update-notification-helpers.js`, `app.js`).
- [ ] **6.8** Allowlist `modelSize` on download/check IPC (`src/main.js`).

---

## Phase 7 — High-risk / architectural (separate PRs per item)

**Risk:** High | **Do not batch with phases 3–4**

- [ ] **7.1** Stream-to-disk during capture (Windows frame lists, macOS desktop/Swift buffers) — design doc first; feature flag; long-recording manual test.
- [ ] **7.2** Full single GPU queue including setup pip/download vs compute (only after 5.1–5.3 proven stable).
- [ ] **7.3** Fail-closed device validation (product decision; may block VMs/BT mics) — optional strict mode vs preflight-only.
- [ ] **7.4** `scan_and_sync_recordings` hold lock for full scan or idempotent scan keys (`meeting_manager.py`) — measure lock timeout on large libraries.
- [ ] **7.5** Production Swift helper path: skip `PATH` `which()` when bundled (`swift_audio_capture.py`).

---

## Phase completion tracker

| Phase | Focus | Status |
|-------|--------|--------|
| 1 | Hygiene | Not started |
| 2 | Recording lifecycle | Not started |
| 3 | Path enforcement | Not started |
| 4 | Recorder correctness | Not started |
| 5 | AI concurrency & archives | Not started |
| 6 | Performance & UX | Not started |
| 7 | Architectural | Not started |

**Suggested agent order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 (7.x one item per PR).
