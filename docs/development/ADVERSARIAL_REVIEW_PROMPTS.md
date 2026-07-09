# Adversarial review prompts (targeted)

Use these when asking a strong model (Fable, Opus, etc.) to hunt for **new** issues without burning a full-app review quota.

## How to use

1. Pick **one** theme below. Do not paste multiple themes into one session.
2. Paste the **Shared preamble** once, then the theme prompt.
3. Prefer **diff-scoped** review after a PR (`git diff base...HEAD` limited to the theme’s paths). Use an area prompt for residual risk when there is no diff.
4. Cap exploration: the allowed-path list is a hard budget. If the model needs one adjacent file, it may open it — it must not wander the whole tree.
5. Ask for ranked findings with `file:symbol` and a concrete failure scenario. No mega-refactor plans.

## Hunt criteria (open-ended — not a closed checklist)

The “Hunt for” bullets under each theme are **starting lenses**, not the only allowed findings.

The reviewer **must** also look for anything high-impact they notice inside the allowed paths, including but not limited to:

- Correctness bugs and silent data loss
- Race conditions, TOCTOU, stale session/IDs, double-start/stop/quit
- Performance: memory growth, event/IPC storms, unnecessary device warm-up, GPU idle vs busy, long-recording buffers, O(n²) paths
- Concurrency / queue / timeout footguns (hung children, false busy, starvation)
- Security / privacy: token leakage, path traversal, symlink escapes, log/progress redaction gaps
- Platform skew (Windows vs macOS, packaged vs `npm start`, CUDA/MPS)
- Error handling that lies (success when failed, swallowed exceptions, wrong user message)
- Test / characterization blind spots that would miss the bug
- Surprises the authors did not list — if it can hurt users or ship risk, report it

If an area looks solid, say so briefly and stop. Prefer concrete patches over vague advice.

---

## Shared preamble

```text
You are reviewing AvaNevis — a privacy-first Electron desktop app (mic + desktop audio → local Whisper). Windows: faster-whisper (+ optional CUDA). macOS Apple Silicon: MLX + Swift CoreAudio tap helper. Optional local AI: pyannote diarization, llama.cpp summaries. No cloud transcription / no telemetry.

Canonical contracts: root AGENTS.md. Do not invent a second architecture.

Rules for this session:
- Review ONLY the theme and allowed paths below. Do not review the whole app.
- Prefer reading real code and tests over summarizing docs.
- The hunt list is a starting lens, NOT exhaustive. Also report performance issues, races, security/privacy gaps, platform skew, silent failures, and any other high-impact bugs you find in-scope — including ones we did not think to name.
- Output: (1) verdict, (2) ranked findings with severity / file:symbol / failure scenario / suggested fix, (3) brief “what’s solid”, (4) residual hardware smoke if relevant.
- No mega-refactor plan. No rubber stamp.
```

---

## 1. Quit / lifecycle races

**Why:** Silent data loss, orphaned sidecars, mid-pip CUDA trees, skipped drains. CI barely covers this.

```text
Theme: Quit / app lifecycle races (recording quit, AI drain, GPU install, summary metadata).

Allowed paths only:
- src/main.js (before-quit, allowImmediateQuit / consumeAllowImmediateQuit, hasInFlightAiWork, drainAiWorkBeforeQuit, aiQuitDrainPromise)
- src/main/recorder-service.js (handleQuitDuringRecording, quitWorkflowPromise, forceKillRecordingOnShutdown, stop/wait helpers)
- src/main/summary-service.js (activeSummaryGeneration phases, abortActiveSummaryForQuit, metadata phase)
- src/main/gpu-runtime-service.js (gpuRuntimeActionPromise, hasInFlightGpuRuntimeAction, waitForGpuRuntimeIdle)
- src/main/ai-compute-queue.js
- src/main/ai-addon-ipc.js (setup abort / hasInFlightAiAddonSetup only as it relates to quit)
- src/main/python-runtime.js (activeProcesses / drainActiveProcesses)
- Related tests under tests/js/ that mention quit, drain, or compute queue — only if needed

Starting lenses (not exclusive):
- Double-quit / re-entrancy on AI-only vs recording quit paths
- Quit during recording while History transcription/summary is in flight
- Quit mid install-gpu / repair; 90s drain vs force-kill
- Summary metadata phase: sidecars on disk, meetings.json never updated
- Sticky or one-shot quit flags; tray close vs before-quit interaction
- Performance: quit path blocking the UI for too long; drain that never settles

Also report any other high-impact bugs in these paths (races, perf, privacy, wrong kill order, etc.).
```

