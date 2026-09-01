# AvaNevis Agent Guide

Canonical, always-on instructions for **Cursor**, **OpenCode**, and **Claude Code**. This file is the single home for every cross-process rule; other agent files point here rather than restating.

AvaNevis is a privacy-first Electron desktop app: record mic + desktop audio, transcribe locally with Whisper. Electron 44 + plain HTML/CSS/JS frontend, Python 3.11 subprocesses for the backend, optional local AI add-ons (diarization, summaries). Recordings and metadata live in Electron `userData`, never in the repo.

Setup, install, and build commands: root `README.md`. Fresh-machine test setup: `docs/development/TESTING.md`.

## How each tool loads this file

Verified, not assumed — correct these only with evidence.

| Tool | Always-on | On demand |
|------|-----------|-----------|
| Claude Code | root `CLAUDE.md` (imports this file via `@AGENTS.md`), `.claude/rules/*.md` **without** a `paths:` field | `.claude/rules/*.md` **with** `paths:`; skills in `.claude/skills/` |
| Cursor | this file + `.cursor/rules/*.mdc` with `alwaysApply: true` | `.cursor/rules/*.mdc` matching `globs:` |
| OpenCode | this file + every path in `opencode.json` `instructions` (currently **all** `.cursor/rules/*.mdc`, glob-expanded — `globs:`/`alwaysApply:` frontmatter is inert there) | — |

**Gotcha:** Claude Code does **not** read `AGENTS.md`, `.cursor/rules/`, or `.agents/skills/`. It reaches this file only through the `@AGENTS.md` import in root `CLAUDE.md`, and it reaches project skills only through `.claude/skills/`. Root `CLAUDE.md` is `.cursorignore`d so Cursor does not double-load this file.

Project skills live in `.agents/skills/*/SKILL.md`; see `.agents/README.md` for the kept/removed set and discovery details. The official Anthropic `frontend-design` skill is also copied to `.claude/skills/frontend-design/` for direct Claude Code discovery; Cursor receives a scoped renderer router in `.cursor/rules/frontend-design-skill.mdc`, while OpenCode loads the canonical `.agents` skill and that router through `opencode.json`.

## Platform targets

- Windows 10/11 x64; macOS 14+ runtime, packaged macOS builds are Apple Silicon (`arm64`) only.
- Linux Core Beta (Omarchy first) is merged to `master` (`docs/initiatives/LINUX_SUPPORT.md`). Pulse/PipeWire capture uses opaque device IDs (`pulse-source:<name>`, `pulse-monitor:<name>`, `pulse-sink:<name>`, `none`); renderer and IPC must not `parseInt` them. Packaged x86_64 AppImage + pacman + experimental `.deb` (`AvaNevis-Setup-*`, electron-builder 26.x `toolsets.appimage` `1.0.2`, no host fuse2). Core Beta transcription remains CPU `faster-whisper` — preload and transcribe pass `--device cpu` until the dedicated v2.9 Linux-AI lane accepts a managed CUDA profile. The v2.9 Linux-AI lane is limited to CachyOS x86_64 + NVIDIA RTX 4070 and must separately accept managed CUDA Whisper, Speakrs, Pyannote, and summaries through pinned artifacts, encrypted non-`basic_text` `safeStorage` for Pyannote, packaged verification, and hardware evidence. Every unaccepted Linux AI path stays greyed fail-closed `unsupported`, with no CPU fallback or broader support claim. Phase 3 60-minute soak was cancelled 2026-08-27 (not run). Gate B closed 2026-08-28; the release workflow includes all three Linux artifacts. **Supported** Linux targets are Omarchy 4 and CachyOS x86_64 on Hyprland/Wayland + PipeWire (same Core Beta payload); Linux AI support is more narrowly limited to the accepted RTX 4070 profile. Ubuntu, vanilla Arch, Fedora Workstation, SteamOS Desktop Mode, other CachyOS desktops, and extra desktops are **experimental betas** (`docs/guides/LINUX_EXPERIMENTAL.md`) with no hardware claim. The Ubuntu desktop recording/`safeStorage` smoke remains open. Linux packaging verification must not require `dpkg-deb` (Arch-family hosts use `ar`+`tar`).
- `src/main.js` keeps a `faster-whisper` fallback for Intel Macs in dev logic, but packaged builds do not target Intel.
- Windows transcription: `faster-whisper`. Apple Silicon: `lightning-whisper-mlx`. Linux Core Beta: `faster-whisper` on **CPU** only.

## End-to-end flow

Renderer (`src/renderer/app.js`) → `window.electronAPI` (`src/preload.js`) → `ipcMain.handle` in a `src/main/` service → Python spawned via `src/main/python-runtime.js`. The recorder streams structured JSON on stdout; `src/main/recorder-service.js` parses it and persists finished meetings through `backend/meeting_manager.py`.

`src/main.js` is the composition root only — lifecycle, tray, quit drain, service wiring. A few platform/update channels are still registered there directly; everything else lives in a `src/main/` service.

