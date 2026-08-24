# TEMP — Linux Phase 0–2 adversarial review prompt

Disposable. Paste the fenced block below into a review session as **one** theme (do not combine with other themes from `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md`). Delete this file after the review lands.

Branch: `release/linux`. Close-off commit: `8fa8201`. Product recording must still fail closed (`linux_recorder.py` must not exist). Do not start Phase 3 until this review is done.

```text
You are reviewing AvaNevis — a privacy-first Electron desktop app (mic + desktop audio → local Whisper). Windows: faster-whisper (+ optional CUDA). macOS Apple Silicon: MLX + Swift CoreAudio tap helper. Optional local AI: exclusive Speakrs (token-free) or pyannote diarization, llama.cpp summaries. No cloud transcription / no telemetry.

Canonical contracts: root AGENTS.md. Do not invent a second architecture.

This review is the close-off of Linux Core Beta Phases 0–2 on branch release/linux (through commit 8fa8201). Phase 3 linux_recorder.py must NOT exist yet. The recorder factory must still fail closed. Do not treat scripts/linux-audio-spike.py as product capture.

Rules for this session:
- Review ONLY the theme and allowed paths below. Do not review the whole app.
- Prefer reading real code and tests over summarizing docs. Diff-scope: git diff origin/master...HEAD limited to these paths, plus the listed test files.
- The hunt list is a starting lens, NOT exhaustive. Also report performance issues, races, security/privacy gaps, platform skew, silent failures, and any other high-impact bugs you find in-scope — including ones we did not think to name.
- Output: (1) verdict, (2) ranked findings with severity / file:symbol / failure scenario / suggested fix, (3) brief “what’s solid”, (4) residual hardware smoke if relevant.
- No mega-refactor plan. No rubber stamp.

Theme: Linux Phase 0–2 close-off — Pulse device plumbing, packaged runtime, fail-closed recorder, Omarchy spike evidence vs product code.

Allowed paths only:
- scripts/linux-audio-spike.py
- scripts/run-python-tests.js
- scripts/check-python-syntax.js
- backend/audio/__init__.py
- backend/device_manager.py
- backend/device_helpers.py
- src/main/device-ipc.js
- src/main/python-runtime.js
- src/main-process/device-id-helpers.js
- src/main-process/recording-preflight-helpers.js
- src/main-process/recorder-output-helpers.js (getRecorderModule only)
- src/main/recorder-service.js (Linux preflight / spawn / argv only — do not tour stop/quit)
- build/download-manifest.js
- build/prepare-resources.js (Linux Python/ffmpeg + Speakrs skip only)
- tests/js/linux-platform-selection.test.js
- tests/js/device-ipc-linux.test.js
- tests/js/main-process-helpers.test.js (Linux preflight / getRecorderModule only)
- tests/js/recorder-service.deps.test.js (Linux fail-closed start only)
- tests/python/test_linux_device_manager.py
- tests/python/test_linux_platform_selection.py
- docs/initiatives/LINUX_SUPPORT.md (only to check claims against code)
- todo.md (only to check claims against code)

Starting lenses (not exclusive):
- Spike logic or SoundCard capture leaking into backend/audio or being treatable as linux_recorder.py
- Opaque Pulse IDs still parseInt / Number.isInteger coerced in renderer, IPC, or preflight
- Linux start-recording or getRecorderModule no longer fail-closed, or preflight canStart true
- Packaged Python resolving pulsectl/SoundCard/ffmpeg from PATH, venv, or system site-packages
- Missing Pulse / missing device errors leaking socket paths or using ERROR: prefixes that Electron surfaces raw
- HDMI unavailable ports creating capture devices the UI would treat as ready; headphone jack vs new monitor id
- Late desktop loss: SoundCard returns silence with no exception — would a future recorder miss it?
- SoundCard 0.4.6 sys.argv[1] import crash; spike --omarchy HDMI profile / rfkill not restored on failure
- Windows/macOS tests weakened or skipped to make Linux pass
- Docs claiming recording is ready, or UI copy advertising Linux capture/CUDA/add-ons
- dbus-monitor / Chromium spike leftover processes; default-sink left on a null sink

Also report any other high-impact bugs in these paths.
```
