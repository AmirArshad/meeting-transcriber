# Long-Recording Safety

Initiative for Release 2 of the recording awareness / long-recording safety plan.
Implementation plan: `docs/superpowers/plans/2026-07-13-recording-awareness-and-long-recording-safety.md`.

## Problem

Both platform recorders keep mic and desktop capture in RAM for the full session, then allocate additional whole-recording arrays during stop-time join / resample / mix. A forgotten multi-hour session can peak at several GB and leave no recoverable capture file if the process is killed before post-processing finishes.

## Guardrails shipped in Task 6 (this document’s first revision)

- Disk free-space probe uses Node `fs.promises.statfs` (no `wmic` / `df`).
- Thresholds: **warning** below 10 GB free; **critical** below 2 GB free. Never auto-stop solely because a threshold was crossed.
- During an active recording, main checks free space every five minutes and emits `recording-warning` only when crossing into warning or escalating to critical, plus a best-effort native safety notification via the presence service.
- Both platform recorders emit structured stdout stop stages: `post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, `post_processing_complete`. stderr remains diagnostics-only.

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

### Architecture notes (current RAM path)

- Mic and desktop stay separate until post-processing mix (no real-time mixing).
- ~2 h of 48 kHz stereo can peak at several GB during stop-time join/convert on Windows; `MemoryError` must still emit structured failure JSON.
- There is no incremental disk spill yet — Tasks 7–10 add manifests, bounded track spools, streaming finalization, and interrupted-capture recovery.

## Selected spool format (Tasks 7+)

- Session directory: `{output_stem}.capture/` with atomic `manifest.json` (schema version 1).
- Segments: relative `*.pcm.part` under the capture directory (never scan-imported as meetings).
- Manifest stores explicit UTC `startedAtIso` alongside `startedAtMonotonicNs`.
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
