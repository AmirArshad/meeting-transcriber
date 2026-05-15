# Local AI Add-ons Plan

Branch: `feature/local-ai-addons` or a short-lived spike branch per prototype.

Status: Design docs are in place. Implementation has not started. First priority is runtime validation for diarization and summarization before product UI or persistence changes.

Goal: add optional post-install local speaker diarization and transcript summarization while preserving AvaNevis' local-only behavior and current Whisper transcription paths.

## Reference Docs

- Product flow: `docs/features/DESIGN_LOCAL_AI_ADDONS.md`
- Diarization research: `docs/features/FEATURE_SPEAKER_DIARIZATION.md`
- Summarization research: `docs/features/FEATURE_TRANSCRIPT_SUMMARIES.md`
- Implementation plan: `docs/features/PLAN_LOCAL_AI_FEATURES.md`

## Working Rules

- Preserve local-only behavior: no cloud diarization, cloud summarization, telemetry, or background uploads.
- Keep current transcription engines unchanged: `faster-whisper` on Windows/CUDA and `lightning-whisper-mlx` on Apple Silicon/Metal.
- Do not alter recorder stdout JSON contracts unless Electron and Python parsers/tests are updated together.
- Users must provide their own Hugging Face token for gated pyannote models; do not embed or proxy a maintainer-owned token.
- Diarization runs automatically after transcription only when setup is complete and platform acceleration policy passes.
- macOS diarization ships only after accelerated Apple Silicon diarization is good enough; otherwise keep the current transcription-only flow.
- Summary generation is always user-triggered in v1.
- Summary profiles should reuse one installed model where possible; do not require multiple large downloads for normal profile selection.
- Meeting metadata changes must preserve locked, atomic, transactional writes in `backend/meeting_manager.py`.

## Phase 0 - Project Setup And Decisions

- [ ] Create implementation branch or dedicated spike branches.
- [ ] Define acceptance timing targets for 30-minute and 60-minute meetings on RTX 4070 and M4 Pro.
- [ ] Decide whether summary model downloads are on-demand only or offered through a larger optional installer artifact.
- [ ] Decide whether summary v1 uses only `llama.cpp` or includes a Mac-only `mlx-lm` optimization path later.
- [ ] Decide whether `Qwen3-14B` remains a shipped alternate install if `Qwen3.5-9B` runtime support is not reliable.
- [ ] Decide whether `Mistral-Nemo-Instruct-2407` and Gemma 4 remain research-only or become advanced alternate installs.
- [ ] Decide whether summaries should assign owners from unlabeled transcripts as `Unknown` when diarization is absent.

## Phase 1 - Runtime And Hardware Spikes

- [ ] Windows RTX 4070: validate `pyannote/speaker-diarization-community-1` with CUDA on a 30-60 minute meeting.
- [ ] Windows RTX 4070: compare `nvidia/diar_streaming_sortformer_4spk-v2.1` as a Windows-only spike.
- [ ] M4 Pro: validate accelerated Apple Silicon diarization for `pyannote/speaker-diarization-community-1`; do not ship CPU-only diarization as v1 fallback.
- [ ] Windows RTX 4070: validate `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` with pinned `llama.cpp` CUDA.
- [ ] M4 Pro: validate `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` with pinned `llama.cpp` Metal.
- [ ] Verify `Qwen3.5` thinking-disabled mode and JSON-only output reliability.
- [ ] Test one-model summary profiles: `Concise`, `Balanced`, `Detailed`, and `Action items`.
- [ ] Lower-memory summary spike: `Qwen3.5-4B Q4_K_M` as a replacement install option, not an extra required download.
- [ ] Mature fallback spike: `Qwen3-14B Q4_K_M` as a replacement install option if `Qwen3.5` support lags.
- [ ] Record model size, peak RAM/VRAM, processing time, quality notes, and packaging blockers for every spike.

## Phase 2 - Shared AI Add-on State And Model Cache

