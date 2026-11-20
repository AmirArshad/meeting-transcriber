# IPC contract

The channel ownership table below is canonical. A channel rename or payload change updates its owning `src/main` service, `src/preload.js`, every renderer call site, and characterization/source-scan tests. Keep `src/main.js` a composition root and preserve the export key sets of `main-process-helpers` and `ai-addon-setup`.

### Renderer conventions

Plain HTML/CSS/JS — no React or Vue. `src/renderer/app.js` is the state machine; prefer **extracting** pure logic into `src/renderer/*-helpers.js` with a matching `tests/js/*-helpers.test.js` over growing `app.js`. IPC only through `window.electronAPI`.

Non-obvious: the saved `.md` transcript is the source of truth (the viewer renders it with timestamp chips); meeting rename updates metadata **by meeting ID and deliberately does not rename files on disk**; keep the DPR-aware canvas/scrubber patterns when touching the visualizer or playback UI.

## Cross-cutting change checklists

Each of these fans out further than it looks.

- **Recorder process output** → Windows/macOS/Linux recorders, `src/main/recorder-service.js`, `src/main-process/recorder-output-helpers.js` (+ facade), `tests/js/recorder-event-contract.test.js`, and any renderer UI state keyed on that progress.
- **Saved meeting filenames or locations** → `recorder_temp_paths.py`, Windows/macOS/Linux recorders, compressor input-format handling, `backend/meeting_manager.py`, `backend/meetings/scan_import.py`, delete logic, renderer playback assumptions, `tests/python/test_recorder_temp_and_scan_recovery.py`.
- **Model download behavior** → `src/main.js`, the renderer first-time setup flow, transcriber `--preload` CLI behavior, and build logic if bundled/offline semantics change.
- **AI catalog or runtime pins** → `src/ai-addon-state.js`, `src/ai-addon-setup.js` if cache/setup semantics move, `docs/development/LOCAL_AI_MODEL_CATALOG.md`, `todo.md` if product defaults change, `tests/js/ai-addon-*.test.js`. Adding or renaming an engine also updates Settings About credits (`src/renderer/index.html`), `THIRD_PARTY_NOTICES.md`, and `tests/js/legal-notices.test.js`.

## IPC channel ownership

Not inferable from the tree, and the highest-risk surface in the repo. Renaming or re-shaping a channel means updating the owning service, `src/preload.js`, **and every** renderer call site.