---

## 2. Recorder stop / recovery (Windows-heavy)

**Why:** Lost or unrecoverable recordings; stop semantics still asymmetric across platforms.

```text
Theme: Recorder stop, final stdout JSON, and recovery after processing failure.

Allowed paths only:
- backend/audio/windows_recorder.py
- backend/audio/macos_recorder.py
- backend/audio/recorder_stdout.py
- src/main/recorder-service.js
- src/main-process/recorder-output-helpers.js
- src/main-process-helpers.js (only re-exports / if needed)
- src/renderer/app.js (stopRecording / recovery / sessionId filtering only — do not tour the whole file)
- tests/js/recorder-event-contract.test.js
- tests/js/main-process-helpers.test.js (recorder stop / payload tests only)
- tests/python/test_recorder_event_contract.py

Starting lenses (not exclusive):
- exit ≠ 0 with success:false + on-disk audioPath/outputPath
- finally vs except emitting conflicting success payloads
- Stop timeout / force-kill / partial Opus
- Dual stdout listeners (live parse vs stop buffer); event/level storms; memory on long recordings
- stderr wrongly driving control flow
- Renderer recovery that drops recoverable audio or double-transcribes
- Performance: level IPC rate, stop buffer growth, heartbeat false positives

Also report any other high-impact bugs in these paths.
```

---

## 3. Compute serialization & VRAM / availability

**Why:** OOM, hung UI, starved downloads, overlapping GPU work.

```text
Theme: AI compute queue, wall-clock timeouts, download-model idle wait, GPU lock vs compute.

Allowed paths only:
- src/main/ai-compute-queue.js
- src/main/transcription-service.js
- src/main/summary-service.js
- src/main/ai-addon-ipc.js (validation createAbortableComputeAction / queues)
- src/main/gpu-runtime-service.js
- src/main-process/compute-timeout-helpers.js
- src/main.js (only queue wiring / hasInFlightAiWork)
- tests/js/compute-queue-membership.test.js
- tests/js/ai-compute-queue.behavioral.test.js
- tests/js/main-process-helpers.test.js (timeout helpers only)

Starting lenses (not exclusive):
- download-model off-queue but idle-wait: timeout, progress, cancel gaps, starvation
- Validation overlapping transcription; addon queue vs compute queue
- Hung child + runWallClockComputeAction settlement before queue release
- Guided transcription + diarization HF cache env separation under load
- Performance: queue latency, unnecessary waits, GPU VRAM contention, progress event storms
- False busy / stuck gpuRuntimeActionPromise or pendingWorkCount

Also report any other high-impact bugs in these paths.
```

---

## 4. Token / privacy / path jail

**Why:** Trust boundary; token exfil; path traversal; metadata pollution.

```text
Theme: HF token handling, redaction, archive path safety, meeting AI sidecar jail, download host allowlist.

Allowed paths only:
- src/ai-addon-token-store.js
- src/ai-addon-state.js (normalize / catalog token metadata only as relevant)
- src/main/ai-addon-ipc.js (validateDiarizationRuntime stdin / env clearing)
- src/ai-addon/progress-events.js
- src/ai-addon/download-helpers.js
- src/ai-addon/archive-install.js
- src/ai-addon-archive-helpers.js
- src/ai-addon-zip-extractor-worker.js
- src/ai-addon-tar-extractor-worker.js
- src/main-process/ai-progress-helpers.js
- src/ai-progress-sanitizer.js (if present)
- backend/diarization/diarization_pipeline.py (token stdin / env fallback)
- backend/meetings/paths.py
- backend/common/sensitive_text.py
- src/main.js (validateAiMetadataPaths / update-meeting-ai only)
- tests/js/ai-addon-*.test.js (token, archive, download host)
- tests/python/test_meeting_manager.py / diarization token tests as needed

Starting lenses (not exclusive):
- Token in child env, logs, progress, manifests, meeting metadata
- stdin EPIPE / empty token fail-closed
- Zip/tar traversal, symlinks, Windows reserved names
- Host allowlist gaps or over-broad redirects; CDN rotation breakage
- Sidecar path escape / symlink TOCTOU
- Performance: only if it affects safety (e.g. buffering unsanitized logs)

Also report any other high-impact bugs in these paths.
```

