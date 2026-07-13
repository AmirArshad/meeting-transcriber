# Recording Awareness And Long-Recording Safety Implementation Plan

> **For agentic workers:** Execute inline by default. Do **not** launch Task/subagent reviewers for plan self-check or routine implementation — that burns tokens without adding value. If an independent review is needed, ask the user first and run it in a separate session (for example Fable), not as nested agents.

**Goal:** Make an active AvaNevis recording impossible to overlook, make the app easier to rediscover by purpose, and remove the duration-proportional RAM and crash-loss risk exposed by a forgotten 550-minute recording.

**Architecture:** Ship this through two release gates. Release 1 keeps recording truth in `src/main/recorder-service.js` and feeds a new main-process presence service that owns tray, Dock/taskbar, reminder, and window-presence behavior; the renderer mirrors that state with an always-visible status pill. Release 2 builds on Release 1's lifecycle/presence seams and preserves separate mic/desktop capture and post-recording mixing while replacing unbounded RAM buffers and whole-recording finalization arrays with durable segmented track spools and bounded multi-pass processing.

**Tech Stack:** Electron 42 main process and native notifications, plain HTML/CSS/JavaScript renderer, Python 3.11, NumPy, ffmpeg, Node `node:test`, pytest.

**Plan status:** Revised after Fable approach review (2026-07-13). Key decisions locked below: Windows recording close **minimizes** (keeps taskbar + overlay); macOS uses a **static** red active icon + `REC` (no halo pulse); spool backpressure uses a **larger queue + sustained-stall** policy; interrupted-capture recovery is **async after window creation** and mutually exclusive with starting a new recording.

## Global Constraints

- Keep transcription, recording, reminders, and diagnostics local; add no telemetry or background uploads.
- The main-process recorder remains the authority for `starting`, `recording`, `stopping`, and `idle` capture state.
- Remind after 60 minutes and every 60 minutes thereafter, based on the authoritative backend start timestamp rather than renderer interval ticks.
- Never automatically stop a recording because of duration; an automatic cutoff can destroy a legitimate long meeting.
- Do not add a tray `Stop Recording` action in Release 1. The renderer currently owns stop, transcription, and history persistence as one flow.
- Do not use taskbar flashing, Dock bouncing, or animated menu-bar frames. Use persistent state only: a static macOS red active menu-bar icon plus `REC` text, a supplemental Dock badge when permitted, a Windows taskbar overlay (requires a visible taskbar button), tray copy, and an in-app pill.
- While recording on Windows, the recording-aware close action must **minimize** the window (not `hide()`), so the taskbar button and overlay remain visible. Idle close may still hide to tray as today. macOS may continue to hide to the menu bar while recording.
- Preserve 48 kHz stereo output, mono-compatible downmix behavior, gentle mic enhancement, desktop fidelity, Windows timestamp-gap semantics, macOS one-sided stereo repair, and late desktop-failure degradation to mic-only.
- Preserve the structured recorder stdout JSON contract. stderr remains debug-only.
- Keep `productName`, `appId`, the Electron `userData` identity, artifact names, and updater matching stable. Descriptive display/shortcut labels may change without renaming storage.
- Release 2 must not reintroduce real-time mixing. Mic and desktop tracks remain separate until bounded post-processing.
- Release 2 must not expose raw capture-track files as meeting audio or let scan-import treat them as meetings.
- Release 2 spool backpressure must not hard-stop a live meeting on a brief disk stall. Prefer a larger bounded queue and error only after sustained writer stall; document the larger kill-loss window.
- Interrupted-capture recovery must not block first paint or a new recording start: run it async after window creation, surface progress through the presence service, and reject or queue new `start-recording` while recovery owns the recordings directory.

---

## Product Decision

The feedback describes three related failures:

1. **Recall:** "AvaNevis" is memorable only after the user already knows the brand.
2. **Presence:** the current recording signal disappears when the window is hidden or another tab is selected.
3. **Safety:** a forgotten recording grows Python RAM for its entire duration and may have no recoverable capture file if the process is killed before post-processing.

The best response is layered:

| Layer | Shipped behavior |
|---|---|
| Persistent OS presence | macOS static red active menu-bar icon plus `REC` text and a supplemental Dock badge when permitted; Windows red recording overlay on a still-visible taskbar button; recording-aware tray tooltip/menu on both platforms |
| Periodic interruption | Native reminder at 1 hour, then every hour, with elapsed time and click-to-open behavior |
| In-app presence | Recording pill and elapsed clock in the top bar on Record, History, and Settings |
| Accidental-close protection | Recording-specific close dialog: Windows default keeps capture going via **minimize** (taskbar + overlay stay); macOS default keeps capture going via hide-to-menu-bar |
| Rediscovery | Purpose-based renderer and package descriptions plus packaged Spotlight/Start search experiments, while retaining AvaNevis product/storage/Windows shortcut identity |
| Duplicate-instance protection | Relaunching AvaNevis reveals the existing window instead of creating a second process/tray icon |
| Underlying safety | Progressive separate-track disk capture, bounded finalization, and interrupted-session recovery |

Native notifications are best-effort because Focus modes and OS settings can suppress them. On Windows, a fully hidden window has no taskbar button, so `setOverlayIcon` disappears and the tray icon often sits in the overflow flyout — that is not a sufficient sole signal. Release 1 therefore **minimizes while recording on Windows** so overlay + taskbar remain, and still uses tray copy plus best-effort toasts as secondary signals. The permission-independent macOS menu-bar indicator and in-app pill remain required; the macOS Dock badge is supplemental.

## Success Criteria

- Hiding or minimizing AvaNevis during a recording leaves an unmistakable recording signal on both supported platforms: macOS menu-bar red icon + `REC`; Windows taskbar overlay on a still-present taskbar button (minimize-while-recording), plus tray status copy on both.
- While the machine is awake, one reminder is generated at each 60-minute milestone; after sleep, missed milestones are coalesced into one current reminder instead of a burst.
- Clicking a reminder or relaunching the app restores, shows, and focuses the existing window.
- The elapsed time comes from the recorder's `recording_started` event and renders as `H:MM:SS` after one hour.
- Stopping or failure clears reminder timers, menu-bar text, any permitted Dock badge, Windows overlay, tray recording copy, and in-app capture presence.
- Release 1 changes no recorder audio output and passes `npm test` plus the platform presence checklist, including a Windows packaged spike for overlay-when-minimized, tray overflow reality, and toast CLSID on the installed shortcut.
- After Release 2, capture RAM and stop-time RAM remain bounded for a 4-hour recording, and killing the recorder during capture leaves tracks that can be finalized after relaunch.
- Release 2 recovery never blocks first window paint; a new recording cannot start while recovery owns the recordings directory.
- Release 2's short-fixture outputs remain equivalent to the existing path within the documented sample/timing tolerances before the RAM path is removed.

## File Structure

### Pre-Release 1 gates

- Modify plan evidence / checklist notes only until gates pass: snapshot current tray/close behavior; Windows packaged presence + toast CLSID spike; confirm `requestSingleInstanceLock` behavior with `npm start` alongside an installed build.

### Release 1: Recording Awareness

