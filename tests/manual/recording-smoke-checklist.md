# Recording Smoke Checklist

Use this checklist before and after high-risk recorder changes.

## macOS

- [ ] Record microphone + desktop audio while system audio is actively playing.
- [ ] Verify the first 10 seconds of desktop audio are present in the saved recording.
- [ ] Deny Screen Recording permission and verify the failure is explicit.
- [ ] Record with no desktop audio playing and verify the app behaves predictably.
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
