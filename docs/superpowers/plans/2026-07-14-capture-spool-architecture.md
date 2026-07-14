# Capture Spool Architecture (Before / After)

> **For agentic workers:** This is an explanatory architecture plan for the work already landing on `feature/long-recording-safety-r2`. Prefer the existing implementation plan for task execution: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md`.

**Goal:** Document how long-recording safety changes capture from duration-proportional RAM to durable segmented track spools with bounded multi-pass finalization, and record why that design is the right fit for AvaNevis.

**Architecture:** Mic and desktop remain separate during capture. Live callbacks enqueue small PCM chunks into per-track writer threads that append rolling `*.pcm.part` segments under `{stem}.capture/`, committing durable frame counts through an atomic `manifest.json`. On stop (or user-approved recovery), `streaming_post_processor.finalize_capture` reads those segments in ~1-second windows, writes normalized intermediates, mixes into recoverable `final.pcm.tmp`, encodes Opus, then cleans up only after verified completion.

**Tech Stack:** Python 3.11 recorders, NumPy, ffmpeg, Electron main-process recovery/gate UI, existing stdout JSON recorder contract.

**Diagram:** [docs/architecture/long-recording-safety-before-after.svg](../architecture/long-recording-safety-before-after.svg)

## Global Constraints

- Preserve separate mic/desktop capture and **post-stop** mixing (no real-time mix redesign).
- Preserve 48 kHz stereo output, platform processing profiles (`windows-v1` / `macos-v1`), and structured stdout stop stages.
- Never scan-import `.capture/` directories or `*.pcm.part` as meetings.
- Spool callbacks must never block or silently drop audio; fail only on hard queue cap, sustained stall, or writer exception.
- Recovery is user-approved; never auto-delete interrupted captures on dismiss/failure.
- Spool path is always on (Task 10 Step 6 removed `AVANEVIS_CAPTURE_SPOOL` and the RAM mix path).

---

## Core change vs pre-R2 RAM path

| Layer | Pre-R2 (removed) | Current (only path) |
|---|---|---|
| During capture | Append every frame into Python RAM lists / `ChunkedAudioBuffer` | Append into `TrackSpool` → disk segments + manifest |
| Peak RAM | Grows with meeting length (+ more on stop) | Bounded by spool queue (~8 MiB/track) + finalization chunk size (~1 s) |
| Crash mid-meeting | Usually nothing recoverable | Committed segments + `manifest.json` remain |
| Stop / finalize | Whole-array join / resample / mix | Multi-pass streaming over segments → `final.pcm.tmp` → Opus |
| After crash | Manual hope / orphan temps only | User-approved recovery via same finalize path |

Release 1 presence work (tray / Dock / reminders) is related product safety but **not** the audio architecture change. Release 2 audio is the core of this branch: manifests, spools, streaming finalization, recovery, disk-space guardrails.

## How the new path works

### 1. Capture (live)

```
callback PCM  →  TrackSpool.append (non-blocking queue)
              →  writer thread appends to current *.pcm.part
              →  roll new part at ~64 MiB
              →  fsync ~every 1s, then atomic manifest commit of committedFrames
