# Recording and Transcription Regression Checklist

Use this lightweight checklist for any future recording, transcription, or cross-process contract change.

## 1. Run the fast automated suite

- [ ] Run `npm test`.
- [ ] Run `npm run test:python` if any Python recorder/transcriber code changed.
- [ ] Run `python3 -m py_compile backend/*.py backend/audio/*.py backend/transcription/*.py` if recorder/transcriber code changed.
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

## 4. Update evidence

- [ ] Save new representative logs if the recorder contract or error wording changes intentionally.
- [ ] Update `todo.md` with the task result and validation status.
