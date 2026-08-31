# Linux experimental-beta friend checklist

Hardware-only. Automated CI packaging checks are not evidence for these rows.

**Supported** remains Omarchy 4 and CachyOS x86_64 Hyprland/Wayland (PipeWire/`pipewire-pulse`). Every other distro and desktop here is an **experimental beta** until a human fills the row. Ubuntu desktop recording/`safeStorage` smoke is still open. The Phase 3 60-minute soak was cancelled 2026-08-27 (not run). SteamOS testing is Desktop Mode AppImage only. Do not start Phases 6–9.

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
- [x] **CachyOS x86_64 Hyprland** — Supported (2026-08-31). Electron 44.0.0 `linux-unpacked` / AppImage / pacman / deb on this host (`ID=cachyos`, Hyprland/Wayland). noctalia SNI tray registered (`StatusNotifierItem` on the AvaNevis pid). Opaque `pulse-source:` / `pulse-monitor:` IDs; onboard analog-input with every port `not available` omitted; HDMI monitor kept (`hdmi-output-0` available — physical HDMI unplug not performed). Discard left History empty. Stop of a 2:28 mic+desktop capture (Chrome looping the Whisper JFK fixture through the FiiO monitor) saved a meeting; CPU `faster-whisper` `--device cpu` / `int8` put “ask not what your country can do for you” / “fellow Americans” in the `.md`. Add-on Setup / Install Model / Generate Summary stayed disabled `Unsupported`. Other CachyOS desktops remain experimental.
- [ ] **CachyOS x86_64 (non-Hyprland)** — Experimental. pacman or AppImage. Record which desktop the installer selected.
- [ ] **Fedora Workstation 43 or 44** — Experimental. AppImage only. Keep SELinux enforcing; collect AVC evidence if denied. Do not test Silverblue/Kinoite as this row.
- [ ] **SteamOS 3 Desktop Mode** — Experimental, AppImage from home storage only. Gaming Mode is out of scope. Do not disable the read-only root or use pacman.

## Desktop-environment rows

Independent of distro. Same shared product rows; record the desktop name from diagnostics.

- [x] **Hyprland** — Supported on Omarchy 2026-08-28 (native Wayland, `gnome_libsecret`, quickshell SNI) and CachyOS 2026-08-31 (noctalia SNI, packaged 2-minute capture + CPU transcript).
- [ ] **GNOME** (including Ubuntu GNOME)
- [ ] **KDE Plasma**
- [ ] **COSMIC**
- [ ] **Sway**
- [ ] **Niri**
- [ ] **Cinnamon**
- [ ] **XFCE**
