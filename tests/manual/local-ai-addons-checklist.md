# Local AI Add-ons Manual Checklist

Use this checklist when validating speaker identification or local summaries on target hardware.

## Privacy And Network

- [ ] Confirm no network activity occurs during transcription, diarization, or summary generation.
- [ ] Confirm network activity occurs only when the user explicitly starts summary model/runtime setup, Whisper model setup, CUDA setup, or update checks.
- [ ] Confirm pyannote/PyTorch dependency downloads occur only when the user explicitly starts **Pyannote** speaker identification setup.
- [ ] Confirm Speakrs model-pack / Windows ORT downloads occur only when the user explicitly starts **Speakrs** setup.
- [ ] Confirm Hugging Face token values never appear in logs, progress events, meeting metadata, transcripts, or summaries.
- [ ] Confirm bearer tokens, legacy `Authorization: token ...`, `token=` / `access_token=` / `api_key=` values, `X-Api-Key`, and URL credentials are redacted from setup/runtime errors.

## Windows CUDA Pyannote Speaker Identification

- [ ] Use Windows 10/11 x64 with NVIDIA GPU and CUDA setup complete.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Confirm speaker setup does not download dependencies until a token is entered.
- [ ] Start speaker setup and confirm managed dependencies install under Electron `userData/ai-addons/dependencies/diarization`.
- [ ] Cancel speaker setup during dependency download/install and confirm setup returns to Not configured, partial dependency files are removed, and token values are not logged.
- [ ] Re-run speaker setup after cancellation and confirm stale dependency artifact directories are removed while the current artifact installs cleanly.
- [ ] Validate setup from Settings and confirm status becomes Ready.
- [ ] Record and transcribe a meeting with 2-4 speakers.
- [ ] Confirm speaker-guided transcription starts automatically when setup is ready: pyannote runs first, then Whisper transcribes speaker-shaped windows.
- [ ] Confirm normal transcript remains saved if diarization fails.
- [ ] Confirm `*.speakers.json` is written and meeting metadata references it without token values.
- [ ] Confirm History shows a per-recording speaker-identification failure message if guided transcription falls back to normal transcription.
- [ ] Confirm current transcript and History transcript show speaker labels.
- [ ] Attempt a second diarization/summary run while one local AI backend is active and confirm the app serializes work instead of launching concurrent GPU-heavy processes.

## macOS Pyannote Diarization Policy

- [ ] Use Apple Silicon macOS only; confirm Intel macOS is unsupported for speaker identification.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Confirm speaker setup installs managed dependencies under Electron `userData/ai-addons/dependencies/diarization` only after explicit setup.
- [ ] Confirm setup validates PyTorch Metal/MPS availability from the managed dependency environment before status becomes Ready.
- [ ] Temporarily make MPS unavailable or force validation failure and confirm setup stays Error/Unsupported with clear Metal/MPS copy.
- [ ] Record and transcribe a meeting with 2-4 speakers and confirm speaker-guided transcription uses MPS, writes `*.speakers.json`, and speaker labels appear.
- [ ] Confirm macOS transcription still works normally when diarization setup or runtime fails.
- [ ] Confirm no CPU-only diarization fallback runs in setup or at runtime.
- [ ] Cancel speaker setup during dependency download/install and confirm partial dependency files are removed and token values are not logged.

## Summary Setup And Generation

- [ ] Start summary setup explicitly from Settings.
- [ ] Confirm Settings shows progress and a Cancel Download action while runtime/model setup is active.
- [ ] Cancel summary setup during runtime download and confirm partial `.download` files and newly staged runtime artifacts are removed.
- [ ] Cancel summary setup during validation after a previously ready install and confirm the existing model/runtime remain Ready.
- [ ] Confirm the pinned llama.cpp runtime downloads, verifies, and extracts before the model is marked ready.
- [ ] Confirm unsafe or unparseable ZIP/`tar.gz` runtime entries are rejected before extraction.
- [ ] Confirm runtime archives extract into a cleaned staging directory and summary execution uses the extracted `llama-cli` location with adjacent native libraries intact.
- [ ] Confirm the pinned GGUF model downloads through Hugging Face `huggingface_hub`/`hf_xet` on Hugging Face-hosted artifacts and checksum-verifies before Ready.
- [ ] Confirm Hugging Face model downloads write temporary files only under the managed summary cache and checksum-verify before moving into place.
- [ ] Cancel summary setup during the Hugging Face model download and confirm the downloader subprocess exits, partial files are removed, and no diarization token is used.
- [ ] Generate a summary from Home after a saved transcript.
- [ ] Generate or regenerate a summary from History.
- [ ] Confirm `*.summary.json` and `*.summary.md` are written and referenced in meeting metadata.
- [ ] Confirm Summary tab reopens the saved summary after app restart.
- [ ] Confirm Copy and Save actions export the saved Markdown summary.
- [ ] Modify/regenerate a transcript and confirm stale summary warning appears until summary is regenerated.