- Create `src/main/recording-presence-service.js`: tray state, macOS static active icon, Dock/taskbar state, hourly reminder scheduling, and pure presentation builders.
- Create `tests/js/recording-presence-service.test.js`: dependency-injected service behavior and timer tests.
- Create `tests/js/recording-presence-packaging.test.js`: app identity labels and Windows overlay resource assertions.
- Create `build/recording-overlay.png`: transparent 16x16 Windows taskbar overlay with a solid red record dot and a one-pixel light border.
- Create `build/iconRecording.png` and `build/iconRecording@2x.png`: macOS non-template active-state menu-bar icons with a red recording dot (static; no glow frames).
- Modify `src/main/recorder-service.js`: publish authoritative lifecycle changes and return `startedAt` from start.
- Modify `src/main.js`: compose the presence service, enforce one instance, restore/focus the window, set Windows AppUserModelID, and use recording-aware close copy (Windows minimize while recording).
- Modify `src/renderer/index.html`: top-bar recording pill, descriptive subtitle/title.
- Modify `src/renderer/styles.css`: recording/stopping pill states.
- Modify `src/renderer/app.js`: use authoritative start time and render global presence.
- Modify `src/renderer/formatters.js`: add elapsed-clock formatting without changing transcript timestamp formatting.
- Modify `src/preload.js`: expose recorder-state hydration after renderer reload/recreation.
- Modify `package.json`: bundle the overlay and active icons, improve the purpose-based description, and test a macOS display label without changing `productName`, Windows shortcut identity, or `appId`.
- Modify `tests/js/quit-lifecycle.behavioral.test.js`, `tests/js/recording-state-helpers.test.js`, and `tests/js/formatters.test.js`: lifecycle and renderer regression coverage.
- Modify `tests/js/ipc-contract-snapshot.test.js`: pin the new `get-recording-state` hydration channel.
- Modify `tests/manual/recording-smoke-checklist.md`: supported-platform presence/reminder checks.
- Modify `AGENTS.md` and `docs/initiatives/ROADMAP.md`: document the new service and shipped behavior.

### Release 2: Long-Recording Safety

- Create `docs/initiatives/LONG_RECORDING_SAFETY.md`: measured baseline, selected spool format, rollout evidence, and recovery contract.
- Create `backend/audio/capture_manifest.py`: versioned atomic manifest reads/writes and capture-session paths.
- Create `backend/audio/track_spool.py`: bounded callback queue, segmented raw PCM writer, timeline-aware writes, flush, and close.
- Create `backend/audio/streaming_post_processor.py`: bounded normalization, repair, mix, recoverable WAV/RF64 output, and Opus finalization.
- Create `backend/audio/capture_recovery.py`: validate and finalize interrupted capture manifests.
- Create `tests/python/test_capture_manifest.py`, `test_track_spool.py`, `test_streaming_post_processor.py`, and `test_capture_recovery.py`.
- Modify both platform recorders and macOS desktop helper bridges to send chunks to track spools instead of retaining complete recordings.
- Modify `src/main/device-ipc.js`: replace shell disk probes with Node filesystem stats and use a realistic recording reserve warning.
- Modify `src/main/recorder-service.js`: structured stop stages and interrupted-capture recovery orchestration (async, mutually exclusive with new recording).
- Modify meeting scan/recovery code so capture directories are never imported as meeting audio.
- Modify recorder contract, timeline, processor, temp-recovery, and manual long-recording tests.

---

## Before Coding Release 1

Complete these gates before Task 1 implementation. They change dialog copy, assets, and overlay claims.

- [ ] **Gate A — Snapshot current tray/close behavior.** Read `createTray()` and `mainWindow.on('close')` in `src/main.js` (~1037–1163). Record preserved labels and semantics:
  - Tray menu today: `Show/Hide Window`, separator, `Quit`; tooltip `AvaNevis`; click toggles show/hide.
  - Idle close dialog today: title `Minimize to Tray`; buttons `Minimize to Tray` / `Close App` / `Cancel` (default minimize → `hide()`).
  - Diff the presence-service takeover against this snapshot so items are not silently dropped.
- [ ] **Gate B — Windows hidden vs minimized (locked).** While `state === 'recording'|'starting'|'stopping'`, Windows close default is **Minimize** (`mainWindow.minimize()`), not hide, so the taskbar button and overlay remain. Idle/generic close may still hide to tray. Dialog button copy: `Keep Recording Minimized`, `Stop and Quit`, `Cancel`.
- [ ] **Gate C — Windows packaged spike (before Task 3 asset/work completion).** On an installed NSIS build, verify: overlay visible when minimized; overlay gone when fully hidden (documents why Gate B exists); tray overflow default behavior; toast CLSID present on the installed shortcut / toast registration; `setAppUserModelId('com.avanevis.app')` matches the shortcut. Do not treat package.json source assertions alone as proof of Action Center delivery.
- [ ] **Gate D — Single-instance collision.** Confirm `requestSingleInstanceLock` behavior when `npm start` runs alongside an installed packaged build; document which instance wins and that the secondary exits without a second tray.
- [ ] **Gate E — macOS icon (locked).** Ship static `iconRecording.png` / `@2x` only. No glow frames, no 1,200 ms `setImage` interval, no reduced-transparency animation branch beyond showing the same static red icon.

---

## Release 1: Recording Awareness

### Task 0: Presence Baseline Snapshot And Windows Spike Evidence

**Files:**
- Modify: `tests/manual/recording-smoke-checklist.md` (add Gate C evidence section)
- Optionally note findings in `docs/initiatives/ROADMAP.md` if the spike changes packaging assumptions

**Interfaces:**
- Consumes: current `src/main.js` tray/close behavior and one Windows packaged build.
- Produces: checklist evidence that Gate A–E are satisfied before Tasks 1–3 land.

- [ ] **Step 1: Write the tray/close snapshot into the manual checklist**

Paste the Gate A labels so implementers can diff against them during the service takeover.

- [ ] **Step 2: Run the Windows packaged spike**

Build with `npm run build:dir` (or full NSIS when toast registration must be inspected). Record overlay-minimized vs overlay-hidden, tray overflow, and toast CLSID results.

- [ ] **Step 3: Commit checklist evidence only**

```bash
git add tests/manual/recording-smoke-checklist.md docs/initiatives/ROADMAP.md
git commit -m "docs: record recording presence baseline gates"
```

### Task 1: Recording Presence Service

**Files:**
- Create: `src/main/recording-presence-service.js`
- Create: `tests/js/recording-presence-service.test.js`

**Interfaces:**
- Consumes: Electron `app`, `Menu`, `Tray`, `Notification`, `nativeImage`; callbacks `getMainWindow()` and `showMainWindow()`; injected `now()`, `setTimeoutFn()`, `clearTimeoutFn()`, `setIntervalFn()`, and `clearIntervalFn()` for deterministic tests.
- Produces: `createRecordingPresenceService(deps)` returning `createTray()`, `updateCaptureState(nextState)`, `getCaptureState()`, and `destroy()`.
- State shape: `{ state: 'idle'|'starting'|'recording'|'stopping', sessionId: number|null, startedAt: number|null }`.
- Pure exports: `getNextReminderAt(startedAt, now, intervalMs)`, `buildReminderCopy(elapsedMs)`, `buildTrayView(state, now)`, and `buildWindowCloseDialogOptions(state)`.

- [ ] **Step 1: Write failing scheduler and presentation tests**

```js
test('getNextReminderAt schedules the next unmissed hourly milestone', () => {
  assert.equal(getNextReminderAt(1_000, 1_000, 3_600_000), 3_601_000);
  assert.equal(getNextReminderAt(1_000, 3_701_000, 3_600_000), 7_201_000);
});

test('recording state schedules one reminder and clears it on stopping', () => {
  const timers = [];
  const service = createRecordingPresenceService(createDeps({
    now: () => 1_000,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
  }));

  service.updateCaptureState({ state: 'recording', sessionId: 7, startedAt: 1_000 });
  assert.equal(timers[0].delay, 3_600_000);
  service.updateCaptureState({ state: 'stopping', sessionId: 7, startedAt: 1_000 });
  assert.equal(timers[0].cleared, true);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the service does not exist**

Run: `node --test tests/js/recording-presence-service.test.js`

Expected: FAIL with `Cannot find module '../../src/main/recording-presence-service'`.

- [ ] **Step 3: Implement state and absolute reminder scheduling**

Use this public skeleton and keep reminder calculation independent of timer tick count:

```js
const RECORDING_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

function getNextReminderAt(startedAt, now, intervalMs = RECORDING_REMINDER_INTERVAL_MS) {
  const completedIntervals = Math.floor(Math.max(0, now - startedAt) / intervalMs);
  return startedAt + ((completedIntervals + 1) * intervalMs);
}

