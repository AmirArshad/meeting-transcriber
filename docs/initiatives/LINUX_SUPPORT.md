# Linux Support — Implementation Plan

**Status:** Planned (post-v2.6.0)  
**Target platforms (v1):** Ubuntu 22.04+/24.04, Linux Mint, Debian (bookworm+), Fedora (PipeWire)  
**Stretch / later:** Arch, SteamOS (Steam Deck), Flatpak  
**Minimum viable arch:** `linux-x64` (Intel/AMD). ARM64 deferred.  
**Related shipped work:** [LONG_RECORDING_SAFETY.md](LONG_RECORDING_SAFETY.md) (v2.5.0 spools) · [FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md](FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md) (v2.6.0) · [LOCAL_AI_MODEL_CATALOG.md](../development/LOCAL_AI_MODEL_CATALOG.md) · root [`AGENTS.md`](../../AGENTS.md)

---

## Why this plan was rewritten

The previous Linux plan (late 2025 / “v1.8.0”) assumed whole-session RAM mix, no local AI add-ons catalog, and a single “stop then transcribe” UI. Since then AvaNevis shipped:

| Shipped capability | Implication for Linux |
|---|---|
| Durable `{stem}.capture/` track spools + bounded `finalize_capture` (v2.5.0) | Linux recorder **must** use the spool path from day one — no RAM-mix prototype that later gets rewritten |
| Recording presence, discard/`cancel`, structured stdout JSON | Linux must emit the same `levels` / `event` / `warning` / `error` / stop-stage / final-result contract |
| Background transcription queue + Home Activity (v2.6.0) | Mostly shared Electron/Python; Linux must not introduce a second lifecycle. Capture exclusive during encode; Start unlocks after pending persist |
| Optional local AI add-ons (diarization + Qwen summaries via llama.cpp) | Need `linux-x64` catalog pins for llama.cpp runtime + (CUDA) pyannote/torch dependency artifacts |
| Pattern C main services + compute / GPU resource queues | Wire Linux through existing `recorder-service`, `transcription-service`, `ai-addon-ipc`, `gpu-runtime-service` — do not fork orchestration |

This document replaces the old phase/week schedule with a dependency-ordered plan aligned to current invariants.

---

## Product goals (Linux v1)

Ship a privacy-first Linux desktop build that matches Windows/macOS on the core loop:

1. Dual capture (mic + desktop) → durable spools → Opus/WAV finalize  
2. Stop → pending meeting → background transcription (Activity queue) → History  
3. Optional: local speaker labels + user-triggered local summaries  
4. Installer: **AppImage primary**, `.deb` secondary  
5. No account, no cloud transcription, no telemetry  

### Explicit non-goals for v1

- Parallel / overlapping live recordings (still one capture session)  
- Skipping Stage A encode before the next Start  
- Flatpak/Snap sandbox distribution (host Pulse access is harder; revisit later)  
- AMD ROCm transcription/diarization  
- Linux ARM64 packaged builds  
- Steam Deck as a launch gate (nice stretch smoke only)  
- Replacing History or inventing a Linux-only UX  

---

## Architecture decisions

### 1. Monorepo, same factories

Keep one repo. Platform forks stay where they already are:

| Concern | Windows | macOS | Linux (new) |
|---|---|---|---|
| Recorder | `windows_recorder.py` | `macos_recorder.py` | `linux_recorder.py` |
| Devices | WASAPI / `pyaudiowpatch` | sounddevice + virtual loopback helpers | sounddevice + Pulse/PipeWire monitor |
| Transcription | `faster-whisper` | MLX (arm64) / faster-whisper fallback | **`faster-whisper` (same as Windows)** |
| Diarization | CUDA pyannote | MPS pyannote | CUDA pyannote when ready; else unsupported |
| Summaries | llama.cpp CUDA | llama.cpp Metal | llama.cpp CUDA (CPU fallback later if needed) |
| Packaging | NSIS | DMG | AppImage + `.deb` |

Shared and unchanged by design: meeting metadata (`meeting_manager` / `meetings/`), compute queue, Activity/`transcription-queue-state`, renderer History/Activity, summary JSON schema, capture recovery / scan-import.

### 2. Audio capture: PulseAudio / PipeWire monitor

**Approach:** mic + desktop as separate tracks into `{stem}.capture/` spools (same invariant as Win/mac). Desktop = monitor source of the default (or user-selected) sink via PortAudio/`sounddevice`, optionally assisted by `pulsectl` for naming/default resolution.

**Why this works**

- PipeWire ships `pipewire-pulse`; Ubuntu/Mint/Fedora all expose monitor sources  
- No kernel modules, no VB-Cable, no native helper binary  
- Late desktop failure → warn + continue mic-only (match macOS policy)  

**Known flakiness to design for (not ignore)**

