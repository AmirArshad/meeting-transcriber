# Linux experimental beta

Omarchy 4 and CachyOS x86_64 on Hyprland/Wayland (PipeWire with `pipewire-pulse`) are **Supported**. Everything else in this guide is an **experimental beta**: the same Core Beta payload may run, but we have not proven it on that hardware.

This is not Linux 1.0 and not Windows/macOS parity. Transcription uses CPU `faster-whisper` by default. Optional managed CUDA 12 acceleration can be installed from Settings when an NVIDIA GPU is visible (`/proc/driver/nvidia` or `nvidia-smi`); it is hardware-evidenced on CachyOS x86_64 + RTX 4070 and best-effort elsewhere. Uninstall stays available whenever a managed runtime tree exists, including after a GPU disappears, and returns transcription to CPU.

Linux Speakrs and Qwen summaries are CUDA-only, explicit setup paths: no CPU, Vulkan, SYCL, ROCm, Pyannote, or cloud fallback is offered. They remain disabled unless the managed CUDA runtime is admitted. Task 6 packaged summary evidence is complete on the CachyOS RTX 4070 host. Linux Speakrs Task 5 has passed its Linux and macOS negative rows but is **not formally accepted** until the equivalent Windows x64 check passes. The authoritative evidence and exact scope are in the [v2.9 compatibility matrix](../development/V2_9_DEPENDENCY_COMPATIBILITY.md).

Friend hardware evidence uses [tests/manual/linux-experimental-beta-checklist.md](../../tests/manual/linux-experimental-beta-checklist.md). Automated packaging tests do not count as distro validation.

## Support matrix

| Target | Tier | Recommended download | Notes |
|---|---|---|---|
| Omarchy 4 x86_64 | **Supported** | `.pkg.tar.zst`; AppImage alternative | Hyprland/Wayland + PipeWire. Hardware-validated. |
| CachyOS x86_64 (Hyprland) | **Supported** | `.pkg.tar.zst`; AppImage alternative | Same Core Beta payload as Omarchy. Electron 44 packaged evidence 2026-08-31: Wayland, noctalia SNI tray, PipeWire devices, Discard vs Stop History, 2-minute mic+desktop capture with browser speech in the CPU `faster-whisper` transcript. Other CachyOS desktops stay experimental below. |
| Ubuntu Desktop 24.04 / 26.04 | **Experimental beta** | `.deb`; AppImage alternative | Default desktop is still GNOME (GNOME 46 on 24.04, GNOME 50 on 26.04). Ubuntu **desktop** recording/`safeStorage` smoke is still open. |
| Pop!_OS / COSMIC | **Experimental beta** | `.deb`; AppImage alternative | COSMIC is a separate desktop, not “new Ubuntu.” Tray and keyring currently have upstream rough edges. |
| Linux Mint | **Experimental beta** | `.deb`; AppImage alternative | Debian-family updater match. Cinnamon uses `gnome-libsecret`. |
| Vanilla Arch x86_64 | **Experimental beta** | `.pkg.tar.zst` on a conventional desktop; AppImage otherwise | `pipewire-pulse`, a Secret Service provider, and an SNI tray host are not guaranteed. |
| CachyOS x86_64 (non-Hyprland) | **Experimental beta** | `.pkg.tar.zst`; AppImage alternative | KDE/GNOME/COSMIC/Niri/Sway sessions vary. Hyprland is Supported above. |
| Fedora Workstation 43/44 | **Experimental beta** | AppImage | PipeWire is suitable. Stock GNOME likely has no tray. Keep SELinux enforcing. |
| SteamOS 3 Desktop Mode | **Experimental beta, Desktop Mode only** | AppImage | Store the AppImage in the home directory. Do not disable the read-only root or use pacman. Gaming Mode is out of scope. |
| Fedora Silverblue/Kinoite and other Atomic desktops | **Out** | None | Not the Workstation beta target. |
| Linux ARM64, Flatpak, Snap, RPM, AUR publishing | **Out** | None | Unchanged scope. |

Notify-only updates follow the same family rules: a running AppImage stays on AppImage; Debian-family installs prefer `.deb`; Arch-family installs prefer pacman; Fedora, SteamOS, and unknown Linux prefer AppImage. Filenames must still start with `AvaNevis-Setup-`.

## Desktop environments

Capture is Pulse/PipeWire, not compositor-specific. Desktop differences are secret storage, tray hosting, and Wayland/X11 presentation.

| Desktop | Secret-store request | Tray expectation |
|---|---|---|
| GNOME / Ubuntu GNOME | `gnome-libsecret` | Needs an AppIndicator / StatusNotifier extension; otherwise minimize |
| KDE Plasma | `kwallet6` | Usually has an SNI host |
| Hyprland | `gnome-libsecret` | Needs an SNI host (Waybar, quickshell, or similar) |
| COSMIC | `gnome-libsecret` | SNI support exists but is currently rough upstream |
| Sway / Niri | `gnome-libsecret` | Needs an SNI host in the bar |
| Cinnamon / XFCE | `gnome-libsecret` | Usually has a tray |
| Unknown | `gnome-libsecret` | Minimize if tray creation fails |