function buildReminderCopy(elapsedMs) {
  const hours = Math.max(1, Math.floor(elapsedMs / RECORDING_REMINDER_INTERVAL_MS));
  return {
    title: 'AvaNevis is still recording',
    body: `Recording has been active for ${hours} ${hours === 1 ? 'hour' : 'hours'}. Open AvaNevis to stop and transcribe when you are finished.`,
  };
}
```

When a reminder timer fires, re-read current state and `now()`. Show at most one notification for the latest crossed milestone, then schedule the next future milestone. Verify `sessionId`, `state === 'recording'`, and unchanged `startedAt` before showing it. This prevents stale-session reminders and sleep/wake notification bursts.

- [ ] **Step 4: Implement persistent platform presentation**

`buildTrayView()` must return these labels:

```js
// Idle
{ title: '', tooltip: 'AvaNevis - Private meeting recorder and transcriber', statusLabel: 'Ready' }

// Recording
{ title: 'REC', tooltip: 'AvaNevis - Recording (1:02:03)', statusLabel: 'REC  Recording - 1:02:03', trayImage: 'recording' }

// Stopping
{ title: '', tooltip: 'AvaNevis - Finishing recording', statusLabel: 'Finishing recording...' }
```

Apply the view as follows:

- macOS: load the static active icon with `nativeImage.createFromPath()`, call `tray.setImage(activeImage)`, then `activeImage.setTemplateImage(false)` so macOS preserves the red dot instead of tinting it as a template. Keep `tray.setTitle('REC', { fontType: 'monospacedDigit' })` as the readable fallback. Do **not** animate or alternate icons.
- macOS idle restore: on stopping, idle, failure, and service destruction, restore the existing monochrome template icon with `setTemplateImage(true)` and clear the title.
- macOS Dock: attempt `app.dock.setBadge('REC')` as a supplemental signal only; Electron documents that it depends on notification permission, so the menu-bar signal is the reliable indicator.
- Windows: `mainWindow.setOverlayIcon(recordingOverlay, 'AvaNevis is recording')` only while recording/stopping and the window still has a taskbar button; clear with `setOverlayIcon(null, '')`. Overlay requires minimize-not-hide while recording (Gate B).
- `starting` presentation: use the same recording tray/overlay markers as `recording` (red icon / overlay / REC) with tooltip/status copy `Starting recording...` so the brief pre-`recording_started` window is not visually idle.
- Both: rebuild the tray menu with a disabled status row, `Show AvaNevis`, a separator, and `Quit AvaNevis`. Diff against Gate A's `Show/Hide Window` / `Quit` snapshot so behavior is intentionally replaced, not accidentally dropped.
- While recording: refresh elapsed tooltip/menu copy every 60 seconds from `startedAt`; this interval updates presentation only and never decides reminder milestones.
- Give reminders stable IDs such as `recording-reminder-<sessionId>-<hour>` and group `avanevis-recording-reminders`.
- Retain active notification objects until their `click`, `close`, or `failed` event. Instance click calls `showMainWindow()`; on Windows also register `Notification.handleActivation()` once so Action Center/cold activation does not depend on object lifetime.
- Check `Notification.isSupported()`, handle synchronous constructor/show failures, and listen for asynchronous `failed`. Log a concise warning and keep all permission-independent indicators active.
- Stopping: cancel reminders immediately, show finishing copy, keep Windows overlay until idle if the window is still minimized, and clear the active-capture Dock badge.
- Idle/failure: clear all state and presentation.

- [ ] **Step 5: Add close-dialog copy tests**

Assert recording-state dialog options are platform-aware:

- Windows recording: title/body say AvaNevis is still recording; buttons `Keep Recording Minimized`, `Stop and Quit`, `Cancel`; default is minimize (not hide).
- macOS recording: buttons `Keep Recording in Menu Bar`, `Stop and Quit`, `Cancel`; default hides to menu bar.
- Idle state preserves the existing generic minimize-to-tray / close / cancel choice from Gate A (`Minimize to Tray`, `Close App`, `Cancel`).

- [ ] **Step 6: Run the focused tests**

Run: `node --test tests/js/recording-presence-service.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the independently testable service**

```bash
git add src/main/recording-presence-service.js tests/js/recording-presence-service.test.js
git commit -m "feat: add recording presence service"
```

### Task 2: Authoritative Recorder Lifecycle Wiring

**Files:**
- Modify: `src/main/recorder-service.js:34-106,572-775,881-1055`
- Modify: `src/main.js:680-710`
- Modify: `src/preload.js:73-76`
- Modify: `tests/js/ipc-contract-snapshot.test.js`
- Modify: `tests/js/quit-lifecycle.behavioral.test.js`
- Modify: `tests/js/recorder-service.deps.test.js`

**Interfaces:**
- Consumes: optional dependency `onCaptureStateChanged(state)`; default no-op for isolated service consumers.
- Produces: the state shape from Task 1, `getCaptureState()`, `get-recording-state`, and start result `{ success: true, message, sessionId, startedAt }`.

- [ ] **Step 1: Extend recorder test dependencies with a captured lifecycle callback**

```js
const captureStates = [];
const deps = createRecorderDeps({
  onCaptureStateChanged: (state) => captureStates.push(state),
});
```

Cover these exact transitions:

- accepted start before spawn: `starting`
- structured `recording_started`: `recording` with finite `startedAt`
- stop command accepted: `stopping`
- successful close, startup failure, unexpected exit, and process error: `idle`
- stale close from an old process cannot clear a newer session

- [ ] **Step 2: Run the focused lifecycle tests and confirm the new assertions fail**

Run: `node --test tests/js/quit-lifecycle.behavioral.test.js tests/js/recorder-service.deps.test.js`

Expected: FAIL because no callback is emitted and `startedAt` is absent.

- [ ] **Step 3: Add one recorder-owned publisher**

Maintain `activeRecordingSessionId` beside `recordingSessionCounter` and route every transition through one function:

```js
function publishCaptureState(state, sessionId = activeRecordingSessionId, startedAt = recordingStartTime) {
  onCaptureStateChanged({
    state,
    sessionId: Number.isInteger(sessionId) ? sessionId : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
  });
}
```

Set `activeRecordingSessionId` when a start request is admitted. Publish `starting` before spawning, publish `recording` only from `markRecordingStarted()`, publish `stopping` when the shared stop workflow sends `stop`, and publish `idle` from terminal cleanup only when the cleanup process/session is still current.

Pass the expected process/session into terminal cleanup and capture the terminal state before resetting fields. A stale `close`/`error` callback from an older child must not publish `idle` over a newer recording.

- [ ] **Step 4: Return the backend start timestamp**

Change the successful start result to:

```js
resolve({
  success: true,
  message: 'Recording started',
  sessionId,
  startedAt: recordingStartTime,
});
```

Do not create a second timestamp in the renderer.

- [ ] **Step 5: Compose the presence callback in main**

Pass:

```js
onCaptureStateChanged: (state) => recordingPresenceService.updateCaptureState(state),
```

The presence service may be created before `app.whenReady()`, but `createTray()` and Dock/taskbar mutations must run only after readiness.

- [ ] **Step 6: Add recorder-state hydration IPC**

Register a trusted `get-recording-state` handler in the recorder service that returns a fresh copy from `getCaptureState()`. Expose `getRecordingState: () => ipcRenderer.invoke('get-recording-state')` in preload and add the invoke channel to `ipc-contract-snapshot.test.js`. Do not add a push channel: normal renderer state transitions remain owned by the current renderer, while a recreated renderer queries and resumes from the authoritative main state in Task 4. A renderer hydrated into transient `starting` or `stopping` state polls this query once per second until the authoritative state changes or the window unloads; this is lifecycle recovery, not the source of recording elapsed time. Do not impose a fixed 30-minute cap because the current stop budget scales with recording duration and can exceed an hour after a forgotten session.

- [ ] **Step 7: Run recorder and contract tests**

Run: `node --test tests/js/quit-lifecycle.behavioral.test.js tests/js/recorder-service.deps.test.js tests/js/recorder-event-contract.test.js tests/js/ipc-contract-snapshot.test.js`

Expected: PASS; no recorder stdout event names change.

- [ ] **Step 8: Commit lifecycle wiring**

