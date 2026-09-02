# Linux experimental-beta friend checklist

Hardware-only. Automated CI packaging checks are not evidence for these rows.

**Supported** remains Omarchy 4 and CachyOS x86_64 Hyprland/Wayland (PipeWire/`pipewire-pulse`). Every other distro and desktop here is an **experimental beta** until a human fills the row. Ubuntu desktop recording/`safeStorage` smoke is still open. The Phase 3 60-minute soak was cancelled 2026-08-27 (not run). SteamOS testing is Desktop Mode AppImage only. Do not start Phases 6–9.

**v2.9 Linux-AI Task 3 (2026-09-02):** packaged CUDA Whisper is **accepted** on CachyOS x86_64 + NVIDIA RTX 4070. Linux CUDA setup is also **offered** on other NVIDIA x86_64 Linux as best-effort (same managed CUDA 12 profile). Default transcription stays CPU until the user installs CUDA; uninstall returns to CPU. While CUDA is installed, a broken runtime stays fail-closed until repair or uninstall. Speakrs, Pyannote, and summaries remain unavailable. Evidence: [`docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`](../../docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md) Task 3 section.

User-facing install and failure notes: [docs/guides/LINUX_EXPERIMENTAL.md](../../docs/guides/LINUX_EXPERIMENTAL.md).

## How to run a pass

Use a GitHub Release `AvaNevis-Setup-*` artifact (or a locally verified build of the same payload). Record the artifact kind and version. Complete the shared rows, then the distro and desktop rows that match the machine.

A pass needs browser/YouTube (or similar) speech in the **transcript**, not only the level meter or the saved stereo file. Discard must not create a History meeting; Stop must.

Sanitized evidence bundle (no sockets, tokens, recordings, or home paths):

- `/etc/os-release` `ID` / `VERSION_ID`
- `XDG_CURRENT_DESKTOP` and `XDG_SESSION_TYPE`
- Artifact filename
- The `Linux environment diagnostics:` JSON line
- Pass/fail for each shared row below

## Shared product rows

Run these on every experimental machine.

- [ ] **Install.** Recommended download for this distro launches (AppImage default mount, `pacman -U`, or `apt install ./AvaNevis-Setup-*.deb`). AppImage `--appimage-extract-and-run` only if `/dev/fuse`/`fuse3` cannot mount; note that fallback.
- [ ] **Device enumeration.** Microphone and a Pulse/PipeWire `*.monitor` desktop source appear. IDs stay opaque (`pulse-source:…`, `pulse-monitor:…`). Missing-server copy names `pipewire-pulse` / Pulse compatibility and the user audio session.
- [ ] **Two-minute mic+desktop capture.** No ScreenCast / screen-sharing portal. Stop stages complete and a meeting is saved.
- [ ] **Browser speech in the transcript.** After CPU `faster-whisper`, desktop speech is in the `.md` transcript.
- [ ] **Discard versus History.** Discard does not add a meeting; Stop does.
- [ ] **Disabled add-ons.** Speaker Identification and Meeting Summaries stay greyed `unsupported`. Setup and Generate Summary cannot start.
- [ ] **Tray or minimize.** With an SNI host, idle close can hide to tray. With no tray, idle and pending-transcription close **minimize** and leave a taskbar entry. When a tray icon *is* shown, check it is actually drawn (app mark when idle, app mark + red REC badge while recording) — an undecodable image still constructs a Tray on Linux, so a blank entry is a real failure mode.
- [ ] **Sanitized diagnostics.** Main log includes `Linux environment diagnostics:` without Wayland/X11 socket names or secrets.

## Distro rows

Mark only machines that were actually tested. Leave unchecked rows open.

