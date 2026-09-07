# Settings, Navigation and Keyboard Shortcuts Design and Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Status:** Design only; no implementation or platform acceptance. Based on the Settings/navigation and keyboard feedback in [todo.md](../../../todo.md). Click-away meeting rename remains separate.

**Goal:** Make feature setup and page navigation clearer, and provide discoverable keyboard access to navigation and recording.

**Architecture:** Retain the existing renderer state machine and route keyboard commands through the same guarded actions as buttons. Keep preload, IPC ownership, main service admission, and Python/native execution unchanged. Correct the existing main-side Speakrs removal helper to preserve Pyannote credentials.

**Tech Stack:** Existing plain HTML/CSS/JavaScript and Electron; no new dependency.

## Global constraints

- Privacy-first, local-only processing; no telemetry, uploaded logs, or new background downloads.
- Preserve Windows x64, Apple Silicon macOS, and Linux platform gates and opaque device IDs.
- Preserve IPC payloads, facade exports, queues, cancellation, quit drain, timeouts, caches, and meeting persistence.
- Product decision (2026-09-07): removing Speakrs must never delete the saved Hugging Face token; Pyannote removal continues to delete it. Switching from Pyannote to Speakrs continues to retain it.
- Navigation must never start, stop, cancel, or install anything.
- Feature enable/disable wording must disclose downloads and deletion; it must not imply a new retained-install toggle.

## 1. Current behavior

- `src/renderer/index.html:75` contains a decorative microphone above the Record/History/Settings rail. Record uses concentric circles resembling a record action. Legacy tab buttons remain in the DOM, hidden by CSS.
- `src/renderer/app.js:1444` (`activateTab`) synchronizes both navigation surfaces and opens Settings lazily. `openSettingsAtAiAddons` at line 1479 preserves an existing setup deep link. `src/renderer/styles.css:2410` defines a single scrolling Settings page with GPU Acceleration, AI Add-ons, and About sections (`index.html:780`).
- `src/renderer/ai-addon-ui-helpers.js:54` exposes one Linux engine but leaves its radio enabled when controls are available; Windows/macOS retain the two-engine selector. Lines 137–169 define Set Up/Switch model and removal copy. Speakrs removal currently mentions tokens.
- This is a real side effect: `src/main/ai-addon-ipc.js:719` admits removal through existing queues, then `src/ai-addon/diarization-setup.js:1702` resolves the installed engine and explicitly deletes the stored token for Speakrs at line 1732. Slice A corrects this behavior and its warning together; the token belongs to Pyannote, not Speakrs.
- `src/renderer/app.js:4905` appends bounded, plain-text AI Add-on Log lines without timestamps; the general log at line 4594 already timestamps entries. Add-on progress arrives through `src/preload.js:149`.
- The primary recording button calls `handleRecordButtonClick` (`app.js:2823`), using `src/renderer/recording-state-helpers.js:2`: idle means start, recording means stop, other states ignore. Start defaults to Mic + Desktop; alternate capture modes have separate menu actions. There is no central navigation/recording shortcut dispatcher; existing key handlers serve individual controls and dialogs.
- Trace: `app.js:3372`/`:3711` → `src/preload.js:74`/`:75` → `src/main/recorder-service.js:1706`/`:2379`. Main spawns the platform recorder module at line 1927 and sends `stop\n` at line 1071. The inspected Linux endpoint parses stdin and calls stop/cancel separately in `backend/audio/linux_recorder.py:1326`. Navigation ends in the renderer; add-on actions retain their existing main-owned runtime path.

Investigation was limited to these surfaces, `AGENTS.md`, todo/index, the directly relevant `docs/development/contracts/ipc.md` and, for the approved token-retention correction, `docs/development/contracts/local-ai.md`, and the tests listed below. The removal implementation and one platform recorder endpoint were necessary additional boundary checks, not a platform-runtime audit.

## 2. User-facing change

**Recommended approach:** Keep the existing rail and Settings scroll page. Add compact section links beneath Settings: GPU Acceleration, AI Add-ons, Keyboard Shortcuts, About. These scroll and focus section headings, without creating a second router or remounting controls. A new nested Settings navigation system is unnecessary; copy-only changes would leave shortcut discovery unresolved.

- Remove the decorative microphone slot and move the Record navigation button into that first position, using the existing microphone SVG treatment. Tooltip/accessibility name: “Record page”; visible page title remains “Record”. Reserve record-circle imagery for the actual Start recording control. Do not add a new logo asset in this slice.
- On Linux, replace the single engine radio presentation with static “Engine: Speakrs” text in Settings and the adjacent Home setup prompt. It is neither clickable nor a tab stop. Keep the existing Windows/macOS radio choice and token fields.
- Use “Enable speaker identification” / “Enable summaries” for initial setup, “Check setup” for validation, and “Disable and remove…” for removal. Supporting copy explains that enabling downloads local files and removal deletes them; enabling summaries does not generate a summary. Use “Switch to Speakrs/Pyannote” when replacing an installed engine. Ready features retain their status and removal/check actions, not another Enable action.
- Speakrs removal confirmation says “Disable and remove Speakrs speaker identification from this device?” with no Hugging Face warning. It removes Speakrs files only and leaves any saved token untouched. Pyannote removal continues to warn that its saved Hugging Face token will be deleted.
- Add timestamps to AI Add-on Log entries: local date and time to seconds, sampled at receipt, preserved across page changes. This is receipt time, not backend event time. Keep logs memory-only and bounded by the existing cap; prefix each line of a multiline message with the same timestamp and render as text.