### IPC channel ownership

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

## Critical invariants

### Recorder stdout is the control contract

Recorder **control flow** rides structured **stdout** JSON — `levels`, `event`, `warning`, `error` — parsed line-by-line by `parseRecorderStdoutChunk`. **stderr is diagnostics-only and must never drive startup stages, warnings, errors, or recording-start state.**

Change startup/progress in `backend/audio/windows_recorder.py`, `macos_recorder.py`, or `linux_recorder.py` and you must update, together: `src/main/recorder-service.js`, `src/main-process/recorder-output-helpers.js` (and the `src/main-process-helpers.js` re-export), `tests/js/main-process-helpers.test.js`, `tests/js/recorder-event-contract.test.js`. The migration in `docs/completed/json-based-events.md` is complete; do not partially revert it.

- Stop-stage events, both platforms: `post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, `post_processing_complete` — forwarded as `recording-progress`.
- Stdin control is **exact-token only** (`line.strip().lower()` equals `stop` or `cancel`) — not a substring match.
- Final JSON: Windows emits `audioPath`, macOS and Linux emit `outputPath`. Stop parsing accepts both.
- Stop/finalize **failures must still emit a structured `success:false` payload** carrying a recoverable path when a final or temp file exists. Never exit with only a stderr traceback.
- Windows: set `_final_output_path` immediately after compress succeeds, guard temp unlink with `OSError`, and emit the success JSON **before** `cleanup()` (`pa.terminate()`).
- macOS: late desktop-capture failure (after a successful start) warns and continues mic-only. Only mic-thread failure is a hard stop failure. v2.9 retains this conservative policy: late helper failure discards the desktop track for the mix rather than mixing a truncated committed desktop path. Do not copy Linux's keep-committed-frames behavior onto macOS without isolated hardware evidence that preserving those frames is safe.
- Linux: late desktop loss is a vanished Pulse monitor (`source_list()` no longer lists the selected `pulse-monitor:`). SoundCard may keep returning silence with no exception — poll `source_list()` over **one long-lived** watch client (never a new `pulsectl.Pulse` per poll) and warn. Unlike macOS, a late desktop loss **keeps the desktop frames already committed** and mixes them truncated at the last real frame: switching audio output mid-meeting is routine on Linux, so `_close_capture_spools_for_mix` excludes the desktop track only on a *spool* failure, never on a capture-side loss. The warning copy must say the earlier desktop audio is kept. Mic-thread failure is fatal. Desktop startup failure is warning + mic-only.
- Linux capture threads block inside `recorder.record()`, so stop can close and commit a spool underneath them. Re-check `_get_running()` after every `record()` return **and** after an `append()` that returns `False` — otherwise a closed-at-stop spool is misreported as a writer stall, `stop_recording` sees an async failure, and finalization is skipped on an otherwise complete meeting. For the same reason a capture-thread exception raised **after** stop/cancel already cleared the running flag is teardown noise (usually the SoundCard recorder's `__exit__`): log it to stderr and return. Setting `_error_event` there makes `stop_recording` take the async-failure branch *after* the spools are closed, skipping `finalize_capture` and reporting `RECORDING_THREAD_FAILED` with `duration: 0` on a complete meeting. The desktop equivalent must not emit a phantom `DESKTOP_RECORDING_FAILED` — on Discard it would contradict the `cancelled: true` result.
- The Linux vanished-monitor watch client is shared mutable native state. `_close_watch_pulse()` must hold `_watch_pulse_lock` **across** `close()`, and `_watch_source_names()` must hold it across `source_list()` — stop and cancel only join capture threads with a bounded timeout, so a stalled thread can still be inside libpulse when the main thread tears the client down, and freeing a mainloop under an in-flight call is a native use-after-free, not a catchable error. `_close_watch_pulse(final=True)` latches the client closed so a late loop iteration cannot reconnect; the desktop loop must re-check `_get_running()` / `_desktop_give_up` **before** the vanish probe so stop never emits `DESKTOP_MONITOR_VANISHED` on the way out.
- Linux device resolution is exact-match only: SoundCard's `get_microphone()` matches by substring, so a fallback that resolves to a different `id`/`name` than the requested Pulse source must raise rather than silently record the wrong device.
- Pulse port availability comes back as `pulsectl.EnumValue`, which has **no** `.name`, is not an `int` subclass, and reprs as `<EnumValue available=no>`. `is_pulse_port_unavailable` reads `_value` (or compares via `EnumValue.__eq__` against native strings) — a `.name`/`str()` probe silently returns `False` for every real port and disables unplugged-endpoint filtering. Test it against `PulsePortAvailableEnum`, not only hand-written fakes.
- Live stdout may stash a `result` payload for unexpected-exit recovery. There is no legacy `temp.opus` stop fallback.

### Recording data-loss guards

- `cancel-recording` (Discard) **never** calls `addMeetingToHistory` and never enqueues transcription. Stop and cancel are mutually exclusive — first command wins.
- `cancel` skips Stage A / `finalize_capture`, tombstones the capture manifest as `discarded` before best-effort spool cleanup, and emits `{ success: true, cancelled: true }`. A crash before the discarded marker stays recoverable as a normal interrupted capture.
- Capture sessions in `state: discarded` are cleanup-only for discovery/scan-import — **never resurrected as meetings**.
- Renderer cancel carries the known `sessionId`; main rejects a mismatch with `RECORDING_SESSION_MISMATCH` so a stale Start continuation cannot cancel a newer session. Pre-spawn cancel may omit the ID and stays generation-guarded.
- Quit-cancel recovery and a pending Stop IPC share one stop result: stop awaits the quit workflow before returning, so `alreadyPersistedForQuit` closes the dialog-open race. A quit cancel issued after `stop` was sent must await and persist that result — never claim "recording continues".
- Disk space warns below 10 GB and flags critical below 2 GB, but **never auto-stops**. Hourly recording reminders are best-effort and likewise never auto-stop.
- Recorder startup keeps its 15 s / 10 s wall clock even while the startup-cancel callback is installed. Cancel gets the stop wall-clock budget plus bounded post-kill settlement: **a child that never closes must not leave the cancel promise permanently latched**, while capture presence stays `cancelling` until process truth changes. `recorder-service.js` publishes the authoritative `starting`/`recording`/`stopping`/`cancelling`/`idle` transitions and owns the stop heartbeat and the power-save blocker — dropping the blocker lets the machine sleep mid-recording.

### Platform traps

- **Windows save dialogs:** file basenames are sanitized against `WINDOWS_RESERVED_FILE_BASENAME` by `buildSafeSaveDialogDefaultPath` (`src/main/file-export-ipc.js`). A meeting titled `CON`, `PRN`, `AUX`, `NUL`, `COM1`… is unwritable on Windows even with an extension. Do not bypass that helper when adding an export path.
- **macOS tray icon:** call `setTemplateImage(false)` **before** `setImage` for the saturated recording-status icon. Template images get auto-tinted monochrome, which silently destroys the red REC indicator.
- **Windows capture cleanup:** see **Python backend** below — the lock must be released before `rmtree`.

### Post-processing mix architecture

Mic and desktop audio are recorded **separately and mixed after stop** — deliberately. Do not reintroduce real-time mixing without an intentional redesign.

Platform recorders always spill raw capture to durable `{stem}.capture/` track spools during recording; stop finalizes via bounded `finalize_capture` (`windows-v1`, `macos-v1`, `linux-v1`). Interrupted sessions recover through `audio.capture_recovery`. Whole-session RAM mix (and its `MemoryError` path) is obsolete.

Preserve: 48 kHz, stereo, mono-compatible stereo for transcription downmixes, Opus via ffmpeg, gentle mic enhancement, faithful desktop audio, and mic-only degradation rather than discarding the microphone recording. Final mix duration on `windows-v1`, `macos-v1`, and `linux-v1` is bounded by the microphone timeline — desktop leading-pad/trim alignment must not extend the finished file past the mic track.

**Temp-file gotchas:** post-processing temps use a deliberately non-scanned `.pcm.tmp` extension (`backend/audio/recorder_temp_paths.py`). Scan-import recovers orphan temps into `{stem}.wav`, or deletes them when a final Opus/WAV already exists. Temps at or below WAV-header size are **dropped, not promoted**. macOS recovery must promote a leftover `.pcm.tmp` to a stable `{stem}.wav` before emitting `outputPath` — never hand Electron the volatile temp path.

### Privacy is a hard constraint

No cloud transcription. No telemetry or analytics. No background uploads. No network dependency beyond explicit model/update checks and build-time downloads.

### Local AI add-ons: catalog-driven and explicit

**Token handling (hard constraint).** Diarization uses `pyannote/speaker-diarization-community-1` with the **user's own** Hugging Face token only — never embed, proxy, log, or persist a maintainer token. Tokens stay in Electron `safeStorage` and must never reach manifests, meeting metadata, transcripts, summaries, progress events, or logs. Setup validation passes the token by stdin (`--token-stdin`) and clears `HF_TOKEN`, `HUGGINGFACE_HUB_TOKEN`, the deprecated `HUGGING_FACE_HUB_TOKEN`, and `HF_TOKEN_PATH` from the child env via `buildClearedHuggingFaceTokenEnv()`.

**Speakrs is a user-selectable exclusive engine.** Speaker identification is Speakrs or pyannote — only one may be installed. New / unset users default Speakrs; existing pyannote installs stay until the user switches. Speakrs is token-free. Switching to Speakrs deletes pyannote models and deps but **keeps** the Hugging Face token in `safeStorage` so a later Pyannote switch can reuse it; **Remove** still deletes the token. Windows Speakrs uses setup-time ONNX Runtime **1.27.1** (cuda12) plus the existing transcription cuda12 pip DLLs; do **not** claim a Windows speed or DER win vs pyannote CUDA. Extracted Windows ORT DLLs are SHA-256 and size pinned in `src/ai-addon/speakrs-pack-spec.js`; setup validation full-hashes those catalog pins, and each Speakrs compute admission full-hashes changed `path + size + mtimeMs` fingerprints. Neither path may trust hashes from user-writable `install.json`. The `speakrs-cli` binary is installer-bundled; packaged CLI and fixture checks are fail-closed via `src/ai-addon/speakrs-cli-integrity.js`, including passive readiness status. Model packs and the Windows ORT archive stay setup-time downloads.

> **Trap:** never set `HF_TOKEN_PATH` to `""` — `huggingface_hub` reads that as `Path(".")` and breaks offline pyannote loads. The helper sets it to `os.devNull`.

**Supply chain (hard constraint).** Summary downloads stay HTTPS and host-allowlisted via `DOWNLOAD_REDIRECT_HOSTS` in `src/ai-addon/download-helpers.js` — maintain that list when HF/Xet CDNs rotate, and **never** add `*.hf.co`-style wildcards. Runtime archives verify pinned SHA-256 and extract through the path-traversal guards in `src/ai-addon-archive-helpers.js`, off-thread (`src/ai-addon-zip-extractor-worker.js`, `src/ai-addon-tar-extractor-worker.js`). Model and runtime artifacts are pinned in `src/ai-addon-state.js` — never hard-code URLs, filenames, checksums, or runtime names in renderer or business logic. Diarization model refs are resolved from the catalog **in the main process**, never trusted from renderer input.

- Diarization runs automatically only after transcription, when setup is complete and platform policy allows. Speakrs on macOS is Apple Silicon **CoreML-only**; pyannote on macOS is Apple Silicon **MPS-only**. Do not add a CPU fallback for either engine.
- For new recordings with diarization ready, prefer guided transcription: the selected engine first, padded speaker windows, then transcribe those windows. If it fails, save a normal transcript and persist diarization error metadata.
- Summaries are **always user-triggered** from Home or History. Setup is always an explicit user action — no hidden or background downloads.
- Meeting AI metadata accepts only `diarization` and `summary`, keeps sidecar paths under recordings, and stores only concise sanitized strings.
- Transcription metadata records `transcriptionDevice` / `transcriptionComputeType` (`cpu`/`cuda`/`mps`). MLX may report `metal` in result JSON; `meeting_manager` normalizes that alias to `mps`. Guided transcription reports the Whisper runtime separately from `diarization.device` (Speakrs `cuda`/`coreml`, or pyannote `mps`/`cuda`).
- Add-on caches live under `userData/ai-addons/models/...` so app updates preserve installed artifacts.
- Stale summaries are detected through `sourceTranscriptHash`.

**Accepted tradeoff — summary checksum skip.** `generate-summary` calls `checkAiAddonSetupStatus({ verifyChecksums: true, verifyChecksumsIfChanged: true })`. After the first full SHA-256 match in a process, later generates skip re-hashing when the `path`/`size`/`mtimeMs` fingerprint is unchanged. A local attacker preserving size and mtime could bypass it. This is deliberate for an already-locally-trusted file. **Setup and validate paths still full-hash — do not weaken those gates.**

### Summary finalization must not be interrupted

Finalization (`phase = 'metadata'`) begins **before** temp→final sidecar renames. Quit and cancel must not abort inside that region, and the immediate-quit kill loop must spare a metadata-phase `update-ai` process. After a successful `update-ai` exit, **never delete sidecars** because of a late abort.

If the outer wall clock still rejects during metadata (hung `update-ai`), clear `activeSummaryGeneration` so later generates are not sticky-locked — the sidecars are already committed. Cancelling a summary still in preflight or queued (no metadata phase) must clear `activeSummaryGeneration` immediately so the UI is not stuck behind a dead queue slot.

### Quit drain

`drainAiWorkBeforeQuit` sets `quitCommitted` (which rejects new `start-recording` / `generate-summary`), notifies the renderer via `app-quit-progress`, **terminates** non-abortable transcription-class compute jobs rather than merely skipping the wait, and arms `allowImmediateQuit` inside `finally`.

**Gotcha:** the armed `before-quit` pass re-checks **recording only**. Remaining AI/GPU work deliberately falls through to force-kill — re-draining there previously looped forever. Decision helper: `resolveBeforeQuitAction` in `src/main-process/quit-lifecycle-helpers.js`.

### Transcription model cache and offline runtime

Whisper caches are **separate** from the diarization HF cache under `userData/ai-addons/models/diarization`. Guided transcription must not let diarization's `HF_HUB_CACHE` mask the Whisper cache — it passes `AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR` for Whisper only.

**Locations.** faster-whisper (Windows / Intel Mac): `~/.cache/huggingface/hub`, as `models--Systran--faster-whisper-<size>` or legacy `models--guillaumekln--faster-whisper-<size>`. MLX (Apple Silicon): `~/Library/Caches/avanevis/mlx_models/<model-dir>/`.

**Completeness — keep JS and Python aligned.** faster-whisper snapshot needs non-empty `config.json`, `model.bin`, `tokenizer.json`, plus `vocabulary.txt` **or** `vocabulary.json`. MLX needs non-empty `weights.npz` and `config.json`.

Implemented in `cacheContainsCompleteTranscriptionModel` / `buildTranscriptionRuntimeEnv` (`src/main-process-helpers.js`), `getTranscriptionRuntimeEnv` (`src/main/transcription-service.js`), `has_cached_faster_whisper_model` (`backend/transcription/faster_whisper_transcriber.py`), and `_required_model_files_cached` (`backend/transcription/mlx_whisper_transcriber.py`). Changing the required files or the env var names means updating all four plus `tests/js/main-process-helpers.test.js` and `tests/python/test_transcriber_helpers.py`.

**Offline behavior.** Set HF offline / `local_files_only` only when the cache is **complete** (`AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1`; Python may also auto-detect). Model download / `--preload` must keep `modelCached: false` so an incomplete cache can still finish downloading. Diarization loads pyannote with `local_files_only=True`; summary generation uses `buildHuggingFaceOfflineEnv()` when artifacts are installed.

**Windows CUDA profile.** Packaged transcription supports a CUDA 12 profile (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) and probes matching DLLs before GPU use. If only a newer CUDA major is present (CUDA 13 DLL names), surface a runtime-major mismatch and stay on CPU. Install/repair/uninstall/ensure are serialized through a main-process lock with a wall-clock timeout, separate from `aiAddonActionQueue` and `aiComputeActionQueue`.

### GPU compute serialization and timeouts

One main-process queue (`aiComputeActionQueue`, from `src/main/ai-compute-queue.js`) so only one GPU-heavy job runs at a time.

**On the queue:** `transcribe-audio`, `transcribe-audio-with-speakers`, `diarize-transcript`, `generate-summary` (generation subprocess only — meeting preflight runs before enqueue).

**Off the queue, but still serialized elsewhere:**

- Whisper `download-model` / preload must **not** enqueue on the compute queue. It admits **between jobs** on the composition-root `gpuResourceActionQueue`, in the gap after the active transcription releases it. No `MODEL_DOWNLOAD_COMPUTE_BUSY` fail-fast, and no 15-minute idle wait. `cancel-download-model` aborts an in-flight preload. A non-zero preload exit must re-check cache completeness before reporting success.
- AI add-on setup downloads use `aiAddonActionQueue`.
- GPU runtime install/repair/uninstall uses `gpuRuntimeActionPromise`, made mutually exclusive with active compute and Whisper preload through that same `gpuResourceActionQueue` so pip cannot race loaded CUDA DLLs — again by between-job admission, with no `GPU_RUNTIME_COMPUTE_BUSY` fail-fast and no idle wait. Compute actions must rely on this FIFO rather than awaiting a later `gpuRuntimeActionPromise` while holding the resource slot. Parked preload/runtime actions re-check `quitCommitted` at execution time. Destructive add-on removal rejects while compute/preload/runtime work is pending, then synchronously reserves the resource queue before deleting — it must not wait unbounded behind active work, nor begin later during quit teardown.

**Wall-clock timeouts.** `runWallClockComputeAction` (`src/main-process-helpers.js`) kills the active child via `terminateProcessBestEffort` past a per-job limit, then waits for both child exit and job settle before releasing the queue, bounded by `AI_COMPUTE_TIMEOUT_MS.wallClockSettleGraceMs` so an unkillable child cannot hold it forever. The grace timer is cleared on both race outcomes so a first-settling action cannot leak a live callback, while the timeout promise still settles if the action never does. That timer-cleanup correction is a Speakrs-review exception to the plan freeze on `src/main-process/compute-timeout-helpers.js`. It must also terminate processes registered *after* timeout/quit/settlement — including a transcription child spawned after an awaited CUDA probe during settle grace.

| Job | Limit |
|---|---|
| Transcription | `getTranscriptionComputeTimeoutMs`, 30–120 min by model size |
| Diarization | 30 min (`AI_COMPUTE_TIMEOUT_MS.diarization`) |
| Guided transcription | `getGuidedTranscriptionComputeTimeoutMs(modelSize)` — model budget + 30 s margin. The flat `AI_COMPUTE_TIMEOUT_MS.guidedTranscription` is a documentation floor only |
| Summary | 90 min (`AI_COMPUTE_TIMEOUT_MS.summary`), with the metadata-phase exemption above |
| Meeting preflight (`retry-transcription`) | 60 s (`AI_COMPUTE_TIMEOUT_MS.meetingPreflight`) |
| Whisper preload after admission | 30 min (`AI_COMPUTE_TIMEOUT_MS.modelDownload`); partial HF downloads stay resumable |
| Add-on setup validation | 15 min (`AI_COMPUTE_TIMEOUT_MS.addonValidation`) |

`AI_COMPUTE_TIMEOUT_MS.modelDownloadIdleWait` and `.gpuRuntimeComputeIdleWait` (both 15 min) are retained for documentation only — the live path uses between-job `gpuResourceActionQueue` admission instead.

**Gotcha:** the preemptive CUDA→CPU decision must be evaluated when the queued job **starts**, not at enqueue, and must **re-probe** via `resolveCudaStatusForTranscription` — not the 5-minute UI `getCachedCudaStatus` TTL — so a stale or null cache cannot silently skip the CPU UX path. `uninstall-gpu` and failed installs invalidate `cachedCudaStatus`. The result JSON carries the **actual** `device`; main sets `transcriptionDevice` from that field, not from intent.

**Queue-state sequencing.** `transcription-queue-state` payloads carry a monotonically increasing `seq`. Renderer init snapshots and pushes with `seq <= lastAppliedTranscriptionQueueSeq` are ignored **completely**, including terminal-transition side effects. The `transcription-progress` string payload is unchanged — leave it alone.

**Setup validation vs compute.** `createAbortableComputeAction` blocks on `waitForAiComputeQueueIdle` until `hasPendingWork()` is false (no 15 s false-failure), enqueues the validation subprocess on the compute queue, and wraps it in `runWallClockComputeAction`. Validation is user-triggered setup work, never automatic post-transcription behavior.

### Meeting metadata persistence

Changing `backend/meeting_manager.py` must preserve: `FileLock` cross-process locking; atomic temp-file + `os.replace()` writes; transactional add that removes originals only **after** metadata is saved; corrupt-metadata backups named `meetings.corrupt.*.json`; scan/import preservation of suffixed IDs like `meeting_20260107_104555_1`; and recorder-temp recovery before selecting scannable `.opus`/`.wav` files (never import `.pcm.tmp` or legacy `*.temp.wav` as meetings). Delete must tolerate Windows file locking with retry.

Public methods stay instance methods — the tests monkeypatch them as seams.

### macOS desktop audio capture

Preferred: bundled Swift `audiocapture-helper` using a **CoreAudio process tap** on macOS 14.2+. Falls back to Swift ScreenCaptureKit when tap startup fails or macOS is older; PyObjC ScreenCaptureKit is the final fallback.

**Helper contract.** stdout is raw interleaved float32 PCM and nothing else — Electron never parses it. All JSON status, diagnostics, warnings, and errors go to **stderr**, parsed by `backend/audio/swift_audio_capture.py`.

- When a delivery gap follows silence (SCK pauses; the tap may pause), the helper zero-fills into the **same FIFO** as real audio, before the resuming buffer, capped at 3 minutes — so mid-meeting silence does not collapse and writer starvation cannot reorder fill against surrounding samples. Gaps past the cap still shift later desktop audio earlier by `(gap − 180s)`: a bounded, accepted tradeoff.
- Gap detection uses the **previous buffer's frame count** as expected cadence, not a flat 100 ms threshold, and subtracts that duration to avoid +1-buffer over-fill drift.
- `swift_audio_capture.py` must keep desktop frames float32 through `samples_to_frames` — **no float64 upcast**; the mixer and stereo repair expect float32-compatible numpy arrays.
- Helper ready wait is 15 s; the outer desktop start wait is 20 s, so a boundary race still surfaces the specific helper error. Stdin EOF stops the helper (no busy-spin orphan).
- CoreAudio can expose tap input as **multiple channel buffers even when the format is not marked non-interleaved**. Preserve the helper's interleaved stdout normalization and the Python mixer's one-sided stereo repair, or desktop speech dies in the MLX/ffmpeg mono downmix.

**Permissions differ by backend — do not conflate them.** CoreAudio tap needs System Audio Recording for `com.avanevis.app.audiocapture-helper`. ScreenCaptureKit needs Screen Recording. Preflight (`check_permissions --skip-screen-recording-check`) reports `screen_recording.skipped` / `granted: null` plus an unprobed `system_audio_recording` field — **it must not claim Screen Recording was granted.** When desktop audio is missing, inspect `helperCaptureBackend`, helper diagnostics, and unified logs before blaming Screen Recording.

**Planned ≠ shipped:** `docs/initiatives/MACOS_AUDIO_ARCHITECTURE.md` describes future ideas (streaming to disk, app-specific capture). Do not treat its planned sections as current behavior.

Touching the helper pipeline means verifying: it still builds from `swift/AudioCaptureHelper`; `build/prepare-resources.js` still copies it to `build/resources/bin`; codesign/entitlements still run; electron-builder still bundles and signs `Contents/Resources/bin/audiocapture-helper`; a packaged recording with active browser audio reports `helperCaptureBackend=coreaudio_tap` on 14.2+; permission attribution survives Python recorder children running as POSIX process-group leaders; and browser speech reaches the **transcript**, not just the level meter or the saved stereo channel.

### Build packaging

Keep aligned when bundled runtime locations or prepared-resource inputs change: `build/prepare-resources.js`, `build/download-manifest.js` (pinned URLs + checksums, with `tests/js/build-download-manifest.test.js`), `package.json` `extraResources`, and path resolution in `src/main.js`. Generated `build/resources/resource-manifest.json` must keep invalidating stale prepared resources. `prepare-resources.js` builds and stages `Resources/bin/speakrs-cli[.exe]` plus the validation fixture WAV; fail the build if that binary is missing. `ort` compile-time downloads stay pinned in `native/speakrs-cli/ort-compile-pins.json` — **not** in `download-manifest.js`. Model packs and the Windows ORT 1.27.1 archive are setup-time, not installer-bundled.

Windows packaged Python relies on `python311._pth` containing `../backend`; dev relies on `PYTHONPATH` set in `src/main.js`. Packaged macOS/Linux python-build-standalone **does** honor `PYTHONPATH`.

**Packaged-only path hardening.** Packaged apps set `process.env.AVANEVIS_PACKAGED=1` at main-process startup (so worker threads inherit it) and inject it via `buildPythonEnv()` for every Python child. Packaged `buildPythonEnv()` must not inherit ambient `PYTHONPATH`, `PYTHONHOME`, or `PYTHONUSERBASE`, must set `PYTHONNOUSERSITE=1`, and must force `PYTHONDONTWRITEBYTECODE=1` so normal recorder/transcriber/add-on subprocesses cannot mutate the signed app bundle with `__pycache__`. Caller-supplied `PYTHONPATH` extras (managed add-on site-packages) may still prepend the bundled backend path. When set, `backend/audio/swift_audio_capture.py` must **not** call `shutil.which("audiocapture-helper")` — only the bundled `Resources/bin/audiocapture-helper` or explicit dev build paths are valid. Summary tar extraction (`resolvePreferredTarExecutable`) likewise prefers absolute system tar over PATH. Dev/`npm start` leaves the var unset so PATH lookup still works.

**Release asset naming.** `src/updater.js` identifies installers by filename pattern. Change artifact naming in `package.json` or `.github/workflows/build-release.yml` and you must update `src/updater.js` too.

**Tray assets.** `resolveTrayImageFileName` (`src/main/recording-presence-service.js`) owns the per-platform tray image. Linux must use PNGs (`iconTrayLinux.png`, `iconTrayLinuxRecording.png`) — `nativeImage.createFromPath` cannot decode `.ico` outside Windows and returns an **empty** image, while `new Tray(emptyImage)` still succeeds on Linux, so the failure mode is a registered-but-invisible SNI item rather than an exception. Linux `createTray()` also probes `org.kde.StatusNotifierWatcher` via `busctl --user status` before constructing a Tray: Electron 44 `new Tray()` does **not** throw when no SNI host is running, and a successful constructor would make close **hide** with no visible icon. Missing watcher skips tray creation so idle/recording close **minimizes**. Any new tray image must also be added to `package.json` `extraResources`. Regeneration commands are in `docs/development/MACOS_ICONS.md`.

**macOS signing identity.** `build.mac.identity` is pinned to `"-"` so certificate-less builds ad-hoc sign the whole bundle (Gate B). Because an explicit identity beats `CSC_LINK`/keychain discovery, `npm run build:mac` first runs `scripts/check-mac-signing-identity.js`, which fails the build if that pin coexists with real signing credentials. Override with `-c.mac.identity=...`, or acknowledge with `AVANEVIS_ALLOW_ADHOC_MAC_SIGNING=1`.

### Renderer conventions

Plain HTML/CSS/JS — no React or Vue. `src/renderer/app.js` is the state machine; prefer **extracting** pure logic into `src/renderer/*-helpers.js` with a matching `tests/js/*-helpers.test.js` over growing `app.js`. IPC only through `window.electronAPI`.

Non-obvious: the saved `.md` transcript is the source of truth (the viewer renders it with timestamp chips); meeting rename updates metadata **by meeting ID and deliberately does not rename files on disk**; keep the DPR-aware canvas/scrubber patterns when touching the visualizer or playback UI.

### Python backend

Spawned per-invocation by `src/main/` services — not a long-running server. Platform split is explicit and intentional: `windows_recorder.py` vs `macos_recorder.py` vs `linux_recorder.py`, `faster_whisper_transcriber.py` vs `mlx_whisper_transcriber.py`. Shared stdout emitters live in `backend/audio/recorder_stdout.py`; platform recorders keep thin `_send_*` wrappers so the Electron contract stays stable. Module layout detail: `docs/development/BACKEND.md`.

**Windows gotcha:** manifest-less `*.capture` cleanup must probe `session.lock` with `timeout=0`, re-check `manifest.json`, **release the lock, then** `rmtree`. Releasing before the delete is mandatory on Windows — an open lock file cannot be removed.

## Cross-cutting change checklists

Each of these fans out further than it looks.

- **Recorder process output** → Windows/macOS/Linux recorders, `src/main/recorder-service.js`, `src/main-process/recorder-output-helpers.js` (+ facade), `tests/js/recorder-event-contract.test.js`, and any renderer UI state keyed on that progress.
- **Saved meeting filenames or locations** → `recorder_temp_paths.py`, Windows/macOS/Linux recorders, compressor input-format handling, `backend/meeting_manager.py`, `backend/meetings/scan_import.py`, delete logic, renderer playback assumptions, `tests/python/test_recorder_temp_and_scan_recovery.py`.
- **Model download behavior** → `src/main.js`, the renderer first-time setup flow, transcriber `--preload` CLI behavior, and build logic if bundled/offline semantics change.
- **AI catalog or runtime pins** → `src/ai-addon-state.js`, `src/ai-addon-setup.js` if cache/setup semantics move, `docs/development/LOCAL_AI_MODEL_CATALOG.md`, `todo.md` if product defaults change, `tests/js/ai-addon-*.test.js`. Adding or renaming an engine also updates Settings About credits (`src/renderer/index.html`), `THIRD_PARTY_NOTICES.md`, and `tests/js/legal-notices.test.js`.

## Validation

Check commands per toolchain — full setup lives in `README.md`:

- JS: `npm test` (regression suite + `node --check` over all `src/**/*.js`)
- Python: `npm run test:python`, `npm run test:python-syntax`
- Everything: `npm run test:all`
- Device smoke: `python backend/device_manager.py`
- macOS helper: `swift build -c release --arch arm64` inside `swift/AudioCaptureHelper`

**Which one to run.** Start with the smallest relevant command. Escalate to `npm run test:all` when the change is cross-cutting, or touches recorder, persistence, packaging, or security — and always before opening a PR. These two rules do not conflict: small-first is for iterating, `test:all` is the pre-PR gate.

Hardware-dependent paths are covered by manual checklists, not CI: `tests/manual/recording-smoke-checklist.md` and `tests/manual/local-ai-addons-checklist.md`. Targeted adversarial review prompts: `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md`.

**Fakes must model the real dependency.** A green suite is not evidence when the test double is shaped more conveniently than the library. The 2026-08-28 Linux pre-merge review found three defects hidden this way — `is_pulse_port_unavailable` matched every `FakePort` and no real `pulsectl.EnumValue`, and no tray test ever decoded an actual image file. When a helper interprets a third-party object or a shipped asset, assert against the real type (`pytest.importorskip`) or the real bytes, not only a hand-written stand-in.

CI runs JS + Python tests, recursive backend `compileall`, JS syntax checks, manifest tests, and packaged-build smoke — **not** full end-to-end with real audio devices. Characterization gates worth knowing about: IPC/compute-queue source scans and facade export snapshots in `tests/js/`, plus recorder stdout contracts in `tests/js/recorder-event-contract.test.js` and `tests/python/test_recorder_event_contract.py`.

Non-obvious validation targets: transcript JSON shape still matches renderer expectations; complete-cache detection stays aligned across JS and Python; add-on status still covers `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, `unsupported`; Windows speaker prompts stay behind CUDA readiness; summary setup cancellation removes partial files **without** deleting a previously valid install.

