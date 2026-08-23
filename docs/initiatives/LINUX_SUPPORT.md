# Linux Support Plan — Omarchy First

> **Status:** Ready for implementation planning; no Linux product code has started.
> **Replanned:** 2026-08-23 against AvaNevis v2.7.0 / current `master`.
> **Primary target:** Omarchy 4, x86_64, Hyprland/Wayland, PipeWire with `pipewire-pulse`.
> **Secondary target:** Ubuntu 24.04+ and other modern x86_64 desktop distributions where the same binaries and Pulse-compatible capture path work without distro-specific code.

## Executive decision

Build Linux in the existing monorepo and preserve the current Electron ↔ Python contracts. Do not create a Linux-only app, a second compute scheduler, or a prototype recorder that bypasses durable spools.

Delivery has two explicit milestones:

1. **Omarchy Core Beta** — mic + desktop recording, recovery, background transcription queue, local faster-whisper, History/export, tray/notifications, pacman package, and a FUSE-less AppImage.
2. **Linux Feature Parity** — optional summaries plus the exclusive Speakrs/Pyannote speaker-identification selector, with Linux-specific catalog/runtime pins and the same privacy, integrity, cancellation, queue, and quit guarantees as Windows/macOS.

Core Beta may ship while local AI add-ons truthfully report `unsupported` on Linux. A release must not present setup controls that cannot complete. “Linux support” should not be called feature-complete until the parity milestone passes its hardware matrix.

Ubuntu `.deb` support is a later packaging task unless the AppImage works unchanged. No Ubuntu-specific capture implementation is planned.

## Why the old plan needed another rewrite

The original late-2025 plan predated most of the current runtime architecture. The July 2026 refresh covered durable capture and the transcription queue, but only received a one-line Speakrs amendment after v2.7.0. The following shipped behavior now affects Linux:

| Current feature / invariant | Linux consequence |
|---|---|
| Durable `{stem}.capture/` track spools and bounded `finalize_capture` | The Linux recorder must write mic and desktop tracks to spools from its first implementation; no whole-session RAM path |
| Structured recorder stdout JSON | Linux must emit the same `levels`, `event`, `warning`, `error`, stop-stage, and final-result payloads; stderr stays diagnostic-only |
| Discard/cancel with a `discarded` manifest tombstone | Linux cancel must skip finalization and must never resurrect discarded spools |
| Main-owned background transcription queue and Activity UI | Capture unlocks after pending meeting persistence, not after Whisper; Linux uses the same queue and monotonic `seq` state |
| Whisper preload and GPU runtime between-job admission | Linux model download and accelerator setup must use `gpuResourceActionQueue`, not a new lock or fail-fast path |
| Exclusive Speakrs/Pyannote engine selector | Linux needs catalog support for both engines, exclusive deletion, token isolation, setup validation, and guided transcription |
| Bundled `speakrs-cli` with fail-closed integrity | The Linux binary must be built, staged, packaged, and verified; model/runtime packs remain explicit setup-time downloads |
| User-triggered Qwen summaries through pinned llama.cpp | Linux needs a pinned runtime profile and must preserve summary sidecar/metadata finalization semantics |
| AI compute wall clocks and quit drain | Linux process groups and child-tree termination must work for Python, ffmpeg, llama-cli, and the Speakrs grandchild |
| Packaged-path hardening | `AVANEVIS_PACKAGED=1` must prevent packaged Linux from resolving helpers or runtimes from untrusted `PATH` entries |

## Verified Omarchy host facts (2026-08-23)

The initial target machine is Omarchy 4 with Hyprland on Wayland.

- PipeWire and `pipewire-pulse` are active; `pactl` and `wpctl` can reach the user audio server.
- Pulse monitor sources are available, so desktop output can be captured without a ScreenCast portal or whole-screen sharing.
- `fuse2` is not installed. Do not require it for the AppImage.
- `libappindicator-gtk3` is not installed. Tray support must either declare it as a pacman dependency or degrade clearly.
- `gnome-keyring`, `libsecret`, and an active `org.freedesktop.secrets` service are present. This makes Electron `safeStorage` viable on this Omarchy image, but setup must still fail closed when another Linux desktop has no secure secret service.
- Vulkan is installed, but this host exposes an older Intel Haswell device with incomplete Vulkan support and no NVIDIA runtime. A successful `vulkaninfo` probe is not sufficient evidence that llama.cpp Vulkan or CUDA AI paths will work.
- The current development Python does not include `sounddevice`; that does not block the selected Pulse-native approach.

