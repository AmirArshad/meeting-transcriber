# Recording Smoke Checklist

Use this checklist before and after high-risk recorder changes.

## Recording presence — Before Coding Gates (Release 1)

Evidence recorded 2026-07-13 on Windows (`feature/recording-awareness-r1`). Diff tray/close takeover against Gate A before deleting the inline `createTray()` / close dialog.

### Gate A — Tray/close snapshot (`src/main.js` ~1037–1163)

**Tray today**
- Tooltip: `AvaNevis`
- Menu: `Show/Hide Window` → toggle `hide()` / `show()`+`focus()`; separator; `Quit` → `app.quit()`
- Tray click: same show/hide toggle as the menu item
- Icons: macOS `iconTemplate.png` (template); Windows `icon.ico`

**Idle close dialog today**
- Title: `Minimize to Tray`
- Message: `Would you like to close the app or minimize it to the system tray?`
- Detail: `Minimizing to tray keeps the app running in the background.`
- Buttons: `Minimize to Tray` / `Close App` / `Cancel` (`defaultId: 0`, `cancelId: 2`)
- Default action: `mainWindow.hide()` (not minimize)
- Close App: `app.quit()`

### Gate B — Windows recording close (locked)

While capture state is `starting` | `recording` | `stopping`, Windows close default is **Minimize** (`mainWindow.minimize()`), not `hide()`, so the taskbar button and overlay remain. Idle/generic close may still hide to tray. Dialog buttons: `Keep Recording Minimized`, `Stop and Quit`, `Cancel`.

### Gate C — Windows packaged / overlay spike (2026-07-13)

Spike script: `scripts/gate-c-overlay-spike.js` (`npx electron scripts/gate-c-overlay-spike.js`).

| Condition | Spike result | Implication |
|---|---|---|
| Window shown | `isVisible: true`, `isMinimized: false` | Taskbar button present; overlay can attach |
| After `minimize()` | `isMinimized: true` (taskbar button remains) | Overlay remains applicable — Gate B required |
| After `hide()` | Fully hidden (no taskbar button) | Overlay cannot remain — do not hide while recording on Windows |
| `app.setAppUserModelId('com.avanevis.app')` | Set successfully in spike | Must match NSIS shortcut AppUserModelID |
| `app.setToastActivatorCLSID(...)` | Spike returned stable `{A7E2C4F1-9B83-4D2E-8F61-1C0A9E5B7D33}` | Current `installer.nsh` does **not** bake CLSID; Task 3 must set a checked-in stable CLSID before readiness. Full Action Center click-to-open still needs an **installed** NSIS build after Task 3 |
| Tray overflow | Not measured on installed build this session | Packaged QA: note whether tray sits in overflow flyout by default |

`dist/win-unpacked` exists from a prior build (2026-07-09) but is pre-presence; treat Gate C overlay/toast proof as: Electron minimize-vs-hide API evidence above + post-Task-3 installed checklist (below).

### Gate D — Single-instance collision (baseline)

**Before Task 3:** `src/main.js` does **not** call `requestSingleInstanceLock()`. Dev (`npm start`) and an installed packaged build can both run and create separate trays.

**After Task 3 (expected):** Primary that holds the lock wins; secondary calls `app.exit(0)` without creating a window/tray/services and the primary `second-instance` handler reveals/focuses the existing window. Dev and packaged share the same `userData` identity (`AvaNevis` / `com.avanevis.app`), so they contend for one lock — document which process was started first when validating.

### Gate E — macOS recording-status icon (locked design; visual QA on Mac)

Ship static `build/iconRecording.png` (18×18) and `build/iconRecording@2x.png` (36×36) only — saturated `#ef4444` recording dot with a subtle light edge so it stays obvious on light and dark menu-bar/wallpaper backgrounds. Call `setTemplateImage(false)` **before** `tray.setImage(activeImage)`. Title `REC` with `fontType: 'monospacedDigit'`. No animation/glow frames.

