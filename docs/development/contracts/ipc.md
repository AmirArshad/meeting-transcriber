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
| `summary-service.js` | `generate-summary`, `cancel-summary-generation` |
| `meeting-manager-client.js` | `list-meetings`, `get-meeting`, `delete-meeting`, `scan-recordings`, `add-meeting`, `update-meeting`, `update-meeting-ai` |
| `device-ipc.js` | `validate-devices`, `check-disk-space`, `check-audio-output`, `get-audio-devices`, `warm-up-audio-system`, `get-macos-permission-status` |
| `file-export-ipc.js` | `save-transcript-file`, `save-speaker-segments-file`, `save-transcript-as`, `open-legal-notices` |
| `gpu-runtime-service.js` | `check-gpu`, `check-cuda`, `install-gpu`, `ensure-compatible-gpu-runtime`, `uninstall-gpu` |
| `ai-addon-ipc.js` | AI add-on status, diarization token, diarization/summary setup/cancel/validate/remove |
| `ai-compute-queue.js` | none (no IPC) — owns the compute queue itself |
| `recording-presence-service.js` | none — tray/Dock/taskbar presentation only |

Phase 0 source-scan tests treat `src/main.js` + `src/main/**/*.js` as one combined surface, so channel names and payloads stay pinned across the split.

### Facades whose export shape is pinned

`src/main-process-helpers.js` (re-exports `src/main-process/`) and `src/ai-addon-setup.js` (re-exports `src/ai-addon/`) have characterization tests over their `module.exports` key sets. Keep the key sets stable, plus the `AI_ADDON_PROGRESS_CHANNEL` / `AI_ADDON_CANCEL_CODE` string values.
