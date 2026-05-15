# Local AI Feature Implementation Plan

## Questions Before We Decide

1. Should summaries run automatically after every transcription, or should they be manual by default with an optional setting for auto-run?
2. Are we comfortable requiring a Hugging Face account/token for diarization v1, or should we only ship diarization after we can provide a token-free model path?
3. For macOS diarization, should we accept CPU fallback in v1 if PyTorch MPS is unstable, or should Metal acceleration be a hard requirement before release?
4. Should the summary model be downloaded on demand, or should we offer a separate larger installer/build artifact with the default model bundled?
5. Should we implement one cross-platform summary runtime first with `llama.cpp`, or accept a better Mac-specific `mlx-lm` path from day one?
6. What is the minimum supported hardware for summaries: RTX 4070/M4 Pro only, or also 8 GB NVIDIA GPUs and 16 GB Apple Silicon Macs?
7. Should speaker diarization be required before summaries can assign owners, or should summaries work from unlabeled transcripts and mark owners as unknown when needed?
8. What summary format should be the product default: short executive summary, structured meeting minutes, or action-item-first follow-up notes?

## Current Recommendation

Implement these as two separate post-transcription features that share model-cache, progress, and local-only UX patterns.

Default model choices:

| Feature | Default | Acceleration | Fallback |
|---------|---------|--------------|----------|
| Speaker diarization | `pyannote/speaker-diarization-community-1` | CUDA on Windows; validate MPS/Metal on Mac | CPU fallback |
| Transcript summaries | `Qwen3-14B` 4-bit via `llama.cpp` | CUDA on Windows; Metal on Mac | `Qwen3-8B` 4-bit |

Secondary model choices:

- Test `nvidia/diar_streaming_sortformer_4spk-v2.1` as a Windows CUDA diarization spike, not the cross-platform default.
- Test `Mistral-Nemo-Instruct-2407` 4-bit as the long-transcript summary option.
- Test `mlx-lm` for Mac summaries only after the cross-platform `llama.cpp` path is proven.

## Non-Negotiable Constraints

- No cloud transcription, cloud diarization, cloud summarization, telemetry, or background uploads.
- All model downloads must be explicit user actions or clearly user-triggered setup steps.
- Recorder stdout JSON contracts remain unchanged unless both Electron and Python sides are updated together.
- Meeting metadata writes must preserve the existing locked, atomic, transactional behavior.
- Raw transcripts remain the source of truth even when summaries or speaker labels are generated.

## Phase 0: Decision And Prototype Setup

- [ ] Answer the questions at the top of this plan.
- [ ] Pick the v1 summary default: `Qwen3-14B` or `Qwen3-8B`.
- [ ] Decide whether `Mistral-Nemo-Instruct-2407` is exposed in v1 or held as an advanced option.
- [ ] Decide whether macOS summary v1 uses only `llama.cpp` or also `mlx-lm`.
- [ ] Decide whether diarization v1 can ship with Mac CPU fallback if MPS validation fails.
- [ ] Define target acceptance timings on RTX 4070 and M4 Pro for a 60-minute meeting.

## Phase 1: Hardware Spikes

Run these before changing product UI.

- [ ] Windows RTX 4070: `pyannote/speaker-diarization-community-1` with CUDA on a 30-60 minute meeting.
- [ ] Windows RTX 4070: `nvidia/diar_streaming_sortformer_4spk-v2.1` with CUDA on the same audio.
- [ ] Mac M4 Pro: `pyannote/speaker-diarization-community-1` with MPS, then CPU fallback if needed.
- [ ] Windows RTX 4070: `Qwen3-14B Q4_K_M` with `llama.cpp` CUDA.
- [ ] Mac M4 Pro: `Qwen3-14B Q4_K_M` with `llama.cpp` Metal.
- [ ] Lower-end baseline: `Qwen3-8B Q4_K_M` with the same summary prompts.
- [ ] Long transcript baseline: `Mistral-Nemo-Instruct-2407 Q4_K_M` with chunked and long-context prompts.

