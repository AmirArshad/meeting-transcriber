# Linux Support Plan — Omarchy First

> **Status:** Phase 0 in progress on `release/linux`. Gate A is resolved (see below); Linux product capture/add-ons are not advertised as ready.
> **Replanned:** 2026-08-23 against AvaNevis v2.7.0 / current `master`.
> **Review pass:** 2026-08-23 — verified plan claims against the codebase and CI, corrected two host-fact conclusions (secret storage, tray), and pinned every required upstream Linux artifact. All "Verified" sections below were checked on that date.
> **Primary target:** Omarchy 4, x86_64, Hyprland/Wayland, PipeWire with `pipewire-pulse`.
> **Secondary target:** Ubuntu 24.04+ and other modern x86_64 desktop distributions where the same binaries and Pulse-compatible capture path work without distro-specific code.

## How to use this plan

This plan is written to be executed phase by phase, one PR per phase, by an implementer with no prior context on this initiative. Rules:

1. Read root `AGENTS.md` first. It is the canonical source for every cross-process contract this plan touches. Where this plan and `AGENTS.md` disagree on an existing contract, `AGENTS.md` wins.
2. Do not skip phases or reorder them. Each phase's exit criteria must pass before the next phase starts.
3. Every referenced line number was correct on 2026-08-23 and will drift. Each line reference includes a search pattern — locate code by the pattern, not the number.
4. Every artifact pin below lists the exact URL and file name but **not** the SHA-256. At implementation time: download the file, run `sha256sum <file>` (or `shasum -a 256` on macOS), and record the hash in the pin. Never copy a hash from an unverified source, and never pin a URL you have not downloaded and hashed yourself.
5. Never weaken a Windows or macOS test to make Linux pass. Add Linux cases alongside existing ones.
6. Validation per phase: run the smallest relevant suite while iterating (`npm test` for JS, `npm run test:python` for Python), and always run `npm run test:all` before opening the phase PR.
7. No Linux feature may be presented as available in the UI until its phase exit criteria pass. `unsupported` is the correct status until then.

Delivery has two explicit milestones:

1. **Omarchy Core Beta** (Phases 0–5) — mic + desktop recording, recovery, background transcription queue, local faster-whisper, History/export, tray/notifications, pacman package, and a FUSE-less AppImage.
2. **Linux Feature Parity** (Phases 6–9) — optional summaries plus the exclusive Speakrs/Pyannote speaker-identification selector, with Linux-specific catalog/runtime pins and the same privacy, integrity, cancellation, queue, and quit guarantees as Windows/macOS.

Core Beta may ship while local AI add-ons truthfully report `unsupported` on Linux. A release must not present setup controls that cannot complete. "Linux support" should not be called feature-complete until the parity milestone passes its hardware matrix.

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
| Exclusive Speakrs/Pyannote engine selector | Linux needs catalog support for both engines, exclusive deletion, token isolation, setup validation, and guided transcription |
| Bundled `speakrs-cli` with fail-closed integrity | The Linux binary must be built, staged, packaged, and verified; model/runtime packs remain explicit setup-time downloads |
| User-triggered Qwen summaries through pinned llama.cpp | Linux needs a pinned runtime profile and must preserve summary sidecar/metadata finalization semantics |
| AI compute wall clocks and quit drain | Linux process groups and child-tree termination must work for Python, ffmpeg, llama-cli, and the Speakrs grandchild |
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
| Summary runtime, CPU baseline (Phase 8) | `llama-b9173-bin-ubuntu-x64.tar.gz` from `ggml-org/llama.cpp` release `b9173` — the **exact build tag** already pinned in `PINNED_LLAMA_CPP_RUNTIME` (`src/ai-addon-state.js`). URL: `https://github.com/ggml-org/llama.cpp/releases/download/b9173/llama-b9173-bin-ubuntu-x64.tar.gz`. Built against Ubuntu 22.04 glibc; runs on Arch (newer glibc) and Ubuntu 24.04. | `src/ai-addon-state.js` (`linux-x64` runtime entry) |
| Summary runtime, optional Vulkan profile (Phase 8, gated) | `llama-b9173-bin-ubuntu-vulkan-x64.tar.gz` from the same release. URL: `https://github.com/ggml-org/llama.cpp/releases/download/b9173/llama-b9173-bin-ubuntu-vulkan-x64.tar.gz`. Only pinned if the Vulkan profile clears its evidence bar. | `src/ai-addon-state.js` |
| Speakrs Linux ONNX Runtime (Phase 7) | `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` (~233 MB) from `microsoft/onnxruntime` release `v1.27.1` — the **same ORT version** as the Windows pack spec. URL: `https://github.com/microsoft/onnxruntime/releases/download/v1.27.1/onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz`. Caveats: requires cuDNN 9 and CUDA 12 libraries on `LD_LIBRARY_PATH`; cuDNN 9 on Linux additionally requires zlib (statically linked on Windows, not on Linux); Microsoft has deprecated CUDA 12 packages in the 1.27 line, so a future CUDA 13 migration will hit Windows and Linux together — acceptable for v1, do not migrate unilaterally. | `src/ai-addon/speakrs-pack-spec.js` |
| faster-whisper CUDA libraries (Phase 6) | `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` pip packages — both ship manylinux wheels. Same package names as the Windows CUDA profile; the only mechanical difference is `LD_LIBRARY_PATH` injection instead of Windows DLL directories. | Linux GPU runtime profile (Phase 6) |
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