## Long Meeting Validation

- [ ] Validate a 30-60 minute meeting with 2-4 speakers on Windows CUDA.
- [ ] Validate a 30+ minute Apple Silicon transcription for transcript completeness with the default MLX batch size. Only test `AVANEVIS_MLX_WHISPER_BATCH_SIZE` overrides as a controlled performance experiment.
- [ ] Validate a 1-2 hour transcript summary with the default profile.
- [ ] Validate Concise, Balanced, Detailed, and Action items profiles reuse the installed model.
- [ ] Record processing time, peak RAM/VRAM, model sizes, and quality notes.

## Speakrs / Pyannote Selector

- [ ] Settings shows two cards: Speakrs and Pyannote. Apple Silicon marks Speakrs as Recommended; Windows does not.
- [ ] Keyboard: native radio group. Tab lands on the selected card, arrow keys move between Speakrs and Pyannote, and a visible focus ring appears. Mouse click still selects. Disabled cards skip keyboard navigation.
- [ ] Cards stay equal height and aligned at 100–200% zoom; they stack on a narrow Settings pane rather than overflowing.
- [ ] New-user Home speaker prompt shows the same two cards and Set Up starts Speakrs (no token field).
- [ ] Token fields and speaker-count stay **visually** hidden while Speakrs is selected (`.ai-addon-field[hidden]` must beat `display: flex`); they appear only for Pyannote. `needsAccount` still appears for Pyannote. Switching away from Pyannote clears typed tokens. Home and Settings never mix each other's token values.
- [ ] When the other engine is installed, Settings/Home primary button reads **Switch model** (not Set Up). Selecting the other card leaves that button enabled. After setup reaches Ready, engine cards/radios must stay enabled (not stuck dimmed) so Speakrs→Pyannote is possible.
- [ ] Switch Speakrs → Pyannote from a Ready Speakrs install: confirm copy appears, Speakrs pack/ORT is deleted, token field is shown (leave blank to reuse a saved token), shared CUDA pip (`nvidia-cublas`) remains.
- [ ] Switch Pyannote → Speakrs: confirm copy appears, pyannote deps/HF cache are deleted, **saved Hugging Face token is kept**, token UI hides, shared CUDA pip remains. Switching back to Pyannote with an empty token field reuses that saved token. Token-only Pyannote (saved token, no model tree) still requires this confirm and still enables Remove.
- [ ] Remove deletes only the active engine (and any saved Hugging Face token) and leaves `engine` as the last choice so re-setup is one click.
- [ ] Setup/Remove/Switch is rejected while setup is running or compute/preload/GPU-runtime work is pending. A job that starts after setup is queued must not begin exclusive deletion.
- [ ] Packaged missing bundled `speakrs-cli`: Home and Settings show the incomplete-install / Reinstall AvaNevis copy. Set Up is disabled for Speakrs (it cannot restore the bundled binary). Do not tell the user to re-run speaker setup. No Python `FileNotFoundError` or traceback. Dev-mode missing CLI keeps the dev copy and does not show Reinstall AvaNevis.
- [ ] Windows Speakrs setup: no token field; downloads the model pack and ORT; Ready; a new recording uses CUDA guided transcription and writes `*.speakers.json` without token values.
- [ ] macOS Speakrs setup: Apple Silicon CoreML-only (no CPU fallback); no token field; Ready; a new recording uses `coreml` guided transcription and writes `*.speakers.json`.
- [ ] Settings > About credits Speakrs (Apache-2.0) and pyannote (CC BY 4.0). Open third-party notices includes the Speakrs pack table and bundled `speakrs-cli`.