```bash
git add src/main/recorder-service.js src/main.js src/preload.js tests/js/ipc-contract-snapshot.test.js tests/js/quit-lifecycle.behavioral.test.js tests/js/recorder-service.deps.test.js
git commit -m "feat: publish authoritative recording state"
```

### Task 3: Tray, Dock, Taskbar, Notifications, And Single Instance

**Files:**
- Modify: `src/main.js:10,114-129,1036-1179,1325-1376,1451-1455`
- Modify: `package.json:40-80,100-108,169-180`
- Create: `build/recording-overlay.png`
- Create: `build/iconRecording.png`
- Create: `build/iconRecording@2x.png`
- Create: `tests/js/recording-presence-packaging.test.js`

**Interfaces:**
- Consumes: Task 1 service, Task 2 lifecycle callback, and Gate C Windows spike evidence.
- Produces: `showMainWindow()` and `toggleMainWindow()` composition-root helpers.

- [ ] **Step 1: Create the Windows overlay and macOS static active icons**

Create `build/recording-overlay.png` as a transparent 16x16 PNG. Draw a centered 10px `#ef4444` circle with a 1px `#fee2e2` outline. Do not put letters in the 16px asset. Add it to `build.extraResources` at runtime path `recording-overlay.png`.

Create two 18x18 macOS active icons and matching 36x36 `@2x` versions. Both use a red `#ef4444` 8px record dot with a light 1px inner ring and a soft outer halo baked into the static asset (not animated). They must not be template images. Include both in `extraResources` so dev and packaged paths resolve identically. Do **not** create glow/pulse frames.

- [ ] **Step 2: Add packaging assertions**

```js
test('recording presence resources preserve app identity', () => {
  assert.equal(pkg.build.productName, 'AvaNevis');
  assert.equal(pkg.build.appId, 'com.avanevis.app');
  assert.equal(pkg.build.nsis.shortcutName, 'AvaNevis');
  assert.match(pkg.description, /meeting recorder.*transcriber/i);
  assert.match(pkg.build.mac.extendInfo.CFBundleDisplayName, /AvaNevis.*Meeting/i);
  assert.ok(pkg.build.extraResources.some((entry) => entry.to === 'recording-overlay.png'));
  for (const name of ['iconRecording.png', 'iconRecording@2x.png']) {
    assert.ok(pkg.build.extraResources.some((entry) => entry.to === name));
  }
  assert.equal(
    pkg.build.extraResources.some((entry) => String(entry.to || '').includes('Glow')),
    false
  );
});
```

- [ ] **Step 3: Add reliable window reveal helpers**

```js
function showMainWindow() {
  if (!appStartupComplete || !mainWindow || mainWindow.isDestroyed()) {
    revealWindowWhenReady = true;
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    // Idle toggle may hide; while capturing on Windows prefer minimize (Gate B).
    if (process.platform === 'win32' && recordingPresenceService.getCaptureState().state !== 'idle') {
      mainWindow.minimize();
      return;
    }
    mainWindow.hide();
    return;
  }
  showMainWindow();
}
```

Use these from tray click/menu, notification click, macOS `activate`, and `second-instance`.

Make `createWindow()` idempotent: if a live window exists, call `showMainWindow()` instead of constructing another. After asynchronous startup checks create the one window and set `appStartupComplete = true`, consume `revealWindowWhenReady`. This prevents a second-instance event during startup from creating a window that the readiness path then overwrites.

- [ ] **Step 4: Enforce a single app instance**

Call `app.requestSingleInstanceLock()` before readiness. A secondary instance calls `app.quit()` and does not create a window or tray. The primary registers `second-instance` and calls `showMainWindow()`.

On Windows, call `app.setAppUserModelId('com.avanevis.app')` before creating notifications so process identity matches the NSIS shortcut. Also set one checked-in stable Toast Activator GUID with `app.setToastActivatorCLSID()` before readiness; never use Electron's per-run generated CLSID in packaged builds. Packaged validation must inspect the installed shortcut and toast registration (Gate C), because a package JSON source assertion alone cannot prove Windows delivery.

- [ ] **Step 5: Replace inline tray ownership**

Remove `createTray()` from `src/main.js`. Instantiate Task 1's service with Electron dependencies and call `recordingPresenceService.createTray()` after startup checks and before `createWindow()`. Call `recordingPresenceService.destroy()` on the force/final quit path. Diff the new menu against Gate A before deleting the inline implementation.

- [ ] **Step 6: Make close behavior recording-aware**

Use `recordingPresenceService.getCaptureState()` and `buildWindowCloseDialogOptions(state)` to select dialog options.

- Recording on Windows: default `Keep Recording Minimized` → `mainWindow.minimize()` (taskbar button + overlay persist).
- Recording on macOS: default `Keep Recording in Menu Bar` → `mainWindow.hide()`.
- `Stop and Quit` calls the existing `app.quit()` flow so the established graceful stop/persist logic remains authoritative.
- `Cancel` makes no change.
- Idle: preserve Gate A buttons and `hide()` minimize-to-tray behavior.

- [ ] **Step 7: Add purpose-based discoverability without splitting Windows identity**

Set:

```json
{
  "nsis": {
    "shortcutName": "AvaNevis"
  },
  "mac": {
    "extendInfo": {
      "CFBundleDisplayName": "AvaNevis Meeting Transcriber"
    }
  }
}
```

Keep `name`, `productName`, `appId`, Windows `shortcutName`, `artifactName`, and updater token unchanged. Change the package `description` to `AvaNevis private meeting recorder and local AI transcriber`; electron-builder writes this to the Windows shortcut description and uninstall metadata, but treat Start search matching as a packaged experiment rather than a guaranteed alias. Keep the macOS `CFBundleDisplayName` experiment behind packaged Spotlight/Dock validation; if the longer name harms Dock presentation or does not improve Spotlight search, retain `AvaNevis` and rely on the visible renderer subtitle plus store/release copy instead of changing app identity.

- [ ] **Step 8: Run JS and packaging tests**

Run: `node --test tests/js/recording-presence-service.test.js tests/js/recording-presence-packaging.test.js && npm run test:syntax`

Expected: PASS.

- [ ] **Step 9: Commit OS presence**

```bash
git add src/main.js package.json build/recording-overlay.png build/iconRecording.png build/iconRecording@2x.png tests/js/recording-presence-packaging.test.js
git commit -m "feat: show recording state across desktop surfaces"
```

### Task 4: Always-Visible Renderer Presence And Correct Clock

**Files:**
- Modify: `src/renderer/index.html:7,97-103`
- Modify: `src/renderer/styles.css:340-386`
- Modify: `src/renderer/app.js:24-32,1905-1988,2074-2120,3192-3207`
- Modify: `src/renderer/recording-state-helpers.js`
- Modify: `src/renderer/formatters.js`
- Modify: `tests/js/formatters.test.js`
- Modify: `tests/js/recording-state-helpers.test.js`

**Interfaces:**
- Consumes: `startedAt` returned by `startRecording()` and `window.electronAPI.getRecordingState()` from Task 2.
- Produces: `formatElapsedDuration(totalSeconds)`, `getRecordingPresenceView(recordingState, elapsedText)`, and a top-bar element `#recording-presence`.

- [ ] **Step 1: Add failing elapsed-format tests**

```js
test('formatElapsedDuration switches to hours after 60 minutes', () => {
  assert.equal(formatElapsedDuration(0), '00:00');
  assert.equal(formatElapsedDuration(3599), '59:59');
  assert.equal(formatElapsedDuration(3600), '1:00:00');
  assert.equal(formatElapsedDuration(33000), '9:10:00');
});
```

Keep `formatTimestamp()` unchanged because transcript timestamps currently use unbounded `MM:SS` formatting.

- [ ] **Step 2: Add top-bar markup**

Place this after `.top-bar-spacer` so it remains visible on every tab:

```html
<div id="recording-presence" class="top-bar-status recording-presence" hidden aria-live="polite">
  <span class="recording-presence-dot" aria-hidden="true"></span>
  <span id="recording-presence-label">Recording</span>
  <span id="recording-presence-time" class="recording-presence-time">00:00</span>
</div>
```