**This Windows session:** assets created in Task 3 (`build/iconRecording.png`, `@2x`, `recording-overlay.png`); code calls `setTemplateImage(false)` before `tray.setImage(activeImage)`. Menu-bar salience on light/dark wallpaper must still be validated on a Mac (packaged checklist below). Gate E is icon salience, not merely “no pulse.”

## Recording presence — Release 1 manual checks

- [ ] Recording pill visible on Record, History, and Settings tabs while recording; hidden when idle/transcribing
- [ ] Windows: minimized window keeps taskbar overlay; fully hidden window loses overlay (documents why recording close minimizes)
- [ ] macOS: hidden window keeps static red menu-bar icon + `REC` (no pulse/animation)
- [ ] Reminder with a test-overridden one-minute interval, then confirm production uses 60 minutes
- [ ] Notification click restores a minimized/hidden window (via retained `Notification` `click` while the object lives; Electron has no Action Center cold-activation API — treat tray/overlay/`REC` as the reliable reopen path)
- [ ] Notifications disabled / Focus enabled: permission-independent indicators remain; on macOS menu-bar `REC` is required even if Dock badge is unavailable
- [ ] Stop, failure, and quit clear tray/`REC`/overlay/Dock badge/in-app pill
- [ ] Relaunch reveals the existing instance with no second tray icon; document `npm start` vs installed-build single-instance behavior (Gate D)
- [ ] macOS light/dark menu bar and Dock badge when notification permission allows
- [ ] Windows taskbar overlay at 100%, 150%, and 200% scaling while minimized
- [ ] Installed Spotlight/Start search for `AvaNevis`, `meeting`, `recorder`, and `transcriber` — Start Menu shortcut / macOS display name is `AvaNevis Meeting Recorder & Transcriber` (`productName`/`appId` stay `AvaNevis`); record actual OS behavior
- [ ] Gate C toast CLSID / Action Center delivery on an installed Windows NSIS build (delivery only; cold click-to-open remains an Electron API gap)
- [ ] Hydrated Stop & Transcribe after renderer reload uses stop IPC + localStorage settings only (no dead-renderer transient state)

## macOS

- [ ] Record microphone + desktop audio while system audio is actively playing.
- [ ] Verify the first 10 seconds of desktop audio are present in the saved recording.
- [ ] On macOS, play browser/YouTube speech and verify that speech appears in the transcript, not only in the audio meter.
- [ ] Deny Screen Recording permission and verify the failure is explicit.
- [ ] On macOS 14.2+: deny System Audio Recording, record, confirm `helperCaptureBackend` falls back to ScreenCaptureKit and the UI/warning mentions System Audio Recording (not only Screen Recording).
- [ ] Gap-collapse check (tap path): play 30s → full system silence 60s → play 30s; second burst should land near t≈90s in the saved stereo file (not t≈30s).
- [ ] Same gap-collapse check under heavy memory/CPU load (stress the stdout writer / Python reader) and confirm the second burst still lands at t≈90s — guards FIFO ordering under writer starvation.
- [ ] Same gap-collapse check with ScreenCaptureKit forced (`audiocapture-helper --screencapturekit`).
- [ ] Kill the Python recorder with SIGKILL mid-recording; helper CPU should drop and the purple capture indicator should clear (stdin EOF stop).
- [ ] First packaged launch on a clean machine: record-press to ready should succeed within the 15s desktop ready budget.
- [ ] Record with no desktop audio playing and verify the app behaves predictably.
- [ ] Record while using Bluetooth/USB/headphone output and note whether desktop audio still captures correctly on the current macOS version.
- [ ] Mid-recording output-device switch (e.g. AirPods at 44.1 kHz) on the tap path — note pitch shift/desync if any.
- [ ] Quit during an active recording and verify the app does not silently lose data.
- [ ] Stop a long recording and verify post-processing completes without clipping the tail.
- [ ] **Stop stages (Release 2 Task 6):** while stopping, confirm UI progress advances through visible stages (Finishing / Normalizing / Mixing / Encoding) via `recording-progress`, and that live capture (`REC` pill / menu-bar) is distinguishable from finalization (`Finishing recording...` tray/pill stopping state). Stages must come from stdout JSON events, not stderr alone.