Record for each spike:

- model size on disk
- peak RAM/VRAM
- processing time for 30 and 60 minutes of transcript/audio
- output quality notes
- packaging blockers

## Phase 2: Shared Model Cache And Settings

- [ ] Define a model cache directory under Electron `userData`.
- [ ] Add model metadata for curated diarization and summary models.
- [ ] Add explicit download/remove/check-status actions.
- [ ] Add checksum or pinned filename validation for curated summary models.
- [ ] Ensure app-spawned pyannote processes set `PYANNOTE_METRICS_ENABLED=0`.
- [ ] Add settings for GPU/CPU fallback policy where needed.

## Phase 3: Speaker Diarization Backend

- [ ] Add `backend/diarization/` module.
- [ ] Load `pyannote/speaker-diarization-community-1` lazily.
- [ ] Convert Opus recordings to 16 kHz mono WAV when required.
- [ ] Prefer `exclusive_speaker_diarization` for transcript alignment.
- [ ] Preserve normal speaker diarization as a fallback if exclusive output is unavailable.
- [ ] Merge speaker labels into transcript segments by timestamp overlap.
- [ ] Return structured JSON to Electron and human-readable progress on stderr/progress events.

## Phase 4: Transcript Summary Backend

- [ ] Add `backend/summaries/` module.
- [ ] Add `llama.cpp` runtime resolution for Windows and macOS.
- [ ] Add transcript chunking by token budget and timestamp boundaries.
- [ ] Add chunk-summary prompt and final-merge prompt.
- [ ] Require structured JSON output and validate before saving.
- [ ] Add retry/repair path for malformed JSON.
- [ ] Render summary JSON to Markdown for history display/export.

## Phase 5: Electron IPC And Persistence

- [ ] Add `diarize-transcript` IPC handler.
- [ ] Add `summarize-transcript` IPC handler.
- [ ] Add model-cache IPC handlers.
- [ ] Add progress events for model download, model load, diarization, chunk summaries, final merge, and save.
- [ ] Extend meeting metadata to reference speaker-labeled transcripts and summary files.
- [ ] Preserve existing meeting-manager locking and atomic write behavior.

## Phase 6: Renderer UX

- [ ] Add settings for speaker identification.
- [ ] Add settings for transcript summaries.
- [ ] Add model download/status UI.
- [ ] Add post-transcription progress states.
- [ ] Add speaker labels in transcript rendering.
- [ ] Add summary section in meeting detail.
- [ ] Add regenerate speaker labels and regenerate summary actions for existing meetings.
- [ ] Add graceful degradation when tokens/models/GPU acceleration are unavailable.

## Phase 7: Validation

- [ ] Unit-test transcript/speaker merge behavior.
- [ ] Unit-test summary JSON parsing and repair behavior.
- [ ] Unit-test meeting metadata persistence changes.
- [ ] Run `npm test`.
- [ ] Run `npm run test:python`.
- [ ] Run Windows CUDA manual smoke tests on RTX 4070.
- [ ] Run macOS manual smoke tests on M4 Pro.
- [ ] Validate CPU fallback behavior on both platforms.
- [ ] Validate no network calls happen except explicit model downloads and update checks.

## Open Risks

- `pyannote.audio` 4.x and packaged Python 3.11 dependency pins need validation on both platforms.
- PyTorch MPS support for pyannote may not be reliable enough for a marketed Metal path.
- `llama.cpp` packaging may require new native binaries and platform-specific build/download logic.
- 14B summary models may be too heavy for lower-end machines once KV cache is included.
- Hugging Face gated model flows add product friction and token-storage UX requirements.

## Related Docs

- [Speaker diarization](FEATURE_SPEAKER_DIARIZATION.md)
- [Transcript summaries](FEATURE_TRANSCRIPT_SUMMARIES.md)
- [Roadmap](../ROADMAP.md)