## Linux Core Beta and gated AI add-ons

Core Beta capture remains available on supported Linux targets, while each AI
add-on stays unavailable on profiles that fail its own accelerator and
integrity gates. Do not ship a CPU fallback. The accepted gated profile is
CachyOS x86_64 + RTX 4070; unvalidated profiles must keep the affected feature
greyed out and fail closed. Linux is Speakrs-only for speaker identification,
and the reactivated Task 6 summary lane is CUDA-only Qwen/llama.cpp.

The following Phase 0–5 rows document the historical pre-Task-5 Linux
unsupported behavior and must not be read as a permanent Linux-summary
deferral.

- [x] **Phase 0:** catalog status is `unsupported` (`tests/js/linux-platform-selection.test.js`).
- [x] **Phase 4:** Settings cards are visually greyed; Set Up / Install Model / Validate / Remove / Switch / token fields disabled from initial HTML and guarded again after status; Home AI add-on CTA starts disabled and does not offer setup; History Generate Summary stays disabled after startup status refresh; unsupported footprints show `Runtime: disabled`; Linux-specific future-version copy is shown. Evidence 2026-08-27: exact copy pinned in `linux-platform-selection.test.js`; `.ai-addon-card.is-unsupported` in `styles.css`; token/speaker-count hidden (`shouldOfferDiarizationSetupFields`); initial and status-driven gates covered in `ai-addon-ui-helpers.test.js` / `history-detail-helpers.test.js`; `generate-summary` rejects unsupported before spawning meeting-manager preflight. Live Settings chrome was not screenshot this session.
- [x] **Phase 5 packaged fail-closed (2026-08-28):** AppImage and pacman `AVANEVIS_SAFESTORAGE_SMOKE=1` payloads report `diarization.supported: false` and `summary.supported: false` with the Linux future-version reason strings. Setup/generate cannot start from those main-process gates. **Note (pre-merge review 2026-08-28):** the smoke hook now needs `AVANEVIS_ALLOW_SMOKE_HOOKS=1` as well in a packaged build, so re-runs use `AVANEVIS_ALLOW_SMOKE_HOOKS=1 AVANEVIS_SAFESTORAGE_SMOKE=1 <artifact>`.
- [x] **Phase 5 packaged Settings UI (Omarchy AppImage, 2026-08-28):** Speaker Identification and Meeting Summaries cards are `.is-unsupported` with **Unsupported** badges and the decision-12 status strings. Set Up / Install Model / Validate / Remove / engine radios / Home Set Up / History Generate Summary are `disabled`. Force-clicking Setup does not start a download. `generate-summary` IPC rejects with `Local summaries are not available on Linux in this version. They will return in a future Linux update.` Home add-on CTA stays `display: none`.
- [ ] **Windows/macOS regression row (pre-merge review 2026-08-28):** Generate Summary in History and Home starts `disabled` in the HTML and is enabled from add-on status. Confirm on Windows and macOS that it becomes clickable on a normal launch, **and** that it is still clickable when the status probe fails (temporarily break `getAiAddonStatus`, e.g. by pointing the add-on root at an unreadable path): clicking must surface the setup message and open Settings rather than doing nothing. An authoritative `unsupported` status must still leave it disabled with the platform copy.
- [ ] **Historical scope/deferral note (v2.9):** Earlier planning deferred Linux llama.cpp summaries while no redistributable Linux CUDA runtime had been selected. That deferral is preserved as history only; Task 6 is active again and requires its own pinned runtime/model and CachyOS RTX 4070 evidence. Linux CUDA Whisper and CUDA-only Speakrs still require their separate gates. Pyannote is not a Linux option. Do not run GPU rows on CPU-only Omarchy.

## Linux v2.9 Speakrs (CachyOS x86_64 + RTX 4070 — Task 5)

Core Beta Omarchy remains fail-closed for add-ons. On the accepted CachyOS + RTX 4070 profile, Speakrs may un-grey only after managed CUDA 12 preflight succeeds. Linux mode is CUDA-only and Speakrs-only: Pyannote has no visible card or token UI, while summaries stay greyed `unsupported`. Do not treat CI CPU fixture smoke as this row.