Change the visible subtitle and document title to include `Meeting Recorder & Transcriber` while keeping `AvaNevis` first.

- [ ] **Step 3: Style persistent but non-distracting states**

Use the existing top-bar pill visual language. Recording uses the current red recording color and a static dot; stopping uses amber and the text `Finishing recording...`. Do not animate the top-bar dot because the record button already pulses and the OS indicators must not become distracting.

- [ ] **Step 4: Use the authoritative start time**

Replace `recordingStartTime = Date.now()` with:

```js
recordingStartTime = Number(recordingResult.startedAt) || Date.now();
```

Render the clock immediately before creating the interval, then update once per second from `Date.now() - recordingStartTime`. Update both the existing Record-tab timer and top-bar elapsed element from the same formatted value. Reset both to `00:00` on idle.

- [ ] **Step 5: Render global presence from `setRecordingState()`**

The global pill behavior is:

| Renderer state | Pill |
|---|---|
| `recording` | visible, red, elapsed clock |
| `stopping` | visible, amber, `Finishing recording...`, frozen elapsed clock |
| `starting`, `initializing`, `countdown`, `transcribing`, `idle` | hidden |

Implement the table as the pure `getRecordingPresenceView()` helper and let `app.js` only apply its returned view to injected DOM elements. Apart from Task 2's state-hydration query, normal renderer transitions remain local to the renderer, while the main presence service independently owns OS presentation.

- [ ] **Step 6: Hydrate a recreated renderer**

During renderer initialization, call `getRecordingState()` before enabling the record controls. If main reports `recording`, set `activeRecordingSessionId`, `recordingStartTime`, renderer state `recording`, start the timer/visualizer, and allow the existing Stop & Transcribe workflow. If main reports `starting` or `stopping`, show the matching busy state without enabling a second start and start the bounded one-second re-query described in Task 2. On transition to `recording`, start the timer. On transition from `stopping` to `idle`, return controls to idle and run `loadMeetingHistory({ scan: true })` because the original renderer's transcription continuation no longer exists; preserve the audio in History for explicit retry. If hydration fails, log the error and leave the UI idle; main-process `REC` presence remains authoritative.

Assert explicitly that hydrated Stop & Transcribe needs nothing from the dead renderer's in-memory state beyond the stop IPC result and settings already in `localStorage` (model size, language, device selection, etc.). Add a focused helper/regression test or checklist item that Stop after hydration uses the same IPC path as a live renderer and does not read transient fields that only the original renderer held.

- [ ] **Step 7: Run renderer tests**

Run: `node --test tests/js/formatters.test.js tests/js/recording-state-helpers.test.js tests/js/renderer-helper-characterization.test.js && npm run test:syntax`

Expected: PASS.

- [ ] **Step 8: Commit renderer presence**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/app.js src/renderer/formatters.js src/renderer/recording-state-helpers.js tests/js/formatters.test.js tests/js/recording-state-helpers.test.js
git commit -m "feat: add persistent in-app recording status"
```

### Task 5: Release 1 Documentation And Platform Validation

**Files:**
- Modify: `tests/manual/recording-smoke-checklist.md`
- Modify: `AGENTS.md`
- Modify: `docs/initiatives/ROADMAP.md`

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: release evidence for macOS and Windows.

- [ ] **Step 1: Add manual presence checks**

Add checks for:

- recording on Record, History, and Settings tabs
- Windows: minimized window keeps overlay; fully hidden window loses overlay (documents why recording close minimizes)
- macOS: hidden window keeps static red menu-bar icon + `REC` (no pulse)
- reminder at a test-overridden one-minute interval, then production 60-minute configuration
- notification click restoring a minimized/hidden window
- notifications disabled/Focus enabled while permission-independent indicators remain; on macOS, menu-bar `REC` is required even if the supplemental Dock badge is unavailable
- stop, failure, and quit clearing every indicator
- relaunch revealing the existing instance with no second tray icon; document `npm start` vs installed-build single-instance behavior (Gate D)
- macOS light/dark menu bar and Dock badge when notification permission allows it
- Windows taskbar overlay at 100%, 150%, and 200% scaling while minimized
- installed Spotlight/Start search for `AvaNevis`, `meeting`, and `transcriber`, recording actual OS behavior rather than assuming descriptive metadata is indexed
- Gate C toast CLSID / Action Center click-to-open on an installed Windows build

- [ ] **Step 2: Document architecture**

Add `src/main/recording-presence-service.js` to the main-process architecture map in `AGENTS.md`. Add Release 1 behavior to the Roadmap's shipped UI/reliability sections. Record that native reminders are best-effort and that automatic duration cutoffs are intentionally absent.

- [ ] **Step 3: Run the complete Release 1 suite**

Run: `npm test`

Expected: all JS tests and JS syntax checks pass.

- [ ] **Step 4: Run packaged manual checks on both supported platforms**

Run on macOS: `npm run build:mac:dir`

Run on Windows: `npm run build:dir`

Expected: overlay resource exists in packaged resources; installed app identity is unchanged; presence checklist passes.

- [ ] **Step 5: Commit docs and checklist**

```bash
git add tests/manual/recording-smoke-checklist.md AGENTS.md docs/initiatives/ROADMAP.md
git commit -m "docs: add recording presence validation"
```

---

## Release 2: Long-Recording Safety

Release 1 reduces forgotten sessions but does not make long sessions safe. Current capture storage is duration-proportional RAM on both platforms, and stop-time joins/resampling/mixing create more whole-recording allocations. Release 2 is complete only when both capture and finalization are bounded-memory.

### Task 6: Baseline, Disk Probe, And Visible Stop Stages

**Files:**
- Create: `docs/initiatives/LONG_RECORDING_SAFETY.md`
- Modify: `src/main/device-ipc.js:42-109`
- Modify: `src/main/recorder-service.js:71-106,744-771`
- Modify: `src/main/recording-presence-service.js`
- Modify: `backend/audio/windows_recorder.py:740-932`
- Modify: `backend/audio/macos_recorder.py:850-985`
- Modify: `src/main-process/recorder-output-helpers.js:200-278`
- Modify: `tests/js/main-process-helpers.test.js`
- Modify: `tests/js/recorder-event-contract.test.js`
- Modify: `tests/python/test_recorder_event_contract.py`
- Modify: `tests/manual/recording-smoke-checklist.md`

**Interfaces:**
- Produces structured recorder events `post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, and `post_processing_complete` with human-readable `message` fields.
- Produces disk result `{ success, availableBytes, availableGB, warning, level }` without `wmic` or `df`.

- [ ] **Step 1: Record a measured baseline**

On one supported Mac and one Windows machine, record 15-minute and 60-minute mic+desktop sessions. Record capture RSS, stop peak RSS, stop duration, raw/final disk usage, mic sample rate/channels, and desktop sample rate/channels in `LONG_RECORDING_SAFETY.md`. Use those measurements to set pass/fail evidence for the later 2-hour and 4-hour runs.

- [ ] **Step 2: Replace shell disk probes**

Use `fs.promises.statfs(recordingsDir)` and calculate:

```js
const availableBytes = Number(stats.bavail) * Number(stats.bsize);
const warning = availableBytes < (10 * 1024 * 1024 * 1024)
  ? 'Less than 10 GB is available. Long recordings may run out of space.'
  : null;
const level = availableBytes < (2 * 1024 * 1024 * 1024)
  ? 'critical'
  : (warning ? 'warning' : null);
```

Before deleting shell probes, verify Electron 42 `statfs` `bavail`/`bsize` semantics on Windows (Gate: treat unknown space as non-blocking warning if the API is wrong or missing). Return unknown space only when `statfs` fails, with a logged warning. Add injected-filesystem tests for known free space, low free space, critical free space, and probe failure. During recording, check every five minutes from the main-process recorder lifecycle, emit `recording-warning` only when crossing into warning/critical state, and use the presence service to show a best-effort native safety notification while the window may be minimized/hidden. Never auto-stop solely because a threshold was crossed; a track-spool sustained-stall failure must stop accepting new audio and preserve committed segments for recovery.