These facts are evidence for the first target only, not assumptions to bake into generic Linux behavior.

## Go/no-go gates before implementation

### Gate A — restore a trustworthy baseline

The latest `master` CI for commit `3ff88b0` is red: [CI run 31814775402](https://github.com/AmirArshad/meeting-transcriber/actions/runs/31814775402) fails the Windows test “Speakrs install and validation preserve nested CoreML-style bundle paths” with `error !== ready`.

Before branching for Linux:

1. Reproduce and fix the test, or prove and eliminate a platform-only flake.
2. Run `npm run test:all` on the resulting baseline.
3. Record the green CI run in the first Linux PR.

Do not let Linux conditionals hide or skip this failure.

On the current Omarchy host, `npm test` also fails seven Linux-platform assumptions before any product change: resource-manifest/Speakrs packaging rejects `process.platform === 'linux'`, three diarization handler tests require an already-supported platform, the Speakrs resource-manifest test rejects Linux, and one dev-Python fixture falls back to `python`. These are Phase 0 work, not evidence that the documentation change caused a regression. The first Linux PR must make the normal JS suite runnable and green on Linux without weakening Windows/macOS coverage.

### Gate B — triage current macOS release integrity

[Issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76) reports that the v2.7.0 DMG appears corrupt on macOS 15.7.7 / M3 Pro. This does not block an isolated Linux audio spike, but it blocks expansion of the release workflow:

1. Download the published DMG and verify checksum, mountability, signature, notarization, and stapling.
2. Determine whether the screenshot is true file corruption, a signing/notarization failure, or Gatekeeper copy.
3. Close or update the issue with a verified result before adding Linux artifacts to `build-release.yml`.

Windows v2.7.0 has no equivalent open release issue. The red Windows CI test remains Gate A.

### Gate C — freeze target support claims

The first release must state:

- Omarchy 4 x86_64 is supported.
- Wayland/Hyprland + PipeWire/Pulse compatibility is the tested desktop.
- Ubuntu/other distro AppImage use is experimental until matrix evidence exists.
- Speaker identification is accelerator-only; no Linux CPU fallback is introduced implicitly.
- Linux ARM64, Flatpak, Snap, RPM, ROCm/MIGraphX, and native Ubuntu `.deb` are out of the first release.

## Locked architecture decisions

### 1. One codebase, explicit platform branches

Add `linux` branches to the existing factories and services. Do not let “not macOS” continue to mean Windows.

Required audit points include:

- `backend/audio/__init__.py`
- `backend/device_manager.py`
- `src/main/recorder-service.js`
- `src/main/device-ipc.js`
- `src/main/python-runtime.js`
- `src/main/recording-presence-service.js`
- `src/main/transcription-service.js`
- `src/main/gpu-runtime-service.js`
- `src/ai-addon-state.js`
- `src/updater.js`
- renderer platform copy and GPU/add-on gates

Prefer explicit `win32` / `darwin` / `linux` branches over a shared `else`.

### 2. Pulse-compatible audio control and PCM capture

Use:

- **`pulsectl`** for server discovery, source/sink enumeration, default-device resolution, monitor-source mapping, and validation.
- **`SoundCard`** for Pulse-compatible PCM recording.
- PipeWire through `pipewire-pulse` on Omarchy; native PulseAudio remains compatible on other distributions.

Do not depend on `pactl`, `wpctl`, or distro shell scripts at runtime. They are diagnostics only. Do not use `sounddevice` as the primary Linux backend: it adds PortAudio/ALSA routing assumptions that are unnecessary on the verified target.

The host package contract is `libpulse` plus a running Pulse-compatible server. The pacman package should depend on the appropriate Omarchy/Arch packages; the AppImage should preflight and explain a missing server.

### 3. Device IDs are opaque strings

Linux device selection must use stable Pulse names, not numeric indexes:

- mic: `pulse-source:<source.name>`
- desktop: `pulse-monitor:<monitor_source_name>`
- explicit desktop-off: `none`

The renderer and IPC payloads must treat device IDs as strings. Remove or isolate any `parseInt` assumptions. Preserve compatibility for existing Windows numeric IDs and macOS UIDs.

Default selection:

- mic: current Pulse default input, then first usable non-monitor source
- desktop: monitor of current default output
- headphones/Bluetooth/HDMI are naturally handled by selecting the sink’s monitor

Resolve “default” when recording starts. Linux v1 does not hot-switch the desktop stream mid-recording; if a sink disappears, warn and continue mic-only.

### 4. Desktop capture does not use the ScreenCast portal

Capture the selected sink monitor directly through Pulse/PipeWire. `xdg-desktop-portal-hyprland` remains useful for native dialogs and desktop integration but is not the audio-capture contract.

No screen-video permission or screen-sharing UI should appear for normal Linux desktop-audio capture.

### 5. Recording uses the durable spool architecture

Create `backend/audio/linux_recorder.py` with the same external contract as the existing recorders:

- separate mic and desktop capture threads
- bounded queues feeding `TrackSpool`
- atomic capture manifest updates and `session.lock`
- monotonic timestamps for track alignment
- fixed-size blocks and float32 processing
- level JSON at the existing bounded cadence
- exact-token stdin commands: `stop` and `cancel`
- bounded `finalize_capture`
- the standard stop stages:
  `post_processing_started`, `audio_normalizing`, `audio_mixing`,
  `audio_encoding`, `post_processing_complete`
- final structured success/failure JSON with a recoverable path when one exists

Add a `linux-v1` finalization profile. Preserve 48 kHz stereo output, mono-compatible transcription downmix, mic enhancement, faithful desktop audio, and mic-only degradation.

Failure policy:

- mic thread failure is fatal
- desktop startup failure is a structured warning and mic-only continuation
- late desktop failure is a warning and mic-only continuation
- Stop/finalize errors still return `success:false` with the best stable audio path
- Cancel writes `discarded` before best-effort cleanup and never creates a meeting

### 6. Reuse the current meeting, queue, and lifecycle model

Linux does not change:

- Stop → save pending meeting → enqueue one composite transcription job
- durable statuses: `pending`, `failed`, `completed`
- queue state `seq` ordering
- Activity auto-resume after scan
- one live capture at a time
- one GPU-heavy compute action at a time
- recoverable spool discovery and user-approved recovery
- summary generation remaining user-triggered
- quit terminating transcription-class work while preserving pending meetings
- summary metadata finalization being non-abortable once sidecar renames begin

POSIX Python is already spawned as a process-group leader. Linux validation must prove that terminating the group also reaps ffmpeg, llama-cli, and `speakrs-cli`; no child may start a new process group and escape shutdown.

### 7. Core transcription uses faster-whisper

Linux uses `faster-whisper`, not MLX.

- CPU is the guaranteed baseline.
- CUDA is optional and must fall back to CPU with honest UI copy when unavailable or incompatible.
- Model cache completeness and `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY` behavior stay aligned between JS and Python.
- Whisper cache remains separate from the diarization Hugging Face cache.
- Preload stays off the compute queue and enters through `gpuResourceActionQueue` between jobs.
- The actual result device, not intended device, populates meeting metadata.
- The queued job re-probes CUDA when it starts; no stale five-minute UI result controls compute.

Linux child processes lower their own priority with `os.nice`, as on macOS, so transcription cannot starve a newly started recording.

### 8. Packaging is pacman-first, AppImage-second

Primary artifact:

- native pacman package for Omarchy/Arch
- declares host integration dependencies
- desktop entry, icon, protocol/file integration as applicable
- clean install/upgrade/uninstall tests

Portable artifact:

- AppImage built with a static runtime that does not require FUSE2
- runnable via extraction fallback where necessary
- tested on Omarchy and Ubuntu 24.04

Deferred:

- `.deb` until the AppImage has a concrete Ubuntu incompatibility
- RPM, Flatpak, Snap, AUR automation, Linux ARM64

Bundle a pinned Linux Python 3.11 runtime, ffmpeg, backend sources, legal notices, and the Linux `speakrs-cli` in the prepared resource tree. Do not rely on `/usr/bin/python`, system pip packages, or PATH ffmpeg in packaged builds.

## AI add-on parity plan

Linux add-ons are not “just enable the UI.” Each needs catalog entries, runtime packaging, setup validation, hardware policy, integrity checks, queue membership, cancellation, uninstall ownership, legal notices, and manual smoke.

### Shared requirements

- Setup is always an explicit user action.
- Generation/diarization is local-only and offline after setup.
- Downloads remain HTTPS, host-allowlisted, immutable, size/SHA-256 pinned, cancellable, and path-traversal safe.
- Status values remain:
  `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, `unsupported`.
- Add-on caches stay below `userData/ai-addons`.
- Destructive remove/switch is rejected while compute, preload, GPU runtime, or setup work is pending.
- Validation runs through `createAbortableComputeAction` on the compute queue with existing wall clocks.
- Meeting AI metadata remains limited to `diarization` and `summary`, with sidecars below recordings.
- `AVANEVIS_PACKAGED=1` forbids PATH fallback for bundled/native helpers.

### Speakrs on Linux

Product policy for v1: **x86_64 NVIDIA CUDA only; no product CPU fallback**. The CPU mode remains CI-only. AMD/ROCm/MIGraphX is a later evaluated target.

Implementation requirements:

1. Build `speakrs-cli` for Linux x64 with the frozen JSON contract, `online` compiled out, and the required BLAS + CUDA/load-dynamic features.
2. Stage it through `build/prepare-resources.js`, include it in package resources, and make missing/tampered packaged binaries fail closed with reinstall copy.
3. Add `linux-x64` model-pack metadata. Reuse source model files only after the pack builder proves the Linux CUDA list and legal bundle; publish a Linux-named archive with immutable URL, size, and SHA-256.
4. Define the Linux ONNX Runtime/CUDA shared-library closure. Pin every extracted `.so` by name, size, and SHA-256. Never trust hashes from `install.json`.
5. Full-hash setup and validation. At compute admission, full-hash changed path/size/mtime fingerprints as on Windows.
6. Extend `buildSpeakrsSpawnEnv` with contained Linux paths and `LD_LIBRARY_PATH`/ORT configuration without leaking host PATH precedence.
7. Keep progress phases, sidecar schema, guided windows, and fallback-to-normal-transcript behavior unchanged.
8. Preserve the 30-minute diarization wall clock and process-group kill of the CLI grandchild.

Do not claim a Linux accuracy or speed win before same-audio evidence. Keep the known split-identity/over-clustering risk documented and keep Pyannote selectable.

### Pyannote on Linux

Product policy for v1: **x86_64 NVIDIA CUDA only; no CPU fallback**.

Implementation requirements:

1. Add a pinned `linux-x64` managed dependency artifact for pyannote/PyTorch CUDA.
2. Keep the user’s own Hugging Face token in Electron `safeStorage`; never persist plaintext.
3. Preflight `safeStorage.isEncryptionAvailable()`. Omarchy’s Secret Service passed on the initial host, but missing secret storage elsewhere must produce `needsAccount`/unsupported guidance, never basic-text token persistence.
4. Continue passing validation tokens over stdin and clear all Hugging Face token environment variables, with `HF_TOKEN_PATH` set to `os.devNull`, never `""`.
5. Keep pyannote model loading offline/local-only after setup.
6. Preserve the exclusive-engine rules:
   - new/unset users default Speakrs
   - legacy Pyannote installs stay Pyannote
   - switching removes the other engine’s models/dependencies
   - Pyannote → Speakrs keeps the saved token
   - Remove deletes the active engine and the saved token
7. Never delete Whisper caches or shared CUDA libraries during switch/remove.

### Guided transcription and diarization sidecars

When the selected engine is ready, new recordings continue to:

1. run speaker identification first
2. construct padded speaker windows
3. transcribe windows with faster-whisper
4. write the unchanged `*.speakers.json` schema
5. persist engine/device metadata separately from Whisper device metadata

If guided transcription fails, save a normal transcript and concise sanitized diarization error metadata. Existing sidecars are never rewritten merely because the user switches engines.

### Summaries on Linux

The current Qwen3.5 GGUF remains catalog-owned and llama.cpp remains the runtime. Linux must not silently use a system `llama-cli`.

Initial runtime policy:

- Add a pinned Linux x64 **CPU** llama.cpp runtime as the compatibility baseline.
- Treat Vulkan as a measured optimization, not a presence check. The first Omarchy host has Vulkan but incomplete Haswell support.
- If a Vulkan profile is added, make runtime-profile selection catalog/manifest-driven and validate actual model execution before `ready`; do not infer support only from `vulkaninfo`.
- Do not change the global summary model merely to make Linux fast. If the current model cannot complete the defined smoke within the 90-minute wall clock, keep Linux summaries unsupported until a reviewed model/runtime decision is made.

Preserve:

- explicit setup and checksum validation
- managed Hugging Face download path for the GGUF
- reasoning disabled for the current Qwen runtime
- Concise/Balanced/Detailed/Action items profiles
- summary generation on `aiComputeActionQueue`
- `sourceTranscriptHash` stale-summary detection
- unique temporary/final sidecars
- metadata phase beginning before temp→final renames
- cancel/quit immunity during metadata finalization
- no deletion of committed sidecars after a successful `update-ai`

Acceptance requires a 60-minute transcript to generate a Balanced summary within the existing wall clock on the documented baseline hardware.

## Implementation phases

Each phase should land as a reviewable PR with the smallest relevant tests first. Run `npm run test:all` for recorder, persistence, packaging, security, or cross-process changes and before every Linux PR is opened.

### Phase 0 — Baseline and contract characterization

Deliverables:

- close Gate A; document Gate B status
- add Linux cases to platform-selection tests before implementation
- characterize recorder argv selection, Python runtime resolution, device ID serialization, add-on availability, updater asset selection, and packaged path rules
- add Linux rows to the manual recording and local-AI checklists

Exit criteria:

- current Windows/macOS suites remain green
- `npm test` passes on the Omarchy development host
- unknown/non-macOS platforms no longer silently enter Windows code
- no Linux feature is advertised as ready

### Phase 1 — Omarchy audio spike

Build a disposable backend spike, not product orchestration:

- connect with `pulsectl`
- enumerate sources, sinks, defaults, and monitor mapping
- capture selected mic and monitor concurrently with SoundCard
- write short float32 WAVs
- validate mic-only, desktop-only, and mixed output
- switch the default sink during capture and record actual failure behavior
- measure callback/block cadence, drift, CPU, and channel/sample-rate shapes

The spike must not be merged as `linux_recorder.py`.

Exit criteria:

- browser speech survives mono transcription downmix
- no screen-sharing portal appears
- Bluetooth/headphone and HDMI monitor selection is understood
- late desktop loss can be detected and degraded to mic-only
- evidence is added to this document or a linked Linux benchmark note

### Phase 2 — Linux runtime and device plumbing

Files:

- add `requirements-linux.txt` and `requirements-linux-build.txt`
- update requirement-sync/closure checks
- update `build/download-manifest.js` with exact Linux Python/ffmpeg pins
- extend `build/prepare-resources.js` and `src/main/python-runtime.js`
- add Linux device handling in `backend/device_manager.py` and `src/main/device-ipc.js`
- update renderer device-ID helpers/tests

Exit criteria:

- dev and prepared packaged runtime enumerate the same devices
- opaque Pulse IDs round-trip without coercion
- missing Pulse server and missing selected devices return concise errors
- prepared Python runs backend modules without system Python or repo-only imports

### Phase 3 — Production Linux recorder

Files:

- add `backend/audio/linux_recorder.py`
- add the Linux factory branch
- add `linux-v1` finalization profile
- wire the recorder in `src/main/recorder-service.js`
- extend JS/Python recorder contract tests
- extend capture recovery, temp recovery, and scan-import tests where platform assumptions exist

Required test cases:

- mic + desktop success
- mic-only success
- desktop startup failure → warning + mic-only
- late desktop failure → warning + mic-only
- mic failure → structured failure
- Stop success and recoverable finalization failure
- Cancel tombstone and no meeting resurrection
- force-kill + next-launch recovery
- child never closes after cancel/stop timeout
- level/event chunk fragmentation and multi-line stdout parsing

Exit criteria:

- live 15/60-minute Omarchy captures pass
- recording while CPU transcription runs has no obvious glitches
- browser speech reaches the transcript, not only meters/saved channels
- no whole-session capture array grows with duration

### Phase 4 — Electron behavior, queue, and core transcription

Files:

- explicit Linux branches in recording presence, tray, notifications, close dialogs, and permission/preflight copy
- Linux faster-whisper runtime/cache paths
- Linux CPU/CUDA probe and child environment
- updater platform handling without enabling release assets prematurely
- renderer platform gating for GPU and add-ons

Behavior:

- tray uses StatusNotifier/AppIndicator when available and degrades without crashing
- native notifications use Electron/desktop portals and remain best-effort
- Close/quit during recording preserves current stop/persist semantics
- background transcription queue continues while a new recording starts
- queue, summary, and diarization remain serialized
- Whisper preload and GPU runtime setup enter between compute jobs

Exit criteria:

- Activity auto-resume, cancel pending, retry, rename, delete, History, transcript save, and playback work unchanged
- CPU transcription is the reliable baseline
- CUDA mismatch falls back to CPU and records the actual device
- quitting leaves no Python/ffmpeg process group alive

### Phase 5 — Omarchy Core Beta packaging

Files:

- Linux targets and resources in `package.json`
- pacman packaging metadata/dependencies
- FUSE-less AppImage configuration
- Linux artifact naming in `src/updater.js`
- Linux build/smoke jobs in `.github/workflows/ci.yml`
- Linux release job in `.github/workflows/build-release.yml` only after Gate B
- build/installer docs and troubleshooting

Exit criteria:

- clean Omarchy install, upgrade, uninstall
- AppImage launches without FUSE2
- AppImage smoke on Ubuntu 24.04
- packaged app uses bundled Python, ffmpeg, and backend
- `AVANEVIS_PACKAGED=1` blocks PATH helper substitution
- legal notices open
- no AI setup button is offered until its Linux catalog path is complete

### Phase 6 — Linux accelerator/resource foundation

Port the existing managed runtime behavior instead of treating system CUDA as sufficient:

- define Linux faster-whisper CUDA package/runtime pins
- build a fresh CUDA-major probe for queued-job start
- inject contained shared-library paths into children
- serialize install/repair/uninstall with compute and preload through `gpuResourceActionQueue`
- invalidate cached CUDA status after uninstall/failure
- terminate runtime actions cleanly on quit

Exit criteria:

- CUDA 12 profile works on supported NVIDIA hardware without a system CUDA toolkit
- incompatible/newer-only CUDA stays on CPU with clear copy
- install/repair cannot race active compute or loaded libraries
- no Linux shared-library path escapes the managed runtime

### Phase 7 — Speaker identification parity

Order:

1. Linux `speakrs-cli` build/package/integrity
2. Linux model and ORT/CUDA pack pins
3. Speakrs setup validation and guided smoke
4. Pyannote Linux dependency pins and secure-token preflight
5. selector switch/remove behavior on packaged Linux
6. soak and same-audio comparison

Exit criteria:

- both engine cards are truthful
- only one engine is installed
- Speakrs uses no token
- Pyannote token never reaches logs/manifests/metadata
- setup/validate full-hashes; compute admission rehashes changed fingerprints
- both engines run CUDA-only and produce unchanged sidecar schemas
- guided failure preserves a normal transcript
- remove/switch never deletes Whisper or shared CUDA
- quit/timeout leaves no `speakrs-cli` grandchild

### Phase 8 — Summary parity

Order:

1. add pinned Linux model platform entry
2. add pinned Linux CPU llama.cpp runtime and extraction tests
3. validate setup, cancellation, checksum, offline generation, sidecars, stale-hash UX
4. benchmark the current default model
5. optionally add a catalog-driven Vulkan profile after real inference evidence

Exit criteria:

- setup is explicit and cancellable
- runtime/model checksum failures never reach `ready`
- generation is local-only and serialized
- preflight/queued cancel clears the active slot
- metadata finalization cannot be interrupted
- 60-minute Balanced summary meets the existing wall clock
- committed summary sidecars survive late abort/cleanup

### Phase 9 — Feature-parity release and portability evidence

Matrix:

| Environment | Core | CUDA Whisper | Speakrs | Pyannote | Summary | Package |
|---|---:|---:|---:|---:|---:|---|
| Omarchy 4 / Hyprland / PipeWire / CPU-only | Required | n/a | Unsupported | Unsupported | Required if CPU bar passes | pacman + AppImage |
| Omarchy 4 / NVIDIA CUDA | Required | Required | Required | Required | Required | pacman + AppImage |
| Ubuntu 24.04 / Wayland / PipeWire | Smoke | Smoke where available | Experimental | Experimental | Smoke | AppImage |
| Ubuntu 24.04 / X11 / PulseAudio | Smoke | Optional | Deferred unless unchanged | Deferred unless unchanged | Smoke | AppImage |

Release only what the matrix proves. Unsupported combinations must remain explicit and must never fall back to cloud behavior.

## File touch map

| Area | Primary files |
|---|---|
| Audio factory/recorder | `backend/audio/__init__.py`, new `backend/audio/linux_recorder.py`, shared spool/finalization modules |
| Device discovery | `backend/device_manager.py`, `src/main/device-ipc.js`, renderer device helpers |
| Recorder orchestration | `src/main/recorder-service.js`, recorder output helpers and contract tests |
| Python/runtime packaging | `src/main/python-runtime.js`, `build/download-manifest.js`, `build/prepare-resources.js`, Linux requirements |
| Core transcription/CUDA | `src/main/transcription-service.js`, `src/main/gpu-runtime-service.js`, faster-whisper backend, runtime/cache helpers |
| Presence/Wayland UX | `src/main/recording-presence-service.js`, `src/main.js`, renderer copy/styles |
| Add-on catalog/setup | `src/ai-addon-state.js`, `src/ai-addon/manifest-store.js`, setup/archive modules, `src/main/ai-addon-ipc.js` |
| Speakrs | `native/speakrs-cli`, pack spec/files/integrity, Python runner, packaging verification |
| Summaries | summary setup/service, llama.cpp runtime catalog, summary backend/tests |
| Packaging/updater | `package.json`, `src/updater.js`, CI/release workflows, build docs |
| Manual QA/legal | both manual checklists, `LOCAL_AI_MODEL_CATALOG.md`, About/notices tests |

## Validation strategy

### Automated

- JS: `npm test`
- Python: `npm run test:python`
- Syntax: `npm run test:python-syntax`
- Full gate: `npm run test:all`
- Linux `speakrs-cli`: cargo test/clippy plus CI CPU fixture smoke
- packaged resource smoke: Python, ffmpeg, backend, CLI, legal bundle, no PATH substitution
- installer smoke: pacman install/upgrade/uninstall and AppImage launch

Add Linux cases to characterization tests rather than weakening Windows/macOS snapshots. Update IPC source-scan tests only when an actual shared contract changes.

### Hardware/manual

- every input/output device class available on the Omarchy host
- active browser/meeting audio, silence gaps, Bluetooth/HDMI change
- 15/60-minute capture, stop, discard, crash recovery
- recording during CPU and CUDA transcription
- queued transcription + model preload/runtime setup ordering
- tray/notification behavior with and without AppIndicator dependency
- CUDA-major mismatch and CPU fallback
- Speakrs/Pyannote setup, switch, remove, guided fallback, quit
- summary setup cancel and metadata-phase quit
- no network during transcription/diarization/summary generation

## Non-goals for the first Linux release

- application-specific desktop-audio capture
- PipeWire native graph API while Pulse compatibility is sufficient
- real-time mixing or streaming captions
- overlapping live recordings
- Linux CPU speaker identification
- ROCm/MIGraphX/AMD speaker acceleration
- Linux ARM64
- Flatpak, Snap, RPM, AUR automation
- automatic background AI downloads
- cloud transcription, diarization, or summaries

## First implementation action

Do not begin with the recorder. First restore green `master` (Gate A), then execute **Phase 1 — Omarchy audio spike** and record its evidence. Only after the spike validates simultaneous mic + monitor capture should production Linux files or packaging pins be added.