The first release must state:

- Omarchy 4 x86_64 is supported.
- Wayland/Hyprland + PipeWire/Pulse compatibility is the tested desktop.
- Ubuntu/other distro AppImage use is experimental until matrix evidence exists.
- Speaker identification is accelerator-only; no Linux CPU fallback is introduced implicitly.
- Linux ARM64, Flatpak, Snap, RPM, ROCm/MIGraphX, and native Ubuntu `.deb` are out of the first release.

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
- explicit desktop-off: `none`

The renderer and IPC payloads must treat device IDs as strings. The confirmed coercion sites (2026-08-23):

- `src/renderer/app.js` — `parseInt(micId, 10)` / `parseInt(desktopId, 10)` inside `runRecordingPreflightChecks` (near line 3144) and `parseInt(micId)` / `parseInt(desktopId)` in the start-recording path (near line 3252). Search for `parseInt(micId`.
- `src/main/recorder-service.js` — `Number.isInteger(micId) ? micId : null` in the `run-recording-preflight` handler (feeds `getMacOSPermissionStatus`).

The main process is otherwise already string-safe: recorder argv uses `micId.toString()`. Preserve compatibility for existing Windows numeric IDs and macOS UIDs — on those platforms numeric strings still round-trip.

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
- Linux CUDA mechanics: the managed runtime installs the `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` manylinux wheels (verified available) and injects their library directories via **`LD_LIBRARY_PATH`** into Python children — the Linux equivalent of the Windows `os.add_dll_directory` flow. The probe checks for the CUDA-12-major shared-object names; a host with only CUDA-13-named libraries surfaces the runtime-major mismatch and stays on CPU, exactly like Windows.

Linux child processes lower their own priority with `os.nice`, as on macOS, so transcription cannot starve a newly started recording.

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
- Verify packaged-AppImage secret storage explicitly (see decision 9): there are field reports of AppImages failing to `dlopen` the system `libsecret` from inside the AppImage mount namespace. Token save/load must be smoke-tested in the packaged AppImage on Omarchy, not only in the dev build.

Deferred:

- `.deb` until the AppImage has a concrete Ubuntu incompatibility
- RPM, Flatpak, Snap, AUR automation, Linux ARM64

Bundle a pinned Linux Python 3.11 runtime, ffmpeg, backend sources, legal notices, and the Linux `speakrs-cli` in the prepared resource tree (see **Verified upstream artifacts** for the Python/ffmpeg pins). Do not rely on `/usr/bin/python`, system pip packages, or PATH ffmpeg in packaged builds.

### 9. Linux secret storage requires an explicit backend selection (new, 2026-08-23)

Chromium selects the Linux keyring backend from `XDG_CURRENT_DESKTOP`. Hyprland (and Sway, i3, and other non-mainstream desktops) are not recognized, so Electron falls back to the non-encrypting `basic_text` backend even when gnome-keyring and `org.freedesktop.secrets` are fully functional — which is exactly the verified Omarchy host state. Without this decision, the Pyannote token preflight would fail closed on the primary target.

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
- The token preflight (Phase 7) must check **both** `safeStorage.isEncryptionAvailable()` **and** `safeStorage.getSelectedStorageBackend() !== 'basic_text'`. `isEncryptionAvailable()` alone is not sufficient — Electron can report encryption "available" over `basic_text` when plain-text mode is enabled, and `basic_text` is hardcoded-key obfuscation, not encryption.
- Missing secret storage on other desktops must produce `needsAccount`/unsupported guidance with copy telling the user to install/start a Secret Service (e.g. gnome-keyring) — never plain-text token persistence.
- Keep the existing invariants: token via stdin (`--token-stdin`), cleared HF env vars, `HF_TOKEN_PATH` set to `os.devNull`, never `""`.
- Phase 5 must smoke-test token save/load in the **packaged AppImage** on Omarchy (the `dlopen(libsecret)` risk noted in decision 8).

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