- [ ] **Step 3: Emit structured stop stages from both recorders**

Use `_send_event_message()` at equivalent Windows/macOS boundaries. Keep detailed diagnostics on stderr, but route user-visible stage names through stdout JSON. The existing default event parser can forward each `message` through `recording-progress`; add explicit parser assertions so future recorder changes cannot silently return to stderr-only progress.

- [ ] **Step 4: Update manual long-stop evidence**

Require a visible stage change during stop and record whether users can distinguish capture (`REC`) from finalization (`Finishing recording...`).

- [ ] **Step 5: Run all current suites before changing storage**

Run: `npm test && npm run test:python && npm run test:python-syntax`

Expected: PASS. Save baseline measurements in the initiative doc.

- [ ] **Step 6: Commit baseline guardrails**

```bash
git add docs/initiatives/LONG_RECORDING_SAFETY.md src/main/device-ipc.js src/main/recorder-service.js src/main/recording-presence-service.js backend/audio/windows_recorder.py backend/audio/macos_recorder.py src/main-process/recorder-output-helpers.js tests
git commit -m "feat: add long recording guardrails"
```

### Task 7: Durable Capture Manifest And Bounded Track Spool

**Files:**
- Create: `backend/audio/capture_manifest.py`
- Create: `backend/audio/track_spool.py`
- Create: `tests/python/test_capture_manifest.py`
- Create: `tests/python/test_track_spool.py`
- Modify: `backend/meetings/scan_import.py`
- Modify: `tests/python/test_recorder_temp_and_scan_recovery.py`

**Interfaces:**
- `CaptureManifest.create(output_path, started_at_ns) -> CaptureManifest`
- `manifest.add_track(name, sample_rate, channels, dtype) -> None`
- `manifest.commit_track(name, segments, committed_frames) -> None`
- `manifest.set_state('recording'|'finalizing'|'complete'|'error') -> None`
- `TrackSpool(manifest_coordinator, session_dir, track_name, sample_rate, channels, dtype, max_queue_bytes=32*1024*1024, segment_bytes=64*1024*1024, stall_timeout_s=30)`
- `TrackSpool.append(pcm, frame_position=None) -> bool`
- `TrackSpool.close(final_frame_count=None) -> TrackSpoolResult`

`frame_position`, `writtenFrames`, `committedFrames`, and `final_frame_count` always count per-channel audio frames, never interleaved scalar samples. For `channels=2`, one frame contains two samples and `frame_position * channels * dtype.itemsize` gives its byte offset.

Default `max_queue_bytes=32 MiB` (~80–90 s of stereo float32 headroom) absorbs transient Windows AV scans and disk spin-up without killing a live meeting. Document that a forced kill may lose up to roughly `stall_timeout_s` of uncommitted audio plus the in-flight queue — larger than a tiny-queue design, and accepted over mid-meeting hard-stops.

- [ ] **Step 1: Write manifest atomicity and scan-exclusion tests**

Use a session directory named `{output_stem}.capture` and manifest `{session_dir}/manifest.json`. Assert atomic replace leaves valid JSON, schema version is `1`, committed frame counts survive reload, and neither the directory nor `*.pcm.part` segments are returned by `select_scannable_audio_files()`. Add a concurrent mic/desktop commit test that repeatedly updates both tracks and proves neither track state is lost.

- [ ] **Step 2: Write bounded spool tests**

Cover sequential writes, per-channel `frame_position` silence insertion, overlap trimming, 64 MiB segment rollover with a small injected test threshold, queue-byte rejection, writer exceptions, flush/close, and a final frame count that pads the shorter track with silence. Assert that PCM byte lengths are divisible by `channels * dtype.itemsize`; do not test frame counts for channel divisibility.

The overflow / stall contract is explicit:

```python
accepted = spool.append(chunk, frame_position=position)
if not accepted:
    # append returns False only after sustained writer stall (no committedFrames
    # progress for stall_timeout_s) or hard writer exception — not on a brief
    # queue bulge that later drains.
    raise TrackSpoolBackpressureError(
        "Audio capture writer stalled; recording was stopped to preserve committed audio."
    )
```

While the queue is above a soft high-water mark, `append` may still accept until `max_queue_bytes` if the writer is making commit progress. Only after `stall_timeout_s` with no `committedFrames` advance (or a writer exception) does capture stop. Do not silently drop audio and do not block a real-time callback on disk I/O.

- [ ] **Step 3: Implement atomic manifests**

Write JSON to `manifest.json.tmp`, flush and `os.fsync()`, then `os.replace()`. One `CaptureManifestCoordinator` owns a process-wide thread lock and serializes read-modify-write commits from both track-writer threads so they cannot race on the temp path or overwrite sibling track state. It also acquires an OS-visible `session.lock` for the recorder process's entire capture/finalization lifetime. Recovery acquires that same lock non-blocking and skips any session still owned by a live recorder.

Because portable advisory locks differ (POSIX flock vs Windows `msvcrt` / lockfile+PID), implement a small cross-platform helper with explicit crash semantics: stale lock files from dead PIDs must be reclaimable; live-PID locks must be skipped. Add tests that simulate a stale lock and a live lock on both platforms (or with injected lock backends). The recovery skip-if-live guard is only as good as this primitive.

Store only relative segment names under the capture directory. Reject absolute paths, `..`, unknown schema versions, unsupported dtypes, negative/non-integral frame counts, and PCM byte lengths not aligned to the declared frame size.

Required manifest fields:

```json
{
  "schemaVersion": 1,
  "state": "recording",
  "outputStem": "recording_2026-07-13T10-00-00",
  "startedAtMonotonicNs": 123456789,
  "tracks": {
    "mic": {
      "sampleRate": 48000,
      "channels": 2,
      "dtype": "<i2",
      "firstFrameMonotonicNs": 123456999,
      "committedFrames": 0,
      "segments": []
    }
  }
}
```

- [ ] **Step 4: Implement the spool writer thread**

Callbacks copy contiguous PCM bytes into a byte-counted bounded queue and return immediately. The writer owns files, rolls segments at the configured threshold, flushes and fsyncs at least once per second, then atomically advances `committedFrames`; in-memory `writtenFrames` may be newer. The default 32 MiB queue plus sustained-stall detection bounds uncommitted loss to roughly `stall_timeout_s` under a hung writer while tolerating multi-second AV/disk stalls. Close performs a final fsync plus manifest commit. Measure actual kill loss in Task 10; if the 30-second target is missed, tighten flush cadence rather than shrinking the queue back to a few seconds of headroom.

- [ ] **Step 5: Run focused Python tests**

Run on macOS: `python3 -m pytest tests/python/test_capture_manifest.py tests/python/test_track_spool.py tests/python/test_recorder_temp_and_scan_recovery.py`

Run on Windows: `py -3.11 -m pytest tests/python/test_capture_manifest.py tests/python/test_track_spool.py tests/python/test_recorder_temp_and_scan_recovery.py`

Expected: PASS with synthetic small segments; tests allocate no hour-sized arrays.

- [ ] **Step 6: Commit spool primitives**

```bash
git add backend/audio/capture_manifest.py backend/audio/track_spool.py backend/meetings/scan_import.py tests/python
git commit -m "feat: add durable bounded audio track spools"
```

### Task 8: Platform Capture Integration Behind A Rollout Flag

**Files:**
- Modify: `backend/audio/windows_recorder.py`
- Modify: `backend/audio/macos_recorder.py`
- Modify: `backend/audio/swift_audio_capture.py`
- Modify: `backend/audio/screencapture_helper.py`
- Modify: `backend/audio/chunked_audio_buffer.py`
- Modify: `tests/python/test_timeline.py`
- Modify: `tests/python/test_screencapture_helper.py`
- Modify: `tests/python/test_macos_capture_helpers.py`
- Modify: `tests/python/test_recorder_event_contract.py`

