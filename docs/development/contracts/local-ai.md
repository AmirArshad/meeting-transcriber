# Local AI contract

No cloud transcription, diarization, summaries, telemetry, or background downloads. Pyannote uses only the user's safeStorage-protected token: never log, proxy, persist, or pass it except via stdin; clear all HF token environment variables and set `HF_TOKEN_PATH` to `os.devNull`, never an empty string. Speakrs and Pyannote are exclusive; Linux permits Speakrs only, CUDA-only, with no CPU fallback.

Catalogs own model refs, URLs, names, checksums, and runtime pins. Downloads are HTTPS and explicitly host-allowlisted; archives are hash-checked and traversal-guarded. Setup/validate full-hash catalog pins, compute rehashes changed fingerprints, and neither trusts user-writable `install.json`. Summary sidecars are never removed after metadata commit.

Live Linux CUDA admission always re-scans managed loader directories and required library paths. It may reuse SHA-256 evidence when `path + size + mtimeMs` is unchanged in the current process. A local attacker preserving size and mtime could bypass that hash skip, but an extra `.so` still fails the directory scan. Setup, repair, and install still full-hash; driver presence is still live-probed. GPU runtime timeout invalidates mutation authority before promotion. Passive `get-ai-addon-status` returns cached CUDA status and must not wait behind compute.

One compute queue serializes transcription, diarization, guided transcription, and generation. Preload and GPU runtime work admit between jobs through the resource queue. Preserve timeout termination/settlement, quit rejection, actual-device metadata, cache-completeness parity across JS/Python, offline-only behavior for complete caches, and user-triggered-only summary setup/generation.

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

## Platform policy and acceptance baseline

- Windows 10/11 x64; macOS 14+ runtime, packaged macOS builds are Apple Silicon (`arm64`) only.
- Linux Core Beta (Omarchy first) is merged to `master` (`docs/initiatives/LINUX_SUPPORT.md`). Pulse/PipeWire capture uses opaque device IDs (`pulse-source:<name>`, `pulse-monitor:<name>`, `pulse-sink:<name>`, `none`); renderer and IPC must not `parseInt` them. Packaged x86_64 AppImage + pacman + experimental `.deb` (`AvaNevis-Setup-*`, electron-builder 26.x `toolsets.appimage` `1.0.2`, no host fuse2). Core Beta transcription remains CPU `faster-whisper` until the user installs the optional managed CUDA 12 runtime. Linux CUDA setup is offered on x86_64 when an NVIDIA GPU is visible (`/proc/driver/nvidia` first, then `nvidia-smi`; the same detector feeds Settings, `check-gpu`, and install preflight). It is tested on CachyOS x86_64 + RTX 4070 and best-effort on other NVIDIA Linux. While a managed runtime tree exists, transcription is fail-closed CUDA; Settings keeps Uninstall reachable next to Repair so a broken or leftover tree can return to CPU. Linux children always clear ambient `LD_LIBRARY_PATH` and only repopulate it with validated managed and driver directories for an admitted runtime. Linux speaker identification is Speakrs-only; Pyannote stays unavailable and hidden from the Linux selector, while main-process rejection remains a defense-in-depth boundary. Summaries stay greyed `unsupported` until their own gate passes, with no cloud path. Phase 3 60-minute soak was cancelled 2026-08-27 (not run). Gate B closed 2026-08-28; the release workflow includes all three Linux artifacts. **Supported** Linux targets are Omarchy 4 and CachyOS x86_64 on Hyprland/Wayland + PipeWire (same Core Beta payload). Ubuntu, vanilla Arch, Fedora Workstation, SteamOS Desktop Mode, other CachyOS desktops, and extra desktops are **experimental betas** (`docs/guides/LINUX_EXPERIMENTAL.md`) with no hardware claim. The Ubuntu desktop recording/`safeStorage` smoke remains open. Linux packaging verification must not require `dpkg-deb` (Arch-family hosts use `ar`+`tar`).
- `src/main.js` keeps a `faster-whisper` fallback for Intel Macs in dev logic, but packaged builds do not target Intel.
- Windows transcription: `faster-whisper`. Apple Silicon: `lightning-whisper-mlx`. Linux: `faster-whisper` on **CPU** by default; optional managed CUDA 12 after install.
