# macOS desktop-audio contract

The bundled Swift helper prefers CoreAudio process taps on macOS 14.2+, then Swift and PyObjC ScreenCaptureKit fallbacks. Helper stdout is raw interleaved float32 PCM only; JSON diagnostics belong on stderr. Preserve FIFO zero-fill ordering/cap, prior-buffer cadence, float32 processing, multi-buffer interleaving, bounded ready waits, and stdin-EOF shutdown.

CoreAudio requires System Audio Recording; ScreenCaptureKit requires Screen Recording. Do not conflate their preflight results. Packaged changes must retain helper build, staging, entitlements/signing, bundle inclusion, permission attribution, and transcript-level browser-speech verification.
