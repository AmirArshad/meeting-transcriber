# macOS desktop-audio contract

The bundled Swift helper prefers CoreAudio process taps on macOS 14.2+, then Swift and PyObjC ScreenCaptureKit fallbacks. Helper stdout is raw interleaved float32 PCM only; JSON diagnostics belong on stderr. Preserve FIFO zero-fill ordering/cap, prior-buffer cadence, float32 processing, multi-buffer interleaving, bounded ready waits, and stdin-EOF shutdown.

CoreAudio requires System Audio Recording; ScreenCaptureKit requires Screen Recording. Do not conflate their preflight results. Packaged changes must retain helper build, staging, entitlements/signing, bundle inclusion, permission attribution, and transcript-level browser-speech verification.

### macOS desktop audio capture

Preferred: bundled Swift `audiocapture-helper` using a **CoreAudio process tap** on macOS 14.2+. Falls back to Swift ScreenCaptureKit when tap startup fails or macOS is older; PyObjC ScreenCaptureKit is the final fallback.

**Helper contract.** stdout is raw interleaved float32 PCM and nothing else — Electron never parses it. All JSON status, diagnostics, warnings, and errors go to **stderr**, parsed by `backend/audio/swift_audio_capture.py`.

- When a delivery gap follows silence (SCK pauses; the tap may pause), the helper zero-fills into the **same FIFO** as real audio, before the resuming buffer, capped at 3 minutes — so mid-meeting silence does not collapse and writer starvation cannot reorder fill against surrounding samples. Gaps past the cap still shift later desktop audio earlier by `(gap − 180s)`: a bounded, accepted tradeoff.
- Gap detection uses the **previous buffer's frame count** as expected cadence, not a flat 100 ms threshold, and subtracts that duration to avoid +1-buffer over-fill drift.
- `swift_audio_capture.py` must keep desktop frames float32 through `samples_to_frames` — **no float64 upcast**; the mixer and stereo repair expect float32-compatible numpy arrays.
- Helper ready wait is 15 s; the outer desktop start wait is 20 s, so a boundary race still surfaces the specific helper error. Stdin EOF stops the helper (no busy-spin orphan).
- CoreAudio can expose tap input as **multiple channel buffers even when the format is not marked non-interleaved**. Preserve the helper's interleaved stdout normalization and the Python mixer's one-sided stereo repair, or desktop speech dies in the MLX/ffmpeg mono downmix.

**Permissions differ by backend — do not conflate them.** CoreAudio tap needs System Audio Recording for `com.avanevis.app.audiocapture-helper`. ScreenCaptureKit needs Screen Recording. Preflight (`check_permissions --skip-screen-recording-check`) reports `screen_recording.skipped` / `granted: null` plus an unprobed `system_audio_recording` field — **it must not claim Screen Recording was granted.** When desktop audio is missing, inspect `helperCaptureBackend`, helper diagnostics, and unified logs before blaming Screen Recording.

**Planned ≠ shipped:** `docs/initiatives/MACOS_AUDIO_ARCHITECTURE.md` describes future ideas (streaming to disk, app-specific capture). Do not treat its planned sections as current behavior.

Touching the helper pipeline means verifying: it still builds from `swift/AudioCaptureHelper`; `build/prepare-resources.js` still copies it to `build/resources/bin`; codesign/entitlements still run; electron-builder still bundles and signs `Contents/Resources/bin/audiocapture-helper`; a packaged recording with active browser audio reports `helperCaptureBackend=coreaudio_tap` on 14.2+; permission attribution survives Python recorder children running as POSIX process-group leaders; and browser speech reaches the **transcript**, not just the level meter or the saved stereo channel.