Proposed shortcuts (candidates until packaged checks pass):

| Action | Windows / Linux | macOS |
|---|---|---|
| Record page | Ctrl+Shift+1 | Command+Shift+1 |
| History | Ctrl+Shift+2 | Command+Shift+2 |
| Settings | Ctrl+Shift+3 | Command+Shift+3 |
| Start recording (Mic + Desktop) | Ctrl+Shift+R | Command+Shift+R |
| Stop and save recording | Ctrl+Shift+S | Command+Shift+S |

Display these in Settings and relevant button/rail tooltips, with matching `aria-keyshortcuts`. State “Works while AvaNevis is focused. Start uses Mic + Desktop; use the recording menu for other modes.” No global registration or promise of universal conflict freedom.

## 3. Proposed behavior

- Register one renderer dispatcher during initial UI setup, independently of lazy Settings initialization. Match the platform modifier exactly; reject extra modifiers, AltGraph, IME composition, already-handled events, and key repeats. Normalize letter case and shifted number-row keys explicitly; verify non-US layouts rather than relying solely on `event.key === '1'`.
- Suppress commands in inputs, textareas, selects, editable ancestors, and open menus/dialogs, including recovery and rename. Preserve existing Escape, Enter, arrow, and focus-trap behavior. Only consume a recognized, eligible command.
- Navigation invokes `activateTab`; focus the destination heading for keyboard navigation and Settings section jumps. Retain `aria-current`, reduced-motion scrolling, hidden legacy navigation compatibility, and the always-visible recording status. Navigation during capture or AI work does not affect that work.
- Start and Stop are separate commands, never a toggle. Share a command-admission function with mouse controls so keyboard cannot bypass disabled controls, initialization, recovery maintenance, or quit state. Start requires idle and invokes existing `startRecording('mic-and-desktop')`; Stop requires recording and invokes existing `stopRecording()`. Starting/countdown/stopping/cancelling reject both. Claim the transition synchronously before awaiting, preventing rapid duplicate commands. Background transcription must not become a new blanket recording blocker.
- Startup device/preflight errors, countdown, retries, stop progress, saved-with-errors results, and recovery continue through current UI. Stop never means Discard. No shortcut for Discard or cancelling setup. Reload must hydrate authoritative recording presence before admitting recording commands.
- Settings navigation appears immediately even while status is loading. Keep feature actions unavailable until existing status gates resolve. Preserve `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, and `unsupported` internally; use readable labels without collapsing error/unsupported into “Disabled”. Show the existing reason and permitted repair/remove actions.
- On status-read failure, show an inline retry action for the existing status refresh; do not re-register listeners or interpret failure as not installed. Leaving Settings neither cancels setup nor loses progress/log entries. Explicit setup cancellation retains existing cleanup and installed-model preservation behavior.

## 4. Technical impact and implementation plan

Two independently shippable slices share the same page shell. Neither depends on inference/model qualification plans. The approved Speakrs token-retention correction and matching removal wording ship together in slice A.

### Slice A: Settings and navigation presentation

**Files:** Modify `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/app.js`, `src/renderer/ai-addon-ui-helpers.js`, and `src/ai-addon/diarization-setup.js`; extend `tests/js/ai-addon-ui-helpers.test.js`, `tests/js/renderer-helper-characterization.test.js`, and `tests/js/ai-addon-setup.test.js`.

**Implementation:** Move/redraw the Record rail item; add section headings/links and focus handling; render Linux engine as static text in both existing surfaces; centralize feature action labels and installed-engine removal copy. Timestamp the bounded log at append time. Add status-refresh failure/retry presentation while retaining one-time listener installation. Keep existing element IDs used by setup handlers and deep links. In `removeDiarizationSetup`, remove token deletion from the Speakrs branch only; retain installed-engine resolution, Speakrs file cleanup, manifest updates, Pyannote deletion, and existing queued removal admission. Do not read/decrypt/rewrite the token for Speakrs removal. Base confirmation copy on the installed engine, not an uncommitted radio selection. Preserve token retention when switching from Pyannote to Speakrs.

**Validation:** Test Linux has no engine-selection tab stop, two-engine platforms retain radios, initial controls remain disabled, labels cover busy/error/unsupported/switch states, log timestamps survive navigation and enforce the cap, and retry does not duplicate listeners. Extend existing navigation characterization for focus and section links. Update the existing Speakrs removal test (`tests/js/ai-addon-setup.test.js:3116`), which currently expects token deletion, to assert encrypted token bytes remain identical while Speakrs is removed and its engine choice is retained. Cover removal with no token (none created), repeated removal, Pyannote removal still deleting its token, and Pyannote → Speakrs → remove Speakrs preserving credentials. Assert Speakrs confirmation has no Hugging Face/token wording and Pyannote confirmation still does.

### Slice B: Focused keyboard commands and discovery

**Files:** Create `src/renderer/keyboard-shortcut-helpers.js` and `tests/js/keyboard-shortcut-helpers.test.js`; modify `src/renderer/app.js`, `src/renderer/index.html`, `src/renderer/styles.css`; extend `tests/js/renderer-helper-characterization.test.js` and `tests/js/recording-state-helpers.test.js` as needed.

**Implementation:** Extract pure event-to-command matching into the new renderer helper, loaded before `app.js`. Keep dispatch and existing action/state ownership in `app.js`. Generate displayed bindings and accessibility hints from the same binding definition. Add the Keyboard Shortcuts section. Implement the admission, focus, suppression, and duplicate-command rules above without routing Start through the toggle handler.

**Validation:** Test command matching and rejection matrix; exercise dispatcher with spies proving navigation invokes no recording IPC, Start never becomes Stop, and Stop never invokes cancellation. Cover mouse/keyboard rapid alternation, modal/editing suppression, busy states, and reload hydration.

**Other layers:** No preload/channel changes, main service or queue changes, Python/native/catalog/dependency changes, asset packaging changes, or schema migration. Keep `avanevis-settings` values and meeting metadata untouched. Shortcuts are fixed defaults; no new stored preferences. The sole add-on lifecycle change is the approved token-retention correction in `src/ai-addon/diarization-setup.js`, covered by the local-AI contract. Existing tokens remain encrypted in safeStorage; no migration or recovery of previously deleted tokens is possible or proposed.

## 5. Risks and constraints

- The largest risk is shortcut admission bypassing button safeguards or accidentally treating Stop as Discard. Reuse current handlers and test actual dispatch, not just key matching.
- Linux Speakrs-only is not a readiness guarantee. Preserve GPU/component status, Repair plus Uninstall reachability, and fail-closed runtime behavior. Apple Silicon and Windows keep their current engine/acceleration requirements.
- App-focused bindings can still be intercepted by a compositor, OS customization, Electron menu, or development reload binding. The proposed chords are unqualified; investigate shipped menu behavior and non-US layouts during implementation. Do not claim conflict-free support from unit tests.
- Avoid hiding token deletion or suggesting disable retains downloads. Speakrs removal must leave stored credentials untouched even when they cannot currently be decrypted. No token values or additional diagnostics enter timestamps/logs.
- Preserve section scroll, tab order, minimum-window usability, zoom, and existing theme tokens. No framework, font download, or new icon package is required.

## 6. Validation outline

Focused suites: `node --test tests/js/ai-addon-ui-helpers.test.js tests/js/ai-addon-setup.test.js tests/js/renderer-helper-characterization.test.js tests/js/recording-state-helpers.test.js tests/js/ipc-contract-snapshot.test.js`; add the new shortcut suite when implemented. Run `npm test` and, before the cross-cutting implementation PR, `npm run test:all`. No runtime test success is claimed by this design.

Manual packaged checks on Windows 10/11 x64, Apple Silicon macOS, and supported Omarchy/CachyOS Linux: each binding focused/unfocused; at least one non-US layout; editable fields, native/custom dialogs and menus; held keys and rapid mouse/key commands; every capture lifecycle state; active transcription; reload during capture; Settings navigation during setup; setup failure/cancel/retry; unsupported and broken-runtime states. Confirm ordinary recordings still save/transcribe and explicit Discard stays separate. Check minimum window size, zoom, keyboard-only focus, screen-reader labels, and reduced motion. On Windows/macOS, verify Pyannote → Speakrs → remove Speakrs → Pyannote can reuse the saved token without displaying or logging it; verify explicit Pyannote removal still clears it. On Linux verify Speakrs removal works without any token requirement.

Before release, record dated app commit/build, OS/desktop/layout, chord conflicts and final bindings, screenshots of Settings/navigation states, test outputs, and recording outcomes in `docs/development/V2_10_SETTINGS_SHORTCUTS_ACCEPTANCE.md` (create during implementation). Missing hardware checks remain unverified, not inferred from CI.

## 7. Explicitly out of scope

Click-away rename; global/background shortcuts; remapping or command palette; new recording-mode defaults; Discard shortcut; retained-install enable switches; model/language selection redesign; Parakeet or summary model qualification; new platform support; queue/runtime refactoring; durable/exported logs; new branding assets. No implementation, commit, or PR is part of this design task.

## 8. Open decisions

None currently. **Resolved 2026-09-07:** the user approved preserving Hugging Face tokens when removing Speakrs. This behavior and its token-free confirmation are part of slice A; Pyannote removal remains unchanged.

Other choices above are proposed defaults, not blockers requiring an interview. Shortcut conflict/layout qualification is engineering acceptance work, not a product decision.