- [x] **Omarchy 4 x86_64** — Supported. Packaged AppImage + pacman + CPU transcription evidence 2026-08-28. See `tests/manual/recording-smoke-checklist.md`. **60-minute soak cancelled.**
- [ ] **Ubuntu Desktop 24.04** — Experimental. Prefer `.deb`; AppImage alternative. Desktop recording/`safeStorage` smoke still needs a human (2026-08-28 Docker launch is not this row).
- [ ] **Ubuntu Desktop 26.04** — Experimental. Default session is still GNOME (GNOME 50), not COSMIC.
- [ ] **Pop!_OS / COSMIC** — Experimental. `.deb` or AppImage. Note tray/keyring issues; do not “fix” them with AvaNevis workarounds.
- [ ] **Linux Mint** — Experimental. `.deb` or AppImage.
- [ ] **Vanilla Arch x86_64** — Experimental. pacman on a conventional desktop; otherwise AppImage. Confirm `pipewire-pulse` is installed and the user session is running.
- [x] **CachyOS x86_64 Hyprland** — Supported (2026-08-31 Electron 44 capture; reliability follow-through 2026-09-01). noctalia SNI tray: idle `IconPixmap` 64×64 non-empty (3246 opaque), recording REC badge raised reddish pixels 95 → 351. Missing SNI host (`dbus-run-session`) skips `new Tray()` (`StatusNotifierWatcher is not available`) so `hasTray()` is false and close is the minimize path. Opaque Pulse IDs. Forced unplugged motherboard HDMI omitted from dropdowns. First-run empty `localStorage` selected Pulse `defaults` (Logitech C925e + HDMI VG27AQML1A monitor). Packaged 2026-08-31 Discard/Stop + CPU transcript evidence unchanged. **CUDA Whisper accepted 2026-09-02** for this CachyOS x86_64 + NVIDIA RTX 4070 host only (see CUDA Whisper section below). Other CachyOS desktops remain experimental.
- [ ] **CachyOS x86_64 (non-Hyprland)** — Experimental. pacman or AppImage. Record which desktop the installer selected.
- [ ] **Fedora Workstation 43 or 44** — Experimental. AppImage only. Keep SELinux enforcing; collect AVC evidence if denied. Do not test Silverblue/Kinoite as this row.
- [ ] **SteamOS 3 Desktop Mode** — Experimental, AppImage from home storage only. Gaming Mode is out of scope. Do not disable the read-only root or use pacman.

## Desktop-environment rows

Independent of distro. Same shared product rows; record the desktop name from diagnostics.

- [x] **Hyprland** — Supported on Omarchy 2026-08-28 (native Wayland, `gnome_libsecret`, quickshell SNI) and CachyOS 2026-08-31 (noctalia SNI, packaged 2-minute capture + CPU transcript). CachyOS Hyprland CUDA Whisper accepted 2026-09-02 (RTX 4070 profile only).
- [ ] **GNOME** (including Ubuntu GNOME)
- [ ] **KDE Plasma**
- [ ] **COSMIC**
- [ ] **Sway**
- [ ] **Niri**
- [ ] **Cinnamon**
- [ ] **XFCE**

## v2.9 CachyOS CUDA Whisper (Task 3, 2026-09-02)

Hardware acceptance for **this CachyOS x86_64 + NVIDIA RTX 4070 host**. CI and unit tests are not this gate. Other NVIDIA Linux x86_64 may install the same managed CUDA 12 profile as best-effort; that is not this hardware row. Speakrs, Pyannote, and summaries stay greyed `unsupported`.

Same-day follow-up: default transcription is CPU until CUDA is installed. Uninstall returns to CPU. A broken installed runtime stays fail-closed until repair or uninstall. The Task 3 uninstall/fail-closed rows below are **superseded pre-follow-up evidence** (profile required CUDA even after uninstall); current code restores CPU after uninstall and keeps Uninstall visible whenever `ai-addons/cuda/python` exists.

Commands and full hashes: [`docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`](../../docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md) Task 3 section.