## Windows

- [ ] Record microphone + WASAPI loopback audio together.
- [ ] Verify mixed output still sounds balanced and stereo channels are intact.
- [ ] Verify stopping a long recording completes without timeout or truncated output.
- [ ] **Stop stages (Release 2 Task 6):** same as macOS — visible stage changes during stop; capture (`REC`) vs finalization (`Finishing recording...`) distinguishable.
- [ ] **Disk reserve (Release 2 Task 6):** with free space below 10 GB (or a test double), confirm a single `recording-warning` / native safety toast when crossing warning, and escalation to critical below 2 GB; recording must **not** auto-stop.

## Linux (Phases 3–4 closed — 60-minute soak cancelled; Phase 5 Core Beta packaging closed 2026-08-28)

Product capture (`backend/audio/linux_recorder.py`) is wired. Do not treat dummy-Pulse or `scripts/linux-audio-spike.py` as Omarchy exit evidence. Add-ons stay greyed `unsupported` (Phase 4). Phase 5 packaged AppImage/pacman evidence, Settings/legal-notices UI clicks, and a packaged CPU transcription session closed 2026-08-28. Omarchy Core Beta and Gate B are complete; Ubuntu 24.04 desktop smoke remains open.

Evidence 2026-08-27 on `amiromarchy` (Omarchy 4.0.1) used the product recorder CLI unless noted. Artifacts: `/tmp/avanevis-linux-smoke/` (morning CLI) and `/home/amir/avanevis-linux-smoke/` (afternoon headphone + Electron).

