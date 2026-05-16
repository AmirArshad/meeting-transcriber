# Local AI Add-ons Plan

Branch: `feature/local-ai-addons` or a short-lived spike branch per prototype.

Status: Implementation branch created. Phase 1 model/hardware spikes are intentionally skipped by product direction. Build v1 around the current core defaults while keeping model choices catalog-driven and easy to swap later.

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

## Current Execution Notes

- 2026-05-16: Working on `feature/local-ai-addons`.
- 2026-05-16: Runtime spikes are blocked in this environment by missing target hardware/model downloads; starting with Phase 2 add-on state/model-cache foundations and read-only status IPC.
- 2026-05-16: Added local AI add-on state helpers, curated metadata, model-cache paths, read-only status IPC, and JS regression tests. `npm test` passed for this foundation slice.
- 2026-05-16: Added pure diarization segment-overlap merge helpers without pyannote/runtime dependencies. `npm run test:python` passed for this foundation slice.
- 2026-05-16: Added pure summary transcript normalization, token-budget chunking, summary JSON validation, and Markdown rendering helpers without llama.cpp/model dependencies. `npm run test:python` passed for this foundation slice.
- 2026-05-16: Extended meeting metadata with sanitized local AI derived-artifact references and delete cleanup through existing locked atomic writes. Added `update-meeting-ai` bridge. `npm test` and `npm run test:python` passed.
- 2026-05-16: Added secure diarization token storage helpers and IPC using Electron `safeStorage` only, with no plaintext fallback. `npm test` and `npm run test:python` passed.
- 2026-05-16: Product direction updated: skip Phase 1 spikes and proceed with catalog-driven v1 defaults that can be swapped as better local models become available.
- 2026-05-16: Summary model distribution decision: use a larger optional installer/download artifact, similar to the CUDA setup flow, instead of bundling the model in the base installer or doing opaque background downloads.
- 2026-05-16: Added explicit AI add-on setup/check/remove/validate helpers and IPC wrappers, safe redacted `ai-addon-progress` events, platform-specific summary artifact selection, and pinned-filename/checksum enforcement that refuses summary downloads until artifact metadata is complete. `npm test` and `npm run test:python` passed.
- 2026-05-16: Added lazy pyannote diarization runner and `diarize-transcript` IPC boundary without changing Whisper transcription paths. The backend prepares 16 kHz mono WAV input, disables pyannote metrics, prefers exclusive diarization output, writes `*.speakers.json`, and emits redacted progress. `npm test` and `npm run test:python` passed.

## V1 Model Defaults

- Speaker diarization: `pyannote/speaker-diarization-community-1` through `pyannote.audio`; Windows uses CUDA when available, macOS remains unavailable unless a supported accelerated Apple Silicon path is explicitly enabled later.
- Transcript summaries: `Qwen3.5-9B` 4-bit GGUF through pinned `llama.cpp`; Windows runtime target is CUDA, macOS runtime target is Metal.
- Summary model/runtime distribution: explicit optional setup artifact, downloaded/installed only after user action through Settings, with pinned filenames/checksums.
- Model choices must remain data-driven through the app model catalog so replacing defaults or adding alternates does not require touching renderer/business logic.

## Phase 0 - Project Setup And Decisions

- [x] Create implementation branch or dedicated spike branches.
- [x] Define acceptance timing targets for 30-minute and 60-minute meetings on RTX 4070 and M4 Pro. (Skipped for v1 implementation path; revisit after model/runtime integration.)
- [x] Decide whether summary model downloads are on-demand only or offered through a larger optional installer artifact. Decision: use a larger optional setup artifact/download flow like CUDA setup.
- [x] Decide whether summary v1 uses only `llama.cpp` or includes a Mac-only `mlx-lm` optimization path later. Decision: `llama.cpp` only for v1; keep `mlx-lm` as future optimization.
- [x] Decide whether `Qwen3-14B` remains a shipped alternate install if `Qwen3.5-9B` runtime support is not reliable. Decision: keep as catalog alternate, not the default.
- [x] Decide whether `Mistral-Nemo-Instruct-2407` and Gemma 4 remain research-only or become advanced alternate installs. Decision: keep out of v1 default path; catalog can add alternates later.
- [x] Decide whether summaries should assign owners from unlabeled transcripts as `Unknown` when diarization is absent.

## Phase 1 - Runtime And Hardware Spikes

Skipped by product direction. Proceed with the V1 Model Defaults above and keep the catalog easy to update when new local models are better.

- [x] Windows RTX 4070: validate `pyannote/speaker-diarization-community-1` with CUDA on a 30-60 minute meeting. (Skipped.)
- [x] Windows RTX 4070: compare `nvidia/diar_streaming_sortformer_4spk-v2.1` as a Windows-only spike. (Skipped; keep swappable model catalog instead.)
- [x] M4 Pro: validate accelerated Apple Silicon diarization for `pyannote/speaker-diarization-community-1`; do not ship CPU-only diarization as v1 fallback. (Skipped; macOS diarization remains unavailable by default.)
- [x] Windows RTX 4070: validate `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` with pinned `llama.cpp` CUDA. (Skipped.)
- [x] M4 Pro: validate `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` with pinned `llama.cpp` Metal. (Skipped.)
- [x] Verify `Qwen3.5` thinking-disabled mode and JSON-only output reliability. (Skipped; implement strict JSON validation/repair around output.)
- [x] Test one-model summary profiles: `Concise`, `Balanced`, `Detailed`, and `Action items`. (Skipped; profiles share one catalog default.)
- [x] Lower-memory summary spike: `Qwen3.5-4B Q4_K_M` as a replacement install option, not an extra required download. (Skipped; keep as catalog alternate.)
- [x] Mature fallback spike: `Qwen3-14B Q4_K_M` as a replacement install option if `Qwen3.5` support lags. (Skipped; keep as catalog alternate.)
- [x] Record model size, peak RAM/VRAM, processing time, quality notes, and packaging blockers for every spike. (Skipped.)

