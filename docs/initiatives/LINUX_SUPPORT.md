# Linux Support Plan — Omarchy First

> **Status:** Phases 0–2 complete on `release/linux` (Phase 2 packaged enumerate verified 2026-08-24 on Omarchy). Gate A is resolved; Linux product capture is not advertised as ready. Phase 3 (`linux_recorder.py`) is next.
> **Replanned:** 2026-08-23 against AvaNevis v2.7.0 / current `master`.
> **Review pass:** 2026-08-23 — verified plan claims against the codebase and CI, corrected two host-fact conclusions (secret storage, tray), and pinned every required upstream Linux artifact. All "Verified" sections below were checked on that date.
> **Scope cut (2026-08-24):** the first Linux version is **Core Beta only** (Phases 0–5). Speaker identification and local summaries are **out of scope** until a later Linux version. There is no Omarchy host with an NVIDIA GPU to validate those CUDA-only add-ons; do not ship a CPU fallback. The UI must keep both features visible but greyed out as unsupported.
> **Primary target:** Omarchy 4, x86_64, Hyprland/Wayland, PipeWire with `pipewire-pulse`.
> **Secondary target:** Ubuntu 24.04+ and other modern x86_64 desktop distributions where the same binaries and Pulse-compatible capture path work without distro-specific code.

## How to use this plan

This plan is written to be executed phase by phase, one PR per phase, by an implementer with no prior context on this initiative. Rules:

1. Read root `AGENTS.md` first. It is the canonical source for every cross-process contract this plan touches. Where this plan and `AGENTS.md` disagree on an existing contract, `AGENTS.md` wins.
2. Do not skip or reorder **in-scope** phases (0–5). Each phase's exit criteria must pass before the next phase starts. Phases 6–9 are a later Linux version — see rule 8.
3. Every referenced line number was correct on 2026-08-23 and will drift. Each line reference includes a search pattern — locate code by the pattern, not the number.
4. Every artifact pin below lists the exact URL and file name but **not** the SHA-256. At implementation time: download the file, run `sha256sum <file>` (or `shasum -a 256` on macOS), and record the hash in the pin. Never copy a hash from an unverified source, and never pin a URL you have not downloaded and hashed yourself.
5. Never weaken a Windows or macOS test to make Linux pass. Add Linux cases alongside existing ones.
6. Validation per phase: run the smallest relevant suite while iterating (`npm test` for JS, `npm run test:python` for Python), and always run `npm run test:all` before opening the phase PR.
7. No Linux feature may be presented as available in the UI until its phase exit criteria pass. `unsupported` is the correct status until then.
8. Do not start Phases 6–9 as part of the first Linux version. Those phases are a later Linux version, blocked on an Omarchy host with NVIDIA hardware.

Delivery has two explicit milestones. Only the first is in scope now:

1. **Omarchy Core Beta** (Phases 0–5) — **this is the first Linux version.** Mic + desktop recording, recovery, background transcription queue, local faster-whisper **on CPU**, History/export, tray/notifications, pacman package, and a FUSE-less AppImage. Speaker identification and local summaries stay `unsupported` and greyed out in the UI.
2. **Later Linux version — add-on parity** (Phases 6–9, deferred) — optional summaries plus the exclusive Speakrs/Pyannote selector, Linux catalog/runtime pins, and managed CUDA Whisper. **Do not schedule this until an Omarchy machine with an NVIDIA GPU is available for soak.** A CPU llama.cpp binary existing upstream is not a reason to ship Linux summaries in Core Beta.

A Core Beta release must not present setup controls that cannot complete. Greyed-out Settings cards and a disabled Generate Summary control are required; hiding the features, or leaving Set Up clickable, is not. Do not call Linux "feature-complete" with Windows/macOS while add-ons remain deferred.

Ubuntu `.deb` support is a later packaging task unless the AppImage works unchanged. No Ubuntu-specific capture implementation is planned.

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
- **Tray (corrected 2026-08-23):** `libappindicator-gtk3` is not installed on the host — and it does not need to be. Modern Electron/Chromium implements **StatusNotifierItem (SNI) natively over D-Bus** (Chromium migrated off libappindicator in 2019). What the tray actually requires is an **SNI host**, which Omarchy provides via Waybar's tray module. Do **not** add a libappindicator pacman dependency. The real degradation case: a Wayland session with no SNI host — Electron's `GtkStatusIcon` fallback is X11-only, so the tray silently does not appear. See Phase 4.
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

### Gate B — triage current macOS release integrity — **STILL OPEN**

[Issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76) reports that the v2.7.0 DMG appears corrupt on macOS 15.7.7 / M3 Pro. As of 2026-08-23 the issue is open with one reporter follow-up ("redownloaded and verified the download was good") and no maintainer-side verification. This does not block Phases 0–4, but it blocks touching `.github/workflows/build-release.yml` (Phase 5's release job):

1. Download the published DMG and verify checksum, mountability, signature, notarization, and stapling.
2. Determine whether the screenshot is true file corruption, a signing/notarization failure, or Gatekeeper copy.
3. Close or update the issue with a verified result before adding Linux artifacts to `build-release.yml`.

Windows v2.7.0 has no equivalent open release issue.

### Gate C — freeze target support claims

The first Linux version (Core Beta) must state:

- Omarchy 4 x86_64 is supported.
- Wayland/Hyprland + PipeWire/Pulse compatibility is the tested desktop.
- Transcription is local faster-whisper on **CPU**. Linux CUDA Whisper is not a Core Beta support claim.
- Speaker identification (Speakrs and Pyannote) and local summaries are **not available on Linux in this version**; they will return in a future Linux update. The Settings cards stay visible and greyed out. No Linux CPU fallback for either speaker engine.
- Ubuntu/other distro AppImage use is experimental until matrix evidence exists.
- Linux ARM64, Flatpak, Snap, RPM, ROCm/MIGraphX, native Ubuntu `.deb`, and Linux AI add-on setup are out of the first release.

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
- CUDA Whisper, the managed CUDA runtime install, and GPU Settings install/repair are deferred with diarization/summaries until an Omarchy host with NVIDIA hardware exists (Phase 6).
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

- `.deb` until the AppImage has a concrete Ubuntu incompatibility
- RPM, Flatpak, Snap, AUR automation, Linux ARM64

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

**Tray.** Electron uses native D-Bus StatusNotifierItem. On Omarchy, Waybar is the SNI host and the tray works without extra packages. Constraints for `src/main/recording-presence-service.js`:

- Tray creation on a Wayland session with no SNI host yields no visible icon (the `GtkStatusIcon` fallback is X11-only). The service must tolerate an effectively invisible tray without crashing and without losing recording-state presentation elsewhere (window title, taskbar, notifications).
- Do not rely on tray `click` events on Linux — SNI activation semantics vary by host. Drive all tray interaction through `setContextMenu`, and call `setContextMenu` again after mutating menu items (Linux requirement).
- Known upstream quirk: all Electron apps currently share the SNI ID `chrome_status_icon_1` (Electron issue #40936; fix in flight in #48675). Do not attempt to patch this locally; note it in troubleshooting docs if users report tray-management oddities.

**Notifications.** Use Electron's `Notification` (D-Bus `org.freedesktop.Notifications`); Omarchy ships a notification daemon. Notifications remain best-effort — never gate recording flow on notification delivery.

**Ozone / XWayland (decision spike required in Phase 4).** By default Chromium runs under XWayland, which renders blurry under Hyprland fractional scaling — a loud complaint in exactly the Omarchy demographic. Native Wayland via `--ozone-platform-hint=auto` fixes rendering but changes window-decoration and input behavior. Phase 4 must run the app both ways on the Omarchy host, record findings, and pick a shipped default. Recommendation going in: ship `--ozone-platform-hint=auto` (appended in `src/main.js` for Linux only) so Wayland sessions get native rendering and X11 Ubuntu sessions still work; revert to XWayland default only if the spike finds functional regressions. Audio capture is unaffected either way (no ScreenCast portal in the design).

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

### 12. First Linux version does not ship diarization or summaries (new, 2026-08-24)

There is no Omarchy development host with an NVIDIA GPU. Speakrs and Pyannote on Linux are CUDA-only with **no CPU fallback** (same product policy as Windows/macOS). Local summaries are deferred with that same later milestone even though a CPU llama.cpp binary exists upstream — do not ship a Linux-only CPU summary exception in Core Beta.

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

Later version (Phases 6–9) starts only when an Omarchy + NVIDIA machine is available. Until then, keep this decision's grey-out contract; do not partially enable summaries or a Speakrs CPU path.

## Later Linux version — add-on parity plan (deferred)

**Out of scope for the first Linux version.** Keep the requirements below so the later milestone does not have to be rediscovered. Do not implement them, pin their artifacts, or enable their UI in Core Beta.

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
- document Gate B status (still open — do not touch `build-release.yml`)
- add Linux cases to platform-selection tests before implementation
- characterize recorder argv selection, Python runtime resolution, device ID serialization, add-on availability, updater asset selection, and packaged path rules
- add Linux rows to the manual recording and local-AI checklists

Exit criteria:

- current Windows/macOS suites remain green
- `npm test` passes on the Omarchy development host
- unknown/non-macOS platforms no longer silently enter Windows code
- no Linux feature is advertised as ready
- diarization and summary catalog status on Linux is `unsupported` (visual grey-out and Linux-specific copy land in Phase 4)

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
- **HDMI:** Card profile `output:hdmi-stereo` is `available: no` with no cable, but `card_profile_set` still created `alsa_output.pci-0000_00_03.0.hdmi-stereo`. HDMI desktop capture is a **different** Pulse sink + `.monitor`, selected by opaque id. Do not assume unavailable ports stay absent. Profile restored to `off`.
- **Headphones:** Port `analog-output-headphones` exists on the analog card and is `available: no` (jack unplugged). Plugging headphones retargets the **same** analog-stereo sink; the monitor Pulse name does not change. No extra `pulse-monitor:` id.
- **Bluetooth:** Adapter present (`hci0`), soft-blocked. Temporary unblock produced no BlueZ card or A2DP sink (no paired device). A connected headset would appear as its own Pulse sink + `.monitor`, same selection model as HDMI. rfkill restored to blocked.
- **Default-sink switch:** Creating `module-null-sink` `avanevis_spike_alt` and `sink_default_set` **does** change the server default (confirmed in a follow-up with a 150 ms settle). Linux v1 still must not hot-switch the live desktop stream; keep recording the originally selected monitor.
- **Late desktop loss:** Unloaded the null sink while SoundCard was recording `avanevis_spike_alt.monitor`. The Pulse source disappeared (`source_still_listed_after_unload: false`). SoundCard **did not hang and did not raise** — it kept returning ~21 ms blocks of **silence** (post-unload RMS 0). Product recorder must detect a vanished monitor via pulsectl (or equivalent), warn, and continue mic-only. Do not wait for a SoundCard exception.

Host restored afterward: analog duplex profile, HDMI `off`, default analog sink/source, Bluetooth soft-blocked, no leftover null sink.

Phase 3 implications (do not implement here):

- Device IDs stay `pulse-source:` / `pulse-monitor:` / `pulse-sink:` / `none`.
- Desktop thread watches whether the selected monitor remains in `source_list()`; silence alone is not a loss signal (meetings go quiet).
- HDMI/BT are additional sinks; headphones are not.
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

- live 15/60-minute Omarchy captures pass
- recording while CPU transcription runs has no obvious glitches
- browser speech reaches the transcript, not only meters/saved channels
- no whole-session capture array grows with duration

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

### Phase 5 — Omarchy Core Beta packaging

Files:

- Linux targets and resources in `package.json` (AppImage + pacman; `artifactName` producing `AvaNevis-Setup-*` per Locked decision 11)
- the **electron-builder decision** from Locked decision 8: opt into the static AppImage toolset on 26.x, or upgrade to v27 after reviewing its breaking changes — never the legacy FUSE2 runtime
- pacman packaging metadata/dependencies (no libappindicator; validate `.PKGINFO` on clean Omarchy)
- Linux artifact naming in `src/updater.js`, including the tightened `findInstallerAsset` Linux branch (snippet in Locked decision 11)
- Linux build/smoke jobs in `.github/workflows/ci.yml` (ubuntu runner — AppImages cannot be cross-compiled)
- Linux release job in `.github/workflows/build-release.yml` **only after Gate B closes**
- build/installer docs and troubleshooting — first-version claims match Gate C (CPU transcription; add-ons greyed unsupported)

Exit criteria:

- clean Omarchy install, upgrade, uninstall
- AppImage launches without FUSE2 on Omarchy and Ubuntu 24.04
- packaged app uses bundled Python, ffmpeg, and backend — **no** Linux `speakrs-cli`, llama.cpp, or ORT
- `AVANEVIS_PACKAGED=1` blocks PATH helper substitution
- **packaged-AppImage `safeStorage` encrypt/decrypt round-trip** on Omarchy — this covers the `dlopen(libsecret)` AppImage risk; no Hugging Face token is required
- legal notices open
- packaged UI still greys out speaker identification and summaries; no setup button can complete

**Core Beta ends here.** That is the first Linux version.

### Phases 6–9 — Later Linux version (deferred)

**Do not start these phases until an Omarchy host with an NVIDIA GPU is available.** They are not part of the first Linux version. Requirements and artifact URLs stay in this document so the later milestone does not have to be rediscovered.

### Phase 6 — Linux accelerator/resource foundation (deferred)

Port the existing managed runtime behavior instead of treating system CUDA as sufficient:

- define Linux faster-whisper CUDA package/runtime pins (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12` manylinux wheels — verified available)
- build a fresh CUDA-major probe for queued-job start (CUDA-12-major `.so` names; a CUDA-13-only host surfaces the mismatch and stays on CPU)
- inject contained shared-library paths into children via `LD_LIBRARY_PATH` (the Linux analogue of the Windows DLL-directory flow)
- serialize install/repair/uninstall with compute and preload through `gpuResourceActionQueue`
- invalidate cached CUDA status after uninstall/failure
- terminate runtime actions cleanly on quit

Exit criteria:

- CUDA 12 profile works on supported NVIDIA hardware without a system CUDA toolkit
- incompatible/newer-only CUDA stays on CPU with clear copy
- install/repair cannot race active compute or loaded libraries
- no Linux shared-library path escapes the managed runtime

### Phase 7 — Speaker identification parity (deferred)

Order:

1. Linux `speakrs-cli` build/package/integrity — including the `Cargo.toml` Linux target section and the `ort-compile-pins.json` `linux-x64: null` entry (exact snippets in **Speakrs on Linux**)
2. Linux model and ORT/CUDA pack pins (`onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` closure; cuDNN 9 + zlib + `LD_LIBRARY_PATH` caveats)
3. Speakrs setup validation and guided smoke
4. Pyannote Linux dependency pins and the two-part secure-token preflight from Locked decision 9
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

### Phase 8 — Summary parity (deferred)

Order:

1. add pinned Linux model platform entry
2. add pinned Linux CPU llama.cpp runtime (`llama-b9173-bin-ubuntu-x64.tar.gz`) and extraction tests
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

### Phase 9 — Later-version release and portability evidence (deferred)

Hardware gate: Omarchy 4 with NVIDIA CUDA. Until that host exists, the first Linux version ships only the Core Beta column.

Matrix:

| Environment | Core | CUDA Whisper | Speakrs | Pyannote | Summary | Package |
|---|---:|---:|---:|---:|---:|---|
| Omarchy 4 / Hyprland / PipeWire / CPU-only | **Required (first version)** | Unsupported (greyed) | Unsupported (greyed) | Unsupported (greyed) | Unsupported (greyed) | pacman + AppImage |
| Omarchy 4 / NVIDIA CUDA | Required | Later version | Later version | Later version | Later version | pacman + AppImage |
| Ubuntu 24.04 / Wayland / PipeWire | Smoke | Later version | Unsupported until later | Unsupported until later | Unsupported until later | AppImage |
| Ubuntu 24.04 / X11 / PulseAudio | Smoke | Optional later | Deferred | Deferred | Deferred | AppImage |

First version: release only Core Beta on CPU. Unsupported add-ons stay explicit and greyed and must never fall back to cloud behavior. The NVIDIA row is evidence for Phases 6–9 only.

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
- 15/60-minute capture, stop, discard, crash recovery
- recording during CPU transcription
- queued transcription + model preload ordering
- tray behavior with Waybar (SNI host present) and in a bare Wayland session (no SNI host) — no crash, presence still communicated
- app rendering under XWayland vs `--ozone-platform-hint=auto` on Hyprland with fractional scaling (Phase 4 spike)
- packaged-AppImage `safeStorage` encrypt/decrypt on Omarchy
- Settings/Home/History: speaker identification and summaries visible, greyed, future-version copy; no setup or Generate Summary can start
- no network during transcription

Later version only (needs NVIDIA Omarchy):

- CUDA-major mismatch and CPU fallback; managed CUDA install/repair
- Speakrs/Pyannote setup, switch, remove, guided fallback, quit
- summary setup cancel and metadata-phase quit
- no network during diarization/summary generation

## Non-goals for the first Linux release

- speaker identification (Speakrs or Pyannote), guided transcription, or Linux `speakrs-cli`
- local summaries, including a CPU llama.cpp runtime "to try it anyway"
- managed Linux CUDA Whisper / GPU Settings install
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

Gate A is resolved (green run linked above). Phases 0–2 are done on `release/linux`, including 2026-08-24 Omarchy live-capture and packaged-Python device enumeration. **Next: Phase 3 `linux_recorder.py`.** **Do not start Phases 6–9 until an Omarchy host with NVIDIA hardware exists.**
