# TEMP — Linux Phase 3 adversarial review prompt

Disposable. Paste the fenced block below into a review session as **one** theme (do not combine with other themes from `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md`). Delete this file after the review remediations land.

Branch: `release/linux`. Phase 3 product landing is everything since `ce0a550` (`Harden Linux Phase 0–2 after adversarial review`). This Ubuntu VPS is enough for static review + automated tests. It is **not** Omarchy. Do not start Phase 4. Do not treat `scripts/linux-audio-spike.py` as the product recorder. Do not claim Phase 3 complete (Omarchy hardware smoke is still open).

```text
You are reviewing AvaNevis — a privacy-first Electron desktop app (mic + desktop audio → local Whisper). Windows: faster-whisper (+ optional CUDA). macOS Apple Silicon: MLX + Swift CoreAudio tap helper. Optional local AI: exclusive Speakrs (token-free) or pyannote diarization, llama.cpp summaries. No cloud transcription / no telemetry.

Canonical contracts: root AGENTS.md. Do not invent a second architecture. Linux Core Beta plan: docs/initiatives/LINUX_SUPPORT.md (Phase 3 + Locked decisions 2–6).

This review is the close-off of Linux Core Beta Phase 3 *product code* on branch release/linux. Diff-scope: git diff ce0a550...HEAD limited to the allowed paths (plus listed tests). linux_recorder.py now exists and fail-closed factory/preflight/start-recording gates were lifted. Omarchy hardware smoke has NOT run. Dummy-Pulse smoke was NOT run on the implementation VPS.

Rules for this session:
- Review ONLY the theme and allowed paths below. Do not review the whole app.
- Prefer reading real code and tests over summarizing docs.
- The hunt list is a starting lens, NOT exhaustive. Also report performance issues, races, security/privacy gaps, platform skew, silent failures, and any other high-impact bugs you find in-scope — including ones we did not think to name.
- Output: (1) verdict, (2) ranked findings with severity / file:symbol / failure scenario / suggested fix, (3) brief “what’s solid”, (4) residual hardware smoke if relevant.
- No mega-refactor plan. No rubber stamp.
- Do not start Phase 4 work in this session. Record remaining Omarchy smoke; do not invent a substitute for it.

Theme: Linux Phase 3 — production linux_recorder.py, linux-v1 finalization, Electron wiring, durable spools, stdout JSON contract.

Allowed paths only:
- backend/audio/linux_recorder.py
- backend/audio/__init__.py
- backend/audio/streaming_post_processor.py (linux-v1 profile helpers and mix/duration branches only)
- backend/audio/capture_manifest.py (VALID_PROCESSING_PROFILES / linux-v1 only)
- backend/audio/constants.py (LINUX_CHUNK_SIZE only)
- backend/audio/capture_recovery.py (only if Linux/linux-v1 assumptions changed)
- backend/audio/recorder_stdout.py / backend/audio/recorder_stdin.py (only as the Electron contract linux_recorder must match)
- backend/audio/track_spool.py (only if linux_recorder misuse is suspected)
- backend/device_helpers.py (parse_pulse_device_id / is_linux_desktop_off_id only)
- src/main-process/recorder-output-helpers.js (getRecorderModule + stdout parse)
- src/main-process/recording-preflight-helpers.js (Linux canStart / guidance)
- src/main/recorder-service.js (Linux spawn / argv / stop-timeout / cancel — do not tour Windows WASAPI or macOS helper internals)
- tests/python/test_linux_recorder.py
- tests/python/test_linux_platform_selection.py
- tests/python/test_recorder_event_contract.py (Linux additions)
- tests/python/test_streaming_post_processor.py (linux-v1 additions)
- tests/python/test_capture_recovery.py (linux-v1 additions)
- tests/python/test_recorder_temp_and_scan_recovery.py (POSIX/linux-v1 additions)
- tests/js/linux-platform-selection.test.js
- tests/js/recorder-event-contract.test.js
- tests/js/recorder-service.deps.test.js (Linux spawn / stop timeout)
- tests/js/main-process-helpers.test.js (getRecorderModule / Linux preflight)
- docs/initiatives/LINUX_SUPPORT.md (only to check claims against code)
- todo.md (only to check claims against code)
- AGENTS.md (Linux recorder / outputPath / factory claims only)

Starting lenses (not exclusive):
- Whole-session RAM mix or a capture array that grows with duration (lists of PCM chunks, unbounded numpy concat, level history)
- Structured control on stderr, or stdin substring matching instead of exact-token stop/cancel
- Cancel skips discarded tombstone, calls finalize_capture, or can resurrect discarded spools as meetings
- Mic-thread failure is not fatal, or desktop startup / late desktop loss hard-fails the recording
- Late desktop loss: selected pulse-monitor vanished from pulsectl source_list() — SoundCard returns silence with no exception; does the product keep spooling silence, miss the vanish, or treat a Pulse probe exception as vanished?
- Desktop SoundCard open failure becoming CAPTURE_SPOOL_OPEN_FAILED / abort instead of warning + mic-only
- Stop/finalize failure exits with only a traceback, or success:false without a recoverable path when one exists; volatile .pcm.tmp handed to Electron
- Opaque IDs still parseInt / type=int on --mic/--loopback; pulse-source / pulse-monitor / none mishandled
- linux-v1 diverges from locked mix: must stay 48 kHz stereo, macos-style fold/max-pad/one-sided repair, mic enhance BEFORE mix, faithful desktop, resample rather than macos-v1 native-48k hard-fail, mic-only degradation
- linux-v1 accidentally changing windows-v1 (mic-cap) or macos-v1 (post-mix enhance / native 48k) behavior
- Factory/preflight/start-recording still fail-closed on Linux, or Windows/macOS tests were weakened/skipped to make Linux pass
- UI/docs advertising Linux capture/CUDA/add-ons as ready beyond operational Pulse copy; add-ons no longer unsupported
- SoundCard 0.4.6 sys.argv[1] import crash; pulsectl/SoundCard imported at module level so unit tests cannot inject fakes
- Level JSON / event chunk fragmentation, multi-line stdout, or a growing live-result buffer
- Child never-closes after cancel/stop timeout permanently latches cancelling/stopping or skips force-kill
- Force-kill + next-launch recovery misses linux-v1 float32 spools or resurrects discarded linux-v1 sessions
- Preroll / alignment / includeDesktop wrong after late desktop loss (silence padded to mic duration)
- Spike script or pactl/wpctl used at product runtime

Also report any other high-impact bugs in these paths.
```
