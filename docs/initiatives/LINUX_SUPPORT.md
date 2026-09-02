# Linux Support Plan — Omarchy First

> **Status:** **Omarchy Core Beta (Phases 0–5) is complete** and merged to `master` (pre-merge review 2026-08-28). Phase 3 60-minute soak **cancelled** by operator 2026-08-27 — not run, not passed; 15-minute soak is the duration-growth evidence. Phase 5 packaged Settings / legal-notices clicks and a packaged AppImage recording + CPU faster-whisper session closed 2026-08-28. Gate B closed on Apple Silicon macOS 2026-08-28 and the release workflow now includes AppImage, pacman, and an experimental `.deb`. Ubuntu 24.04 **desktop** recording/`safeStorage` smoke is still open (Docker launch only). Additional distros and desktops are **experimental betas** with no hardware claim — see [LINUX_EXPERIMENTAL.md](../guides/LINUX_EXPERIMENTAL.md). Phases 6–9 are now a v2.9 evidence-gated extension for CachyOS x86_64 + NVIDIA RTX 4070; they remain unavailable everywhere else until their individual gates pass.
> **Pre-merge review (2026-08-28):** full-branch review before the first Linux release. Eleven defects fixed — see [Pre-merge review remediation](#pre-merge-review-remediation-2026-08-28). Two of them (`is_pulse_port_unavailable` never matching a real `pulsectl` enum, and a blank Linux tray icon) were behaviours this document previously claimed as evidence; those claims are corrected in place below.
> **Replanned:** 2026-08-23 against AvaNevis v2.7.0 / current `master`.
> **Review pass:** 2026-08-23 — verified plan claims against the codebase and CI, corrected two host-fact conclusions (secret storage, tray), and pinned every required upstream Linux artifact. All "Verified" sections below were checked on that date.
> **Scope cut (2026-08-24):** the first Linux version is **Core Beta only** (Phases 0–5). Speaker identification and local summaries are **out of scope** for Core Beta; do not ship a CPU fallback. The UI must keep both features visible but greyed out as unsupported. CUDA-only add-ons now proceed only through the separately gated v2.9 CachyOS + RTX 4070 lane; hardware presence alone does not change Core Beta support claims.
> **Scope extension (2026-09-01):** v2.9 now includes a separate, sequential Linux AI lane because a CachyOS desktop with an NVIDIA RTX 4070 is available. The lane begins with fresh artifact and compatibility investigation; CUDA Whisper, Speakrs, Pyannote, and summaries are independently accepted or left unavailable. Its detailed execution plan is [2026-09-01-v2.9-linux-ai-addons.md](../superpowers/plans/2026-09-01-v2.9-linux-ai-addons.md).
> **Primary target:** Omarchy 4 and CachyOS x86_64, Hyprland/Wayland, PipeWire with `pipewire-pulse`.
> **Secondary target:** experimental-beta x86_64 desktops (Ubuntu, vanilla Arch, non-Hyprland CachyOS, Fedora Workstation, SteamOS Desktop Mode) where the same Pulse-compatible capture path may work without distro-specific code. These are not hardware-validated. See [LINUX_EXPERIMENTAL.md](../guides/LINUX_EXPERIMENTAL.md).

## How to use this plan

This plan is written to be executed phase by phase, one PR per phase, by an implementer with no prior context on this initiative. Rules:

1. Read root `AGENTS.md` first. It is the canonical source for every cross-process contract this plan touches. Where this plan and `AGENTS.md` disagree on an existing contract, `AGENTS.md` wins.
2. Do not skip or reorder **in-scope** phases. Each phase's exit criteria must pass before the next phase starts. Phases 6–9 are v2.9 Linux-AI gates for the validated CachyOS RTX 4070 profile — see rule 8.
3. Every referenced line number was correct on 2026-08-23 and will drift. Each line reference includes a search pattern — locate code by the pattern, not the number.
4. Every artifact pin below lists the exact URL and file name but **not** the SHA-256. At implementation time: download the file, run `sha256sum <file>` (or `shasum -a 256` on macOS), and record the hash in the pin. Never copy a hash from an unverified source, and never pin a URL you have not downloaded and hashed yourself.
5. Never weaken a Windows or macOS test to make Linux pass. Add Linux cases alongside existing ones.
6. Validation per phase: run the smallest relevant suite while iterating (`npm test` for JS, `npm run test:python` for Python), and always run `npm run test:all` before opening the phase PR.
7. No Linux feature may be presented as available in the UI until its phase exit criteria pass. `unsupported` is the correct status until then.
8. Run Phases 6–9 only through the v2.9 Linux-AI plan on CachyOS x86_64 + NVIDIA RTX 4070. Each component stays unavailable until its specific artifact, security, packaged, and hardware gate passes; no CPU fallback or wider Linux support claim is allowed.

Delivery has two explicit milestones:

1. **Omarchy Core Beta** (Phases 0–5) — **this is the first Linux version.** Mic + desktop recording, recovery, background transcription queue, local faster-whisper **on CPU**, History/export, tray/notifications, pacman package, and a FUSE-less AppImage. Speaker identification and local summaries stay `unsupported` and greyed out in the UI.
2. **v2.9 Linux AI extension** (Phases 6–9, gated) — managed CUDA Whisper, accepted CUDA-only Speakrs/Pyannote support, and accepted CUDA-only summaries on CachyOS x86_64 + NVIDIA RTX 4070. A phase must not make a component available until its fresh artifact, security, packaged, and hardware evidence is recorded. A CPU llama.cpp binary is not an acceptable fallback.

Core Beta and all unvalidated Linux AI profiles must not present setup controls that cannot complete. Greyed-out Settings cards and a disabled Generate Summary control are required; hiding the features, or leaving Set Up clickable, is not. Do not call Linux "feature-complete" with Windows/macOS beyond the accepted 4070 matrix.

An experimental x86_64 `.deb` is published beside AppImage and pacman for Debian-family friends. It does not promote Ubuntu (or any other distro) to Supported. No Ubuntu-specific capture implementation is planned.

## Executive decision

Build Linux in the existing monorepo and preserve the current Electron ↔ Python contracts. Do not create a Linux-only app, a second compute scheduler, or a prototype recorder that bypasses durable spools.

## Why the old plan needed another rewrite

The original late-2025 plan predated most of the current runtime architecture. The July 2026 refresh covered durable capture and the transcription queue, but only received a one-line Speakrs amendment after v2.7.0. The following shipped behavior now affects Linux:

| Current feature / invariant | Linux consequence |
|---|---|
| Durable `{stem}.capture/` track spools and bounded `finalize_capture` | The Linux recorder must write mic and desktop tracks to spools from its first implementation; no whole-session RAM path |
| Structured recorder stdout JSON | Linux must emit the same `levels`, `event`, `warning`, `error`, stop-stage, and final-result payloads; stderr stays diagnostic-only |
| Discard/cancel with a `discarded` manifest tombstone | Linux cancel must skip finalization and must never resurrect discarded spools |
| Main-owned background transcription queue and Activity UI | Capture unlocks after pending meeting persistence, not after Whisper; Linux uses the same queue and monotonic `seq` state |
| Whisper preload and GPU runtime between-job admission | Linux model download and accelerator setup must use `gpuResourceActionQueue`, not a new lock or fail-fast path |
| Exclusive Speakrs/Pyannote engine selector | **Out of the first Linux version.** Catalog stays without `linux-x64` entries; UI stays greyed `unsupported`. Later version (Phase 7) needs both engines, exclusive deletion, token isolation, setup validation, and guided transcription |
| Bundled `speakrs-cli` with fail-closed integrity | **Do not stage a Linux Speakrs binary in Core Beta.** Windows/macOS packaging is unchanged. Later version (Phase 7) builds, stages, and fail-closes the Linux CLI; model/runtime packs remain setup-time downloads |
| User-triggered Qwen summaries through pinned llama.cpp | **Out of the first Linux version**, including the CPU llama.cpp runtime. Later version (Phase 8) pins a Linux runtime and preserves sidecar/metadata finalization |
| AI compute wall clocks and quit drain | Core Beta must prove process-group kill for Python and ffmpeg. `llama-cli` and `speakrs-cli` grandchildren are a later-version concern |
| Packaged-path hardening | `AVANEVIS_PACKAGED=1` must prevent packaged Linux from resolving helpers or runtimes from untrusted `PATH` entries |

## Verified Omarchy host facts (2026-08-23)

The initial target machine is Omarchy 4 with Hyprland on Wayland.

- PipeWire and `pipewire-pulse` are active; `pactl` and `wpctl` can reach the user audio server.
- Pulse monitor sources are available, so desktop output can be captured without a ScreenCast portal or whole-screen sharing.
- `fuse2` is not installed. Do not require it for the AppImage (see the electron-builder decision in Phase 5).
- **Tray (corrected 2026-08-27):** `libappindicator-gtk3` is not installed on the host — and it does not need to be. Modern Electron/Chromium implements **StatusNotifierItem (SNI) natively over D-Bus**. What the tray actually requires is an **SNI host**; the observed Phase 4 session used quickshell's `org.kde.StatusNotifierWatcher` (Waybar was not running). Do **not** add a libappindicator pacman dependency. The real degradation case is a Wayland session with no SNI host, where Electron may have no visible tray. See Phase 4.
- **Secret storage (corrected 2026-08-23):** `gnome-keyring`, `libsecret`, and an active `org.freedesktop.secrets` service are present on the host — but that alone does **not** make Electron `safeStorage` work. Chromium selects its Linux keyring backend from `XDG_CURRENT_DESKTOP`, and **Hyprland is not on Chromium's recognition list** (only GNOME/KDE/XFCE/Cinnamon/Deepin/Pantheon/UKUI/Unity variants are). Without intervention, `safeStorage` selects the `basic_text` backend and `isEncryptionAvailable()` returns `false` on Omarchy even though a fully working Secret Service is running. See **Locked decision 9 — Linux secret storage**. Setup must still fail closed on desktops with genuinely no secret service.
- Vulkan is installed, but this host exposes an older Intel Haswell device with incomplete Vulkan support and no NVIDIA runtime. A successful `vulkaninfo` probe is not sufficient evidence that llama.cpp Vulkan or CUDA AI paths will work.
- The current development Python does not include `sounddevice`; that does not block the selected Pulse-native approach.

These facts are evidence for the first target only, not assumptions to bake into generic Linux behavior.

## Verified upstream artifacts (2026-08-23)

Every external Linux artifact this plan needs exists upstream, mostly at the exact versions already pinned for Windows/macOS. Asset existence was verified against the live GitHub/PyPI APIs on 2026-08-23. SHA-256 values must be computed at pin time (rule 4 above).

| Purpose | Artifact | Where it gets pinned |
|---|---|---|
| Bundled Python 3.11 (Phase 2) | `cpython-3.11.7+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz` from python-build-standalone release `20240107` — the **same release** as the existing macOS pin. URL: `https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz` (literal `+`, matching the existing macOS pin style in `build/download-manifest.js`). The project moved from `indygreg` to `astral-sh` on GitHub; old URLs redirect, but use the `astral-sh` URL form for new pins. | `build/download-manifest.js` (`pythonLinux`) |
| Bundled ffmpeg (Phase 2) | `ffmpeg-linux-x64` (fully static) from `shaka-project/static-ffmpeg-binaries` release `n8.0.1-1` — the **same release** as the existing macOS pin. URL: `https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.0.1-1/ffmpeg-linux-x64`. | `build/download-manifest.js` (`ffmpegLinux`) |
| Summary runtime, CPU baseline (**deferred Phase 8**) | `llama-b9173-bin-ubuntu-x64.tar.gz` from `ggml-org/llama.cpp` release `b9173` — the **exact build tag** already pinned in `PINNED_LLAMA_CPP_RUNTIME` (`src/ai-addon-state.js`). URL: `https://github.com/ggml-org/llama.cpp/releases/download/b9173/llama-b9173-bin-ubuntu-x64.tar.gz`. Built against Ubuntu 22.04 glibc; runs on Arch (newer glibc) and Ubuntu 24.04. **Do not pin this in Core Beta.** | `src/ai-addon-state.js` (`linux-x64` runtime entry) |
| Summary runtime, optional Vulkan profile (**deferred Phase 8**, gated) | `llama-b9173-bin-ubuntu-vulkan-x64.tar.gz` from the same release. URL: `https://github.com/ggml-org/llama.cpp/releases/download/b9173/llama-b9173-bin-ubuntu-vulkan-x64.tar.gz`. Only pinned if the Vulkan profile clears its evidence bar. **Do not pin this in Core Beta.** | `src/ai-addon-state.js` |
| Speakrs Linux ONNX Runtime (**deferred Phase 7**) | `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` (~233 MB) from `microsoft/onnxruntime` release `v1.27.1` — the **same ORT version** as the Windows pack spec. URL: `https://github.com/microsoft/onnxruntime/releases/download/v1.27.1/onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz`. Caveats: requires cuDNN 9 and CUDA 12 libraries on `LD_LIBRARY_PATH`; cuDNN 9 on Linux additionally requires zlib (statically linked on Windows, not on Linux); Microsoft has deprecated CUDA 12 packages in the 1.27 line, so a future CUDA 13 migration will hit Windows and Linux together — acceptable for a later version, do not migrate unilaterally. **Do not pin this in Core Beta.** | `src/ai-addon/speakrs-pack-spec.js` |
| faster-whisper CUDA libraries (**deferred Phase 6**) | `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` pip packages — both ship manylinux wheels. Same package names as the Windows CUDA profile; the only mechanical difference is `LD_LIBRARY_PATH` injection instead of Windows DLL directories. **Do not pin this in Core Beta.** | Linux GPU runtime profile (Phase 6) |
| Capture library (Phases 1–3) | `SoundCard` 0.4.6 (PyPI) — actively maintained (Jan 2026 numpy-compat release); documented working against PipeWire's Pulse compatibility layer. | `requirements-linux.txt` |
| Audio control library (Phases 1–3) | `pulsectl` 24.12.0 (PyPI) — latest release Dec 2024; mature, low-churn ctypes binding to libpulse. Slow release cadence is acceptable; the Phase 1 spike exercises exactly the API surface we depend on. | `requirements-linux.txt` |

## Go/no-go gates before implementation

### Gate A — restore a trustworthy baseline — **RESOLVED 2026-08-23, one follow-up remains**

The `master` CI failure this gate was written about is closed:

- Red run: [CI run 31814775402](https://github.com/AmirArshad/meeting-transcriber/actions/runs/31814775402) on commit `3ff88b0` failed the Windows test "Speakrs install and validation preserve nested CoreML-style bundle paths" with `'error' !== 'ready'`.
- Green run: [CI run 32613244438](https://github.com/AmirArshad/meeting-transcriber/actions/runs/32613244438) on commit `5b48391` (a docs-only change) ran the identical suite and passed. The failure did not reproduce with no code change in between: this is a **flake**, not a regression.
- Diagnosis limit: the failing assertion (`installValidTestSetup` in `tests/js/speakrs-task2-hardening.test.js`, search for `assert.equal(status.features.diarization.status, 'ready')`) compares only the status string and discards the `error` field the status object carries, so the CI log contains no failure cause.

**Remaining follow-up (do this in the Phase 0 PR):** make the assertion diagnosable so the next flake occurrence produces a cause in the log. Replace the bare assertion with one that surfaces the error detail:

```js
assert.equal(
  status.features.diarization.status,
  'ready',
  `diarization status was '${status.features.diarization.status}'`
  + ` (error: ${status.features.diarization.error || 'none reported'})`
);
```

Record the green run link above in the first Linux PR description. Do not let Linux conditionals hide or skip any Windows/macOS test.

On the current Omarchy host, `npm test` also fails seven Linux-platform assumptions before any product change: resource-manifest/Speakrs packaging rejects `process.platform === 'linux'`, three diarization handler tests require an already-supported platform, the Speakrs resource-manifest test rejects Linux, and one dev-Python fixture falls back to `python`. These are Phase 0 work, not evidence of a regression. The first Linux PR must make the normal JS suite runnable and green on Linux without weakening Windows/macOS coverage.

### Gate B — triage current macOS release integrity — **CLOSED 2026-08-28**

[Issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76) reported that the v2.7.0 DMG appeared corrupt on macOS 15.7.7 / M3 Pro. Maintainer verification on Apple Silicon macOS found:

1. The published DMG matched GitHub's SHA-256 (`901417118ab2ee3e964a73bea0562e09082625c7c7a55b37c6bedc0e6521fccf`), passed `hdiutil verify`, and mounted normally. It was not file corruption.
2. The contained app was only linker-signed: no sealed resources, `Identifier=Electron`, `codesign --verify --deep --strict` failed, Gatekeeper assessment failed, and there was no notarization/stapling ticket. The release workflow's old claim that certificate-less builds were ad-hoc signed was false because electron-builder skips signing when no identity is found.
3. `build.mac.identity` is now explicitly `"-"`, which produces a complete ad-hoc bundle signature with hardened runtime and the existing `disable-library-validation` entitlement. The packaged verifier checks the whole app seal before and after smoke execution and uses `PYTHONDONTWRITEBYTECODE=1` so imports cannot invalidate it.
4. A fresh Electron 42.9.0 DMG passed `hdiutil verify`, mounted, passed the MLX/ffmpeg/helper/Speakrs packaged smoke, and the app inside the mounted DMG passed deep/strict signature verification. It remains intentionally not Developer-ID signed, notarized, or stapled until enrollment, so the documented first-launch Gatekeeper bypass remains necessary.

Gate B is closed and `.github/workflows/build-release.yml` now builds, verifies, uploads, and publishes AppImage, pacman, and experimental `.deb` Core Beta artifacts.

Windows v2.7.0 has no equivalent open release issue.

### Gate C — freeze target support claims

The first Linux version (Core Beta) must state:

- Omarchy 4 x86_64 is supported.
- CachyOS x86_64 Hyprland/Wayland + PipeWire is supported (same Core Beta payload; evidence 2026-08-31, including packaged 2-minute mic+desktop Stop with browser speech in the CPU transcript).
- Wayland/Hyprland + PipeWire/Pulse compatibility is the tested desktop.
- Transcription is local faster-whisper on **CPU**. Linux CUDA Whisper is not a Core Beta support claim.
- Speaker identification (Speakrs and Pyannote) and local summaries are **not available on Linux in this version**; they will return in a future Linux update. The Settings cards stay visible and greyed out. No Linux CPU fallback for either speaker engine.
- Ubuntu, vanilla Arch, non-Hyprland CachyOS, Fedora Workstation, SteamOS Desktop Mode, and additional desktops (GNOME, KDE Plasma, COSMIC, Sway, Niri, Cinnamon, XFCE) are **experimental betas** until friend hardware evidence exists. See [LINUX_EXPERIMENTAL.md](../guides/LINUX_EXPERIMENTAL.md) and [linux-experimental-beta-checklist.md](../../tests/manual/linux-experimental-beta-checklist.md).
- Linux ARM64, Flatpak, Snap, RPM, ROCm/MIGraphX, and Linux AI add-on setup remain out of this release. The experimental `.deb` is a packaging convenience, not a Ubuntu support claim.

## Locked architecture decisions

### 1. One codebase, explicit platform branches

Add `linux` branches to the existing factories and services. Do not let "not macOS" continue to mean Windows.

Required audit points (verified 2026-08-23; each entry names the file and the pattern to search for):

- `backend/audio/__init__.py` — already fails closed with `NotImplementedError` on non-Windows/non-macOS. Correct baseline; extend with a `Linux` branch in Phase 3.
- `backend/device_manager.py` — `load_audio_backend()` and `DeviceManager.__init__` already raise `DeviceManagerEnvironmentError` on other platforms. Extend with pulsectl in Phase 2.
- `src/main/recorder-service.js` — recorder module selection; already passes device IDs as strings into argv (`micId.toString()`), but the preflight handler coerces: search for `Number.isInteger(micId)` in the `run-recording-preflight` handler.
- `src/main/device-ipc.js` — device validation and enumeration.
- `src/main/python-runtime.js` — `getPythonConfig()` branches on `process.platform === 'darwin'` with Windows as the implied else.
- `src/main/recording-presence-service.js` — tray/Dock/taskbar presentation.
- `src/main/transcription-service.js` — runtime env and cache paths.
- `src/main/gpu-runtime-service.js` — CUDA probe/install paths.
- `src/ai-addon-state.js` — has zero Linux entries; gates via explicit `supportedPlatforms` maps, so Linux truthfully reports `unsupported` until catalog entries land. This is the correct Core Beta behavior — do not fake entries early.
- `src/updater.js` — see Locked decision 11.
- `src/renderer/app.js` — three confirmed "not-mac means Windows" sites: two instances of `navigator.platform.includes('Mac')` (search for that exact string; near lines 1894 and 3419 on 2026-08-23) where the else branch shows Windows copy, and the GPU CTA (`const isMac = platform === 'darwin'` inside the function near line 5234) where the else branch assumes Windows.

Prefer explicit `win32` / `darwin` / `linux` branches over a shared `else`.

### 2. Pulse-compatible audio control and PCM capture

Use:

- **`pulsectl`** (pin 24.12.0 or later) for server discovery, source/sink enumeration, default-device resolution, monitor-source mapping, and validation.
- **`SoundCard`** (pin 0.4.6 or later) for Pulse-compatible PCM recording. On Linux, SoundCard exposes Pulse source names as device IDs, which maps directly onto the opaque-string ID scheme in decision 3.
- PipeWire through `pipewire-pulse` on Omarchy; native PulseAudio remains compatible on other distributions.

Do not depend on `pactl`, `wpctl`, or distro shell scripts at runtime. They are diagnostics only. Do not use `sounddevice` as the primary Linux backend: it adds PortAudio/ALSA routing assumptions that are unnecessary on the verified target.

The host package contract is `libpulse` plus a running Pulse-compatible server. The pacman package should depend on the appropriate Omarchy/Arch packages; the AppImage should preflight and explain a missing server.

For USB DAC/PipeWire failures and `ENOSPC` recovery, see
[`docs/development/LINUX_AUDIO_TROUBLESHOOTING.md`](../development/LINUX_AUDIO_TROUBLESHOOTING.md).

### 3. Device IDs are opaque strings

Linux device selection must use stable Pulse names, not numeric indexes:

- mic: `pulse-source:<source.name>`
- desktop: `pulse-monitor:<monitor_source_name>`
- output/sink (enumerated, not used for capture selection): `pulse-sink:<sink.name>`
- explicit desktop-off: `none`

The renderer and IPC payloads must treat device IDs as strings. The 2026-08-23 `parseInt` / `Number.isInteger` coercion sites now go through `toOpaqueDeviceId` / `coerceIntegerDeviceId`. Recorder argv still uses `micId.toString()` and must keep Pulse IDs unchanged. Preserve compatibility for existing Windows numeric IDs and macOS UIDs — on those platforms numeric strings still round-trip.

Default selection:

- mic: current Pulse default input, then first usable non-monitor source
- desktop: monitor of current default output
- headphones/Bluetooth/HDMI are naturally handled by selecting the sink's monitor

Resolve "default" when recording starts. Linux v1 does not hot-switch the desktop stream mid-recording; if a sink disappears, warn and continue mic-only.

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
- quit terminating transcription-class work while preserving pending meetings

POSIX Python is already spawned as a process-group leader. Core Beta must prove that terminating the group also reaps ffmpeg. `llama-cli` and `speakrs-cli` grandchildren are a later-version concern (Phases 7–8). Summary generation remaining user-triggered, and summary metadata finalization being non-abortable, stay Windows/macOS invariants and must not grow Linux catalog paths in Core Beta.

### 7. Core transcription uses faster-whisper (CPU for the first Linux version)

Linux uses `faster-whisper`, not MLX.

First Linux version (Core Beta):

- **CPU is the only supported transcription path.**
- CUDA Whisper, the managed CUDA runtime install, and GPU Settings install/repair are deferred from Core Beta with diarization/summaries. They are now the separately gated v2.9 CachyOS + RTX 4070 Phase 6 work; no status changes until its implementation and packaged evidence pass.
- A CUDA probe may still run so Linux does not silently take the Windows GPU path. It must report unavailable/incompatible honestly and stay on CPU. Do not advertise Linux CUDA as ready, and do not offer an Install GPU control that cannot complete.
- Model cache completeness and `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY` behavior stay aligned between JS and Python.
- Whisper cache remains separate from the diarization Hugging Face cache (that cache stays unused on Linux in Core Beta).
- Preload stays off the compute queue and enters through `gpuResourceActionQueue` between jobs.
- The actual result device, not intended device, populates meeting metadata.
- Linux child processes lower their own priority with `os.nice`, as on macOS, so transcription cannot starve a newly started recording.

Later version (Phase 6, deferred) — keep the existing Windows semantics, do not invent a new lock:

- The queued job re-probes CUDA when it starts; no stale five-minute UI result controls compute.
- Managed runtime installs the `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` manylinux wheels and injects their library directories via **`LD_LIBRARY_PATH`** into Python children.
- The probe checks for CUDA-12-major shared-object names; a host with only CUDA-13-named libraries surfaces the runtime-major mismatch and stays on CPU.

### 8. Packaging is pacman-first, AppImage-second

Primary artifact:

- native pacman package for Omarchy/Arch (electron-builder `pacman` target, generated via fpm)
- declares host integration dependencies
- desktop entry, icon, protocol/file integration as applicable
- clean install/upgrade/uninstall tests — validate the generated `.PKGINFO` dependency list on a clean Omarchy install rather than trusting fpm's output
- **do not** declare a libappindicator dependency (see host facts: tray is native SNI)

Portable artifact:

- AppImage built with the **static (FUSE-less) runtime** — see the electron-builder decision below
- runnable via extraction fallback where necessary
- tested on Omarchy and Ubuntu 24.04

**electron-builder decision (Phase 5, decide before configuring targets).** The repo is on `electron-builder ^26.15.3`. The static FUSE-less AppImage runtime is:

- **opt-in on 26.x**: set `"toolsets": { "appimage": "1.0.2" }` (or later toolset) in the build config, or
- **the default on v27+**, which also changes `--no-sandbox` semantics: v27's `AppRun` adds `--no-sandbox` only when unprivileged user namespaces are unavailable (this conveniently handles Ubuntu 24.04's AppArmor user-namespace restrictions), instead of always injecting it.

Pick one: either opt in via `toolsets` on the current 26.x, or take the v27 upgrade **after** reviewing the [v27 breaking-changes list](https://www.electron.build/docs/migration/v27-breaking-changes/). Do not ship the legacy FUSE2 runtime — `fuse2` is absent on the Omarchy target and EOL upstream.

Two operational constraints:

- **AppImages cannot be cross-compiled from macOS or Windows.** The CI Linux build job (ubuntu runner) is a hard requirement, not a nicety.
- Verify packaged-AppImage secret storage explicitly (see decision 9): there are field reports of AppImages failing to `dlopen` the system `libsecret` from inside the AppImage mount namespace. A generic `safeStorage` encrypt/decrypt round-trip must be smoke-tested in the packaged AppImage on Omarchy, not only in the dev build. This is desktop-integration evidence, not a Pyannote token requirement — Core Beta has no Linux token flow.

Deferred:

- RPM, Flatpak, Snap, AUR automation, Linux ARM64

An experimental x86_64 `.deb` (`AvaNevis-Setup-*`, explicit `libpulse0` / `libsecret-1-0`, no AppIndicator/ffmpeg/AI depends) shipped 2026-08-28 for Debian-family friends. It does not change the Supported tier.

Bundle a pinned Linux Python 3.11 runtime, ffmpeg, backend sources, and legal notices in the prepared resource tree (see **Verified upstream artifacts** for the Python/ffmpeg pins). Do not rely on `/usr/bin/python`, system pip packages, or PATH ffmpeg in packaged builds. **Do not stage Linux `speakrs-cli`, ONNX Runtime, llama.cpp, or pyannote CUDA wheels in Core Beta.** `build/prepare-resources.js` must not fail a Linux package because a Speakrs binary is absent. Windows/macOS Speakrs packaging stays fail-closed.

### 9. Linux secret storage requires an explicit backend selection (new, 2026-08-23)

Chromium selects the Linux keyring backend from `XDG_CURRENT_DESKTOP`. Hyprland (and Sway, i3, and other non-mainstream desktops) are not recognized, so Electron falls back to the non-encrypting `basic_text` backend even when gnome-keyring and `org.freedesktop.secrets` are fully functional — which is exactly the verified Omarchy host state. Core Beta still lands this switch so Hyprland encryption is correct for any future token use and so the AppImage `libsecret` smoke is meaningful. The Pyannote token preflight itself is **not** a Core Beta requirement.

Implementation (Phase 4, in `src/main.js` **before** `app.whenReady()`):

```js
if (process.platform === 'linux') {
  const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const isKde = desktop.includes('kde') || Boolean(process.env.KDE_FULL_SESSION);
  app.commandLine.appendSwitch(
    'password-store',
    isKde ? 'kwallet6' : 'gnome-libsecret'
  );
}
```

Rules:

- KDE is not a tested target for this release; the `kwallet6` branch is a best-effort courtesy (kwalletd6 is D-Bus-activated on demand). Refine per `KDE_SESSION_VERSION` only if a real KDE report demands it — do not build that matrix speculatively.
- Forcing `gnome-libsecret` on a host with no Secret Service is safe: Chromium fails to initialize the backend and `safeStorage.isEncryptionAvailable()` returns `false`, which is the correct fail-closed outcome.
- The token preflight (**deferred Phase 7**) must check **both** `safeStorage.isEncryptionAvailable()` **and** `safeStorage.getSelectedStorageBackend() !== 'basic_text'`. `isEncryptionAvailable()` alone is not sufficient — Electron can report encryption "available" over `basic_text` when plain-text mode is enabled, and `basic_text` is hardcoded-key obfuscation, not encryption.
- Missing secret storage on other desktops must produce `needsAccount`/unsupported guidance with copy telling the user to install/start a Secret Service (e.g. gnome-keyring) — never plain-text token persistence. Core Beta has no Linux token UI; keep this rule for the later version.
- Keep the existing invariants: token via stdin (`--token-stdin`), cleared HF env vars, `HF_TOKEN_PATH` set to `os.devNull`, never `""`.
- Phase 5 must smoke-test a generic packaged-AppImage `safeStorage` encrypt/decrypt round-trip on Omarchy (the `dlopen(libsecret)` risk noted in decision 8). Do not require a Hugging Face token save for Core Beta.

### 10. Wayland presentation: tray, notifications, and the ozone decision (new, 2026-08-23)

**Tray.** Electron uses native D-Bus StatusNotifierItem. On the observed Omarchy session, quickshell was the SNI host and the tray worked without extra packages; do not assume Waybar owns the watcher. Constraints for `src/main/recording-presence-service.js`:

- Tray creation on a Wayland session with no SNI host can yield no visible icon. The service must tolerate that without crashing. If tray creation fails, close-during-recording must minimize instead of hide so the taskbar recording indicator and Stop/Discard path remain reachable.
- Do not rely on tray `click` events on Linux — SNI activation semantics vary by host. Drive all tray interaction through `setContextMenu`, and call `setContextMenu` again after mutating menu items (Linux requirement).
- Known upstream quirk: all Electron apps currently share the SNI ID `chrome_status_icon_1` (Electron issue #40936; fix in flight in #48675). Do not attempt to patch this locally; note it in troubleshooting docs if users report tray-management oddities.

**Notifications.** Use Electron's `Notification` (D-Bus `org.freedesktop.Notifications`); Omarchy ships a notification daemon. Notifications remain best-effort — never gate recording flow on notification delivery.

**Ozone / XWayland (decision spike required in Phase 4).** By default Chromium runs under XWayland, which renders blurry under Hyprland fractional scaling — a loud complaint in exactly the Omarchy demographic. Native Wayland via `--ozone-platform-hint=auto` fixes rendering but changes window-decoration and input behavior. Phase 4 must run the app both ways on the Omarchy host, record findings, and pick a shipped default. Recommendation going in: ship `--ozone-platform-hint=auto` (appended in `src/main.js` for Linux only) so Wayland sessions get native rendering and X11 Ubuntu sessions still work; revert to XWayland default only if the spike finds functional regressions. Audio capture is unaffected either way (no ScreenCast portal in the design).

**Shipped default (2026-08-27 Omarchy spike):** `--ozone-platform-hint=auto`. On Hyprland it binds native Wayland (`xwayland=False`); `--ozone-platform=x11` still binds XWayland when forced. Do **not** force `--ozone-platform=wayland` as the Linux default — that would hurt X11 Ubuntu. Findings are in the Phase 4 evidence section.

### 11. The updater stays notify-only; tighten Linux asset matching (new, 2026-08-23)

`src/updater.js` only notifies and opens a download URL — it performs no self-update. This is correct for Linux (no AppImage self-update machinery, and pacman-installed apps must not self-update). Two required changes (Phase 5):

- `findInstallerAsset` already has a Linux branch, but it matches **any** asset ending in `.AppImage`, `.deb`, or `.tar.gz` without the `AvaNevis-Setup-` name check that Windows/macOS use (search for `asset.name.endsWith('.AppImage')`). Tighten it to require the `INSTALLER_NAME_TOKEN` prefix and match only the artifact types actually shipped:

```js
// Linux: match only our published artifacts, preferring the AppImage.
const linuxAsset = assets.find(asset =>
  asset.name.startsWith(INSTALLER_NAME_TOKEN) && asset.name.endsWith('.AppImage')
) || assets.find(asset =>
  asset.name.startsWith(INSTALLER_NAME_TOKEN) && asset.name.endsWith('.pkg.tar.zst')
);
return linuxAsset || null;
```

- Linux `artifactName` values in `package.json` must therefore produce `AvaNevis-Setup-*` file names, keeping `src/updater.js` and release naming aligned (the existing release-asset-naming invariant in `AGENTS.md`).

**Shipped matching (2026-08-28 experimental slice):** still notify-only and still `AvaNevis-Setup-*` only. Selection is now distro-aware: running AppImage → AppImage; Debian-family → `.deb` then AppImage; Arch-family → pacman then AppImage; Fedora, SteamOS, and unknown Linux → AppImage. Source archives and unprefixed names still never match.

### 12. Core Beta historical decision: no diarization or summaries (2026-08-24; superseded for the v2.9 RTX 4070 lane)

The original Omarchy Core Beta host had no NVIDIA evidence. The current CachyOS RTX 4070 host is reserved for the separately gated v2.9 Linux-AI lane. Speakrs and Pyannote on Linux are CUDA-only with **no CPU fallback** (same product policy as Windows/macOS). Local summaries are deferred with that same later milestone even though a CPU llama.cpp binary exists upstream — do not ship a Linux-only CPU summary exception in Core Beta.

Core Beta product rules:

- `getDiarizationAvailability('linux', …)` and `getSummaryAvailability('linux', …)` stay `supported: false`. Do not add `linux-x64` catalog, Speakrs pack, ORT, llama.cpp, or pyannote CUDA entries.
- Feature status remains `unsupported`. Setup/generate IPC stays fail-closed.
- **Do not hide the features.** Settings must still show the Speaker identification and Local summaries cards so users can see they exist on other platforms.
- **Do grey them out.** `buildAiAddonControlState` already sets `canConfigure` / `canValidate` / `canRemove` / `canSelectEngine` false when `status === 'unsupported'`. Phase 4 must make that visually obvious: disabled buttons, disabled engine radios, disabled summary profile select, muted card chrome (for example an `ai-addon-card is-unsupported` class), and no token/speaker-count fields offered.
- Home "Set up local AI add-ons" CTA must not offer setup on Linux (hide or disable it; do not leave Set Up clickable).
- History and Home **Generate Summary** stay disabled, with the same unsupported reason in the tooltip/status text.
- Linux-specific reason strings, not the generic "not supported on this platform" fallback:

  - Speaker identification: `Speaker identification is not available on Linux in this version. It will return in a future Linux update.`
  - Local summaries: `Local summaries are not available on Linux in this version. They will return in a future Linux update.`

- Tests: `tests/js/linux-platform-selection.test.js` already pins catalog `unsupported`. Add renderer helper coverage that Linux control state is fully disabled and that the two reason strings render. Update `tests/manual/local-ai-addons-checklist.md` Linux rows to match.

For unvalidated Linux profiles, keep this decision's grey-out contract; do not partially enable summaries or a Speakrs CPU path. The v2.9 CachyOS + RTX 4070 lane supersedes the later-version scheduling condition only after each component's acceptance gate passes.

## Linux add-on parity plan (historical Core Beta deferral; v2.9 execution is gated)

**Out of scope for Core Beta.** The requirements below are the baseline for the v2.9 gated implementation. Do not implement, pin, or enable an individual component until the current [v2.9 Linux-AI plan](../superpowers/plans/2026-09-01-v2.9-linux-ai-addons.md) records its acceptance evidence.

Linux add-ons are not "just enable the UI." Each needs catalog entries, runtime packaging, setup validation, hardware policy, integrity checks, queue membership, cancellation, uninstall ownership, legal notices, and manual smoke. Hardware gate: Omarchy 4 x86_64 **with NVIDIA CUDA**.

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

Product policy for the later Linux version: **x86_64 NVIDIA CUDA only; no product CPU fallback**. The CPU mode remains CI-only. AMD/ROCm/MIGraphX is a later evaluated target.

Implementation requirements:

1. Build `speakrs-cli` for Linux x64 with the frozen JSON contract, `online` compiled out, and the required BLAS + CUDA/load-dynamic features. **The current `native/speakrs-cli/Cargo.toml` fallback target is CPU-only** (`default-linalg` without `cuda`/`load-dynamic`) — it must not be used as-is for the product build. Add an explicit Linux target section and narrow the fallback so it no longer matches Linux:

   ```toml
   [target.'cfg(target_os = "linux")'.dependencies]
   speakrs = { version = "=0.5.0", default-features = false, features = ["default-linalg", "cuda", "load-dynamic"] }

   [target.'cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))'.dependencies]
   speakrs = { version = "=0.5.0", default-features = false, features = ["default-linalg"] }
   ```

   (Cargo unions features across matching `cfg` targets, so leaving the old fallback broad would still compile — but the explicit split keeps intent readable and CI-CPU builds must select CPU features explicitly, not by accident.)
2. Add a `linux-x64` entry to `native/speakrs-cli/ort-compile-pins.json`. Because Linux uses `load-dynamic` (like Windows), no ORT binary is downloaded at compile time — the entry is `null` with a comment pointing at the setup-time archive pin in `src/ai-addon/speakrs-pack-spec.js`, mirroring the existing `win32-x64: null` entry.
3. Stage the binary through `build/prepare-resources.js`, include it in package resources, and make missing/tampered packaged binaries fail closed with reinstall copy.
4. Add `linux-x64` model-pack metadata. Reuse source model files only after the pack builder proves the Linux CUDA list and legal bundle; publish a Linux-named archive with immutable URL, size, and SHA-256.
5. Define the Linux ONNX Runtime/CUDA shared-library closure from `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` (see **Verified upstream artifacts** — including the cuDNN 9 / zlib / `LD_LIBRARY_PATH` caveats). Pin every extracted `.so` by name, size, and SHA-256. Never trust hashes from `install.json`.
6. Full-hash setup and validation. At compute admission, full-hash changed path/size/mtime fingerprints as on Windows.
7. Extend `buildSpeakrsSpawnEnv` with contained Linux paths and `LD_LIBRARY_PATH`/ORT configuration without leaking host PATH precedence.
8. Keep progress phases, sidecar schema, guided windows, and fallback-to-normal-transcript behavior unchanged.
9. Preserve the 30-minute diarization wall clock and process-group kill of the CLI grandchild.

Do not claim a Linux accuracy or speed win before same-audio evidence. Keep the known split-identity/over-clustering risk documented and keep Pyannote selectable.

### Pyannote on Linux

Product policy for the later Linux version: **x86_64 NVIDIA CUDA only; no CPU fallback**.

Implementation requirements:

1. Add a pinned `linux-x64` managed dependency artifact for pyannote/PyTorch CUDA.
2. Keep the user's own Hugging Face token in Electron `safeStorage`; never persist plaintext.
3. Token preflight per **Locked decision 9**: the `password-store` switch must already be appended at startup, and the preflight requires **both** `safeStorage.isEncryptionAvailable()` **and** `getSelectedStorageBackend() !== 'basic_text'`. Missing secret storage produces `needsAccount`/unsupported guidance, never basic-text token persistence.
4. Continue passing validation tokens over stdin and clear all Hugging Face token environment variables, with `HF_TOKEN_PATH` set to `os.devNull`, never `""`.
5. Keep pyannote model loading offline/local-only after setup.
6. Preserve the exclusive-engine rules:
   - new/unset users default Speakrs
   - legacy Pyannote installs stay Pyannote
   - switching removes the other engine's models/dependencies
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

**Deferred.** The current Qwen3.5 GGUF remains catalog-owned and llama.cpp remains the runtime. Linux must not silently use a system `llama-cli`. Do not add a Core Beta CPU-only Linux summary path.

Initial runtime policy (later version):

- Add a pinned Linux x64 **CPU** llama.cpp runtime as the compatibility baseline: `llama-b9173-bin-ubuntu-x64.tar.gz` (verified — same build tag as the Windows/macOS pins; see **Verified upstream artifacts**).
- Treat Vulkan as a measured optimization, not a presence check. The first Omarchy host has Vulkan but incomplete Haswell support. The candidate asset is `llama-b9173-bin-ubuntu-vulkan-x64.tar.gz` (verified to exist) — pin it only after real inference evidence.
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

Acceptance requires a 60-minute transcript to generate a Balanced summary within the existing wall clock on the documented baseline hardware. This acceptance bar is for the later Linux version only; Core Beta must not add a Linux summary catalog path "to try CPU first."

## Implementation phases

Phases 0–5 are the first Linux version. Phases 6–9 are a later version and must not be scheduled until an Omarchy host with NVIDIA CUDA exists.

Each in-scope phase should land as a reviewable PR with the smallest relevant tests first. Run `npm run test:all` for recorder, persistence, packaging, security, or cross-process changes and before every Linux PR is opened.

### Phase 0 — Baseline and contract characterization

**Status (2026-08-23):** Implemented on `release/linux`. Gate A diagnosable assertion landed. Linux platform-selection tests cover recorder module, Python layout, add-on availability, updater fail-closed matching, and Speakrs packaging. GPU Settings and permission copy no longer treat Linux as Windows. Manual checklists have explicit Linux-not-ready rows. Add-on catalog paths stay `unsupported`.

Deliverables:

- record the Gate A resolution: link the green run ([32613244438](https://github.com/AmirArshad/meeting-transcriber/actions/runs/32613244438)) in the PR, and land the diagnosable-assertion fix from Gate A (exact snippet above) in `tests/js/speakrs-task2-hardening.test.js`
- document Gate B closure and the macOS bundle-signing root cause before enabling Linux release artifacts
- add Linux cases to platform-selection tests before implementation
- characterize recorder argv selection, Python runtime resolution, device ID serialization, add-on availability, updater asset selection, and packaged path rules
- add Linux rows to the manual recording and local-AI checklists

Exit criteria:

- current Windows/macOS suites remain green
- `npm test` passes on the Omarchy development host
- unknown/non-macOS platforms no longer silently enter Windows code
- no Linux feature is advertised as ready
- diarization and summary catalog status on Linux is `unsupported` (visual grey-out and Linux-specific copy landed in Phase 4)

### Phase 1 — Omarchy audio spike

Build a disposable backend spike, not product orchestration:

- connect with `pulsectl`
- enumerate sources, sinks, defaults, and monitor mapping
- capture selected mic and monitor concurrently with SoundCard
- write short float32 WAVs
- validate mic-only, desktop-only, and mixed output
- switch the default sink during capture and record actual failure behavior
- measure callback/block cadence, drift, CPU, and channel/sample-rate shapes

The spike must not be merged as `linux_recorder.py`. Keep `scripts/linux-audio-spike.py` disposable.

Exit criteria:

- browser speech survives mono transcription downmix
- no screen-sharing portal appears
- Bluetooth/headphone and HDMI monitor selection is understood
- late desktop loss can be detected and degraded to mic-only
- evidence is added to this document or a linked Linux benchmark note

#### Phase 1 evidence — 2026-08-23 cloud dummy Pulse (partial)

Ran `scripts/linux-audio-spike.py` against PulseAudio 16.1 on a headless cloud VM (`module-sine-source` mic + `module-null-sink` desktop, SoundCard 0.4.6, pulsectl 24.12.0). This validates the **API surface**, not Omarchy hardware.

Proven on dummy Pulse:

- pulsectl connected and enumerated sources, sinks, defaults, and sink `.monitor` mapping
- SoundCard captured `pulse-source:avanevis_mic` and `pulse-monitor:avanevis_desktop.monitor` **concurrently** on two threads
- float32 WAVs written for mic-only, desktop-only, and mixed output (48 kHz request; RMS mic ≈ 0.35, desktop ≈ 0.14 after an 880 Hz playback into the null sink)
- default-sink switch `avanevis_desktop` → `avanevis_alt` succeeded in < 1 ms; Linux v1 will not hot-switch the live desktop stream
- desktop monitor block cadence median ≈ 21.4 ms (1024 frames @ 48 kHz); dummy sine source is not wall-clock paced (median block ≈ 3 µs after a ~2 s first-block wait)
- process CPU ≈ 5% over a ~3.9 s wall capture

#### Phase 1 evidence — 2026-08-24 Omarchy 4 / Hyprland / PipeWire (closes hardware exit criteria)

Ran `scripts/linux-audio-spike.py --omarchy --seconds 4` on host `amiromarchy` (Omarchy 4.0.0, Hyprland/Wayland, PipeWire 1.6.8 via `pipewire-pulse`, Python 3.11.16 venv, SoundCard 0.4.6, pulsectl 24.12.0). Hardware: Haswell-ULT MacBook-class machine — analog duplex on `alsa_card.pci-0000_00_1b.0` (Cirrus Logic CS4208) plus HDMI card `alsa_card.pci-0000_00_03.0` with no display attached. Full JSON: `/tmp/avanevis-linux-spike/spike-report.json` (not in git; host device names only).

Proven on this host:

- pulsectl enumerated opaque Pulse names. Selected `pulse-source:alsa_input.pci-0000_00_1b.0.analog-stereo` and `pulse-monitor:alsa_output.pci-0000_00_1b.0.analog-stereo.monitor`.
- SoundCard captured mic + analog-sink monitor **concurrently** (188 blocks, median ~21.3 ms = 1024 frames @ 48 kHz). Desktop tone RMS ≈ 0.141; mic RMS ≈ 0.024. Process CPU ≈ 20% over ~4.1 s wall. Stereo was channel-identical (correlation 1.0); mean-mono downmix kept the same RMS.
- **Browser speech:** Chromium (`--ozone-platform=wayland`) autoplayed a 4 s Open Speech Repository clip into the default analog sink. Monitor capture RMS ≈ 0.019, L/R identical. `ffmpeg -ac 1 -ar 16000` (the transcription downmix shape) kept mean_volume **-34.3 dB** on both stereo and mono — speech energy is not cancelled or dropped. Not one-sided; the macOS stereo-repair gate would not fire.
- **No ScreenCast portal:** `dbus-monitor --session` during concurrent capture + Chromium playback saw **zero** `org.freedesktop.portal.ScreenCast` / `impl.portal.ScreenCast` markers (~70 KB of unrelated session traffic). Desktop capture is Pulse monitor only.
- **HDMI:** Card profile `output:hdmi-stereo` is `available: no` with no cable, but `card_profile_set` still created `alsa_output.pci-0000_00_03.0.hdmi-stereo`. HDMI desktop capture is a **different** Pulse sink + `.monitor`, selected by opaque id. Do not assume unavailable ports stay absent. Profile restored to `off`. **Correction (2026-08-28 pre-merge review):** the product filter implementing this (`is_pulse_port_unavailable`) was a no-op against real `pulsectl` until the review — see [Pre-merge review remediation](#pre-merge-review-remediation-2026-08-28). Unplugged endpoints are omitted as of that fix; the behaviour has not been re-verified on Omarchy hardware.
- **Headphones:** Port `analog-output-headphones` exists on the analog card and is `available: no` (jack unplugged). Plugging headphones retargets the **same** analog-stereo sink; the monitor Pulse name does not change. No extra `pulse-monitor:` id.
- **Bluetooth:** Adapter present (`hci0`), soft-blocked. Temporary unblock produced no BlueZ card or A2DP sink (no paired device). A connected headset would appear as its own Pulse sink + `.monitor`, same selection model as HDMI. rfkill restored to blocked.
- **Default-sink switch:** Creating `module-null-sink` `avanevis_spike_alt` and `sink_default_set` **does** change the server default (confirmed in a follow-up with a 150 ms settle). Linux v1 still must not hot-switch the live desktop stream; keep recording the originally selected monitor.
- **Late desktop loss:** Unloaded the null sink while SoundCard was recording `avanevis_spike_alt.monitor`. The Pulse source disappeared (`source_still_listed_after_unload: false`). SoundCard **did not hang and did not raise** — it kept returning ~21 ms blocks of **silence** (post-unload RMS 0). Product recorder must detect a vanished monitor via pulsectl (or equivalent), warn, and continue mic-only. Do not wait for a SoundCard exception.

Host restored afterward: analog duplex profile, HDMI `off`, default analog sink/source, Bluetooth soft-blocked, no leftover null sink.

Phase 3 implications (do not implement here):

- Device IDs stay `pulse-source:` / `pulse-monitor:` / `pulse-sink:` / `none`.
- Desktop thread watches whether the selected monitor remains in `source_list()`; silence alone is not a loss signal (meetings go quiet).
- HDMI/BT are additional sinks; headphones are not. Product enumerate omits a sink/monitor whose active Pulse port is `available=no`.
- No ScreenCast portal, no `xdg-desktop-portal-hyprland` audio path.

Do not advertise Linux recording as ready until Phase 3 ships.

### Phase 2 — Linux runtime and device plumbing

Files:

- add `requirements-linux.txt` (pin `pulsectl==24.12.0`, `SoundCard==0.4.6`, plus the shared numpy/scipy set) and `requirements-linux-build.txt`
- update requirement-sync/closure checks
- update `build/download-manifest.js` with the verified Linux Python/ffmpeg pins (see **Verified upstream artifacts**; compute SHA-256 at pin time per rule 4)
- extend `build/prepare-resources.js` and `src/main/python-runtime.js`
- add Linux device handling in `backend/device_manager.py` and `src/main/device-ipc.js`
- update renderer device-ID helpers/tests, removing the `parseInt`/`Number.isInteger` coercions named in Locked decision 3

Exit criteria:

- dev and prepared packaged runtime enumerate the same devices
- opaque Pulse IDs round-trip without coercion
- missing Pulse server and missing selected devices return concise errors
- prepared Python runs backend modules without system Python or repo-only imports

**Status (2026-08-24, Omarchy host):** Exit criteria met. `npm run prepare-build` staged python-build-standalone 3.11.7 and ffmpeg n8.0.1. Dev `.venv` 3.11.16 and packaged `build/resources/python/bin/python3` returned identical JSON:

- `pulse-source:alsa_input.pci-0000_00_1b.0.analog-stereo`
- `pulse-sink:alsa_output.pci-0000_00_1b.0.analog-stereo`
- `pulse-monitor:alsa_output.pci-0000_00_1b.0.analog-stereo.monitor` (also `defaults.default_output`)

Packaged imports of `pulsectl` / `SoundCard` / `numpy` / `soxr` resolved under `build/resources/python/lib/python3.11/site-packages` with `PATH=/usr/bin:/bin` (no venv). Missing Pulse (`PULSE_SERVER=unix:/tmp/avanevis-no-pulse`) exits 1 with `ERROR: PulseAudio/PipeWire is not running. Start the session audio service and try again.` — no socket path. Missing device: `Microphone device ID pulse-source:does-not-exist was not found`. Speakrs CLI staging is skipped on Linux (Phase 7).

#### Phase 0–2 adversarial review — 2026-08-24

Static review on Ubuntu (Omarchy hardware not required for these contracts) plus the Omarchy evidence already recorded above. Product recording stayed fail-closed. Remediations landed before Phase 3:

- Packaged `buildPythonEnv()` no longer inherits ambient `PYTHONPATH` / `PYTHONHOME` / `PYTHONUSERBASE` and sets `PYTHONNOUSERSITE=1`. Caller-managed extras may still prepend the bundled backend path.
- Linux enumerate keys devices by opaque Pulse name, so two mics that share a description both appear.
- Sinks and monitors whose active Pulse port is explicitly `available=no` (forced HDMI on an unplugged port) are omitted; unknown jack-detect stays listed.
- `get-audio-devices` and `warm-up-audio-system` share the 10 s device-manager timeout and kill the child.
- Spike `--omarchy` restores owned sink/profile/rfkill state (exit 1 on restore failure), records ScreenCast with interface match rules into a mode-0600 log that is deleted after scoring, and SIGKILLs owned Chromium/D-Bus process groups.

Do not advertise Linux recording as ready until Phase 3 ships.

### Phase 3 — Production Linux recorder

Files:

- add `backend/audio/linux_recorder.py`
- add the Linux factory branch in `backend/audio/__init__.py`
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

- live 15-minute Omarchy capture passes (60-minute soak **cancelled** by operator 2026-08-27 — not evidence it would pass)
- recording while CPU transcription runs has no obvious glitches
- browser speech reaches the transcript, not only meters/saved channels
- no whole-session capture array grows with duration

**Status (2026-08-25, Ubuntu VPS — not Omarchy):** `backend/audio/linux_recorder.py` is wired through the factory, `getRecorderModule('linux')`, and recording preflight. Automated cases for mic+desktop, mic-only, desktop startup/late loss, mic failure, Stop success, recoverable finalization failure, cancel tombstone, force-kill recovery, stop/cancel timeout, and stdout chunk parsing are in the suite. Dummy-Pulse smoke on this VPS is API evidence only.

#### Phase 3 evidence — 2026-08-27 Omarchy 4.0.1 / Hyprland / PipeWire 1.6.8 (closed)

Host `amiromarchy`, branch `release/linux` (morning CLI rows @ `b6adf0a`; afternoon Electron/headphone @ `2eb90ca`). Product recorder is `backend/audio/linux_recorder.py` via `.venv` 3.11.16 (SoundCard 0.4.6, pulsectl 24.12.0). Same Pulse ids as Phase 2: `pulse-source:alsa_input.pci-0000_00_1b.0.analog-stereo` and `pulse-monitor:alsa_output.pci-0000_00_1b.0.analog-stereo.monitor`. Artifacts under `/tmp/avanevis-linux-smoke/` (morning CLI) and `/home/amir/avanevis-linux-smoke/` (afternoon headphone + Electron; not in git). `/tmp` is 3.9 GB tmpfs — do not put a 60-minute spool there.

Proven on this host with the **product** recorder (not the spike):

- **Mic + desktop Stop:** 9.82 s stereo Opus 48 kHz; stdout stop stages `post_processing_started` → `audio_normalizing` → `audio_mixing` → `audio_encoding` → `post_processing_complete`; desktop levels nonzero; L/R RMS matched (−23.9 dB). No leftover `.capture`. No ScreenCast D-Bus markers.
- **Discard:** stdin `cancel` after 3 s → `{ success: true, cancelled: true }`; no opus; capture dir removed (`Recording cancelled; capture discarded.`).
- **Desktop startup failure:** `pulse-monitor:does-not-exist` → `DESKTOP_START_FAILED`, `desktopStatus: unavailable`, mic-only opus 3.38 s.
- **Late desktop loss:** recorded `pulse-monitor:avanevis_smoke_desk.monitor`, unloaded the null sink at ~5 s. `DESKTOP_MONITOR_VANISHED` help text says earlier desktop audio is kept; stderr `keeping 240640 committed desktop frames` (5.01 s @ 48 kHz). Desktop level 0.088 → 0.0 after vanish. Final 9.66 s mix mean −11.5 dB (tone kept, not discarded). Analog default sink restored.
- **Browser speech in the transcript:** Chromium (`--ozone-platform=wayland`) autoplayed Open Speech Repository `OSR_us_000_0010_8k.wav` into the analog sink. Product mix 12.10 s, stereo and ffmpeg `-ac 1 -ar 16000` downmix both mean −30.4 dB. `faster-whisper` `tiny.en` on **CPU** (`device: cpu`, `int8`) transcribed *The birch canoe slid on the smooth planks. Glue the sheet to the dark blue background.*
- **15-minute soak (pass):** 08:55–09:11 +01, 901.8 s stereo Opus (12 MB, mean −42.0 dB). Stdout stop stages complete; no leftover `.capture`. Steady VmRSS **49.6 MB → 52.3 MB** while `{stem}.capture/` grew to **688 MB** on disk (linear ~45 MB/min). Fourteen 880 Hz desktop beeps landed at ~60 s spacing (first onset 59.4 s). Not a duration-growing capture array.
- **Capture during CPU transcription (CLI):** 62.00 s mix while `tiny.en` looped on CPU (whisper pcpu peaked 144%). Desktop level stayed 0.088 after preroll (1 zeroish sample at start). Recorder RSS 14→56 MB. No warnings.
- **PipeWire restart mid-capture:** `systemctl --user restart pipewire pipewire-pulse wireplumber` at t≈4 s. Pulse was back within 0.5 s and the analog source/monitor names were unchanged. SoundCard streams went `FAILED`. Watchdog did **not** emit `DESKTOP_MONITOR_VANISHED` (not a false vanish). Desktop path warned `DESKTOP_RECORDING_FAILED` and kept 160768 frames (~3.35 s). Mic path is fatal per contract → `RECORDING_THREAD_FAILED`, `success: false`, duration 0, no opus; leftover capture left `state: finalizing` with both tracks committed. Matches the parked cross-platform “mic-thread failure skips finalization” finding — do not treat as a Linux-only vanish bug. Reconnect-after-FAILED is not a Core Beta requirement.
- **Headphone unplug/replug (pass):** physical analog jack on the CS4208 card. Pulse retargeted the **same** `alsa_output.pci-0000_00_1b.0.analog-stereo` sink (`Active Port` speakers → headphones → speakers → headphones). Monitor id never changed. No `DESKTOP_MONITOR_VANISHED`. 45.36 s mix, mean −30.6 dB, stop stages complete, no leftover `.capture`. Goertzel markers in the mix: **440 Hz at t≈1.5 s** (played before unplug) power 93.8; 880 Hz at t≈32.5 s (during unplug, speakers) power 115; 1320 Hz at t≈40.5 s (after replug) power 93.5. Pre-unplug desktop audio is in the saved file.
- **Electron record-during-CPU-transcription (pass):** `npm start` on this host (userData `~/.config/avanevis`). First-run FTUE downloaded `small` to CPU/`int8` in ~26 s. Cache already had a 67 MB incomplete `model.bin` blob from the morning abort (`…671.160804a2.incomplete`, still 67 MB afterward); huggingface wrote a sibling complete blob of the same hash (484 MB) rather than growing that incomplete in place. Stop meeting 1 (2:06) unlocked Start with pill `Ready · 1 transcribing` while Activity showed TRANSCRIBING. Meeting 2 started at 17:25:01 with `faster_whisper_transcriber --model small --device auto` at **123% pcpu / 763 MB RSS** and `linux_recorder` at **33% pcpu / 56 MB RSS**. Overlap snapshot: Meeting 1 TRANSCRIBING + Meeting 2 Recording. After Stop meeting 2 (39 s): pill `Ready · 2 transcribing`, Activity Meeting 1 TRANSCRIBING / Meeting 2 QUEUED. Meeting 1 metadata `transcriptionDevice: cpu`, `transcriptionComputeType: int8`. Meeting 2 mix still has 880 Hz desktop beeps at t≈4 / 19 / 28 s (no obvious capture dropout under CPU Whisper). First-run mic/desktop dropdowns were empty until selected — not a recorder defect.
- **Electron Discard vs History (pass):** History had 2 meetings (`20260827_172451`, `20260827_172555`). Started meeting 3, confirmed Cancel, Discard. Main log: `Recording cancelled; capture discarded.` UI returned to `Ready · 1 transcribing` with **historyCount still 2** (same ids). Recordings dir gained no third opus/md; no leftover `.capture`.
- **60-minute soak (cancelled, 2026-08-27):** operator waived the hour-long run. Not executed; do not treat the 15-minute RSS/spool row as 60-minute evidence. `/tmp` on this host is 3.9 GB tmpfs — a future soak must spool on disk.

**Phase 3 is closed** with that waiver. Phase 4 may start. Do not treat `scripts/linux-audio-spike.py` as the product recorder.

#### Phase 3 adversarial review — 2026-08-25 (done)

Static review on the Ubuntu VPS of everything since `ce0a550`, scoped to `linux_recorder.py`, the `linux-v1` profile helpers, capture recovery, and the Electron wiring. No RAM mix, no capture array that grows with duration, no structured control on stderr, exact-token stdin, cancel tombstone, opaque IDs never `parseInt`ed, and `windows-v1` / `macos-v1` behavior all held up. Four defects found and remediated in this branch, each with a regression test that fails against the pre-fix recorder:

- **Late desktop loss discarded every already-committed desktop frame.** `_close_capture_spools_for_mix` copied the macOS rule (`_desktop_runtime_failure` ⇒ `includeDesktop = false`). On macOS a late loss means the helper crashed; on Linux it is the routine case of the user switching audio output, which removes the old sink's monitor — so a monitor vanishing at minute 59 threw away 59 minutes of system audio. The track is now excluded only on a *spool* failure; a capture-side loss keeps the committed frames truncated at the last real frame (`pad_to=None`, mixer zero-fills the rest), and the warning copy no longer claims a mic-only save.
- **Blocking-read capture threads could turn a good recording into `RECORDING_THREAD_FAILED`.** Unlike the macOS callback model, the Linux threads block inside `recorder.record()`; `stop_recording` joins for 2 s and then closes and commits the spools. A thread waking after that appended to a closed spool, which reads as `False` — the mic path mis-reported it as a writer stall and set `_error_event`, which `stop_recording` consults *after* the close, so finalization was skipped and the meeting was lost to a spurious error (recoverable only on next launch). The desktop path emitted a phantom `DESKTOP_SPOOL_FAILED` warning, including during Discard. Both loops now re-check `_get_running()` after `record()` returns and after a `False` append, and read the spool reference once.
- **The vanished-monitor watchdog opened a new `pulsectl.Pulse` connection every 500 ms**, inline in the desktop capture read loop — roughly 7,200 connect/handshake/teardown cycles per hour, each one stalling capture. The tests injected a single shared fake, so the suite could not see it. The watch now holds one long-lived client, rebuilt only after a failure and closed on stop/cancel/abort; probe exceptions still fail open (never treated as a vanish).
- **SoundCard's fallback lookup could silently bind the wrong device.** `sc.get_microphone()` matches by substring, so an exact-match miss could open a different microphone or monitor with no warning. Resolution is now exact-`id`/`name` only; a mismatch raises (mic → honest start failure, desktop → warning + mic-only).

Also fixed: the desktop level meter stayed frozen at its last value after the monitor vanished, so the UI implied desktop audio was still flowing.

Residual hardware smoke this review cannot substitute for was run 2026-08-27 except the 60-minute soak, which the operator **cancelled** (not passed). Electron record-during-CPU-transcription and headphone unplug/replug passed. PipeWire restart: SoundCard streams fail closed (mic fatal); the watchdog did not false-vanish.

### Phase 4 — Electron behavior, queue, and core transcription

Files:

- explicit Linux branches in recording presence, tray, notifications, close dialogs, and permission/preflight copy (see Locked decision 10 for the tray/SNI rules)
- **Linux secret-storage bootstrap in `src/main.js`** per Locked decision 9 (the `password-store` switch, appended before `app.whenReady()`), plus a `getSelectedStorageBackend()` probe exposed for later preflights
- **Wayland/ozone decision spike** per Locked decision 10: run the app under XWayland and under `--ozone-platform-hint=auto` on the Omarchy host, record findings in this document, and ship the chosen default
- Linux faster-whisper **CPU** runtime/cache paths
- Linux CUDA probe that reports unavailable/incompatible and stays on CPU — do not ship managed CUDA install or an Install GPU control
- updater platform handling without enabling release assets prematurely
- renderer platform gating for GPU and add-ons, including the three "not-mac means Windows" copy sites named in Locked decision 1
- **Add-on grey-out per Locked decision 12:** Linux reason strings in `src/ai-addon-state.js`; disabled controls and muted card chrome in `src/renderer/app.js` / `src/renderer/index.html` / `src/renderer/styles.css`; helper coverage in `src/renderer/history-detail-helpers.js` / `src/renderer/ai-addon-ui-helpers.js` and matching `tests/js/` tests; Linux rows in `tests/manual/local-ai-addons-checklist.md`

Behavior:

- tray uses native SNI, drives all interaction through `setContextMenu`, and degrades without crashing when no SNI host exists
- native notifications use Electron/desktop portals and remain best-effort
- Close/quit during recording preserves current stop/persist semantics
- background transcription queue continues while a new recording starts
- Whisper preload enters between compute jobs
- speaker identification and summary cards remain visible, greyed out, with the decision-12 copy; Set Up / Install Model / Validate / Remove / Switch / token fields / Generate Summary cannot start
- Home AI add-on CTA does not offer setup
- queue serialization for summary/diarization is unchanged on Windows/macOS; Linux must not enqueue those jobs

Exit criteria:

- Activity auto-resume, cancel pending, retry, rename, delete, History, transcript save, and playback work unchanged
- CPU transcription is the supported Linux path
- a machine with no NVIDIA GPU stays on CPU with copy that does not advertise Linux CUDA as ready
- quitting leaves no Python/ffmpeg process group alive
- `safeStorage.getSelectedStorageBackend()` reports a real backend (not `basic_text`) on the Omarchy host
- Settings/Home/History add-on controls are visibly disabled on Linux and show the future-version copy; IPC setup/generate still fail closed

### Phase 4 Omarchy evidence (2026-08-27)

Host: `amiromarchy`, Omarchy 4, Hyprland (`XDG_CURRENT_DESKTOP=Hyprland`, `WAYLAND_DISPLAY=wayland-1`), laptop panel `eDP-1` scale **1.6**. `org.freedesktop.secrets` is running. The session SNI host is **quickshell** (`org.kde.StatusNotifierWatcher`); Waybar was not running this session.

Switches live in `src/main-process/linux-electron-bootstrap.js` and are applied from `src/main.js` **before** `app.requestSingleInstanceLock()` so Chromium does not already bind XWayland / `basic_text`.

**Secret storage (Locked decision 9).** Live `whenReady()` log: `Linux secret storage backend: gnome_libsecret` — not `basic_text`. Hyprland is still not on Chromium's desktop list; the explicit `password-store=gnome-libsecret` switch is what selected the real backend. `getSelectedStorageBackend()` / `probeSecretStorage()` are exported for the later Phase 7 token preflight. Packaged-AppImage `dlopen(libsecret)` was proven in Phase 5 (2026-08-28): generic encrypt/decrypt round-trip, backend `gnome_libsecret`, not `basic_text`.

**Ozone (Locked decision 10).** Three launches of `node_modules/electron/dist/electron .` with Omarchy's ambient `ELECTRON_OZONE_PLATFORM_HINT=wayland` **unset**, so the measurement is the app switch:

| Launch | `whenReady()` log | Hyprland `xwayland` | window size |
|---|---|---|---|
| `--ozone-platform=x11` | `ozone-platform: x11 hint: auto` | `True` | `[781, 952]` |
| app default (hint auto only) | `ozone-platform: wayland hint: auto` | `False` | `[781, 952]` |
| `--ozone-platform=wayland` | `ozone-platform: wayland hint: auto` | `False` | `[781, 952]` |

**Shipped Linux default: `--ozone-platform-hint=auto`.** Native Wayland binds on this host without forcing `--ozone-platform=wayland` (keep X11 Ubuntu working). Audio capture is Pulse/PipeWire either way — no ScreenCast portal; do not reopen Phase 3. Side-by-side sharpness screenshots were not taken; native vs XWayland is distinguished by Hyprland's `xwayland` flag. Window size matched across the three launches on the 1.6-scale panel.

**Tray (Locked decision 10).** Linux registers no tray `click` handler; interaction is `setContextMenu` only. `new Tray()` is try/catch so a missing SNI host does not crash the app. Live with quickshell as watcher: `RegisteredStatusNotifierItems` = `[':1.198/StatusNotifierItem']`; no `Failed to create system tray` in the main log. Recording close dialog uses **Keep Recording in Tray** and `keepRecordingAction: 'hide'`. Killing the SNI host for a live invisible-tray pass was not done this session (would disrupt the desktop); the constructor-throw path is unit-tested in `tests/js/recording-presence-service.test.js`.

> **Correction (2026-08-28 pre-merge review):** this row proved the SNI *item registered*, not that an icon was *visible*. It was not. Linux resolved the idle tray image to Windows `build/icon.ico`, and `nativeImage.createFromPath` returns an **empty** image for `.ico` outside Windows (verified on Electron 42: `isEmpty: true`, size `0x0`). `new Tray(emptyImage)` still succeeds on Linux, so `hasTray()` was `true`, the close dialog offered "Keep Recording in Tray", and the window hid to a blank tray entry. Fixed by dedicated PNGs — see [Pre-merge review remediation](#pre-merge-review-remediation-2026-08-28). Visual confirmation on an Omarchy panel is still outstanding.

**Phase 4 adversarial review remediation (2026-08-27).** A failed tray constructor now leaves `hasTray() === false`; close-during-recording switches to **Keep Recording Minimized** / `keepRecordingAction: 'minimize'` so the taskbar indicator remains visible. Linux CUDA status no longer advertises Windows profiles, packages, Python, or an install recommendation, and ensure/install/uninstall reject before GPU queue admission. Add-on controls and the Home CTA start disabled until authoritative status arrives, action handlers repeat the fail-closed gate, unsupported footprints say `Runtime: disabled`, and Home status refresh reapplies History Generate Summary availability. `generate-summary` rejects an unsupported platform before spawning the meeting-manager preflight. Focused regressions cover each path; Windows/macOS behavior remains pinned by the cross-platform suites.

**CUDA / CPU Whisper.** `buildTranscriptionCliArgs` on Linux always passes `--device cpu`. `check-cuda` reports `unsupportedPlatform` without Windows install metadata or a Python probe; `install-gpu` / `ensure-compatible-gpu-runtime` / `uninstall-gpu` reject before runtime queue admission. Copy says CUDA is not available on Linux in this version and transcription uses CPU faster-whisper. GPU Settings hides Install GPU on non-win32 (Phase 0).

**Add-on grey-out (Locked decision 12).** Exact reason strings live in `src/ai-addon-state.js`. Settings cards `#diarization-addon-card` / `#summary-addon-card` take `.ai-addon-card.is-unsupported`; all setup controls begin disabled and remain gated by status; token and speaker-count fields are not offered when unsupported; History Generate Summary stays disabled with that copy; `generate-summary` rejects unsupported before any Python preflight. Locked decision 1 copy sites were already extracted in Phase 0 (`inferRendererHostFamily` / `getRecordingPermissionFailureGuidance` / `getUnsupportedGpuSettingsCopy`).

**Phase 4 product code and adversarial review are closed.** Phase 5 packaging and packaged UI/recording evidence closed 2026-08-28; Omarchy Core Beta is complete. Gate B is closed; Ubuntu desktop smoke remains open. The Core Beta CUDA/add-on grey-out behavior remains correct until the v2.9 CachyOS RTX 4070 lane accepts each replacement path.

### Phase 5 — Omarchy Core Beta packaging

**Status (2026-08-28):** Packaging implementation, Ubuntu CI, updater matching, Omarchy/Ubuntu package smokes, packaged Settings/legal-notices UI clicks, and a packaged AppImage recording + CPU transcription session landed on `release/linux`. Stay on **electron-builder `^26.15.3`**; do **not** upgrade to v27 in this phase (ESM, Node 22.12, toolset-default changes, `--no-sandbox` / desktop Exec / DMG APFS). Opt in to the reviewed static AppImage toolset with `"toolsets": { "appimage": "1.0.2" }` — never the legacy FUSE2 runtime (`0.0.0`). The live build fetched `appimage-tools-runtime-20251108.tar.gz` (static type2-runtime), not `appimage-12.0.1.7z`. The static runtime is a static-pie ELF and does **not** need host `fuse2` / `libfuse.so.2`; it still uses the kernel FUSE device (`/dev/fuse`) plus userspace `fuse3` (`fusermount3`) via bundled squashfuse. Do **not** treat `--appimage-extract-and-run` as proof of the shipped default.

Arch **build-host** only: electron-builder's bundled fpm needs `libcrypt.so.1` (`libxcrypt-compat` on Omarchy). That is not a pacman runtime depend.

Files:

- Linux targets and resources in `package.json` (AppImage + pacman + experimental deb; `artifactName` producing `AvaNevis-Setup-*` per Locked decision 11)
- the **electron-builder decision** from Locked decision 8: opt into the static AppImage toolset on 26.x (`1.0.2`), not a v27 upgrade
- pacman packaging metadata/dependencies (no libappindicator; `.PKGINFO` validated on Omarchy)
- Linux artifact naming in `src/updater.js` (tightened `findInstallerAsset`)
- Linux build/smoke job in `.github/workflows/ci.yml` (ubuntu runner — AppImages cannot be cross-compiled)
- Linux release job in `.github/workflows/build-release.yml` — **added after Gate B closed 2026-08-28**; publishes both AppImage and pacman artifacts
- build/installer docs and troubleshooting — first-version claims match Gate C (CPU transcription; add-ons greyed unsupported)

Exit criteria:

- clean Omarchy install, upgrade, uninstall — **passed 2026-08-28** (`sudo pacman -U dist/AvaNevis-Setup-2.7.0.pkg.tar.zst`, same-version reinstall, `sudo pacman -R avanevis` without `-s`; gtk3 and libsecret remained)
- AppImage launches without FUSE2 on Omarchy — **passed** (see evidence; not extract-and-run)
- AppImage launches without FUSE2 on Ubuntu 24.04 — **container only** (2026-08-28 `ubuntu:24.04` with fuse3 + `/dev/fuse`, no fuse2). Ubuntu **desktop** recording/safeStorage smoke is still open.
- packaged app uses bundled Python, ffmpeg, and backend — **no** Linux `speakrs-cli`, llama.cpp, or ORT — **passed** (verifier + installed layout; no `resources/bin`)
- `AVANEVIS_PACKAGED=1` blocks PATH helper substitution — **passed** (`scripts/verify-linux-packaging.js` isolation)
- **packaged-AppImage `safeStorage` encrypt/decrypt round-trip** on Omarchy — **passed** (`gnome_libsecret`, `roundTrip: true`, not `basic_text`; no HF token)
- legal notices open — **passed 2026-08-28:** Settings **Open third-party notices** in the packaged AppImage invoked `xdg-open /tmp/.mount_AvaNev…/resources/legal/THIRD_PARTY_NOTICES.md` (AppImage mount, not the repo file) and nvim opened that bundled file.
- packaged UI still greys out speaker identification and summaries; no setup button can complete — **passed 2026-08-28:** packaged Settings cards `#diarization-addon-card` / `#summary-addon-card` have `.is-unsupported`; badges **Unsupported**; Set Up / Install Model / Validate / Remove / Home Set Up / History **Generate Summary** `disabled`; Home add-on prompt `display: none`. Exact decision-12 strings in the card status text. `generate-summary` IPC: `Local summaries are not available on Linux in this version. They will return in a future Linux update.`

**Omarchy Core Beta is complete.** Residual: Ubuntu 24.04 **desktop** AppImage recording smoke (Docker launch only). Gate B is closed and Linux artifacts are in the release workflow.

### Phase 5 Omarchy / Ubuntu evidence (2026-08-28)

Host: `amiromarchy`, Omarchy 4.0.1, Hyprland. `fuse2` / `libfuse.so.2` **not** installed; `fuse3` + `/dev/fuse` are present. Artifacts (gitignored, not committed): `dist/AvaNevis-Setup-2.7.0.AppImage` (~312 MB), `dist/AvaNevis-Setup-2.7.0.pkg.tar.zst` (~284 MB), `dist/linux-unpacked/`.

**Verifier.** `node scripts/verify-linux-packaging.js --unpacked --appimage --pacman` passed. `.PKGINFO` depends: `alsa-lib`, `at-spi2-core`, `dbus`, `gtk3`, `libnotify`, `libpulse`, `libsecret`, `libxss`, `libxtst`, `nss`, `xdg-utils`. No `libappindicator`, no `ffmpeg`.

**AppImage (Omarchy, default runtime).** `ldd` shows no FUSE libs (static-pie). `AVANEVIS_SAFESTORAGE_SMOKE=1 ./dist/AvaNevis-Setup-2.7.0.AppImage` exit 0. Payload included `pythonExe` / `ffmpegPath` / `backendPath` under `/tmp/.mount_AvaNev…/resources/…`, `transcriberModule: transcription.faster_whisper_transcriber`, `backend: gnome_libsecret`, `isBasicText: false`, `roundTrip: true`, add-ons `supported: false`, `legalNoticesReadable: true`. Ozone: native Wayland (`hint: auto`). `--appimage-extract-and-run` was **not** used.

**Ubuntu 24.04.** No Ubuntu desktop on this host. Evidence is an `ubuntu:24.04` container. `--appimage-help` succeeded with **no** fuse packages and **no** `libfuse.so.2`. A default Electron launch without `/dev/fuse` failed (`fusermount` / `fuse: device not found`) — that is missing kernel FUSE, not a fuse2 requirement. Retry with `--device /dev/fuse`, `fuse3` (not fuse2), and xvfb: AppImage mounted at `/tmp/.mount_AvaNev…`, `app.isPackaged: true`, bundled Python 3.11.7 / ffmpeg n8.0.1 / backend, CPU faster-whisper. Timeout killed the GUI after 25 s (no smoke env). That container also began a Whisper `small` preload against the HF Hub — expected first-launch behavior, not a Linux-only cloud path. This is **not** a Ubuntu desktop recording/safeStorage smoke.

**pacman.** Clean install to `/opt/AvaNevis`; same-version upgrade; `AVANEVIS_SAFESTORAGE_SMOKE=1 /opt/AvaNevis/avanevis` exit 0 with the same fail-closed add-on payload and `gnome_libsecret` round-trip; uninstall without `-s`. Installed tree had no `resources/bin` (no `speakrs-cli`).

**Packaged Settings / legal notices / recording (Omarchy AppImage, 2026-08-28).** Default AppImage launch (not `--appimage-extract-and-run`); host still has no `fuse2` / `libfuse.so.2`. Native Wayland (`ozone-platform: wayland hint: auto`). `app.isPackaged: true`. Bundled Python 3.11.7 / ffmpeg n8.0.1 / backend under `/tmp/.mount_AvaNevOkeFIA/resources/…`. Screenshots of greyed Speaker Identification and Meeting Summaries cards; History Generate Summary disabled. `xdg-open` of bundled `resources/legal/THIRD_PARTY_NOTICES.md`. Meeting `20260828_005135`: 4:55 stereo Opus, Stop stages Normalizing → Mixing → Encoding → saved, then `Ready · 1 transcribing`. Live transcriber: `/tmp/.mount_AvaNev…/resources/python/bin/python3 -m transcription.faster_whisper_transcriber --model small --device cpu` with `AVANEVIS_PACKAGED=1`, `PYTHONPATH` the bundled backend, `PYTHONNOUSERSITE=1`. Metadata `transcriptionDevice: cpu`, `transcriptionComputeType: int8`, `transcriptionStatus: completed`. Transcript includes Harvard-list desktop speech (*The birch canoe slid on the smooth planks*). No `resources/bin` / `speakrs-cli`. Not a 60-minute soak.

**Still open:** Ubuntu 24.04 **desktop** AppImage recording/safeStorage smoke (Docker launch 2026-08-28 is not that row).

Repo documentation (AGENTS.md, README, BACKEND.md, TESTING/BUILD, checklists) describes shipped Linux Core Beta: Pulse/PipeWire recording, CPU faster-whisper, add-ons still greyed `unsupported`. Do not advertise CUDA or add-ons as ready. GitHub Releases include AppImage, pacman, and experimental `.deb` after Gate B closed. Experimental-beta distro coverage is documented in `docs/guides/LINUX_EXPERIMENTAL.md`; it is not hardware evidence.

### Pre-merge review remediation (2026-08-28)

Full-branch review of `release/linux` before merging to `master` and cutting the first Linux release. The automated suite was green throughout — every defect below was invisible to it, and three were actively masked by tests whose fakes did not model the real dependency. Each fix ships with a regression test that fails against the pre-fix code.

**Shipped behaviour did not match this document (2):**

1. **`is_pulse_port_unavailable()` never returned `True` in production.** `pulsectl` hands back a `pulsectl.EnumValue` whose `__slots__` is `('_t','_value','_c_val')` — no `.name`, not an `int` subclass, `repr()` = `<EnumValue available=no>`. Every branch of the probe missed it, so the "omit sinks/monitors whose active port is `available=no`" rule from Phase 1/Phase 2 was dead code and unplugged HDMI endpoints stayed in the desktop dropdown. `tests/python/test_linux_device_manager.py` passed only because `FakePort` used plain strings/ints. Now reads `_value` with an `EnumValue.__eq__` fallback, and is tested against the real `PulsePortAvailableEnum`.
2. **The Linux tray icon was an empty image.** `recording-presence-service.js` resolved the idle icon to `build/icon.ico`, which Electron cannot decode outside Windows. Added `build/iconTrayLinux.png` (64×64 app mark) and `build/iconTrayLinuxRecording.png` (app mark + red REC badge), both generated with ImageMagick from `build/icons/256x256.png` and `build/recording-overlay.png` and staged via `extraResources`. `loadTrayNativeImage` now warns on an undecodable image instead of silently registering nothing.

**Concurrency and data-loss (2):**

3. **Pulse watch-client use-after-free window.** `_close_watch_pulse()` closed outside `_watch_pulse_lock` while `_watch_source_names()` called `source_list()` outside it too. Stop/cancel join capture threads with a 2 s timeout, so a thread stalled in `recorder.record()` (the PipeWire-restart case from Phase 3) could be inside libpulse while the main thread freed the mainloop — a segfault, not a structured failure. Both sides now hold the lock (`RLock`), `final=True` latches the client closed, and the desktop loop re-checks `_get_running()`/`_desktop_give_up` **before** the vanish probe so stop cannot emit `DESKTOP_MONITOR_VANISHED` on the way out.
4. **Capture-thread teardown errors failed complete meetings.** An exception from the SoundCard recorder's `__exit__` during stop set `_error_event`, which `stop_recording` reads *after* closing the spools — skipping `finalize_capture` and emitting `RECORDING_THREAD_FAILED` with `duration: 0` (recoverable only via next-launch capture recovery). Both threads now treat a post-stop exception as stderr-only teardown noise. The desktop path additionally no longer emits a phantom `DESKTOP_RECORDING_FAILED` during Discard.

**Cross-platform regressions introduced by the Linux work (2):**

5. **Generate Summary could stay permanently disabled on Windows/macOS.** The buttons ship `disabled` in `index.html` and are only enabled from `aiAddonStatusSnapshot`; a single failed `getAiAddonStatus()` left them inert. `getSummaryActionControlState` now takes `platformSupportsSummaries` and keeps an *unknown* status clickable on win32/darwin, while an authoritative `unsupported` still wins.
6. **`mac.identity: "-"` would silently override a real Developer ID certificate.** Exactly the Gate B failure class. `npm run build:mac` now runs `scripts/check-mac-signing-identity.js`, which fails the build when the ad-hoc pin coexists with `CSC_LINK` / `CSC_NAME` / `APPLE_TEAM_ID` / etc., with an `AVANEVIS_ALLOW_ADHOC_MAC_SIGNING=1` escape hatch.

**Hardening and polish (5):**

7. **Packaged smoke hook is opt-in.** `AVANEVIS_SAFESTORAGE_SMOKE=1` exits the app; in a packaged build it now also requires `AVANEVIS_ALLOW_SMOKE_HOOKS=1` so a stray environment variable cannot terminate a user's install at startup.
8. **`TrackSpool.append`/`close` ordering.** A chunk enqueued after `close()` returned reported success but was never written. The closed check and the enqueue are now atomic against `close()`.
9. **`_resolve_recoverable_output_path` used `str.replace('.wav', '.opus')`**, which rewrites every occurrence. Replaced with `build_final_opus_path_for_output` (`Path.with_suffix`).
10. **Non-Windows CUDA payload pinned.** `buildUnsupportedPlatformCudaStatus` reshaped the macOS `check-cuda` response (empty `supportedProfiles`, null `recommendedInstallProfile`) and made `install-gpu` / `ensure-compatible-gpu-runtime` / `uninstall-gpu` reject rather than resolve. Both are intended; both are now asserted for darwin as well as linux.
11. **Dropdown copy.** The synthetic Linux desktop-off entry rendered as "None (microphone only) (48000 Hz)"; `populateSelect` now omits the suffix when a device carries no sample rate.

**Reviewed and deliberately not changed:** `get-audio-devices` returns `defaults` (the Linux resolver correctly implements Locked decision 3) but no renderer reads it on any platform, so there is no first-run auto-selection anywhere. Wiring it is a cross-platform behaviour change that wants hardware validation — tracked, not shipped here.

**Still open after this review:** the 60-minute soak (cancelled, not passed), the Ubuntu 24.04 desktop AppImage recording/`safeStorage` smoke, a visual confirmation of the new tray icons on an Omarchy panel, and a live no-SNI-host tray pass (unit-tested only).

### Phases 6–9 — v2.9 Linux AI extension (gated)

**Run these phases only through the v2.9 Linux-AI plan on CachyOS x86_64 + NVIDIA RTX 4070.** Begin with fresh official artifact, license, hash, driver/CUDA, Python, and encrypted-secret-storage investigation. Requirements and historical artifact URLs below are leads, not accepted pins.

**Task 1 evidence (CachyOS RTX 4070, 2026-09-02).** The host is CachyOS
x86_64 / Hyprland / Wayland / PipeWire 1.6.8 with an RTX 4070 (compute 8.9),
NVIDIA 610.57.04, and CUDA UMD 13.3.  The candidate CUDA 12 CTranslate2,
CUBLAS, and cuDNN manylinux wheel closure was downloaded and locally hashed in
the dependency compatibility matrix.  This is sufficient to start the managed
runtime implementation gate, not to advertise CUDA Whisper.  The selected
Electron secret-store backend is `gnome_libsecret`, but encryption is currently
unavailable and an encrypt/decrypt round-trip fails; Pyannote is consequently
unavailable pending Task 6.  ONNX Runtime 1.27.1 Linux CUDA 12 was inspected as
a Speakrs lead, but no packaged/integrity-checked Linux CLI exists yet.  Current
official llama.cpp Linux releases have no CUDA x86_64 artifact, so summaries are
also unavailable.  Full hashes, sizes, and source links are recorded in
`docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`.

### Phase 6 — Linux accelerator/resource foundation (v2.9 gated)

Port the existing managed runtime behavior instead of treating system CUDA as sufficient:

- define Linux faster-whisper CUDA package/runtime pins (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12` manylinux wheels — verified available)
- build a fresh CUDA-major probe for queued-job start (CUDA-12-major `.so` names; a CUDA-13-only host surfaces the mismatch and remains unavailable)
- inject contained shared-library paths into children via `LD_LIBRARY_PATH` (the Linux analogue of the Windows DLL-directory flow)
- serialize install/repair/uninstall with compute and preload through `gpuResourceActionQueue`
- invalidate cached CUDA status after uninstall/failure
- terminate runtime actions cleanly on quit

Exit criteria:

- CUDA 12 profile works on supported NVIDIA hardware without a system CUDA toolkit
- incompatible/newer-only CUDA remains unavailable with clear copy
- install/repair cannot race active compute or loaded libraries
- no Linux shared-library path escapes the managed runtime

### Phase 7 — Speaker identification parity (v2.9 gated)

Order:

1. Linux `speakrs-cli` build/package/integrity — including the `Cargo.toml` Linux target section and the `ort-compile-pins.json` `linux-x64: null` entry (exact snippets in **Speakrs on Linux**)
2. Linux model and ORT/CUDA pack pins (`onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` closure; cuDNN 9 + zlib + `LD_LIBRARY_PATH` caveats)
3. Speakrs setup validation and guided smoke
4. Investigate Pyannote Linux dependency pins and the two-part secure-token preflight from Locked decision 9; accept Pyannote only if both pass
5. selector switch/remove behavior on packaged Linux
6. soak and same-audio comparison

Exit criteria:

- both engine cards are truthful
- only one engine is installed
- Speakrs uses no token
- Pyannote token never reaches logs/manifests/metadata
- setup/validate full-hashes; compute admission rehashes changed fingerprints
- every accepted engine runs CUDA-only and produces unchanged sidecar schemas
- guided failure preserves a normal transcript
- remove/switch never deletes Whisper or shared CUDA
- quit/timeout leaves no `speakrs-cli` grandchild

### Phase 8 — Summary parity (v2.9 gated)

Order:

1. add pinned Linux model platform entry
2. investigate and add one pinned Linux CUDA llama.cpp runtime and extraction tests; do not use the historical CPU/Vulkan assets as a fallback
3. validate setup, cancellation, checksum, offline generation, sidecars, stale-hash UX
4. benchmark the current default model
5. optionally add a catalog-driven Vulkan profile (`llama-b9173-bin-ubuntu-vulkan-x64.tar.gz`) after real inference evidence

Exit criteria:

- setup is explicit and cancellable
- runtime/model checksum failures never reach `ready`
- generation is local-only and serialized
- preflight/queued cancel clears the active slot
- metadata finalization cannot be interrupted
- 60-minute Balanced summary meets the existing wall clock
- committed summary sidecars survive late abort/cleanup

### Phase 9 — v2.9 Linux AI release evidence (gated)

Hardware gate: CachyOS x86_64 with NVIDIA RTX 4070 CUDA. Until an individual component passes, the first Linux version ships only the Core Beta column for that component.

Matrix:

| Environment | Core | CUDA Whisper | Speakrs | Pyannote | Summary | Package |
|---|---:|---:|---:|---:|---:|---|
| Omarchy 4 / Hyprland / PipeWire / CPU-only | **Required (first version)** | Unsupported (greyed) | Unsupported (greyed) | Unsupported (greyed) | Unsupported (greyed) | pacman + AppImage |
| CachyOS / Hyprland / PipeWire / RTX 4070 | Required | Evidence-gated v2.9 | Evidence-gated v2.9 | Evidence-gated v2.9 | Evidence-gated v2.9 | AppImage + pacman + deb |
| Ubuntu 24.04 / Wayland / PipeWire | Smoke | Experimental/unavailable | Experimental/unavailable | Experimental/unavailable | Experimental/unavailable | AppImage |
| Ubuntu 24.04 / X11 / PulseAudio | Smoke | Experimental/unavailable | Experimental/unavailable | Experimental/unavailable | Experimental/unavailable | AppImage |

Core Beta remains CPU-only. Unaccepted and unvalidated Linux AI add-ons stay explicit and greyed and must never fall back to CPU or cloud behavior. The RTX 4070 row is evidence for Phases 6–9 only.

## File touch map

| Area | Primary files |
|---|---|
| Audio factory/recorder | `backend/audio/__init__.py`, new `backend/audio/linux_recorder.py`, shared spool/finalization modules |
| Device discovery | `backend/device_manager.py`, `src/main/device-ipc.js`, renderer device helpers |
| Recorder orchestration | `src/main/recorder-service.js`, recorder output helpers and contract tests |
| Python/runtime packaging | `src/main/python-runtime.js`, `build/download-manifest.js`, `build/prepare-resources.js`, Linux requirements |
| Core transcription | `src/main/transcription-service.js`, faster-whisper backend, runtime/cache helpers. Managed CUDA (`src/main/gpu-runtime-service.js`) is later-version only |
| Presence/Wayland UX | `src/main/recording-presence-service.js`, `src/main.js`, renderer copy/styles |
| Secret storage bootstrap | `src/main.js` (`password-store` switch). Token preflight stays later-version (Phase 7) |
| Add-on grey-out (Core Beta) | `src/ai-addon-state.js` Linux reason strings, `src/renderer/app.js`, `src/renderer/history-detail-helpers.js`, `src/renderer/ai-addon-ui-helpers.js`, `src/renderer/index.html`, `src/renderer/styles.css`, `tests/js/linux-platform-selection.test.js`, helper tests, `tests/manual/local-ai-addons-checklist.md` |
| Add-on catalog/setup (later version) | `src/ai-addon-state.js` `linux-x64` entries, `src/ai-addon/manifest-store.js`, setup/archive modules, `src/main/ai-addon-ipc.js` |
| Speakrs (later version) | `native/speakrs-cli` (`Cargo.toml`, `ort-compile-pins.json`), pack spec/files/integrity, Python runner, packaging verification |
| Summaries (later version) | summary setup/service, llama.cpp runtime catalog, summary backend/tests |
| Packaging/updater | `package.json`, `src/updater.js`, CI/release workflows, build docs |
| Manual QA/legal | both manual checklists, `LOCAL_AI_MODEL_CATALOG.md`, About/notices tests |

## Validation strategy

### Automated

- JS: `npm test`
- Python: `npm run test:python`
- Syntax: `npm run test:python-syntax`
- Full gate: `npm run test:all`
- packaged resource smoke: Python, ffmpeg, backend, legal bundle, no PATH substitution — **no** Linux `speakrs-cli` in Core Beta
- installer smoke: pacman install/upgrade/uninstall and AppImage launch

Linux `speakrs-cli` cargo test/clippy plus CI CPU fixture smoke belongs to **deferred Phase 7**, not Core Beta.

Add Linux cases to characterization tests rather than weakening Windows/macOS snapshots. Update IPC source-scan tests only when an actual shared contract changes.

### Hardware/manual

First Linux version (Omarchy CPU-only):

- every input/output device class available on the Omarchy host
- active browser/meeting audio, silence gaps, Bluetooth/HDMI change
- 15-minute capture, stop, discard, crash recovery (60-minute soak cancelled for Core Beta Phase 3, 2026-08-27)
- recording during CPU transcription
- queued transcription + model preload ordering
- tray behavior with an SNI host present (this Omarchy session: quickshell StatusNotifierWatcher, not Waybar) and in a bare Wayland session (no SNI host) — no crash, presence still communicated. Phase 4 live: SNI item registered; missing-host crash path is unit-tested
- app rendering under XWayland vs `--ozone-platform-hint=auto` on Hyprland with fractional scaling — Phase 4 spike closed 2026-08-27; shipped default is `auto` (native Wayland on this host)
- packaged-AppImage `safeStorage` encrypt/decrypt on Omarchy — **passed 2026-08-28** (`gnome_libsecret`, not `basic_text`)
- tray icon is **visibly rendered** in the panel, idle and recording (the 2026-08-27 pass only proved SNI registration; the icon was blank until the 2026-08-28 pre-merge fix) — **open**
- Settings/Home/History: speaker identification and summaries visible, greyed, future-version copy; no setup or Generate Summary can start — **packaged AppImage 2026-08-28** (cards `.is-unsupported`, buttons disabled, `generate-summary` IPC fail-closed with the Linux reason string)
- no network during transcription

Later version only (needs NVIDIA Omarchy):

- CUDA-major mismatch and CPU fallback; managed CUDA install/repair
- Speakrs/Pyannote setup, switch, remove, guided fallback, quit
- summary setup cancel and metadata-phase quit
- no network during diarization/summary generation

## Core Beta non-goals and v2.9 Linux-AI boundaries

- speaker identification, guided transcription, or Linux `speakrs-cli` outside accepted v2.9 CachyOS RTX 4070 gates
- local summaries outside an accepted CUDA runtime; a CPU llama.cpp runtime "to try it anyway"
- managed Linux CUDA Whisper / GPU Settings install outside the accepted profile
- a Linux CPU fallback for Speakrs or Pyannote
- application-specific desktop-audio capture
- PipeWire native graph API while Pulse compatibility is sufficient
- real-time mixing or streaming captions
- overlapping live recordings
- ROCm/MIGraphX/AMD speaker acceleration
- Linux ARM64
- Flatpak, Snap, RPM, AUR automation
- automatic background AI downloads
- cloud transcription, diarization, or summaries

## First implementation action

Gates A and B are resolved. Phases 0–5 Omarchy Core Beta is complete on `release/linux` and ready to merge to `master` (Phase 3 60-minute soak cancelled by operator 2026-08-27; Phase 4 ozone/secret-storage/tray/CPU/add-on grey-out and review remediation closed 2026-08-27; Phase 5 packaging + packaged UI/recording evidence closed 2026-08-28; pre-merge full-branch review 2026-08-28). The release workflow includes AppImage, pacman, and an experimental `.deb`. Ubuntu 24.04 desktop recording/`safeStorage` smoke is still open, as are a visual tray-icon check and unplugged-endpoint filtering on hardware. Other distros remain experimental betas. The next implementation action is Task 1 of the v2.9 Linux-AI plan on CachyOS x86_64 + NVIDIA RTX 4070.
