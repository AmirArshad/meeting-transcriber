# Long-Recording Safety

**Status: shipped in AvaNevis v2.5.0** (July 2026).

Initiative for Release 2 of the recording awareness / long-recording safety plan.
Implementation plan: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md`.
Architecture before/after (SVG + explanation): `docs/architecture/long-recording-safety-before-after.svg`, `docs/superpowers/plans/2026-07-14-capture-spool-architecture.md`.
Release notes: `docs/releases/v2.5.0.md`.

## Problem

Before Release 2, both platform recorders kept mic and desktop capture in RAM for the full session, then allocated additional whole-recording arrays during stop-time join / resample / mix. A forgotten multi-hour session could peak at several GB and leave no recoverable capture file if the process was killed before post-processing finished. Task 10 Step 6 removed that RAM path; capture now always spills to durable `{stem}.capture/` spools.

## Guardrails shipped in Task 6 (this document’s first revision)

- Disk free-space probe uses Node `fs.promises.statfs` (no `wmic` / `df`).
- Thresholds: **warning** below 10 GB free; **critical** below 2 GB free (distinct toast/body copy). Never auto-stop solely because a threshold was crossed.
- During an active recording, main checks free space every five minutes and emits `recording-warning` only when crossing into warning or escalating to critical, plus a best-effort native safety notification via the presence service.
- Both platform recorders emit structured stdout stop stages: `post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, `post_processing_complete`. stderr remains diagnostics-only.

### Windows `statfs` gate evidence (Task 6)

Recorded 2026-07-13 on Windows 10/11 (`feature/long-recording-safety-r2` development machine):

| Source | Value |
|---|---|
| `fs.promises.statfs(cwd).bavail` | `384069146` |
| `fs.promises.statfs(cwd).bsize` | `4096` |
| Computed free bytes | `bavail × bsize` = **1,465.11 GB** |
| PowerShell free-space cross-check (`D:`) | Matches the same free-space figure |

Conclusion: Electron/Node `statfs` `bavail`/`bsize` semantics are correct on this Windows host; shell `wmic`/`df` probes were safe to remove.

## Measured baseline (signed off 2026-07-14)

Hardware evidence for Release 2 was **signed off** after Mac + Windows packaged/smoke
runs (user, 2026-07-14): capture, stop finalization, recovery UX, presence, and
long-recording safety behavior all passed. Per-cell RSS / stop-duration / disk
high-water numbers were not logged into these tables; do not invent figures here.
Use the synthetic finalization harness below when a reproducible numeric baseline
is needed without hardware.

### Windows baseline

| Duration | Evidence |
|---|---|
| 15 / 60 min (and longer smoke) | Signed off — mic+desktop record → durable `{stem}.capture/` → bounded finalize → Opus; CUDA GPU + CPU-fallback transcription; recovery / History retry smoke |
| Notes | Packaged Windows smoke; spool path only (no RAM mix) |

### macOS baseline

| Duration | Evidence |
|---|---|
| 15 / 60 min (and longer smoke) | Signed off — mic+desktop record → spool → finalize → Opus; MLX transcription; presence + recovery smoke |
| Notes | Packaged macOS arm64 smoke; spool path only (no RAM mix) |

### How to measure (if re-baselining later)

1. Start AvaNevis from a terminal so Python recorder stderr is available; note the recorder PID after `recording_started`.
2. Capture process RSS at steady state mid-recording and the peak during stop/finalization (Task Manager / Activity Monitor / `ps`).
3. Time wall-clock from Stop until the final success JSON / meeting save.
4. Note mic and desktop sample rate / channel counts from recorder stderr device config lines.
5. Record temp/raw size if visible and final Opus size from the recordings folder.

### Synthetic finalization benchmark

`npm run benchmark:finalization -- --duration 60 --profile windows-v1 --desktop`
runs the real spool finalizer, ffmpeg WAV/RF64 writer, verification, and Opus encoder
against incrementally generated synthetic tracks. It reports JSON with wall time,
real-time factor, raw/final bytes, baseline RSS, and sampled peak Python RSS during
finalization. Use `--profile macos-v1`, `--no-desktop`, or `--chunk-seconds 5` for
comparison runs.

This benchmark is repeatable and does not require audio hardware. It does not
replace live capture RSS, device sample formats, audio integrity, or child ffmpeg
RSS. Do not compare wall times across different machines.

#### 2026-07-14 synthetic evidence (Windows development host)

Windows 10/11 build `26200`, Python `3.11.9`, synthetic 60-second tracks, real
ffmpeg WAV verification and Opus encoding:

| Profile | Desktop | Chunk | Wall time | Real-time factor | Sampled Python RSS increase |
|---|---:|---:|---:|---:|---:|
| `windows-v1` | yes | 1 s | 4.842 s | 0.0807 | 5.30 MiB |
| `windows-v1` | yes | 5 s | 4.859 s | 0.0810 | 11.71 MiB |
| `windows-v1` | no | 5 s | 4.629 s | 0.0772 | 12.34 MiB |
| `macos-v1` | yes | 5 s | 4.584 s | 0.0764 | 15.67 MiB |

The paired Windows mic+desktop run showed no speed benefit from five-second
chunks and increased sampled Python RSS, so the production default remains one
second. The benchmark validates bounded finalization instrumentation and provides
a reproducible measurement path alongside the signed-off hardware smoke.

### Architecture notes (durable spool path)

- Mic and desktop stay separate until post-processing mix (no real-time mixing).
- Capture **always** spills to durable `{stem}.capture/` track spools; the
  `AVANEVIS_CAPTURE_SPOOL` rollout flag and whole-session RAM mix path are removed
  (Task 10 Step 6).
- Stop finalizes via bounded `finalize_capture`; interrupted sessions recover via
  `audio.capture_recovery`. Whole-session RAM mix / `MemoryError` on that path is
  obsolete.
- **Hardware smoke:** Mac + Windows packaged/smoke, presence, and long-recording
  evidence signed off (user, 2026-07-14).

## Selected spool format (Tasks 7+)

- Session directory: `{output_stem}.capture/` with atomic `manifest.json` (schema version 1).
- Segments: relative `*.pcm.part` under the capture directory (never scan-imported as meetings).
- Manifest stores explicit UTC `startedAtIso` alongside `startedAtMonotonicNs`.
- Primitives landed: `backend/audio/capture_manifest.py`, `backend/audio/track_spool.py` (bounded queue, soft 75% warn, hard cap, stall timeout, writer-thread fsync commits **throttled to `flush_interval_s`** so `writtenFrames` may lead `committedFrames`).
- Spool path is the only capture path (flag removed in Task 10 Step 6).

## Recovery contract (Task 10; summary)

- Async discovery after window creation; never block first paint.
- User-approved `Recover Now` / `Later`; no auto-recover; no delete on dismiss/failure.
- One shared recordings-maintenance gate with scan/start; active recording always wins.
- One startup prompt per launch + one persistent banner; calm local-first copy.

## Rollout evidence checklist

- [x] Windows 15 / 60 min (and longer) hardware smoke signed off (2026-07-14; numeric RSS table not logged)
- [x] macOS 15 / 60 min (and longer) hardware smoke signed off (2026-07-14; numeric RSS table not logged)
- [x] Stop stages visible in UI (`Finishing recording...` vs live `REC`)
- [x] Disk warning / critical crossing emits once per escalation (no spam)
- [x] Task 10: long-recording / recovery / bounded-memory path signed off via Mac + Windows smoke (2026-07-14)