**Interfaces:**
- Rollout flag: `AVANEVIS_CAPTURE_SPOOL=1` selects the new path until Task 10 removes the old path.
- Windows mic writes sequentially; Windows desktop converts callback timestamps to per-channel `frame_position` relative to mic capture start. Existing `timeline.py` target positions are interleaved sample counts and must be divided by channel count or replaced with a frame-based helper before use.
- macOS Swift/PyObjC helpers accept `audio_sink(chunk) -> bool`; with a sink configured, they do not retain full-session `audio_buffer` lists.

- [ ] **Step 1: Add platform parity tests before implementation**

Assert Windows timestamp gaps produce the same PCM placement as `reconstruct_desktop_timeline()` after explicitly converting its interleaved sample positions to frames. Assert macOS Swift and PyObjC sink modes preserve float32, channel shape, helper diagnostics, gap-filled helper data, and mic-only degradation after a late desktop failure.

- [ ] **Step 2: Integrate Windows spools**

Replace `mic_frames.append()` with sequential mic spool writes in the flagged path. Convert desktop callback timestamps to per-channel target frame positions using the existing mic-first-capture reference and write through the desktop spool so silence is materialized on disk, not as an in-memory timeline. On queue/write failure, set a thread-safe recorder error that the Windows CLI loop checks alongside `stop_event`; the loop must stop capture, close/commit both spools, and emit structured failure instead of raising only inside the PyAudio callback. Close both spools to the same final frame count before finalization.

- [ ] **Step 3: Integrate macOS mic spool**

Replace `ChunkedAudioBuffer` retention in the flagged path with float32 mic spool writes. Keep only the latest chunk needed by level diagnostics. Do not raise a spool error only inside the callback: record it in the recorder's thread-safe async error state so the CLI main loop exits, closes/commits both spools, and emits structured failure output.

- [ ] **Step 4: Integrate macOS desktop sinks**

Add optional sink callbacks to both desktop helper bridges. The Swift stdout reader and PyObjC sample callback pass contiguous float32 chunks to the sink and retain diagnostics counters, but no complete-session arrays. A desktop spool/sink failure is surfaced through the existing helper-failure channel and follows the current late-failure mic-only warning behavior; close/commit the desktop spool at its last valid frame instead of silently dropping queued data.

- [ ] **Step 5: Preserve the RAM path only for controlled rollout**

Default the flag off for the first development PR, run parity tests and hardware capture, then default it on for packaged QA. Do not add a user-facing setting. The old path exists only as a rollback seam and is deleted in Task 10 after 2-hour and 4-hour evidence passes.

Tasks 7-9 are development/QA stages, not user release boundaries. Do not ship a packaged release that can write schema version 1 capture manifests until Task 10 recovery is implemented and validated.

Update both CLI stdin listeners so EOF while capture is active sets the local stop event. The recorder then closes/commits spools and exits rather than becoming an orphan after Electron disappears. The cross-process `session.lock` remains the recovery guard for crashes and forced termination where EOF cleanup cannot finish.

- [ ] **Step 6: Run platform helper tests and syntax**

Run: `npm run test:python && npm run test:python-syntax`

On macOS also run: `swift build -c release --arch arm64` from `swift/AudioCaptureHelper`.

Expected: PASS.

- [ ] **Step 7: Commit platform capture integration**

```bash
git add backend/audio/windows_recorder.py backend/audio/macos_recorder.py backend/audio/swift_audio_capture.py backend/audio/screencapture_helper.py backend/audio/chunked_audio_buffer.py tests/python
git commit -m "feat: spool recorder tracks during capture"
```

### Task 9: Bounded Multi-Pass Finalization

**Files:**
- Create: `backend/audio/streaming_post_processor.py`
- Create: `tests/python/test_streaming_post_processor.py`
- Modify: `backend/audio/processor.py`
- Modify: `backend/audio/wav_io.py`
- Modify: `backend/audio/compressor.py`
- Modify: `backend/audio/windows_recorder.py`
- Modify: `backend/audio/macos_recorder.py`
- Modify: `tests/python/test_processor.py`
- Modify: `tests/python/test_wav_io.py`
- Modify: `tests/python/test_compressor.py`

**Interfaces:**
- `finalize_capture(manifest_path, output_path, ffmpeg_path='ffmpeg', progress_callback=None, chunk_frames=48000) -> FinalizationResult`
- `FinalizationResult`: `{ final_path, duration, temp_wav_path, recovered, stats }`.

- [ ] **Step 1: Characterize output equivalence with short fixtures**

Create mono, stereo, Windows multichannel, macOS multichannel, quiet-mic, clipping-mix, one-sided-mic, one-sided-desktop, initial-offset, mid-stream-gap, and unequal-length fixtures. Run each through the current whole-array path and save assertions for duration, channel count, alignment, non-silent regions, peak range, and PCM mean absolute error.

Accept only these tolerances unless the initiative doc records and approves an audible behavior change:

- duration difference: at most one output frame plus codec delay
- gap/start alignment: at most 10 ms
- channel count/sample rate: exact 2 channels at 48 kHz
- float/PCM comparison before Opus: mean absolute int16 error at most 2 samples for non-resampled fixtures

- [ ] **Step 2: Implement bounded normalization and repair passes**

Read at most `chunk_frames` per track at once. First pass computes per-channel count, sum, min, max, RMS, one-sided mic/desktop decisions, and pre-mix statistics without loading complete tracks. Preserve the current platform processing order explicitly: Windows repairs/channel-normalizes as currently characterized and enhances the mic before mixing; macOS repairs both mic and desktop, aligns/mixes, applies global mix limiting, then enhances the resulting mix or mic-only output. Record `processingProfile: 'windows-v1'|'macos-v1'` in the manifest so recovery uses the same sequence.

- [ ] **Step 3: Normalize source tracks to 48 kHz stereo on disk**

Normalize source segments to bounded 48 kHz stereo intermediates. Duplicate mono and preserve stereo. Preserve platform-specific multichannel behavior: Windows currently selects front left/right, while macOS folds center at `CENTER_CHANNEL_ATTENUATION` and remaining channels at `SURROUND_CHANNEL_ATTENUATION`; implement both as stateful chunk transforms. On Windows, preserve the current resampling quality with `soxr.ResampleStream` and carry filter state across chunks; do not resample each chunk independently. macOS capture is already opened at 48 kHz, so reject an unexpected manifest rate in characterization until an equivalent stateful macOS resampler is deliberately selected.

- [ ] **Step 4: Compute global mixed peak in a bounded pass**

Read normalized mic/desktop chunks together, apply both one-sided repair decisions and platform profile, and compute whether the existing global mix soft limiting is required. For `macos-v1`, perform an additional bounded statistics pass over the globally limited mixed signal so the current post-mix DC removal, normalization, and soft-limit decisions are known before final output. Do not write final output until all profile decisions are known.

- [ ] **Step 5: Stream the final mix to a recoverable WAV/RF64 temp**

Perform a final bounded pass, apply every selected profile transform consistently to each chunk, and stream float32 PCM to the explicitly resolved ffmpeg executable. Write the mixed temp inside `{output_stem}.capture/final.pcm.tmp`, not beside the meeting output, so ordinary scan-import cannot promote a manifest-owned partial. Use `-rf64 auto`, 48 kHz, stereo, 16-bit PCM. Verify that ffmpeg can fully decode the temp and that measured output bytes/duration match the manifest before promoting it to the root recorder temp/recovery contract or encoding Opus.

- [ ] **Step 6: Encode and clean intermediate tracks transactionally**

Create/verify Opus first. Set manifest state `complete` and store the final relative path. Only then remove normalized intermediates, capture segments, and manifest-owned `final.pcm.tmp`, then remove the empty capture directory. Cleanup is idempotent: relaunch recovery also removes these files for any `complete` manifest whose final output verifies, covering a crash after completion but before deletion. On any failure before verified completion, leave the manifest and committed tracks for recovery and emit `success:false` with a stable recoverable path when one exists.

- [ ] **Step 7: Assert bounded allocations**

Tests instrument readers and writers to reject chunk requests above `chunk_frames`; use repeated small synthetic segments to represent long duration without allocating hours of PCM. No implementation may call `b''.join`, `ChunkedAudioBuffer.to_array()`, or `np.concatenate()` across the complete recording in the spool path.

