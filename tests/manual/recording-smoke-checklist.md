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

**After Task 3 (expected):** Primary that holds the lock wins; secondary calls `app.quit()` without creating a window/tray and the primary `second-instance` handler reveals/focuses the existing window. Dev and packaged share the same `userData` identity (`AvaNevis` / `com.avanevis.app`), so they contend for one lock — document which process was started first when validating.

### Gate E — macOS recording-status icon (locked design; visual QA on Mac)

Ship static `build/iconRecording.png` (18×18) and `build/iconRecording@2x.png` (36×36) only — saturated `#ef4444` recording dot with a subtle light edge so it stays obvious on light and dark menu-bar/wallpaper backgrounds. Call `setTemplateImage(false)` **before** `tray.setImage(activeImage)`. Title `REC` with `fontType: 'monospacedDigit'`. No animation/glow frames.

**This Windows session:** assets created in Task 3 (`build/iconRecording.png`, `@2x`, `recording-overlay.png`); code calls `setTemplateImage(false)` before `tray.setImage(activeImage)`. Menu-bar salience on light/dark wallpaper must still be validated on a Mac (packaged checklist below). Gate E is icon salience, not merely “no pulse.”

## Recording presence — Release 1 manual checks

- [ ] Recording pill visible on Record, History, and Settings tabs while recording; hidden when idle/transcribing
- [ ] Windows: minimized window keeps taskbar overlay; fully hidden window loses overlay (documents why recording close minimizes)
- [ ] macOS: hidden window keeps static red menu-bar icon + `REC` (no pulse/animation)
- [ ] Reminder with a test-overridden one-minute interval, then confirm production uses 60 minutes
- [ ] Notification click restores a minimized/hidden window
- [ ] Notifications disabled / Focus enabled: permission-independent indicators remain; on macOS menu-bar `REC` is required even if Dock badge is unavailable
- [ ] Stop, failure, and quit clear tray/`REC`/overlay/Dock badge/in-app pill
- [ ] Relaunch reveals the existing instance with no second tray icon; document `npm start` vs installed-build single-instance behavior (Gate D)
- [ ] macOS light/dark menu bar and Dock badge when notification permission allows
- [ ] Windows taskbar overlay at 100%, 150%, and 200% scaling while minimized
- [ ] Installed Spotlight/Start search for `AvaNevis`, `meeting`, and `transcriber` — record actual OS behavior
- [ ] Gate C toast CLSID / Action Center click-to-open on an installed Windows NSIS build
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

## Windows

- [ ] Record microphone + WASAPI loopback audio together.
- [ ] Verify mixed output still sounds balanced and stereo channels are intact.
- [ ] Verify stopping a long recording completes without timeout or truncated output.

## Cross-platform

- [ ] Verify model preload/download state is reported correctly in the UI.
- [ ] Verify meeting history save/delete/scan still behaves correctly.
- [ ] Verify the app can be launched, record, stop, transcribe, and save a meeting end to end.
- [ ] With speaker identification ready, verify a new recording uses speaker-guided transcription and does not leave hidden `.*.guided.*.tmp.md` files after success, failure, or relaunch.
- [ ] Start summary generation, immediately hover/click the active Generate Summary button, and verify cancellation leaves the transcript unchanged and no summary sidecars are orphaned without metadata.

## Related guardrails

- Compare recorder failure-mode output with `tests/manual/fixtures/macos-no-desktop-audio.log` when desktop capture degrades to mic-only.
- Compare recorder failure-mode output with `tests/manual/fixtures/macos-screen-recording-warning.log` when Screen Recording permission is missing.
- Use `tests/manual/recording-transcription-regression-checklist.md` for the minimum pre/post-change validation pass.
