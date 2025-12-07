# macOS Audio Architecture Improvements

**Status:** Planned  
**Priority:** High (Post-v1.7.0)  
**Target:** macOS 13+ (Ventura/Sonoma)

This document outlines three key architectural improvements for the macOS audio subsystem, leveraging the capabilities of Apple's **ScreenCaptureKit (SCK)** framework.

---

## 1. Real-Time Streaming (Memory Efficiency)

### Problem

Currently, the recorder buffers all audio frames in RAM (`self.audio_buffer`) and writes to disk only when recording stops.

- **Impact:** A 2-hour meeting can consume 1-2GB of RAM.
- **Risk:** Potential OOM (Out of Memory) crashes on 8GB Macs during very long sessions.

### Solution

Implement a **Ring Buffer** or **Chunked Writer** that flushes audio to a temporary file on disk every few seconds.

### Implementation Plan

1.  **Create `WaveFileWriter` Class:**
    - Opens a `.wav` file in `wb` mode on start.
    - Accepts audio chunks (numpy arrays) via `write_chunk()`.
    - Handles thread-safe writing.
2.  **Modify `StreamDelegate`:**
    - Instead of appending to `self.audio_buffer`, push chunks to a `Queue`.
3.  **Writer Thread:**
    - Consumes chunks from `Queue`.
    - Writes to disk immediately.
4.  **Result:** RAM usage remains flat (~50MB) regardless of recording duration.

---

## 2. App-Specific Capture ("Pro" Feature)

### Problem

The current implementation captures "All System Audio". This includes unwanted sounds:

- Slack/Teams notification pings.
- Email alerts.
- System error sounds.

### Solution

Leverage ScreenCaptureKit's `SCContentFilter` to capture audio **only from specific applications** (e.g., Zoom, Teams, Chrome).

### Implementation Plan

1.  **Enumerate Windows/Apps:**
    - Use `SCShareableContent.getShareableContentWithCompletionHandler_` to list running applications.
    - Filter for relevant apps (browsers, meeting tools).
2.  **Update UI:**
    - Add a "Source" dropdown in the frontend: `[System Audio]`, `[Zoom]`, `[Chrome]`.
3.  **Update Backend:**
    - Pass `app_id` (PID) to `macos_recorder.py`.
    - Modify `SCContentFilter` to use `initWithDesktopIndependentWindow:` targeting specific `SCRunningApplication`.

---

## 3. Real-Time Mixing

### Problem

Audio mixing (Mic + Desktop) happens **after** the recording stops.

- **Impact:** Users see a "Processing..." spinner for 10-30 seconds after a long meeting.
- **UX:** Delays the "instant gratification" of seeing the transcript.

### Solution

Mix microphone and desktop audio streams in real-time buffers before writing to disk.

### Implementation Plan

1.  **Synchronization:**
    - Use timestamps from `CMSampleBuffer` (Desktop) and `sounddevice` (Mic) to align streams.
    - Handle clock drift (resampling on the fly).
2.  **Mixing Loop:**
    - Create a 100ms buffer.
    - Sum `Mic * Volume` + `Desktop * Volume`.
    - Apply soft limiter (tanh) to prevent clipping.
3.  **Write Mixed Output:**
    - Write the _mixed_ stream to disk directly.
4.  **Result:** Zero processing delay when stopping. The file is ready immediately.

---

## Summary of Benefits

| Feature         | Benefit        | User Value                                 |
| :-------------- | :------------- | :----------------------------------------- |
| **Streaming**   | Flat RAM usage | Reliability for 4+ hour meetings           |
| **App Capture** | Clean audio    | No notification sounds ruining transcripts |
| **RT Mixing**   | Instant finish | No "Processing..." wait time               |
