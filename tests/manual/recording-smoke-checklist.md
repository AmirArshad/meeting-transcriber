# Recording Smoke Checklist

Use this checklist before and after high-risk recorder changes.

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
