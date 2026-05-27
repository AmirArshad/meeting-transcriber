# Feature: Acoustic Echo Cancellation (AEC)

## Status: Planned (recommended next project)

## Problem statement

This is a real, high-impact issue for speaker users (especially on macOS laptops with strong speakers and sensitive mics).

Current signal path during speaker use:

1. Desktop stream captures clean far-end speech.
2. Microphone captures near-end voice plus delayed acoustic leakage of that far-end speech.
3. Final output mixes both streams, so far-end speech is duplicated (clean + delayed leak), producing audible echo/reverb.

This degrades recording quality, transcription accuracy, and downstream diarization/summary quality.

## Clarification on terminology

The app is privacy-first and local. In this document:

- **Post-processing** means processing done after recording stops.
- **Real-time** means processing while capture is running.

Avoid calling post-processing "offline mode" to reduce confusion.

## Architecture constraints to preserve

- Keep the current product invariant: mic and desktop are still recorded separately and mixed after stop.
- Preserve structured recorder stdout JSON contracts consumed by `src/main.js`.
- Keep post-stop compression/transcription flows unchanged.

## Refined strategy (cross-platform)

## V1 (recommended): Real-time capture-time AEC on microphone path

Run AEC while recording so large speaker leakage is removed before final mix.

Important: this does **not** require real-time final mixing. Keep post-stop mix architecture intact.

Target V1 flow:

1. Capture mic stream and desktop reference stream as today.
2. During recording, feed synchronized short frames to AEC engine:
   - near-end input: mic frame
   - far-end reference: desktop frame
3. Write de-echoed mic frames to mic buffer/file.
4. At stop, run current post-mix path: de-echoed mic + clean desktop.

Why this is best for V1:

- Handles strong, dynamic speaker bleed better than post-processing-only suppression.
- Avoids a full recorder redesign.
- Preserves existing post-stop mix/compress pipeline and contracts.

## V1.5 (optional fallback): Post-processing echo suppressor

If real-time AEC cannot initialize (engine/runtime issue), optionally run a conservative post-processing suppressor before final mix and surface a warning state.

This is fallback behavior, not primary strategy.

## Engine recommendation

Primary recommendation: mature WebRTC AudioProcessing-style AEC implementation through a thin native wrapper.

Why:

- Better delay handling, double-talk protection, and residual suppression for real-world room/speaker conditions.
- More suitable for high-echo cases than lightweight spectral subtraction alone.

## Concrete implementation plan

## Phase 0 - Spike and quality gate (3-5 days)

- Validate candidate AEC engine on Windows and macOS with recorded test pairs.
- Confirm acceptable CPU cost and packaging feasibility.
- Define fixed frame size (for example 10 ms), analysis sample rate (for example 16 kHz mono), and conversion strategy from current 48 kHz/stereo capture.

Exit criteria:

- Clear quality win on loud-speaker test cases.
- No blocking packaging issue identified.

## Phase 1 - Shared AEC runtime wrapper

- Add `backend/audio/aec_runtime.py` abstraction:
  - `initialize(config)`
  - `process_frame(mic_frame, desktop_ref_frame)`
  - `flush()`
  - `close()`
- Add strict fail-safe behavior: if runtime errors, disable AEC for current recording and continue standard pipeline.

## Phase 2 - Windows integration

- Integrate frame sync/adaptation in `backend/audio/windows_recorder.py`.
- Keep timeline reconstruction for desktop reference semantics.
- Store processed mic frames for existing post-stop mix path.

## Phase 3 - macOS integration

- Integrate the same wrapper in `backend/audio/macos_recorder.py`.
- Use current startup alignment logic plus running drift correction for frame pairing.
- Ensure helper backend differences (CoreAudio tap vs ScreenCaptureKit fallback) do not break frame feeding.

## Phase 4 - UX and controls

- Add Settings control: `Echo cancellation` with `Off | Standard | Strong`.
- Add lightweight runtime status in logs/dev console (active, degraded, fallback).
- Keep headphone recommendation tip as best-practice guidance.

## Phase 5 - Validation and rollout

- Ship behind beta toggle first.
- Expand manual smoke checklist for loud-speaker scenarios on both platforms.
- Promote to default-on after quality and stability targets are met.

## Acceptance criteria

For reproducible speaker tests (quiet/moderate/noisy rooms):

- Echo reduction:
  - median ERLE improvement >= 12 dB in far-end-only segments.
- Voice preservation:
  - near-end speech loss <= 1.5 dB in double-talk segments.
- Stability:
  - no recording failures caused by AEC; clean fallback to non-AEC path.
- Performance:
  - recording CPU increase stays within acceptable platform budgets.
  - post-stop processing time does not materially regress.

## Risks and mitigations

- **Frame misalignment/drift:** implement continuous delay tracking, not one-time offset only.
- **Over-suppression of near-end voice:** enforce double-talk protection and conservative defaults.
- **Packaging complexity:** gate with spike milestone before broad integration.
- **Backend divergence:** keep one shared AEC wrapper with platform adapters only where needed.

## Decision recommendation

Make this the next project and implement **real-time capture-time AEC v1** as the primary path.

Rationale:

- Highest quality impact on core recording experience.
- Strongly addresses severe speaker leakage scenarios.
- Achievable without abandoning current post-stop mix architecture.

## References

- [WebRTC AudioProcessing](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/)
- [speexdsp-python](https://github.com/xiongyihui/speexdsp-python)
- [pyaec on PyPI](https://pypi.org/project/pyaec/)
- [aec-rs (pyaec backend)](https://github.com/thewh1teagle/aec-rs)

---

**Last Updated:** May 18, 2026