---

## 5. Packaged vs dev runtime (Python / CUDA / helper)

**Why:** “Works in npm start, fails in installer”; wrong binary; CUDA major mismatch.

```text
Theme: Packaged vs development Python/runtime resolution, AVANEVIS_PACKAGED, CUDA probe/fallback, Swift helper path rules.

Allowed paths only:
- src/main/python-runtime.js
- src/main.js (buildPythonEnv / path resolution only)
- src/main/gpu-runtime-service.js
- src/main-process/cuda-runtime-helpers.js (or equivalent under src/main-process/)
- backend/transcription/faster_whisper_transcriber.py (CUDA fallback / cache env)
- backend/transcription/cuda_probe.py (if present)
- backend/audio/swift_audio_capture.py (AVANEVIS_PACKAGED / helper resolution)
- build/prepare-resources.js
- build/download-manifest.js
- package.json (extraResources / build scripts only as needed)
- tests/js/main-process-helpers.test.js (CUDA / path helpers)
- tests/python/test_screencapture_helper.py / transcriber helper tests as needed

Starting lenses (not exclusive):
- Packaged app resolving PATH helper instead of bundled binary
- CUDA 13-only box: transcription CPU fallback vs diarization hard-fail
- Dev PYTHONPATH vs packaged python311._pth / backend layout
- Wrong ffmpeg / site-packages after GPU install/repair
- Performance: cold start probes, redundant device/GPU checks at launch
- Silent fallback that looks like success but is CPU-only forever

Also report any other high-impact bugs in these paths.
```

---

## 6. macOS capture pipeline (when Mac hardware is available)

**Why:** Phase 7B smoke debt; desktop speech can die in mono downmix even when meters look fine.

```text
Theme: macOS desktop capture — Swift helper, CoreAudio tap vs ScreenCaptureKit, PCM float32, one-sided stereo repair, permissions.

Allowed paths only:
- swift/AudioCaptureHelper/
- backend/audio/swift_audio_capture.py
- backend/audio/swift_pcm_alignment.py
- backend/audio/swift_helper_status.py
- backend/audio/macos_recorder.py
- backend/audio/macos_stereo_repair.py
- backend/audio/macos_desktop_diagnostics.py
- src/main/device-ipc.js (macOS permission status only)
- docs/initiatives/MACOS_AUDIO_ARCHITECTURE.md (shipped vs planned — do not treat planned as shipped)
- tests/python/test_swift_*.py / macos capture tests as present
- tests/manual/recording-smoke-checklist.md (macOS items)

Starting lenses (not exclusive):
- helperCaptureBackend reporting vs actual path used
- float32 vs float64 upcast; interleaved stdout contract
- One-sided stereo / mono transcription downmix dropping desktop speech
- Permission confusion (System Audio Recording vs Screen Recording)
- Performance: helper CPU, PCM buffer growth, diagnostic spam
- Packaged codesign / Resources/bin/audiocapture-helper resolution

Also report any other high-impact bugs in these paths.
Deliverable may include a short hardware smoke checklist if code looks fine but runtime proof is missing.
```

---

## Suggested cadence

| When | Use |
|------|-----|
| After a risky PR | Diff-scoped review using the matching theme’s paths |
| Weekly / pre-release | One of themes 1–5 (rotate; start with quit or recorder stop) |
| Mac or CUDA box available | Theme 2 (Windows recovery) or 5/6 with hardware smoke |

## Out of scope for these prompts (usually)

- Full-app architecture tours
- Pure formatter / canvas helper polish
- Catalog pin table archaeology without a security/download angle
- CSS / visual design
- Re-opening Phase 2 `app.js` controller extraction unless the theme is a specific UI race