- [x] **Omarchy hardware:** Record microphone + Pulse/PipeWire monitor (desktop) audio together on Omarchy 4 (Hyprland/Wayland). No ScreenCast portal / screen-sharing UI. (9.82 s mix; dbus-monitor: no ScreenCast markers.)
- [x] **Omarchy hardware:** Browser/YouTube speech reaches the transcript after mono downmix, not only the meter or saved stereo channel. (Chromium autoplay of OSR Harvard sentences; `tiny.en` CPU transcript contained *birch canoe* / *dark blue background*.)
- [x] **Omarchy hardware:** Desktop *startup* failure warns and continues mic-only. Mic-thread failure remains covered by the automated suite, not re-run as a destructive live kill on this pass.
- [x] **Omarchy hardware:** Late desktop loss — vanished Pulse monitor mid-capture (null-sink unload). `DESKTOP_MONITOR_VANISHED` says earlier desktop audio is kept; 240640 committed frames mixed; desktop level dropped to 0.
- [x] **Omarchy hardware:** Unplug/replug headphones mid-capture (physical analog jack; same `alsa_output.pci-0000_00_1b.0.analog-stereo` sink, `Active Port` headphones ↔ speakers). No vanish warning. 440 Hz tone played **before** unplug is in the 45.36 s mix (Goertzel peak t≈1.5 s); 880 Hz during unplug and 1320 Hz after replug also present.
- [x] **Omarchy hardware:** Restart PipeWire mid-capture. Pulse names returned immediately; watchdog did **not** false-vanish. SoundCard streams went `FAILED` — desktop warned and kept ~3.35 s, mic is a structured `RECORDING_THREAD_FAILED` (fatal, no opus). Recording does not continue across a full PipeWire restart; leftover `{stem}.capture` stayed `finalizing` with both tracks committed.
- [x] **Omarchy hardware:** Discard/cancel tombstones the capture as `discarded` and never creates a History meeting. CLI `{ cancelled: true }`; capture dir removed. **Electron UI:** History had 2 meetings; Discard of meeting 3 left `historyCount` 2 (same ids), no third opus/md, main log `Recording cancelled; capture discarded.`
- [x] **Omarchy hardware:** Stop stages (`post_processing_started` → encoding → complete) come from stdout JSON.
- [x] **Omarchy hardware:** Live 15-minute capture passed; recording while CPU transcription runs has no obvious glitches; capture arrays do not grow with duration over 15 minutes (RSS 49.6→52.3 MB vs 688 MB spool; 14 desktop beeps at ~60 s). CLI capture during `tiny.en` CPU load passed (62 s). Electron queue overlap passed (`npm start`; Stop meeting 1 2:06 → Start meeting 2 while `small` CPU Whisper at 123% pcpu). **60-minute soak cancelled** by operator 2026-08-27 — not run, not passed.
- [x] **Phase 4:** Tray uses native SNI + context menu only; missing SNI host does not crash. Evidence 2026-08-27 on `amiromarchy`: SNI host was quickshell (`org.kde.StatusNotifierWatcher`; Waybar not running). After `whenReady()`, `RegisteredStatusNotifierItems` included `:1.198/StatusNotifierItem`; main log had no `Failed to create system tray`. Linux has no tray `click` handler (`setContextMenu` only). With a tray, recording close is Keep Recording in Tray / `hide`; when tray construction fails, it is Keep Recording Minimized / `minimize` so the taskbar recording indicator and Stop/Discard remain reachable. Missing-host live (kill the watcher) was not run; constructor throw and fallback close behavior are unit-tested.
- [x] **Phase 5 packaging (Omarchy, 2026-08-28):** AppImage is a static-pie ELF (`toolsets.appimage` `1.0.2`); host has no `fuse2` / `libfuse.so.2`. Default AppImage launch (not `--appimage-extract-and-run`) used bundled Python/ffmpeg/backend under the AppImage mount, CPU `transcription.faster_whisper_transcriber`, and `safeStorage` backend `gnome_libsecret` (`roundTrip: true`, not `basic_text`). pacman `.PKGINFO` depends matched the explicit list (no libappindicator, no ffmpeg). Clean `pacman -U` / same-version upgrade / `pacman -R` (not `-s`) on Omarchy. Verifier passed on unpacked + AppImage + pacman. No `speakrs-cli` / llama.cpp / CUDA ORT in the package.
- [x] **Phase 5 packaged UI + recording (Omarchy AppImage, 2026-08-28):** Settings Speaker Identification and Meeting Summaries cards greyed (`.is-unsupported`, **Unsupported**); Set Up / Install Model / Generate Summary disabled and cannot start (`generate-summary` IPC fail-closed with the Linux future-version string). **Open third-party notices** opened `/tmp/.mount_AvaNev…/resources/legal/THIRD_PARTY_NOTICES.md` (not the repo file). Packaged recording meeting `20260828_005135` (4:55, not a 60-minute soak) transcribed with bundled `python3 -m transcription.faster_whisper_transcriber --model small --device cpu`; metadata `transcriptionDevice: cpu`, `transcriptionComputeType: int8`; transcript contains Harvard-list desktop speech (*birch canoe*). `AVANEVIS_PACKAGED=1`, `PYTHONPATH` bundled backend, `PYTHONNOUSERSITE=1`.
- [ ] **Still open:** Ubuntu 24.04 **desktop** AppImage recording/safeStorage smoke (2026-08-28 evidence is Docker with `fuse3` + `/dev/fuse`, no fuse2 — not a Ubuntu desktop). Friend distro/desktop rows live in `tests/manual/linux-experimental-beta-checklist.md`. Linux artifacts (AppImage, pacman, experimental `.deb`) are enabled in the release workflow after Gate B closed.

## Interrupted capture recovery (Release 2 Task 10)