```

- Session dir: `{output_stem}.capture/`
- Tracks: typically `mic` and optional `desktop`
- Queue soft warn at 75%; hard fail rather than drop samples
- Timeline gaps (especially Windows desktop) are materialized as silence **on disk**, not as giant in-memory zero arrays beyond a 1 MiB silence chunk bound

This is **segmented append**, not “record finished Opus clips and merge them later.”

### 2. Stop / finalize (bounded multi-pass)

`finalize_capture` does **not** load the whole meeting:

1. Mark manifest `finalizing`
2. Stream each track through normalize/resample/downmix into `normalized_*.f32.part` (~1 s chunks)
3. Scan stats in bounded windows (peaks, one-sided stereo decisions, enhance plans)
4. Stream aligned mix into `final.pcm.tmp` via ffmpeg
5. Encode Opus, verify decode
6. Mark `complete`, then delete intermediates / segments / capture dir

If anything fails before verified completion, committed tracks stay for recovery.

### 3. Interrupted recovery

On relaunch, discovery lists incomplete `.capture` sessions asynchronously. The user chooses **Recover Now** or **Later**. Accepted recovery re-enters the same `finalize_capture` path from committed frame extents, behind one shared recordings-maintenance gate with scan/start.

## “Chunks then merge?” — precise answer

**Yes, chunks — no, not a naive merge.**

| Stage | What “chunk” means |
|---|---|
| Live capture | Device/callback-sized PCM packets enqueued; writer rolls **64 MiB** segment files |
| Finalization | Logical stream over those segments read in **~48 000 frames (~1 s)** windows |
| Output | One continuous mixed temp → one Opus meeting file |

There is **no** step that concatenates many Opus/WAV meeting files. Segment files are raw continuity for one track; the mixer treats them as one timeline via ordered `segments` + `committedFrames`.

## Is this the best / most optimal approach?

**Best fit for AvaNevis’s constraints: yes. Absolute minimum I/O or simplest possible design: no — and that is intentional.**

### Why this design wins here

1. **Product invariant:** keep mic and desktop separate until post-processing (quality: mic enhance vs faithful desktop).
2. **Crash safety:** durable committed extents without waiting for stop.
3. **Bounded RAM:** meeting length no longer owns process RSS.
4. **Quality parity:** offline multi-pass can preserve today’s normalize / enhance / one-sided repair / mix-limit behavior.
5. **Recoverability:** fail closed on audio (never silent drop); fail open on recovery files (never delete on dismiss).

### Alternatives considered (and why not default)

| Alternative | Upside | Downside for AvaNevis |
|---|---|---|
| Keep RAM path | Simplest code | Multi-hour OOM; crash loss — the bug being fixed |
| One growing WAV per track (no segments) | Less bookkeeping | Harder atomic commit boundaries; huge single-file growth; weaker crash bookkeeping |
| Live mix to one Opus during capture | Lowest peak disk / no stop mix | Breaks separate-track processing; irreversible encode; hard recovery of “desktop late fail → mic-only” |
| Live encode per track then ffmpeg concat | Smaller disk | Lossy before mix; concat seams; still need alignment/enhance redesign |
| mmap / single spill file | Similar durability | Still need manifest + bounded finalize; less explicit commit points |

### Honest tradeoffs of the chosen path

- **Stop is multi-pass disk I/O** (normalize + stats + mix). Wall-clock stop can be longer than the old in-RAM path for the same duration; peak RAM is the win.
- **Disk usage during capture** is ~raw PCM (large) until cleanup after verified Opus.
- **Forced-kill loss window** is roughly queued audio + last uncommitted flush interval (~1 s), not “whole meeting.”
- Spool path is always on; the temporary rollout flag and RAM mix path are removed (Task 10 Step 6).

So: optimal for **safe long local meetings with preserved mix quality**, not optimal for **minimum stop latency** or **minimum temporary disk**.

## File map (already on branch)

| Responsibility | Module |
|---|---|
| Atomic manifest / session paths | `backend/audio/capture_manifest.py` |
| Bounded live spool writer | `backend/audio/track_spool.py` |
| Streaming finalize | `backend/audio/streaming_post_processor.py` |
| Interrupted recovery CLI/helpers | `backend/audio/capture_recovery.py` |
| Platform wiring (spool-only) | `backend/audio/windows_recorder.py`, `macos_recorder.py` |
| Disk warnings / stop stages / recovery IPC | `src/main/device-ipc.js`, `recorder-service.js` |
| Scan/recovery serialization | `src/main/recordings-maintenance-gate.js` |
| Initiative notes + baselines | `docs/initiatives/LONG_RECORDING_SAFETY.md` |
| Full task plan | `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md` |

## Remaining rollout (optional)

- [x] Windows/macOS hardware smoke signed off (2026-07-14; see `LONG_RECORDING_SAFETY.md`)
- [x] Delete RAM path + `AVANEVIS_CAPTURE_SPOOL` (Task 10 Step 6)
- [x] Update `AGENTS.md` capture invariant to spool/recovery
- [ ] Optional: log numeric RSS / stop-duration cells if re-baselining later

## Validation focus

```bash
npm test
npm run test:python
# targeted:
py -3.11 -m pytest tests/python/test_track_spool.py tests/python/test_streaming_post_processor.py tests/python/test_capture_recovery.py -q
node --test tests/js/recorder-service.recovery.test.js tests/js/recordings-maintenance-gate.test.js
```

Manual: record mic+desktop (no flag), confirm `{stem}.capture/` appears during capture, stop stages in UI, final Opus, then kill-mid-capture recovery prompt on relaunch.
