# Long-Recording Safety

Initiative for Release 2 of the recording awareness / long-recording safety plan.
Implementation plan: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md`.
Architecture before/after (SVG + explanation): `docs/architecture/long-recording-safety-before-after.svg`, `docs/superpowers/plans/2026-07-14-capture-spool-architecture.md`.

## Problem

Both platform recorders keep mic and desktop capture in RAM for the full session, then allocate additional whole-recording arrays during stop-time join / resample / mix. A forgotten multi-hour session can peak at several GB and leave no recoverable capture file if the process is killed before post-processing finishes.

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

## Measured baseline (pending hardware)

Record 15-minute and 60-minute mic+desktop sessions on one supported Mac and one Windows machine. Fill the tables below before treating Task 10’s 2-hour / 4-hour runs as pass/fail evidence. Do not invent numbers.

### Windows baseline

| Duration | Capture RSS | Stop peak RSS | Stop duration | Raw/temp disk | Final Opus | Mic rate/ch | Desktop rate/ch | Notes |
|---|---|---|---|---|---|---|---|---|
| 15 min | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | |
| 60 min | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | |

### macOS baseline

| Duration | Capture RSS | Stop peak RSS | Stop duration | Raw/temp disk | Final Opus | Mic rate/ch | Desktop rate/ch | Notes |
|---|---|---|---|---|---|---|---|---|
| 15 min | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | |
| 60 min | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | |

### How to measure

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

This benchmark is repeatable and does not require audio hardware, but it is not a
replacement for the 15/60-minute capture tables or 2/4-hour hardware evidence. It
does not measure live callback behavior, capture RSS, device sample formats, audio
integrity, or child ffmpeg RSS. Do not compare wall times across different machines.

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
a reproducible measurement path; longer hardware recording evidence remains open.

### Architecture notes (current RAM path)

- Mic and desktop stay separate until post-processing mix (no real-time mixing).
- ~2 h of 48 kHz stereo can peak at several GB during stop-time join/convert on Windows; `MemoryError` must still emit structured failure JSON.
- There is no incremental disk spill on the default RAM path — Tasks 7–9 add manifests, bounded track spools, and streaming finalization behind `AVANEVIS_CAPTURE_SPOOL`; Task 10 adds interrupted-capture recovery and removes the RAM path after hardware evidence.

## Selected spool format (Tasks 7+)

- Session directory: `{output_stem}.capture/` with atomic `manifest.json` (schema version 1).
- Segments: relative `*.pcm.part` under the capture directory (never scan-imported as meetings).
- Manifest stores explicit UTC `startedAtIso` alongside `startedAtMonotonicNs`.
- Primitives landed: `backend/audio/capture_manifest.py`, `backend/audio/track_spool.py` (bounded queue, soft 75% warn, hard cap, stall timeout, writer-thread fsync commits **throttled to `flush_interval_s`** so `writtenFrames` may lead `committedFrames`).
- Rollout flag: `AVANEVIS_CAPTURE_SPOOL` (off for first integration PRs; do not ship schema v1 packaged until Task 10 recovery exists).

## Recovery contract (Task 10; summary)

- Async discovery after window creation; never block first paint.
- User-approved `Recover Now` / `Later`; no auto-recover; no delete on dismiss/failure.
- One shared recordings-maintenance gate with scan/start; active recording always wins.
- One startup prompt per launch + one persistent banner; calm local-first copy.

## Rollout evidence checklist

- [ ] Windows 15 / 60 min baselines filled
- [ ] macOS 15 / 60 min baselines filled
- [ ] Stop stages visible in UI (`Finishing recording...` vs live `REC`)
- [ ] Disk warning / critical crossing emits once per escalation (no spam)
- [ ] Task 10: 2 h / 4 h bounded-memory hardware evidence (not claimed until run)