- [ ] Startup with unfinished `.capture` session(s): main window appears promptly; discovery is silent until results exist (no banner flash during `discovering`).
- [ ] Prompt copy shows candidate count + approximate disk usage; singular/plural matches count; no filesystem paths in UI.
- [ ] `Later` → status stays `available`, prompt does not reappear this launch, banner remains on every tab with count/size; new recording still starts.
- [ ] Reload renderer during `available` or `recovering`: banner restores; prompt does **not** show a second time (`promptEligible` already claimed).
- [ ] Accepted recovery: banner shows `Recovering interrupted recording… (n of m)` (distinct from stopping pill `Finishing recording...`); app does not look frozen.
- [ ] Forced failure (corrupt fixture): error banner with `Retry`; all capture files kept; next launch re-prompts.
- [ ] Partial failure: copy distinguishes finished vs remaining; `Retry` excludes already-successful candidates; `Dismiss` returns to `available` with unresolved set still banner-visible.
- [ ] Quit during active recovery: unfinished candidates recoverable next launch; no quit-triggered capture deletion.
- [ ] `Recover Now` refused while recording; recovery banner hidden while capture state ≠ `idle`; concurrent Recover activations join one action.
- [ ] `start-recording` during startup scan waits briefly for gate release instead of hard busy error; scan and accepted recovery never overlap file mutation.

## Cross-platform

- [x] Verify model preload/download state is reported correctly in the UI.
- [x] Verify meeting history save/delete/scan still behaves correctly.
- [x] Verify the app can be launched, record, stop, transcribe, and save a meeting end to end.
- [x] **Background transcription queue (PR2):** Stop Meeting 1 → Start unlocks as soon as the file is saved (status pill `Ready · 1 transcribing`); start Meeting 2 while Meeting 1 is still Whispering. Activity shows Meeting 1 Transcribing / Meeting 2 Queued with correct titles. Include a **CPU transcription** run (no CUDA / force CPU) and confirm Meeting 2 capture is not obviously glitched.
- [x] **Cancel recording / Discard (PR3):** While recording (and during countdown), Discard is visible and spaced away from Stop. Confirm dialog always says “Discard this recording? The audio will not be saved.” After confirm: capture stops, no meeting in History/Activity, status returns to Ready. Discard is hidden once Stop is pressed. Cancel mid-recording on Windows and macOS; relaunch after discard shows no recovered meeting for that session.
- [ ] **Adversarial recorder races:** hold Start A's response, discard A, start B, then release A; B must remain recording. Suppress `recording_started` and confirm startup fails after 10s/15s. Make cancel ignore stdin/termination and confirm the timeout does not permanently latch cancel or block forced quit.
- [ ] **Windows orphan sweep:** create an unlocked manifest-less `*.capture` directory and confirm scan/discovery removes it; hold `session.lock` from another process and confirm it is preserved until unlocked.
- [ ] **Queue ordering:** delay the initial queue-state request until after a newer push and confirm the stale snapshot neither replaces Activity nor triggers a History reload.
- [x] Resume banner: quit mid-transcription → relaunch shows “Resume N pending transcriptions” (no auto-resume); Resume enqueues; Cancel from Activity marks failed “Cancelled by user” and drops from resume count.
- [x] GPU install / model download while a job is queued: fail-fast with “N recordings are queued…” (no multi-minute wait).
- [ ] With speaker identification ready, verify a new recording uses speaker-guided transcription and does not leave hidden `.*.guided.*.tmp.md` files after success, failure, or relaunch.
- [ ] Start summary generation, immediately hover/click the active Generate Summary button, and verify cancellation leaves the transcript unchanged and no summary sidecars are orphaned without metadata.
- [ ] Fill 15/60-minute RSS/disk baselines in `docs/initiatives/LONG_RECORDING_SAFETY.md` before claiming Task 10 2h/4h evidence.

## Related guardrails

- Compare recorder failure-mode output with `tests/manual/fixtures/macos-no-desktop-audio.log` when desktop capture degrades to mic-only.
- Compare recorder failure-mode output with `tests/manual/fixtures/macos-screen-recording-warning.log` when Screen Recording permission is missing.
- Use `tests/manual/recording-transcription-regression-checklist.md` for the minimum pre/post-change validation pass.
