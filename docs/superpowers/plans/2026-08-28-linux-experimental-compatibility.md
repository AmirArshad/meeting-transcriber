# Experimental Linux Compatibility Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Expand AvaNevis's best-effort Linux compatibility and friend-test coverage across current x86_64 distributions and desktop environments without promoting any target beyond the evidence-backed support tier.

**Architecture:** Keep the existing Pulse-compatible recorder, Electron bootstrap, bundled Python/ffmpeg payload, and notify-only updater. Add sanitized environment diagnostics and distro-aware artifact selection as small pure helpers, add one Debian-family package target through the existing electron-builder 26.x pipeline, and verify each installer contains the same Core Beta payload. Put hardware-dependent confidence in a manual experimental-beta matrix rather than automated claims.

**Tech Stack:** Electron 42, Node.js CommonJS, node:test, electron-builder 26.15.3, AppImage static toolset 1.0.2, Debian/pacman packages, Python 3.11, Pulse/PipeWire.

## Global Constraints

- Omarchy 4 x86_64, Hyprland/Wayland, PipeWire/`pipewire-pulse` remains the only **Supported** Linux target.
- Ubuntu, vanilla Arch, CachyOS, Fedora Workstation, SteamOS Desktop Mode, and additional desktop environments are **experimental betas** with no hardware claim.
- Linux transcription remains CPU `faster-whisper` only; Linux CUDA, Speakrs, Pyannote, and summaries remain unavailable and greyed `unsupported`.
- Do not start Phases 6–9, add a distro-specific recorder, add ScreenCast portal capture, or alter the opaque Pulse device-ID contract.
- Stay on electron-builder `^26.15.3` with `toolsets.appimage` `1.0.2`; do not upgrade to v27.
- Keep every release installer name under the `AvaNevis-Setup-*` invariant and update packaging, release workflow, updater, verifier, and tests together.
- Add at most one package format: an experimental x86_64 `.deb`; do not add RPM, Flatpak, Snap, or AUR publishing.
- Never weaken Windows or macOS tests and never claim GUI or hardware validation that was not performed.
- The Ubuntu desktop recording/`safeStorage` smoke remains open; the 60-minute soak remains cancelled.
- Do not commit changes.

---

### Task 1: Desktop Bootstrap Diagnostics

**Files:**
- Modify: `src/main-process/linux-electron-bootstrap.js`
- Modify: `src/main.js`
- Test: `tests/js/linux-electron-bootstrap.test.js`

**Implementation:** Add pure classification and diagnostic helpers covering GNOME/Ubuntu GNOME, KDE Plasma, Hyprland, COSMIC, Sway, Niri, Cinnamon, XFCE, and unknown desktops. Report only bounded/sanitized desktop and session labels, display-presence booleans, requested password store, selected safeStorage backend, encryption availability, ozone hint, and whether a sandbox-disabling argument is present. Keep KDE on `kwallet6`; all other named environments retain `gnome-libsecret`; keep `--ozone-platform-hint=auto`; emit diagnostics after Electron is ready without exposing socket paths or secrets.

**Validation:** `node --test tests/js/linux-electron-bootstrap.test.js`

### Task 2: Honest Linux Failure and Presence Copy

**Files:**
- Modify: `src/main/device-ipc.js`
- Modify: `backend/device_manager.py`
- Modify: `src/renderer/platform-selection-helpers.js`
- Modify: `src/main/recording-presence-service.js`
- Test: `tests/js/linux-platform-selection.test.js`
- Test: `tests/js/recording-presence-service.test.js`
- Test: `tests/python/test_device_manager.py`

**Implementation:** Make missing-audio-server guidance name `pipewire-pulse`/Pulse compatibility, instruct users to start the user session, and preserve the existing no-device/error contracts. For Linux sessions where tray creation failed, ensure idle and pending-transcription close dialogs minimize instead of hiding an app that may have no visible SNI item. Do not add D-Bus probing or make a tray host a hard dependency.

**Validation:** `node --test tests/js/linux-platform-selection.test.js tests/js/recording-presence-service.test.js && python -m pytest tests/python/test_device_manager.py -q`

### Task 3: Experimental Debian Artifact and Distro-Aware Updater

**Files:**
- Modify: `package.json`
- Modify: `src/updater.js`
- Modify: `scripts/verify-linux-packaging.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/build-release.yml`
- Test: `tests/js/updater.test.js`
- Test: `tests/js/linux-packaging.test.js`

**Implementation:** Add an x64 `deb` target named `AvaNevis-Setup-${version}.deb` with explicit Electron runtime dependencies plus `libpulse0` and `libsecret-1-0`, and no required/recommended AppIndicator, ffmpeg, or AI runtime. Extend the verifier to inspect Debian control metadata and the extracted bundled payload. Select update assets by current install/runtime and `/etc/os-release`: a running AppImage stays on AppImage; Debian-family installs prefer `.deb`; Arch-family installs prefer pacman; Fedora, SteamOS, and unknown Linux prefer AppImage. Preserve notify-only behavior and strict installer-name matching. Build, verify, collect, and publish all three Linux artifacts in CI/release workflows.

**Validation:** `node --test tests/js/updater.test.js tests/js/linux-packaging.test.js`

### Task 4: Experimental Beta Documentation and Friend Checklist

**Files:**
- Create: `docs/guides/LINUX_EXPERIMENTAL.md`
- Create: `tests/manual/linux-experimental-beta-checklist.md`
- Modify: `README.md`
- Modify: `docs/guides/TROUBLESHOOTING.md`
- Modify: `docs/initiatives/LINUX_SUPPORT.md`
- Modify: `todo.md`
- Modify: `AGENTS.md`
- Modify: `.github/workflows/build-release.yml`

**Implementation:** Publish a Supported/Experimental beta/Out matrix with a recommended download for every reviewed distro. Document audio-service, FUSE3 and `/dev/fuse`, `--appimage-extract-and-run` fallback, Ubuntu sandbox/AppArmor behavior, safeStorage/keyring expectations, SNI degradation, SELinux/immutable constraints, and known likely failures without suggesting `setenforce 0`. Add per-distro and per-desktop friend-test rows for install, device enumeration, two-minute mic+desktop capture, browser speech in the transcript, Discard versus History, disabled add-ons, tray/minimize, and a sanitized evidence bundle. State explicitly that SteamOS testing is Desktop Mode AppImage only, Ubuntu desktop smoke still needs a human, and the 60-minute soak was cancelled.

**Validation:** `rg -n "experimental beta|Omarchy|SteamOS|60-minute|Ubuntu.*desktop" README.md docs/guides/LINUX_EXPERIMENTAL.md docs/guides/TROUBLESHOOTING.md docs/initiatives/LINUX_SUPPORT.md tests/manual/linux-experimental-beta-checklist.md todo.md AGENTS.md .github/workflows/build-release.yml`

### Task 5: Full Validation and Static Contract Review

**Files:**
- Review: all changed files

**Implementation:** Review the final diff for false support claims, forbidden feature work, release-asset naming drift, and accidental Windows/macOS changes. Run the complete JS and cross-language suites. Packaging tests are automated contract checks only; do not launch the GUI or claim distro hardware evidence.

**Validation:** `npm test && npm run test:all`