- [ ] Define add-on manifest under Electron `userData` for setup state, selected summary profile, model references, and last validation status.
- [ ] Ensure tokens are stored only via Electron `safeStorage`, never in the manifest or meeting metadata.
- [ ] Define model cache directory under Electron `userData`.
- [ ] Add curated model metadata for diarization and summary models.
- [ ] Add explicit download, remove, check-status, and validate actions.
- [ ] Add checksum or pinned filename validation for summary GGUF artifacts.
- [ ] Add status states: `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, and `unsupported`.
- [ ] Add progress events that avoid transcript text, token values, and raw prompts.

## Phase 3 - Diarization Backend

- [ ] Add `backend/diarization/` module.
- [ ] Add lazy loading for `pyannote/speaker-diarization-community-1`.
- [ ] Set `PYANNOTE_METRICS_ENABLED=0` in app-spawned diarization processes.
- [ ] Convert Opus recordings to 16 kHz mono WAV when required.
- [ ] Prefer `exclusive_speaker_diarization` for alignment.
- [ ] Preserve standard diarization output as a fallback only when exclusive output is unavailable.
- [ ] Merge speaker labels into Whisper segments by timestamp overlap.
- [ ] Return structured JSON to Electron and progress-safe stderr/events.
- [ ] Gracefully save the normal transcript if diarization fails.

## Phase 4 - Summary Backend

- [ ] Add `backend/summaries/` module.
- [ ] Add pinned `llama.cpp` runtime resolution for Windows CUDA and macOS Metal.
- [ ] Add transcript normalization that uses speaker labels when available and works without them.
- [ ] Add token-budget chunking by timestamp and topic boundaries.
- [ ] Add prompt templates for `Concise`, `Balanced`, `Detailed`, and `Action items` profiles against one installed model.
- [ ] Add chunk summary and final merge flow.
- [ ] Require structured JSON output and validate before saving.
- [ ] Add retry/repair path for malformed JSON.
- [ ] Render summary JSON to Markdown for History display/export.
- [ ] Ensure failed summary generation never modifies the transcript.

## Phase 5 - IPC And Persistence

- [ ] Add `get-ai-addon-status` IPC handler.
- [ ] Add secure token IPC for store/get/delete or reuse an existing safeStorage abstraction if available.
- [ ] Add `setup-diarization`, `remove-diarization-setup`, and token validation IPC handlers.
- [ ] Add `setup-summary-model` and `remove-summary-model` IPC handlers.
- [ ] Add `diarize-transcript` IPC handler for post-transcription integration.
- [ ] Add `generate-summary` IPC handler for Home and History actions.
- [ ] Add progress events for model download, validation, diarization, chunk summaries, final merge, and save.
- [ ] Extend meeting metadata with `ai.diarization` and `ai.summary` references without storing large derived output inline.
- [ ] Save derived files: `*.speakers.json`, `*.summary.json`, and `*.summary.md`.
- [ ] Preserve `backend/meeting_manager.py` file locking, atomic writes, and transactional behavior.
- [ ] Use `sourceTranscriptHash` to mark stale summaries after transcript changes.

## Phase 6 - Renderer UX

- [ ] Add `AI Add-ons` Settings area below GPU Acceleration.
- [ ] Add Speaker Identification setup card with token input, model-terms link, token test, status badge, progress, retry, and remove setup.
- [ ] Add Summary setup card with one installed model, profile selection, model-cache status, validate, progress, and remove model.
- [ ] Add Home prompt priority: Whisper setup, permissions/devices, CUDA, speaker setup, summary setup.
- [ ] Hide Windows speaker setup prompt until CUDA is installed when NVIDIA/CUDA is the target path.
- [ ] Hide macOS speaker setup prompt unless accelerated Apple Silicon diarization is validated and available.
- [ ] Run diarization automatically after transcription when configured.
- [ ] Add `Generate Summary` action after a meeting is transcribed and saved.
- [ ] Make `Generate Summary` navigate to Settings when summary setup is missing.
- [ ] Add History `Transcript` and `Summary` tabs.
- [ ] Add Summary empty state, progress state, saved summary viewer, regenerate action, and optional copy/save actions.
- [ ] Render speaker labels in the current transcript and History transcript viewer.
- [ ] Add graceful degradation for invalid token, terms not accepted, missing model, unsupported hardware, and runtime failure.

## Phase 7 - Tests And Validation

- [ ] Unit-test add-on state normalization and prompt priority, especially CUDA before diarization on Windows/NVIDIA.
- [ ] Unit-test secure token storage behavior without exposing token values in logs.
- [ ] Unit-test speaker/segment overlap merge behavior.
- [ ] Unit-test summary chunking, JSON validation, and malformed-output retry/repair behavior.
- [ ] Unit-test meeting metadata persistence with derived artifact references.
- [ ] Add JS tests for History `Transcript` / `Summary` tab state and setup routing.
- [ ] Run `npm test`.
- [ ] Run `npm run test:python`.
- [ ] Run Windows CUDA manual smoke tests on RTX 4070.
- [ ] Run macOS manual smoke tests on M4 Pro.
- [ ] Validate no network calls happen except explicit model downloads and update checks.
- [ ] Validate 1-2 hour meetings with 2-4 speakers.

## Known Risk Areas

- `pyannote.audio` 4.x and packaged Python 3.11 dependency pins may be difficult to package consistently.
- macOS diarization acceleration may not be good enough for v1; the expected fallback is transcription-only behavior.
- `llama.cpp` GPU packaging adds platform-specific native binaries and model-cache concerns.
- Long-context summary generation can exceed memory budgets without conservative chunking.
- Hugging Face gated model setup adds user friction and must be explained clearly.
- Meeting metadata changes are high-risk because history persistence must remain atomic and resilient.

## Definition Of Done

- Speaker identification can be set up post-install with the user's own Hugging Face token.
- Windows diarization runs automatically after transcription when configured and degrades to normal transcript on failure.
- macOS diarization is offered only when accelerated Apple Silicon diarization is validated; otherwise current flow remains unchanged.
- Summary model setup is explicit and local, with one installed default model and multiple profiles where possible.
- Summaries are generated only from explicit Home or History user action.
- Generated summaries persist and reopen in History under a `Summary` tab.
- Existing transcription, recording, meeting history, and privacy behavior remain intact.