## Phase 2 - Shared AI Add-on State And Model Cache

- [x] Define add-on manifest under Electron `userData` for setup state, selected summary profile, model references, and last validation status.
- [x] Ensure tokens are stored only via Electron `safeStorage`, never in the manifest or meeting metadata.
- [x] Define model cache directory under Electron `userData`.
- [x] Add curated model metadata for diarization and summary models.
- [x] Add explicit download, remove, check-status, and validate actions. (Summary downloads are implemented behind explicit user action and currently refuse to run until pinned URLs/checksums are filled in.)
- [x] Add checksum or pinned filename validation for summary GGUF artifacts. (Pinned filename is catalog-driven; checksum is required before ready state or download.)
- [x] Add status states: `notConfigured`, `needsAccount`, `downloading`, `validating`, `ready`, `error`, and `unsupported`.
- [x] Add progress events that avoid transcript text, token values, and raw prompts.

## Phase 3 - Diarization Backend

- [x] Add `backend/diarization/` module. (Pure merge helpers only; pyannote runtime integration remains pending.)
- [x] Add lazy loading for `pyannote/speaker-diarization-community-1`.
- [x] Set `PYANNOTE_METRICS_ENABLED=0` in app-spawned diarization processes.
- [x] Convert Opus recordings to 16 kHz mono WAV when required.
- [x] Prefer `exclusive_speaker_diarization` for alignment.
- [x] Preserve standard diarization output as a fallback only when exclusive output is unavailable.
- [x] Merge speaker labels into Whisper segments by timestamp overlap.
- [x] Return structured JSON to Electron and progress-safe stderr/events.
- [ ] Gracefully save the normal transcript if diarization fails. (Backend/IPC boundaries are ready; automatic post-transcription integration remains pending.)

## Phase 4 - Summary Backend

- [x] Add `backend/summaries/` module. (Pure pipeline helpers only; llama.cpp runtime integration remains pending.)
- [ ] Add pinned `llama.cpp` runtime resolution for Windows CUDA and macOS Metal.
- [x] Add transcript normalization that uses speaker labels when available and works without them.
- [ ] Add token-budget chunking by timestamp and topic boundaries. (Partial: token-budget/timestamp chunks added; topic-boundary heuristics remain pending.)
- [ ] Add prompt templates for `Concise`, `Balanced`, `Detailed`, and `Action items` profiles against one installed model.
- [ ] Add chunk summary and final merge flow.
- [x] Require structured JSON output and validate before saving. (Pure validation helper added; runtime save integration remains pending.)
- [ ] Add retry/repair path for malformed JSON.
- [x] Render summary JSON to Markdown for History display/export.
- [ ] Ensure failed summary generation never modifies the transcript.

## Phase 5 - IPC And Persistence

- [x] Add `get-ai-addon-status` IPC handler.
- [x] Add secure token IPC for store/get/delete or reuse an existing safeStorage abstraction if available. (Status/delete/store only expose redacted state; token retrieval remains main-process-only for future backend calls.)
- [x] Add `setup-diarization`, `remove-diarization-setup`, and token validation IPC handlers.
- [x] Add `setup-summary-model` and `remove-summary-model` IPC handlers. (Downloads stay blocked until pinned artifact URL/checksum metadata is supplied.)
- [x] Add `diarize-transcript` IPC handler for post-transcription integration. (Not yet auto-wired into the renderer transcription flow.)
- [ ] Add `generate-summary` IPC handler for Home and History actions.
- [ ] Add progress events for model download, validation, diarization, chunk summaries, final merge, and save. (Partial: add-on setup/download/validation events now emit through redacted `ai-addon-progress`.)
- [x] Extend meeting metadata with `ai.diarization` and `ai.summary` references without storing large derived output inline.
- [ ] Save derived files: `*.speakers.json`, `*.summary.json`, and `*.summary.md`. (Partial: diarization can now write `*.speakers.json`; summary generation/save integration remains pending.)
- [x] Preserve `backend/meeting_manager.py` file locking, atomic writes, and transactional behavior.
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

- [ ] Unit-test add-on state normalization and prompt priority, especially CUDA before diarization on Windows/NVIDIA. (Partial: add-on setup/cache normalization and platform support are covered; renderer prompt priority is pending.)
- [x] Unit-test secure token storage behavior without exposing token values in logs.
- [x] Unit-test speaker/segment overlap merge behavior.
- [ ] Unit-test summary chunking, JSON validation, and malformed-output retry/repair behavior. (Partial: chunking and validation covered; retry/repair pending runtime integration.)
- [x] Unit-test meeting metadata persistence with derived artifact references.
- [ ] Add JS tests for History `Transcript` / `Summary` tab state and setup routing.
- [x] Run `npm test`.
- [x] Run `npm run test:python`.
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