| Service in `src/main/` | Channels |
|---|---|
| `recorder-service.js` | `run-recording-preflight`, `start-recording`, `stop-recording`, `cancel-recording`, `get-recording-state` |
| `transcription-service.js` | `check-model-downloaded`, `download-model`, `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, `retry-transcription`, `finalize-recording-transcription`, `cancel-pending-transcription` |
| `audio-import-service.js` | `select-import-audio`, `start-import-audio`, `cancel-import-audio`, `import-audio-progress` (event) |
| `summary-service.js` | `generate-summary`, `cancel-summary-generation` |
| `history-search-service.js` | `search-history`, `rebuild-history-index`, `get-history-index-status` |
| `history-qa-service.js` | `get-history-qa-eligibility`, `get-history-qa-model-state`, `unload-history-qa-model`, `ask-history`, `cancel-history-qa`, `list-chat-threads`, `get-chat-thread`, `create-chat-thread`, `rename-chat-thread`, `delete-chat-thread`, `update-chat-thread-scope`, plus `history-qa-model-state` / `history-qa-progress` events |
| `meeting-manager-client.js` | `list-meetings`, `get-meeting`, `delete-meeting`, `scan-recordings`, `add-meeting`, `update-meeting`, `update-meeting-ai` |
| `device-ipc.js` | `validate-devices`, `check-disk-space`, `check-audio-output`, `get-audio-devices`, `warm-up-audio-system`, `get-macos-permission-status` |
| `file-export-ipc.js` | `save-transcript-file`, `save-speaker-segments-file`, `save-transcript-as`, `open-legal-notices` |
| `gpu-runtime-service.js` | `check-gpu`, `check-cuda`, `install-gpu`, `ensure-compatible-gpu-runtime`, `uninstall-gpu` |
| `ai-addon-ipc.js` | AI add-on status, diarization token, diarization/summary setup/cancel/validate/remove |
| `updater-service.js` | `get-update-state`, `check-for-updates`, `download-update`, `cancel-update-download`, `install-update-now`, `set-auto-download-updates`, `open-update-release-page`, plus `update-state-changed` (event) |
| `ai-compute-queue.js` | none (no IPC) — owns the compute queue itself |
| `recording-presence-service.js` | none — tray/Dock/taskbar presentation only |

Phase 0 source-scan tests treat `src/main.js` + `src/main/**/*.js` as one combined surface, so channel names and payloads stay pinned across the split.

### Local audio import

The native picker returns the basename of one selected MP3, WAV or Opus file. Main owns the selected path and staging directory. Start accepts the same transcription selection used for recording finalization. Progress carries the preparing and saving phases. Cancellation waits for conversion and cleanup before acknowledging, and becomes unavailable when saving begins. A committed result includes the saved meeting even if queue admission fails. After saving, use the ordinary Activity cancellation and retry channels.

### Summary language payload

`generate-summary` requires `{ meetingId, transcriptLanguage,
sourceTranscriptHash, profile? }`, with optional `modelId` constrained to the
installed model. Main validates eligibility and the current on-disk transcript;
it passes `--language`, `--source-transcript-hash` and `--model-id` to the local
runner. Successful `ai.summary` metadata may add `language`, `languageSource`
(`userConfirmed`), `modelId`, and `languagePolicyVersion`. Missing fields mean
legacy/unconfirmed output. Channel names and preload export shape are unchanged.

### Transcript & subtitle export

`save-transcript-as` accepts `{ format, suggestedName, title?, content?, meetingId? }`, where `format` is one of `md`, `txt`, `srt`, or `vtt`, and sanitizes the dialog filename with `buildSafeSaveDialogDefaultPath` (`WINDOWS_RESERVED_FILE_BASENAME`, preserving dotted directories via `path.parse` / `path.win32.basename`). For `srt` and `vtt`, main verifies `meetingId`, resolves the current on-disk Markdown SHA-256 against the `{stem}.captions.json` `sourceTranscriptHash` (`CAPTIONS_MISSING` / `CAPTIONS_STALE` when absent or edited without fabricating timings), and serializes cues via the shared `src/renderer/subtitle-export-helpers.js` UMD module. The separate Summary Save As flow remains Markdown-only.

### Local History search & threaded Chat

`history-search-service.js` owns the disposable SQLite FTS5 cache (`userData/search/history-index.sqlite`) and exposes `search-history` (debounced renderer search returning BM25-ranked meetings with highlighted `snippetParts` and `[MM:SS]` timestamp jump coordinates), `rebuild-history-index`, and `get-history-index-status`. `history-qa-service.js` owns `userData/chat/threads.json` (`chat-thread-store.js`) and exposes `list-chat-threads`, `get-chat-thread`, `create-chat-thread`, `rename-chat-thread`, `delete-chat-thread`, `update-chat-thread-scope`, `get-history-qa-eligibility`, `get-history-qa-model-state`, `unload-history-qa-model`, `ask-history`, `cancel-history-qa`, plus renderer push listeners `onHistoryQaModelState` (`history-qa-model-state`) and `onHistoryQaProgress` (`history-qa-progress`). The renderer renders Chat responses exclusively via bundled offline `marked` + strict-allowlist `DOMPurify` (`src/renderer/markdown-render-helpers.js`) and never sends bearer tokens, ports, or arbitrary file paths over IPC.

### In-app auto-updater

`updater-service.js` owns `electron-updater` lifecycle (`in-app` mode on packaged Windows NSIS, macOS `.zip`, and Linux AppImage), Linux `pacman`/`.deb` `manual-package` fallback (via `src/updater.js` release detection + strict filename-validated install command), and `userData/updater-preferences.json` (`autoDownload: false` by default). Every `update-state-changed` push and state snapshot carries a monotonically increasing `seq`. The renderer never passes feed URLs, versions, or paths over IPC, and renders release notes strictly through `markdown-render-helpers.js` (`STRICT_DOMPURIFY_CONFIG`). `install-update-now` rejects active recording (`UPDATE_BLOCKED_RECORDING`), active audio import (`UPDATE_BLOCKED_IMPORT_SAVE`), and summary `metadata` commits (`UPDATE_BLOCKED_SUMMARY_FINALIZING`), and prompts confirmation (`UPDATE_CONFIRM_AI_INTERRUPT`) before draining active local AI work and calling `quitAndInstall(false, true)`.

### Facades whose export shape is pinned

`src/main-process-helpers.js` (re-exports `src/main-process/`) and `src/ai-addon-setup.js` (re-exports `src/ai-addon/`) have characterization tests over their `module.exports` key sets. Keep the key sets stable, plus the `AI_ADDON_PROGRESS_CHANNEL` / `AI_ADDON_CANCEL_CODE` string values.