- [x] **Packaged setup:** Set Up Speakrs downloads the Task 4 model pack + ORT/wheel closure; Ready only after full-hash validation. `SPEAKRS_MODE=cuda`. No Hugging Face token field. Evidence 2026-09-03 is in the compatibility matrix.
- [x] **Validate / repair:** Validate and repair re-hash catalog pins (not `install.json` hashes) and remain Ready only when CUDA preflight still passes. Evidence 2026-09-03: missing ResNet repaired to Ready.
- [x] **Guided transcription:** A new recording uses CUDA guided transcription and writes `*.speakers.json` without token values. Whisper device is recorded separately from `diarization.device`. Evidence 2026-09-03: persisted CUDA/float16 fixture and CUDA sidecar.
- [x] **Normal-transcript fallback (RE-OPENED 2026-09-03 by adversarial review):** Guided failure persists an ordinary transcript plus diarization error metadata; it does not discard the meeting. **Packaged CachyOS rerun 2026-09-03:** with `features.diarization.status: "error"` recorded before transcription after moving the managed ResNet aside while the Ready manifest remained, meeting `20260903_125307` saved an ordinary CUDA/`float16` transcript, no `.speakers.json`, and concise `ai.diarization` (`status: "error"`, model `speakrs-community1-vbx`, `completedAt`, `error: "Speakrs model pack is not installed."`, `segmentsPath: null`). History showed the per-recording error line exactly once; the unavailable progress line appeared exactly once. Earlier failed fixtures remain historical in the compatibility matrix.
- [x] **Never-installed negative case (new, required — this is the regression the review caught):** With Speakrs removed, the packaged CachyOS rerun 2026-09-03 captured `features.diarization.status: "notConfigured"` for meeting `20260903_124835`, and captured `"downloading"` while a Speakrs pack setup was in flight for meeting `20260903_124956`. Both produced ordinary CUDA/`float16` transcripts; neither meeting has an `ai.diarization` key in `meetings.json`, History has no "Speaker identification failed for this recording" banner, and the transcription progress logs have no "Speaker identification is unavailable" line. Cross-platform: this defect reproduced on Windows x64 and macOS arm64 too, so run the equivalent check there before release.
- [x] **Cancel / quit:** Fresh rebuilt `linux-unpacked` run on 2026-09-03 observed the packaged `speakrs-cli` child in its POSIX process group. Cancel returned `{ success: true, cancelled: true }`, left the meeting failed with `Cancelled by user`, removed guided temp output, and left `busyCount: 0`; sending quit during a live Speakrs child exited the app and both child processes with no lingering CLI or guided Python process.
- [x] **Remove / Speakrs-only UI:** Remove deleted only `models/diarization/speakrs` and `runtimes/speakrs-ort`; managed CUDA and Whisper caches stayed (2026-09-03). **Superseded DOM evidence:** Pyannote cards could paint because `display:flex` beat `hidden`; after rebuilding, Settings visibly showed Speakrs only, Pyannote text/cards were not painted or keyboard-reachable, and Home also contained no visible Pyannote. The historical summary-unavailable styling in that run predates the reactivated Task 6 lane. Main-process Linux Pyannote rejection remains in place.
- [x] **Fail-closed preflight:** On the rebuilt packaged app, removing the managed CUDA tree and restarting produced `checkCUDA.runtimeLoadable: false` / `statusCode: "missingLibraries"` and a diarization card with `status: "unsupported"` plus the managed CUDA 12/GPU reason; no CPU fallback was offered. Non-ready probe statuses and non-x64 admission remain covered by `linux-cuda-transcription-admission.test.js`.
- [x] Record hashes, device, sidecar schema, and child-process cleanup in `docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`. Evidence for the 2026-09-03 packaged rerun is recorded there; the earlier `20260903_110001` metadata omission remains a superseded historical failure. Task 5 is not formally accepted until the equivalent never-installed check passes on Windows x64 and macOS arm64.

## Linux Qwen summaries (CachyOS x86_64 + RTX 4070 — Task 6)