`--ozone-platform-hint=auto` stays as shipped. Linux startup logs a sanitized diagnostic record (desktop/session labels, display-presence booleans, requested vs selected secret backend, ozone hint, `--no-sandbox`). It does not log Wayland/X11 socket names, tokens, or user paths.

## Install

Release assets are `AvaNevis-Setup-<version>.AppImage`, `AvaNevis-Setup-<version>.pkg.tar.zst`, and `AvaNevis-Setup-<version>.deb`. The v2.9 branch packages bundled Python 3.11, ffmpeg, backend, and staged `speakrs-cli`; Whisper models, Speakrs model packs, llama.cpp/Qwen artifacts, and CUDA runtimes are explicit setup-time downloads. No ambient system CUDA libraries are trusted.

### AppImage

The runtime is electron-builder 26.x static toolset `1.0.2`. Host `fuse2` / `libfuse.so.2` is **not** required. Kernel `/dev/fuse` plus userspace `fuse3` still mount the image.

```bash
chmod +x AvaNevis-Setup-<version>.AppImage
./AvaNevis-Setup-<version>.AppImage
```

If the image cannot mount (`fuse: device not found`, missing `fusermount3`, or a container without `/dev/fuse`), fallback is:

```bash
./AvaNevis-Setup-<version>.AppImage --appimage-extract-and-run
```

Do not treat that fallback as the shipped default. On Ubuntu, AppArmor may block unprivileged user namespaces; toolset `1.0.2` detects that and relaunches with `--no-sandbox`. That is a reduced Chromium sandbox, not a reason to disable AppArmor.

### pacman (Omarchy, Arch, CachyOS)

```bash
sudo pacman -U AvaNevis-Setup-<version>.pkg.tar.zst
```

Upgrade with the same command. Remove with `sudo pacman -R avanevis` (not `-s`, so shared desktop libraries stay). Do not use pacman on SteamOS.

### deb (Ubuntu, Debian, Pop!_OS, Mint)

```bash
sudo apt install ./AvaNevis-Setup-<version>.deb
```

The package depends on Electron GTK/NSS libraries plus `libpulse0` and `libsecret-1-0`. It does **not** depend on AppIndicator, ffmpeg, or AI runtimes. Remove with `sudo apt remove avanevis`.

## Audio

AvaNevis talks to a Pulse-compatible server (`pipewire-pulse` or PulseAudio) in the **user** session. It does not use the ScreenCast portal or compositor-specific capture.

If devices fail to list:

1. Install `pipewire-pulse` (or PulseAudio) for your distro.
2. Start or sign back into the user audio session so the Pulse socket exists.
3. Refresh devices or restart AvaNevis.

Useful diagnostics (not used by the app at runtime):

```bash
systemctl --user status pipewire-pulse
pactl info
pactl list sources short
```

You should see both a microphone source and a `*.monitor` source for desktop audio. HDMI, headphones, and Bluetooth are separate sinks; pick the monitor that matches the output you can hear.

## Secrets, tray, and SELinux

`safeStorage` needs a real Secret Service (GNOME Keyring, KWallet, or equivalent). `libsecret` alone is only a client library. If encryption is unavailable the log shows `basic_text` / `secretEncryptionAvailable: false`. That is fail-closed, not a crash.

If no StatusNotifierItem host is present, close dialogs keep AvaNevis **minimized** so a taskbar entry remains. That is expected on stock GNOME and on compositors without a tray module. Do not install a host just to claim support.

SELinux (Fedora) must stay enforcing. If launch or capture is denied, collect `ausearch` / AVC evidence. Never suggest `setenforce 0`.

SteamOS and other immutable images: use the AppImage from home storage. Do not disable the read-only root for this beta.

## Known likely failures

- Missing `pipewire-pulse` / Pulse session (vanilla Arch, incomplete installs).
- No `/dev/fuse` or `fuse3` for the AppImage (containers, some locked-down images).
- Ubuntu AppArmor user-namespace restriction → AppImage `--no-sandbox` fallback.
- Stock GNOME with no AppIndicator extension → no tray, minimize instead.
- COSMIC tray/keyring bugs upstream.
- SteamOS Gaming Mode, Deck audio routing, and pacman on a read-only root.
- `safeStorage` `basic_text` when no keyring is running (especially Hyprland/Sway/Niri without one configured).
- CUDA-only Speakrs or summaries remain unavailable until managed-runtime, GPU, architecture, and integrity checks pass.

## Evidence bundle

When reporting a friend-test result, send only:

- Distro ID and version (`/etc/os-release`)
- Desktop and session (`XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`)
- Artifact used (`AppImage` / `pkg.tar.zst` / `deb`) and version
- Whether devices enumerated, and whether a `*.monitor` source was listed
- Whether a two-minute mic+desktop recording saved, and whether browser speech reached the **transcript**
- Tray vs minimized close behavior
- The sanitized `Linux environment diagnostics:` JSON line from the main process log

Do not send Pulse socket paths, keyring contents, tokens, recordings, or full home-directory listings.