- Default sink changes mid-session (Bluetooth connect/disconnect)  
- Multiple sinks / HDMI / USB docks → wrong monitor  
- Odd sample rates → resample into shared 48 kHz spool finalize path  
- Headless / SSH sessions with no audio graph  

v1 mitigation: resolve monitor at start; if missing, offer mic-only; on desktop stream death after start, warn and continue mic-only.

### 3. Spool + finalize (hard requirement)

Linux must implement the **current** capture contract from day one. Do not prototype a whole-session RAM mixer.

Required behaviors (see `AGENTS.md` + `LONG_RECORDING_SAFETY.md`):

- Spill mic and desktop to durable `{stem}.capture/` track spools during recording  
- Stop uses bounded `finalize_capture` (platform profile `linux-v1` or reuse shared passes where possible)  
- Stdin exact-token `stop` / `cancel`; `cancel` tombstones `discarded` then cleanup — never resurrect as a meeting  
- Structured stdout: startup events, `levels`, warnings/errors, stop stages  
  (`post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, `post_processing_complete`)  
- Final success JSON must include a recoverable path (`audioPath` and/or `outputPath`; Electron already accepts both)  
- Failures emit structured `success: false` (not stderr-only exit)  
- Post-processing temps use non-scanned `.pcm.tmp`; recovery promotes to stable `{stem}.wav` before handing Electron a path  
- Interrupted sessions recover through `audio.capture_recovery` + scan-import rules  

Shared helpers to reuse: `recorder_stdout.py`, `recorder_stdin.py`, `recorder_temp_paths.py`, `finalize_capture` / streaming post-processor, compressor, wav_io, timeline.

### 4. Sequential recording & transcription queue (mostly free)

v2.6.0 already owns:

- Capture exclusive during encode  
- `addMeeting(pending)` + main-owned composite job on `aiComputeActionQueue`  
- Home Activity list, cancel pending, auto-resume pending after maintenance  
- Recording-while-transcribe priority self-lower in Python children  
- Between-job `gpuResourceActionQueue` admission for preload / GPU runtime  

**Linux work:** ensure the Linux recorder integrates with `recorder-service.js` the same way Win/mac do (session IDs, cancel mismatch, quit-during-recording). Do **not** add a Linux-specific queue. Smoke: Start → Stop → Start again while Meeting 1 is still transcribing.

### 5. Local AI add-ons on Linux

Catalog today pins only `win32-x64` and `darwin-arm64` for summary runtime and diarization dependency artifacts (`src/ai-addon-state.js`). Linux needs new pins.

| Feature | Linux v1 policy |
|---|---|
| Whisper transcription | `faster-whisper`; CUDA when probe passes; else CPU. Reuse Windows cache completeness + `AVANEVIS_TRANSCRIPTION_*` env contract |
| GPU runtime install/repair | Port or narrow `gpu-runtime-service` for Linux CUDA wheels **or** document “system CUDA + pip profile” for v1; keep mutual exclusion via `gpuResourceActionQueue` |
| Speaker diarization | Enable only when CUDA-ready + catalog Linux artifacts + user HF token (same privacy rules). No CPU-only Linux diarization in v1 (same spirit as refusing CPU macOS diarization) |
| Summaries | Pin `linux-x64` llama.cpp runtime (+ CUDA build if practical); same default model (`qwen3.5-9b-q4-k-m`) and JSON schema; user-triggered only |
| Setup validation | Stay on `createAbortableComputeAction` + `AI_COMPUTE_TIMEOUT_MS.addonValidation` |

Checksum / HTTPS / host-allowlist / HF xet download rules unchanged. Update `LOCAL_AI_MODEL_CATALOG.md` and `tests/js/ai-addon-*.test.js` when pins land.

### 6. Packaging

| Artifact | Role |
|---|---|
| **AppImage** | Primary — widest distro reach, fewer glibc fights |
| **`.deb`** | Secondary — Ubuntu/Debian convenience |
| Flatpak/Snap | Deferred (sandbox ↔ Pulse monitor friction) |

Build notes:

- Extend `build/download-manifest.js` + `build/prepare-resources.js` for Linux Python standalone + static ffmpeg  
- Build AppImage on an older Ubuntu runner for glibc compatibility (evaluate current GitHub `ubuntu-22.04` vs older image; document the chosen floor)  
- `package.json` `build.linux` targets; artifact names must stay compatible with `src/updater.js` patterns  
- Set `AVANEVIS_PACKAGED=1` for packaged children (same as other platforms)  
- Bundle/link `libportaudio`; rely on host Pulse/PipeWire  

---

## Implementation phases (dependency order)

No calendar estimates — order is technical.

### Phase 0 — Characterization gates

Before coding the recorder:

1. Confirm shared spool finalize APIs that Linux can call without forking Win/mac semantics  
2. Spike: list Pulse/PipeWire monitor sources on Ubuntu 24.04 + one PipeWire-native distro; capture 30s mic+monitor via `sounddevice`  
3. Decide Linux final JSON field (`audioPath` vs `outputPath` — either is fine; pick one and document)  
4. Inventory `process.platform === 'win32'|'darwin'` branches in `src/main/**`, presence service, GPU service, AI catalog that need `linux` arms or safe no-ops  

### Phase 1 — Device enumeration

- Add Linux path in `backend/device_manager.py` / `device_helpers.py`  
- Expose mic inputs + monitor sources as desktop/loopback choices  
- Prefer monitor of default sink; label clearly in UI  
- Mic-only when no monitor  
- Extend device IPC / preflight so Linux is not “unsupported platform”  

### Phase 2 — Linux recorder (spool-first)

- Add `backend/audio/linux_recorder.py` implementing `BaseAudioRecorder`  
- Wire factory in `backend/audio/__init__.py`  
- Dual-track spool writes; `linux-v1` finalize (or shared passes + Linux capture adapters)  
- Full stdout JSON + stdin `stop`/`cancel` contract  
- Desktop-late-failure → warn + mic-only  
- Unit/contract tests: extend `tests/js/recorder-event-contract.test.js` and `tests/python/test_recorder_event_contract.py` (+ new Linux-focused Python tests for monitor selection / cancel discard)  

### Phase 3 — Electron / presence / preflight

- `recorder-service.js`: treat Linux like other POSIX platforms for process groups; keep session/cancel/quit semantics  
- `recording-presence-service.js`: tray + notifications; no Dock badge / Windows overlay (no-op those)  
- Disk `statfs` warnings already Node-based — verify on Linux filesystems  
- Close-dialog / single-instance copy for Linux window managers  
- Preflight: skip macOS permission probes; optional Pulse/PipeWire reachability check  

### Phase 4 — Transcription + sequential queue smoke

- Confirm `get_transcriber()` → faster-whisper on Linux  
- CUDA probe path: either reuse/adapt Windows CUDA status helpers or Linux-specific probe that still feeds `resolveCudaStatusForTranscription`  
- Priority self-lower already uses `os.nice` on non-Windows — verify under concurrent record+transcribe  
- Manual smoke matrix (must pass before calling Linux “feature complete” for core loop):  
  - Record mic+desktop → History playback  
  - Discard mid-recording → no meeting  
  - Stop → Start immediately while transcription runs (Activity queue)  
  - Quit with pending job → pending survives; resume banner / auto-resume after maintenance  
  - Interrupted kill → recover spool  

### Phase 5 — Local AI add-ons (Linux catalog)

1. Pin `linux-x64` llama.cpp runtime artifact (checksum + URL)  
2. Pin Linux CUDA diarization dependency artifact (or staged install recipe matching Windows privacy rules: user token, `--token-stdin`, cleared HF token env via `buildClearedHuggingFaceTokenEnv`)  
3. Extend `getSummaryRuntimeArtifactForPlatform` / diarization dependency helpers for `linux` + `x64`  
4. UI: show setup only when platform status is `enabled`; otherwise `unsupported` with clear copy  
5. Validate: summary generate → `*.summary.json` / `*.summary.md`; guided transcription when diarization ready  

Can ship core Linux **without** Phase 5 if Settings marks add-ons unsupported — but document that as an intentional v1 cut.

### Phase 6 — Packaging + CI

1. `requirements-linux.txt`  
2. Linux pins in `download-manifest.js`; `prepare-resources.js` `IS_LINUX` path  
3. `package.json` scripts: `build:linux`, `build:linux:dir`  
4. electron-builder `linux` targets (AppImage + deb)  
5. CI workflow on Ubuntu for prepare-build + packaged smoke (launch + import check + short faster-whisper if feasible in CI)  
6. Release asset naming + `updater.js` recognition  
7. README install section (AppImage chmod + `.deb`)  

### Phase 7 — Distro QA / docs

Manual matrix (host installs, not Flatpak):

| Distro | Audio stack | Priority |
|---|---|---|
| Ubuntu 24.04 | PipeWire + pulse compat | **P0** |
| Ubuntu 22.04 | Pulse/PipeWire | **P0** |
| Linux Mint (Ubuntu base) | Pulse/PipeWire | P1 |
| Debian bookworm+ | Pulse/PipeWire | P1 |
| Fedora (current) | PipeWire | P1 |
| Arch (current) | PipeWire | P2 |
| SteamOS | PipeWire | P2 stretch |

Also update: `AGENTS.md` platform targets, `ROADMAP.md` status when work starts/ships, `tests/manual/recording-smoke-checklist.md` Linux section, legal/THIRD_PARTY as needed.

---

## File touch map (expected)

```
backend/audio/
  __init__.py                 # Linux factory branch
  linux_recorder.py           # NEW — spool-first recorder
  (shared finalize / stdout / temp helpers — extend, don't fork)

backend/device_manager.py
backend/device_helpers.py     # monitor detection / dedupe / sort

src/ai-addon-state.js         # linux-x64 runtime + diarization dependency pins
src/main/recorder-service.js  # only if Linux-specific spawn/presence edges appear
src/main/recording-presence-service.js
src/main/device-ipc.js
src/main/gpu-runtime-service.js   # Linux CUDA story
src/main/python-runtime.js        # already mostly POSIX-ready
src/updater.js                    # Linux asset patterns

build/download-manifest.js
build/prepare-resources.js
package.json                      # linux targets + scripts
requirements-linux.txt            # NEW

.github/workflows/…               # linux build / smoke
tests/js/recorder-event-contract.test.js
tests/python/test_recorder_event_contract.py
tests/js/ai-addon-*.test.js
tests/manual/recording-smoke-checklist.md
docs/development/LOCAL_AI_MODEL_CATALOG.md
AGENTS.md
```

Meeting persistence, Activity queue, and summary pipeline should need **little or no** Linux-only logic if the recorder + catalog pins are correct.

---

## Dependencies (planned)

### `requirements-linux.txt` (sketch)

```
-r requirements-common.txt   # or equivalent shared pins used by Win/mac today
sounddevice>=0.4.6
pulsectl>=23.5.0             # monitor / default-sink resolution (optional but useful)
faster-whisper==<pin matching Windows>
# plus existing shared pins: numpy, soxr, filelock, etc.
```

System / bundle:

- `libportaudio2` (bundle or declare)  
- Host `pipewire-pulse` or PulseAudio  
- Bundled static `ffmpeg`  
- Bundled CPython standalone (same prepare-resources pattern)  

---

## Feasibility notes

| Area | Assessment |
|---|---|
| Mic + monitor capture | Feasible; mature pattern (OBS-class). Moderate edge-case QA |
| Spool/finalize parity | Medium engineering — reuse shared finalize; don’t invent a second pipeline |
| Transcription queue | Low incremental cost — already main-owned and platform-agnostic |
| Summaries on Linux | Medium — mostly catalog + llama.cpp Linux pin |
| Diarization on Linux | Medium/hard — CUDA artifact story + VRAM; keep unsupported until ready |
| Packaging | Medium — AppImage well-trodden; `.deb` secondary |
| “Works on every distro” | Ongoing — constrain v1 to Ubuntu/Debian desktop first |

Linux capture is generally **less permission-hostile than macOS** and **similar in spirit to Windows loopback**. Flakiness is mostly environment variance (sinks/Bluetooth), not a missing OS API.

---

## Development workflow

```bash
# On a Linux desktop with PipeWire/Pulse
npm install
python3.11 -m venv .venv
./.venv/bin/python -m pip install -r requirements-linux.txt -r requirements-dev.txt
npm start

# Packaged
npm run prepare-build
npm run build:linux        # once scripts exist
```

Branch naming when implementation starts: follow repo convention (`feature/linux-support` or cloud `cursor/…` branches). Keep Win/mac green; Linux lands behind factory/platform checks until smoke-signed.

---

## Distribution (when shipping)

GitHub Releases assets (versions illustrative):

- `AvaNevis-Setup-<version>.exe`  
- `AvaNevis-Setup-<version>.dmg`  
- `AvaNevis-<version>.AppImage`  
- `avanevis_<version>_amd64.deb`  

README install blurb:

```bash
chmod +x AvaNevis-<version>.AppImage
./AvaNevis-<version>.AppImage

# or
sudo dpkg -i avanevis_<version>_amd64.deb
sudo apt-get install -f
```

---

## Future (post-Linux-v1)

1. Flatpak with explicit Pulse/PipeWire portal story  
2. AMD ROCm faster-whisper / diarization (demand-driven)  
3. `linux-arm64`  
4. Steam Deck-oriented defaults (tiny/base model hints, UI scaling)  
5. Optional system-package ffmpeg/Python for distro maintainers (not the primary support path)

---

## References

- PulseAudio monitor sources — https://www.freedesktop.org/wiki/Software/PulseAudio/  
- PipeWire pulse compatibility — https://docs.pipewire.org/  
- electron-builder Linux — https://www.electron.build/configuration/linux  
- In-repo: `AGENTS.md` recorder/AI invariants · `docs/completed/json-based-events.md` · `docs/development/LOCAL_AI_MODEL_CATALOG.md`

---

**Last updated:** 2026-07-16  
**Status:** Planning refreshed for spool capture, sequential transcription queue, and local AI add-ons — ready to implement when prioritized