## Maintenance hotspots

- `src/main.js` — composition root; easy to regress via quit/compute-queue or path resolution.
- `src/renderer/app.js` — the largest file and the biggest hotspot; many implicit assumptions, controller extraction deferred.
- `src/main/recorder-service.js`, `transcription-service.js` — most IPC and subprocess orchestration.
- `backend/audio/windows_recorder.py` — timing-, sample-rate-, and callback-sensitive.
- `backend/audio/macos_recorder.py` — threading + native helper + permission edge cases.
- `backend/audio/linux_recorder.py` — Pulse/PipeWire SoundCard capture; vanished-monitor poll; linux-v1 finalization.
- `build/prepare-resources.js` — packaging-critical and platform-specific.

## Working defaults

- Work inline. Do not delegate routine inspection, small edits, focused tests, or plan self-review to a subagent. Ask before launching one; reserve it for an explicitly requested independent review or a genuinely high-risk cross-process, concurrency, persistence, packaging, security, or platform boundary.
- Do not re-review work after feedback unless a material change introduced new risk.
- Keep plans concise and file-level. Add per-step TDD scripts, commit instructions, or handoff workflow only when asked or when the behavior is high-risk.
- Prefer extracting behind stable interfaces over rewriting flows; keep platform differences explicit rather than abstracted away; preserve the intentional graceful degradation in handlers rather than hard-failing.
- When simplifying, preserve current operational behavior first, then reduce complexity.
- Trust runtime scripts and CI over stale docs. When docs disagree with this file on a cross-process contract, this file wins. Inspect both the Electron and Python side before changing any cross-process contract.
- Keep `todo.md` current when task status, major progress, or execution order changes. Update this file when cross-process contracts, AI catalog pins, build inputs, or validation expectations change.