- [x] **Build / verify.** `npm run build:linux && npm run verify:linux:packaged`. Evidence payload: `dist/linux-unpacked/avanevis` first, then confirmed `AvaNevis-Setup-2.8.0.AppImage` SHA-256 `c94935183d3d54f231ace78131b39aa07046e70e0b5b1ad6103d058a278e3821`, `AvaNevis-Setup-2.8.0.pkg.tar.zst` `15e3e67ff091fd057a69c55e747fbb3782da21619ae2916f8318f70e1c5fa143`, `AvaNevis-Setup-2.8.0.deb` `e248e5600a717871c5d0883bb4d73ad3e372ebe531092a5cb9a00c9ff7fc633d`. Isolated `--user-data-dir=/tmp/avanevis-v29-task3`.
- [x] **Managed CUDA 12 install.** Packaged `installGPU` used exact staged wheel paths (`--no-index --no-deps --target python.staging-*` + hashed `.whl` files; no `--find-links` / `package==version`), then atomic swap onto `ai-addons/cuda/python`. `statusCode=ready`, `matchedProfile=cuda12`. Device: NVIDIA GeForce RTX 4070, driver 610.57.04, compute cap 8.9. Wheel/library hashes matched the Task 2 catalog.
- [x] **Fresh preload + CUDA transcription.** Whisper `tiny` was not cached; preload succeeded (CPU/int8 download path). `retryTranscription` of 148.47 s JFK desktop-loop fixture `meeting_20260902_task3_cuda.opus` in 7943 ms. Result JSON `device: cuda`, `computeType: float16`. Meeting metadata at success: `transcriptionDevice: cuda`, `transcriptionComputeType: float16`, `transcriptionStatus: completed`. Queue: `queued` → `waiting_resource` → `transcribing` → `persisting` → `completed`. Transcript contains looping JFK speech.
- [x] **Repair.** Corrupted live `libcublas.so.12` → `runtimeIntegrityFailed`; transcription threw (no CPU child). `installGPU({ mode: "repair" })` swapped via staging (`renamedActive: true`); later tiny transcription `cuda` / `float16`.
- [x] **Uninstall tombstone (superseded pre-follow-up).** `uninstallGPU` renamed the live tree to `python.tombstone-*`, then deleted only the tombstone. Live `python/` gone; `wheelhouse` kept. Transcription then failed closed. Current code returns to CPU after uninstall; a fresh uninstall→CPU packaged smoke is in the residual list below.
- [x] **Fail-closed, no CPU fallback.** Extra `libcublas.so.13` → `runtimeIntegrityFailed`. Invalid probe JSON → `probeError`. Missing `nvidia-smi` with an admitted managed runtime → final CUDA probe `probeError` / throw (Settings/install detection is `/proc`-first and is a separate residual smoke). Uninstalled runtime → `missingLibraries` / throw is **superseded**; current code returns to CPU after uninstall.
- [x] **Cancel and quit.** Cancel during `small` `transcribing` released `gpuResourceActionQueue` (`busyCount: 0`); later tiny job `cuda` / `float16`. Quit drain terminated the in-flight retry; relaunch queue empty; later tiny job `cuda` / `float16`.
- [x] **Residual desktop audio (best-effort, not a CUDA block).** 8.00 s mic+desktop Stop wrote a usable Opus file. `DESKTOP_AUDIO_RESOURCE_EXHAUSTED` was **not** reproduced on this host.

### Residual adversarial follow-up smoke (packaged Linux, not yet run)

- [ ] `/proc` NVIDIA visible and `nvidia-smi` removed from `PATH`: Settings remains offered and install is not rejected by the preliminary GPU check.
- [ ] Corrupt one managed library: transcription fails closed, both Repair and Uninstall remain reachable, and Uninstall restores successful CPU/int8 transcription.
- [ ] Remove GPU/driver visibility while the managed tree remains: Uninstall stays visible and restores CPU.
- [ ] No managed tree plus hostile `LD_LIBRARY_PATH`: inspect the actual preload and transcription child environments and confirm CPU/int8 output.
- [ ] Healthy runtime plus `skipInstallIfReady: true`: no wheel download or pip subprocess occurs.
