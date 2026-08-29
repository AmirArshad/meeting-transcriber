# Recording and Transcription Regression Checklist

Use this lightweight checklist for any future recording, transcription, or cross-process contract change.

## 1. Run the fast automated suite

- [ ] Run `npm test`.
- [ ] Run `npm run test:python` if any Python recorder/transcriber code changed.
- [ ] Run `npm run test:python-syntax` (or `python scripts/check_python_syntax.py`) if recorder/transcriber/backend code changed.
- [ ] Run `swift build -c release --arch arm64` if the macOS helper or helper integration changed.

## 2. Re-check process contracts

- [ ] Recorder `stdout` remains reserved for machine-readable JSON messages/final results.
- [ ] Recorder `stderr` remains human-readable status/debug output.
- [ ] Structured recorder messages still match Electron expectations in `src/main.js`.
- [ ] Compare failure-mode output against representative fixtures in `tests/manual/fixtures/`.

## 3. Run the minimum manual flows for the touched area

- [ ] Run the relevant items from `tests/manual/recording-smoke-checklist.md`.
- [ ] Re-check quit during recording if start/stop/quit behavior changed.
- [ ] Re-check no-permission and no-desktop-audio flows if macOS capture behavior changed.
- [ ] Re-check model preload/download and transcript save flow if transcription behavior changed.
- [ ] On macOS, verify desktop speech survives the saved stereo file and the MLX mono transcription path.

## 4. Update evidence

- [ ] Save new representative logs if the recorder contract or error wording changes intentionally.
- [ ] Update `todo.md` with the task result and validation status.

## 5. Renderer visual-foundation matrix

Use this section for renderer-only visual changes. The existing recording and
transcription behavior remains the source of truth; visual approval never
replaces an interaction pass.

- [ ] At 1440x900, 1024x768, 800x700, and 560x700, visit Record, History, and Settings; confirm no clipped controls or horizontal page overflow.
- [ ] Start recording, confirm the rail and top-bar recording presence remain visible, then Stop & Transcribe and repeat with Discard.
- [ ] In History, select a meeting and exercise audio play/seek/volume, Transcript/Summary tabs, inline rename (Enter/Escape), Copy, Save, Retry, Generate Summary, and Delete.
- [ ] Navigate the rail, setup controls, recording controls, History, and Settings using the keyboard only; every interactive element has a visible focus indicator.
- [ ] Enable reduced motion in the OS and confirm pulsing, spinning, modal entrance, hover translation, and smooth scrolling no longer create sustained movement.
- [ ] Windows 10/11 smoke: system text is legible, native selects open, scrollbar/focus treatment remains visible, and no title-bar or DPI scaling collision appears at 100%, 150%, or 200%.
- [ ] macOS 14+ smoke: system typography falls back cleanly, controls retain visible focus, and the narrow History split does not overlap window chrome.
- [ ] Omarchy smoke: packaged AppImage/pacman/deb renders the same shell; Record/History/Settings remain usable; add-on cards remain visible, greyed, and fail-closed.