The runtime decision and packaged inference evidence are recorded, including
the quit-during-metadata row. Reuse the existing Windows/macOS summary flow
and shared queues. Do not substitute CPU, Vulkan, SYCL, ROCm, cloud, or
ambient `LD_LIBRARY_PATH` behavior.

- [x] Pin and document the Qwen GGUF and Linux CUDA llama.cpp runtime: immutable HTTPS URLs, exact sizes and SHA-256 values, licenses, archive layout, Qwen3.5 compatibility, reasoning-disabled flags, and the complete verified shared-library closure. Catalog and evidence: [`V2_9_DEPENDENCY_COMPATIBILITY.md`](../../docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md).
- [x] Setup is explicit and local-only: managed `userData` cache, allowlisted downloads, safe staged extraction, full-hash validation, no Hugging Face/diarization token access, and cancellation cleanup that preserves any prior valid install. Automated structural coverage and packaged setup/Ready evidence passed.
- [x] Status remains `unsupported` unless Linux x86_64 NVIDIA detection, managed CUDA admission, runtime/model integrity, and packaged-path validation all pass. Generation uses `aiComputeActionQueue` and the shared GPU resource queue, with wall-clock cancellation and quit cleanup. Packaged status/generation evidence passed on 2026-09-03.
- [x] Packaged CachyOS + RTX 4070 acceptance: a measured 305-second idle interval preserved summary `ready` status; a controlled quit during metadata finalization preserved the newly generated JSON/Markdown sidecars and `meetings.json` metadata (`completed`, `balanced`, model, `generatedAt`, `sourceTranscriptHash`, and both sidecar paths). The app, `meeting_manager`, summary, and lock-helper children all exited. Full hashes, runtime paths, CUDA/device details, cancellation, and the earlier approximately 15-second / 6,250 MiB inference evidence are in the compatibility matrix. The separate CUDA-probe quit row, Task 5, and overall branch acceptance remain open.
- [x] Quit during the in-queue CUDA probe: on the rebuilt packaged app, a delayed `nvidia-smi` wrapper stalled a live probe behind a three-level tree (`python(cuda_probe)` → `sh(wrapper)` → `sleep`), and quit was issued through the app's own tray `Quit AvaNevis` item over `com.canonical.dbusmenu` — a native click handler path, not CDP. Four consecutive runs quit 138–206 ms into the live probe window; exact-PID snapshots before and after each quit show the app, probe, wrapper, and `sleep` grandchild all gone with zero survivors in the probe's process group. Drain was clean (`AI_ADDON_SETUP_CANCELLED` at the post-probe abort check, ~1 s exit, no drain-timeout or GPU-repair warning), `meetings.json` and both sidecars stayed byte-identical with no `.tmp` leftovers, and a post-quit relaunch still reported summary `ready` with the meeting `completed`. Regression lock: `Linux CUDA probe owns a process group so quit reaches nvidia-smi descendants` in `tests/js/linux-cuda-gpu-runtime-service.test.js`.

### v2.9 renderer refresh regression

- [ ] At desktop and narrow widths, Speaker Identification and Meeting Summaries retain their full unsupported reason copy without truncation.
- [ ] Unsupported badges, cards, engine radios, setup/validate/remove actions, Home setup CTA, and History Generate Summary retain disabled styling with a visible disabled state.
- [ ] Keyboard focus never lands on disabled Linux add-on controls; enabled navigation and Settings controls retain a visible focus ring.
- [ ] Reduced-motion mode does not alter unsupported visibility or enable any add-on control.

## Failure Modes

- [ ] Invalid Hugging Face token shows a clear setup error and does not store plaintext tokens.
- [ ] Missing model-term acceptance shows a clear token/access error.
- [ ] Missing summary model routes the user to Settings and does not start generation.
- [ ] Runtime missing `llama-cli` keeps summary setup out of Ready.
- [ ] Checksum mismatch keeps summary setup out of Ready and explains the mismatch.
- [ ] Untrusted summary/runtime download host keeps setup out of Ready.
- [ ] Unsafe ZIP entries that escape the extraction directory are rejected before extraction.
- [ ] Summary generation failure leaves transcript files unchanged.
