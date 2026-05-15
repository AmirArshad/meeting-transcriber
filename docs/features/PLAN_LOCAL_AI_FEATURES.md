# Local AI Feature Implementation Plan

## Questions Before We Decide

1. Should summaries run automatically after every transcription, or should they be manual by default with an optional setting for auto-run? Decision: manual only in v1.
2. Are we comfortable requiring a Hugging Face account/token for diarization v1, or should we only ship diarization after we can provide a token-free model path? Decision: v1 may require users to bring their own Hugging Face token; do not ship a maintainer-owned token.
3. For macOS diarization, should we accept CPU fallback in v1 if PyTorch MPS is unstable, or should Metal acceleration be a hard requirement before release? Decision: wait for good accelerated Apple Silicon diarization; if unavailable, keep the current transcription-only flow.
4. Should the summary model be downloaded on demand, or should we offer a separate larger installer/build artifact with the default model bundled?
5. Should we implement one cross-platform summary runtime first with `llama.cpp`, or accept a better Mac-specific `mlx-lm` path from day one?
6. What is the minimum supported hardware for summaries: RTX 4070/M4 Pro only, or also 8 GB NVIDIA GPUs and 16 GB Apple Silicon Macs?
7. Should speaker diarization be required before summaries can assign owners, or should summaries work from unlabeled transcripts and mark owners as unknown when needed?
8. What summary format should be the product default: short executive summary, structured meeting minutes, or action-item-first follow-up notes? Decision: expose profiles if they can run on one installed model; do not require multiple large downloads for profile selection.

## Current Recommendation

Implement these as two separate post-transcription features that share model-cache, progress, and local-only UX patterns.

The concrete product flow is defined in [Optional local AI add-ons](DESIGN_LOCAL_AI_ADDONS.md): Settings handles setup, Home prompts route users to setup when needed, diarization runs automatically once configured, and summaries only run from explicit user action.

Default model choices:

| Feature | Default | Acceleration | Fallback |
|---------|---------|--------------|----------|
| Speaker diarization | `pyannote/speaker-diarization-community-1` | CUDA on Windows; validated accelerated Apple Silicon path on Mac | Current transcription-only flow if Mac acceleration is not good enough |
| Transcript summaries | `Qwen3.5-9B` 4-bit via `llama.cpp`, pending pinned-runtime validation | CUDA on Windows; Metal on Mac | Alternate single-model installs: `Qwen3-14B` for mature runtime support or `Qwen3.5-4B` for low memory |

Secondary model choices:

- Test `nvidia/diar_streaming_sortformer_4spk-v2.1` as a Windows CUDA diarization spike, not the cross-platform default.
- Test `Mistral-Nemo-Instruct-2407` 4-bit only if Qwen3.5 long-context behavior, speed, or packaging is not acceptable.
- Test `Gemma 4 26B A4B` as a high-quality, high-memory Apache-2.0 alternative after `llama.cpp` `gemma4` validation.
- Test `Gemma 4 E4B` as a lower-memory Gemma comparison, not as the default unless it beats Qwen3.5 on real transcripts.
- Test `mlx-lm` for Mac summaries only after the cross-platform `llama.cpp` path is proven.

## Non-Negotiable Constraints

- No cloud transcription, cloud diarization, cloud summarization, telemetry, or background uploads.
- All model downloads must be explicit user actions or clearly user-triggered setup steps.
- Users must provide their own Hugging Face token for gated diarization models; do not embed or proxy a shared maintainer token.
- Summary profiles should reuse one installed model where possible. Do not require multiple large model downloads for normal profile selection.
- Recorder stdout JSON contracts remain unchanged unless both Electron and Python sides are updated together.
- Meeting metadata writes must preserve the existing locked, atomic, transactional behavior.
- Raw transcripts remain the source of truth even when summaries or speaker labels are generated.

## Phase 0: Decision And Prototype Setup

- [ ] Answer the questions at the top of this plan.
- [x] Decide summary run behavior. Decision: always user-triggered in v1.
- [ ] Validate the v1 summary default: `Qwen3.5-9B` with pinned `llama.cpp` CUDA/Metal builds.
- [x] Decide profile model strategy. Decision: profiles reuse one installed model where possible; alternate models are replacement installs, not required downloads.
- [ ] Decide whether `Qwen3-14B` remains a shipped fallback if `Qwen3.5` runtime support lags.
- [ ] Decide whether `Mistral-Nemo-Instruct-2407` is exposed in v1 or held as an advanced option.
- [ ] Decide whether Apache-2.0 Gemma 4 models join the prototype matrix beyond research notes.
- [ ] Decide whether macOS summary v1 uses only `llama.cpp` or also `mlx-lm`.
- [x] Decide whether diarization v1 can ship with Mac CPU fallback if MPS validation fails. Decision: no; wait for validated acceleration and otherwise use the current transcription-only flow.
- [ ] Define target acceptance timings on RTX 4070 and M4 Pro for a 60-minute meeting.

## Phase 1: Hardware Spikes

Run these before changing product UI.

- [ ] Windows RTX 4070: `pyannote/speaker-diarization-community-1` with CUDA on a 30-60 minute meeting.
- [ ] Windows RTX 4070: `nvidia/diar_streaming_sortformer_4spk-v2.1` with CUDA on the same audio.
- [ ] Mac M4 Pro: `pyannote/speaker-diarization-community-1` with accelerated Apple Silicon path; do not ship CPU-only diarization as v1 fallback.
- [ ] Windows RTX 4070: `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` with `llama.cpp` CUDA.
- [ ] Mac M4 Pro: `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` with `llama.cpp` Metal.
- [ ] Verify `Qwen3.5` thinking-disabled mode and JSON-only output reliability.
- [ ] Lower-end baseline: `Qwen3.5-4B Q4_K_M` with the same summary prompts.
- [ ] Mature fallback baseline: `Qwen3-14B Q4_K_M` with the same summary prompts.
- [ ] Gemma low-memory baseline: `Gemma 4 E4B Q4_K_M` or `UD-Q4_K_XL` with the same summary prompts.
- [ ] Gemma high-memory baseline: `Gemma 4 26B A4B UD-Q4_K_M` with the same summary prompts.
- [ ] Long transcript fallback baseline: `Mistral-Nemo-Instruct-2407 Q4_K_M` with chunked and long-context prompts if Qwen3.5 is not acceptable.

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
- [ ] Add settings/status for GPU/acceleration policy where needed.

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
- [ ] Validate Windows CPU fallback behavior and macOS transcription-only fallback when diarization acceleration is unavailable.
- [ ] Validate no network calls happen except explicit model downloads and update checks.

## Open Risks

- `pyannote.audio` 4.x and packaged Python 3.11 dependency pins need validation on both platforms.
- PyTorch MPS support for pyannote may not be reliable enough for a marketed Metal path; if so, macOS diarization waits rather than using CPU-only v1 behavior.
- `llama.cpp` packaging may require new native binaries and platform-specific build/download logic.
- 14B summary models may be too heavy for lower-end machines once KV cache is included.
- Hugging Face gated model flows add product friction and token-storage UX requirements.

## Related Docs

- [Speaker diarization](FEATURE_SPEAKER_DIARIZATION.md)
- [Transcript summaries](FEATURE_TRANSCRIPT_SUMMARIES.md)
- [Optional local AI add-ons](DESIGN_LOCAL_AI_ADDONS.md)
- [Roadmap](../ROADMAP.md)