## AI add-on parity plan

Linux add-ons are not "just enable the UI." Each needs catalog entries, runtime packaging, setup validation, hardware policy, integrity checks, queue membership, cancellation, uninstall ownership, legal notices, and manual smoke.

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

Product policy for v1: **x86_64 NVIDIA CUDA only; no CPU fallback**.

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

The current Qwen3.5 GGUF remains catalog-owned and llama.cpp remains the runtime. Linux must not silently use a system `llama-cli`.

Initial runtime policy:

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

Acceptance requires a 60-minute transcript to generate a Balanced summary within the existing wall clock on the documented baseline hardware.

## Implementation phases

Each phase should land as a reviewable PR with the smallest relevant tests first. Run `npm run test:all` for recorder, persistence, packaging, security, or cross-process changes and before every Linux PR is opened.

### Phase 0 — Baseline and contract characterization

**Status (2026-08-23):** Implemented on `release/linux`. Gate A diagnosable assertion landed. Linux platform-selection tests cover recorder module, Python layout, add-on availability, updater fail-closed matching, and Speakrs packaging. GPU Settings and permission copy no longer treat Linux as Windows. Manual checklists have explicit Linux-not-ready rows.

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
- Linux faster-whisper runtime/cache paths
- Linux CPU/CUDA probe and child environment
- updater platform handling without enabling release assets prematurely
- renderer platform gating for GPU and add-ons, including the three "not-mac means Windows" copy sites named in Locked decision 1

Behavior:

- tray uses native SNI, drives all interaction through `setContextMenu`, and degrades without crashing when no SNI host exists
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
- `safeStorage.getSelectedStorageBackend()` reports a real backend (not `basic_text`) on the Omarchy host

### Phase 5 — Omarchy Core Beta packaging

Files:

- Linux targets and resources in `package.json` (AppImage + pacman; `artifactName` producing `AvaNevis-Setup-*` per Locked decision 11)
- the **electron-builder decision** from Locked decision 8: opt into the static AppImage toolset on 26.x, or upgrade to v27 after reviewing its breaking changes — never the legacy FUSE2 runtime
- pacman packaging metadata/dependencies (no libappindicator; validate `.PKGINFO` on clean Omarchy)
- Linux artifact naming in `src/updater.js`, including the tightened `findInstallerAsset` Linux branch (snippet in Locked decision 11)
- Linux build/smoke jobs in `.github/workflows/ci.yml` (ubuntu runner — AppImages cannot be cross-compiled)
- Linux release job in `.github/workflows/build-release.yml` **only after Gate B closes**
- build/installer docs and troubleshooting

Exit criteria:

- clean Omarchy install, upgrade, uninstall
- AppImage launches without FUSE2 on Omarchy and Ubuntu 24.04
- packaged app uses bundled Python, ffmpeg, and backend
- `AVANEVIS_PACKAGED=1` blocks PATH helper substitution
- **packaged-AppImage secret storage round-trips** (token save + reload) on Omarchy — this covers the `dlopen(libsecret)` AppImage risk
- legal notices open
- no AI setup button is offered until its Linux catalog path is complete

### Phase 6 — Linux accelerator/resource foundation

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

### Phase 7 — Speaker identification parity

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

### Phase 8 — Summary parity

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
| Secret storage bootstrap | `src/main.js` (password-store switch), token preflight in add-on setup/IPC |
| Add-on catalog/setup | `src/ai-addon-state.js`, `src/ai-addon/manifest-store.js`, setup/archive modules, `src/main/ai-addon-ipc.js` |
| Speakrs | `native/speakrs-cli` (`Cargo.toml`, `ort-compile-pins.json`), pack spec/files/integrity, Python runner, packaging verification |
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
- tray behavior with Waybar (SNI host present) and in a bare Wayland session (no SNI host) — no crash, presence still communicated
- app rendering under XWayland vs `--ozone-platform-hint=auto` on Hyprland with fractional scaling (Phase 4 spike)
- packaged-AppImage `safeStorage` token save/reload on Omarchy
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

Gate A is resolved (green run linked above). Begin with **Phase 0** — land the assertion-diagnosability fix, the Linux platform-selection test cases, and a green `npm test` on the Omarchy host — then execute **Phase 1 — Omarchy audio spike** and record its evidence in this document. Only after the spike validates simultaneous mic + monitor capture should production Linux files or packaging pins be added.