- [ ] **Step 8: Run audio regression suites**

Run: `npm run test:python && npm run test:python-syntax`

Expected: all fixture equivalence, compressor fallback, temp promotion, and recorder output tests pass.

- [ ] **Step 9: Commit bounded finalization**

```bash
git add backend/audio/streaming_post_processor.py backend/audio/processor.py backend/audio/wav_io.py backend/audio/compressor.py backend/audio/windows_recorder.py backend/audio/macos_recorder.py tests/python
git commit -m "feat: finalize recordings with bounded memory"
```

### Task 10: Interrupted Capture Recovery And Rollout Completion

**Files:**
- Create: `backend/audio/capture_recovery.py`
- Create: `tests/python/test_capture_recovery.py`
- Modify: `src/main/recorder-service.js`
- Modify: `src/main.js:1341-1349`
- Modify: `backend/meetings/scan_import.py`
- Modify: `backend/meeting_manager.py`
- Modify: `tests/python/test_recorder_temp_and_scan_recovery.py`
- Modify: `tests/python/test_meeting_manager.py`
- Modify: `tests/manual/recording-smoke-checklist.md`
- Modify: `AGENTS.md`
- Modify: `docs/initiatives/LONG_RECORDING_SAFETY.md`

**Interfaces:**
- CLI: `python -m audio.capture_recovery --recordings-dir <dir> --ffmpeg <path>`.
- JSON result: `{ success, recovered: [{ captureDir, audioPath, duration }], failed: [{ captureDir, code, message }] }`.
- Main service: `recoverInterruptedCaptures() -> Promise<RecoveryResult>` starts **after** window creation (never blocks first paint), reports progress through the presence service / `recording-progress`, and is mutually exclusive with `start-recording`.

- [ ] **Step 1: Add kill-point recovery tests**

Create fixture manifests representing interruption during capture, concurrent mic/desktop commit, segment flush, normalization, mix, Opus encode, and after final output verification but before manifest completion. Assert recovery resumes from committed per-channel frame extents, never imports an individual track or manifest-owned temp, never deletes a verified final output, and leaves failed sessions available for retry.

- [ ] **Step 2: Implement recovery CLI**

Acquire the same OS-visible `session.lock` used by the live recorder in non-blocking mode. Skip locked sessions instead of mutating them. For acquired sessions, validate every relative segment and frame alignment, mark stale `recording` sessions as `finalizing`, and call `finalize_capture()`. Emit one final JSON result on stdout; diagnostics stay on stderr. Do not trust paths outside the requested recordings directory.

- [ ] **Step 3: Run recovery async after window creation, mutually exclusive with new recording**

Add `recoverInterruptedCaptures()` to the recorder service. Invoke it from `src/main.js` **after** `createWindow()` / startup UI is up, not before the history scan blocks first paint. Preferred order:

1. Create window and tray/presence.
2. Kick off recovery in the background; presence/status copy may show `Recovering interrupted recording...` when work is found.
3. When recovery finishes successfully, trigger or allow the normal meeting scan/import path so recovered files become History entries (one source of truth for meeting IDs).
4. While recovery is in flight (`recoveryInProgress === true`), `start-recording` must reject with a clear user-facing message (recovery yields to no new capture; the user waits or cancels recovery only if a future cancel IPC is added — v1: no cancel, just wait). Do not start a second recorder that could race the same recordings directory or `session.lock` reclaim path.

Do not await multi-hour finalization inside `app.whenReady()` before showing the window.

- [ ] **Step 4: Validate real long recordings**

Run 2-hour and 4-hour mic+desktop recordings on Windows and macOS. Record capture peak RSS, stop peak RSS, stop duration, disk high-water mark, final duration, first/middle/last audio integrity, browser-speech transcription, and recovery after a forced kill at the 60-minute mark. Use the measured per-hour track/intermediate high-water values to replace Task 6's interim fixed disk thresholds with a projection based on current elapsed duration plus finalization reserve.

Pass criteria:

- capture RSS does not grow linearly with duration after warm-up
- peak Python RSS remains below 512 MiB during capture and below 1 GiB during finalization on the measured machines
- tail audio is present within 100 ms of the requested stop point
- recovered recording includes audio through the last fsynced interval, losing no more than about `stall_timeout_s` (default 30s) under forced kill — document the measured window in `LONG_RECORDING_SAFETY.md`
- no raw track or capture directory appears as a meeting
- startup with a large interrupted capture still shows the main window promptly; new recording remains blocked until recovery completes

- [ ] **Step 5: Remove the RAM path and rollout flag**

After both platform checks pass, delete `AVANEVIS_CAPTURE_SPOOL`, duration-proportional frame lists/bytearrays, complete-session concatenation paths, and obsolete tests. Update `AGENTS.md` to replace the known RAM constraint with the new capture manifest/recovery invariant.

- [ ] **Step 6: Run final CI-style validation**

Run: `npm test && npm run test:python && npm run test:python-syntax`

On macOS also run: `swift build -c release --arch arm64` from `swift/AudioCaptureHelper`.

Expected: PASS, followed by both platform manual evidence tables completed in `LONG_RECORDING_SAFETY.md`.

- [ ] **Step 7: Commit recovery and rollout completion**

```bash
git add backend/audio/capture_recovery.py backend/audio src/main/recorder-service.js src/main.js backend/meetings backend/meeting_manager.py tests AGENTS.md docs/initiatives/LONG_RECORDING_SAFETY.md
git commit -m "feat: recover interrupted long recordings"
```

---

## Deferred Ideas

These ideas are intentionally outside this initiative:

- User-configurable reminder intervals. Start with one evidence-based 60-minute default; add a setting only if users ask.
- Automatic stop based on calendar events, silence, duration, RAM, or meeting-app presence.
- Tray-level Stop, global stop hotkeys, or remote controls until stop/transcribe/history orchestration has one main-process owner.
- Real-time transcription or real-time mic/desktop mixing.
- Continuous Dock bounce, taskbar flashing, menu-bar icon animation/halo pulse, or notification sounds every few minutes. Static red active icon + `REC` is the intentional macOS signal.
- Cancelable interrupted-capture recovery UI (v1 blocks new recording until recovery finishes; add cancel only if long recoveries prove painful).
- Cloud-based reminders, account identity, or telemetry measuring recording duration.

## Rollback Boundaries

- Release 1 can be reverted without touching recorder audio or saved metadata.
- Task 8 retains the RAM path only until Task 10 hardware evidence passes.
- Capture manifests are versioned from their first use. Once a packaged build writes schema version 1, recovery support for that schema is a persisted-data compatibility requirement.
- Never delete capture segments during rollback unless a verified final audio path exists and the manifest is `complete`.

## Final Verification Matrix

| Scenario | macOS | Windows | Automated | Manual |
|---|---:|---:|---:|---:|
| Recording visible in app on every tab | Yes | Yes | Yes | Yes |
| Hidden/minimized persistent OS indicator | Menu bar static red + `REC`; Dock badge if permitted | Taskbar overlay while **minimized** (not fully hidden) + tray status | Service fakes | Packaged |
| Hourly reminder and click-to-open | Yes | Yes | Timer/notification fakes | Packaged (+ toast CLSID) |
| Notifications disabled | Menu-bar signal remains | Overlay (minimized) + tray remain | Failure fake | Packaged |
| Relaunch focuses existing session | Yes | Yes | Main helper/service | Packaged |
| Stop/failure clears state | Yes | Yes | Recorder lifecycle | Packaged |
| Startup recovery does not block first paint | Yes | Yes | Service fake + long fixture | Packaged |
| New recording blocked during recovery | Yes | Yes | Recorder service | Manual |
| 4-hour bounded capture/finalization | Yes | Yes | Synthetic chunks | Hardware |
| Kill/relaunch recovery (≤ ~stall_timeout_s loss) | Yes | Yes | Kill-point fixtures | Hardware |
| Audio quality/timing parity | Yes | Yes | Short fixtures | Listening/transcript |
