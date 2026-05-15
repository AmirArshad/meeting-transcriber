# Feature: Transcript Summaries

## Overview

Add local AI-generated meeting summaries after transcription completes. The feature should turn a timestamped transcript into concise meeting notes, action items, decisions, risks, and follow-up questions without uploading audio or text.

Product-flow design for optional setup, manual Home/History generation, saved summaries, and `Transcript` / `Summary` History tabs lives in [Optional local AI add-ons](DESIGN_LOCAL_AI_ADDONS.md).

## 2026 Research Update

The best current approach is a local instruction LLM, not a legacy task-specific summarization model. Meeting summaries need instruction following, structured extraction, long-context handling, and predictable output formatting.

Recommended models and runtimes:

| Target | Recommended model | Runtime | Notes |
|--------|-------------------|---------|-------|
| Preferred v1 candidate | `Qwen3.5-9B` 4-bit | `llama.cpp` GGUF on CUDA/Metal after compatibility validation | Strong current instruction-following and long-context metrics, Apache-2.0, native 262k context. Unsloth GGUF `Q4_K_M` is about 5.7 GB and `UD-Q4_K_XL` is about 6.0 GB. |
| Mature fallback | `Qwen3-14B` 4-bit | `llama.cpp` GGUF on CUDA/Metal, or `mlx-lm` on Mac | Strong instruction following, Apache-2.0, broad local-runtime support, 32k native context with YaRN extension to 131k. GGUF `Q4_K_M` is about 9 GB; MLX 4-bit is about 8.3 GB. |
| Lower-end option | `Qwen3.5-4B` 4-bit | `llama.cpp` GGUF on CUDA/Metal after compatibility validation | Better memory fit for 8 GB GPUs and lower-memory Apple Silicon, Apache-2.0, native 262k context. Unsloth GGUF `Q4_K_M` is about 2.7 GB. |
| Long-context alternative | `Mistral-Nemo-Instruct-2407` 4-bit | `llama.cpp` GGUF on CUDA/Metal, or `mlx-lm` on Mac | Mature 128k-context option if Qwen3.5 runtime support or output quality is not acceptable. GGUF `Q4_K_M` is about 7.5 GB; MLX 4-bit is about 6.9 GB. |
| High-memory research option | `Qwen3.5-27B` 4-bit | `llama.cpp` GGUF, likely partial offload on RTX 4070 | Higher published quality than 9B, but too large for a safe RTX 4070 12 GB default once KV cache is included. Treat as high-RAM/Mac-unified-memory research. |
| Gemma high-quality alternative | `Gemma 4 26B A4B` 4-bit | `llama.cpp` GGUF after `gemma4` compatibility validation | Apache-2.0, 256k context, MoE with about 3.8B active parameters, and strong published benchmarks. Unsloth GGUF `UD-Q4_K_M` is about 16.9 GB, so it is not a safe RTX 4070 default. |
| Gemma lower-memory alternative | `Gemma 4 E4B` 4-bit | `llama.cpp` GGUF after `gemma4` compatibility validation | Apache-2.0, 128k context, and about 5.0 GB for Unsloth GGUF `Q4_K_M`/`UD-Q4_K_XL`, but weaker text-summary benchmark profile than Qwen3.5. |

Gemma status:

- Gemma 4 exists and supersedes Gemma 3 / Gemma 3n for this shortlist.
- Official Gemma 4 models currently listed on Hugging Face include `google/gemma-4-E2B-it`, `google/gemma-4-E4B-it`, `google/gemma-4-26B-A4B-it`, and `google/gemma-4-31B-it`.
- Gemma 4 model cards list Apache-2.0 licensing, unlike the older Gemma 3 custom-license cards previously reviewed.
- Keep `Qwen3.5-9B` as the v1 default candidate for now because it has a better quality-to-size fit for RTX 4070 and M4 Pro text-only summaries.
- Test Gemma 4 if the pinned `llama.cpp` build supports the `gemma4` architecture and the latest chat template cleanly.

Runtime recommendation:

- Use `llama.cpp`/GGUF first for one cross-platform summary engine with CUDA on NVIDIA and Metal on Apple Silicon.
- Consider `mlx-lm` as a Mac-only optimization path after the cross-platform path works; the app already packages MLX for Whisper on Apple Silicon.
- Avoid `transformers`/full PyTorch LLM inference for summaries in v1 because packaging and VRAM/RAM footprint are heavier than GGUF/MLX.
- Validate `Qwen3.5` support in the exact pinned `llama.cpp` build before committing to it in product. It uses the newer `qwen35` GGUF architecture and should run with thinking disabled for deterministic structured summaries.
- Validate `Gemma 4` support separately in the exact pinned `llama.cpp` build. Unsloth notes recent Gemma 4 chat-template and `llama.cpp` fixes, so pinning exact runtime and model artifacts matters.

## Problem Being Solved

Today AvaNevis saves a full transcript, but users still need to read and distill it manually.

The summary feature should answer:

- What happened in the meeting?
- What decisions were made?
- Who owns which action item?
- What risks, blockers, or open questions remain?
- Which transcript evidence supports the summary?

## Design Principles

- Preserve local-only behavior: no cloud summary API, no telemetry, no background upload.
- Run after transcription, not during recording.
- Keep the raw transcript as the source of truth.
- Save generated summaries as meeting metadata/output files so they can be re-opened from history.
- Treat model output as fallible: keep prompts grounded in transcript text and prefer structured JSON validation before rendering.

## Proposed Output Shape

```json
{
  "summary": "Short paragraph summary of the meeting.",
  "topics": [
    {
      "title": "Topic name",
      "summary": "What was discussed",
      "timestamps": ["00:03:12", "00:14:40"]
    }
  ],
  "decisions": [
    {
      "decision": "Decision text",
      "owner": "Speaker 1",
      "timestamp": "00:21:18"
    }
  ],
  "action_items": [
    {
      "task": "Action item text",
      "owner": "Speaker 2",
      "due": null,
      "timestamp": "00:32:04"
    }
  ],
  "risks": [
    {
      "risk": "Risk or blocker text",
      "timestamp": "00:41:27"
    }
  ],
  "open_questions": [
    {
      "question": "Question that needs follow-up",
      "timestamp": "00:45:10"
    }
  ]
}
```

## Pipeline

```text
Transcript segments
  -> normalize transcript text with timestamps and speaker labels when available
  -> split into chunks by token budget and speaker/topic boundaries
  -> generate chunk summaries as structured JSON
  -> merge chunk summaries into final structured JSON
  -> validate and repair JSON if needed
  -> render summary in the meeting viewer and save to meeting history
```

## Chunking Strategy

Use chunked map-reduce even for long-context models.

Reasons:

- Long context increases memory and latency.
- Smaller chunks make JSON failures easier to retry.
- Chunk summaries can include evidence timestamps that the final merge can preserve.
- The same architecture works for lower-end models.

Initial target budgets:

- `Qwen3.5-9B`: 16k-40k transcript tokens per chunk initially; raise only after KV-cache measurements on RTX 4070 and M4 Pro.
- `Qwen3-14B`: 12k-20k transcript tokens per chunk.
- `Qwen3.5-4B`: 8k-16k transcript tokens per chunk.
- `Gemma 4 E4B`: 8k-20k transcript tokens per chunk initially.
- `Gemma 4 26B A4B`: 20k-60k transcript tokens per chunk on systems with enough RAM/VRAM.
- `Mistral-Nemo`: 20k-60k transcript tokens per chunk when long-context mode is selected.

## Backend Architecture

Add a new module:

```text
backend/
  summaries/
    __init__.py
    transcript_summarizer.py
    summarize_transcript.py
```

Responsibilities:

- Resolve the selected local summary model.
- Start or call the local inference runtime.
- Build prompts from transcript segments.
- Stream progress events to Electron.
- Validate JSON output.
- Return summary JSON plus a rendered Markdown summary.

## Runtime Options

### Option A: `llama.cpp` CLI or server

Recommended v1 path.

Pros:

- One runtime for Windows CUDA and Apple Silicon Metal.
- Mature GGUF quantization ecosystem.
- Smaller model files and lower memory than full PyTorch.
- Can expose an OpenAI-compatible local server or run single-shot CLI calls.

Cons:

- Need to package platform-specific binaries or build/download them during prepare-build.
- Need to manage `n_gpu_layers`, context length, and model file paths per platform.

### Option B: `llama-cpp-python`

Good Python API, but packaging GPU-enabled wheels needs careful validation.

Pros:

- Clean Python integration.
- Supports CUDA and Metal builds.
- Supports structured JSON/grammar modes.

Cons:

- GPU wheels vary by CUDA/Python/macOS target.
- Source builds are not acceptable during normal app installation.

### Option C: `mlx-lm` on macOS

Good follow-up optimization after `llama.cpp` works.

Pros:

- Native Apple Silicon/Metal stack.
- Fits current macOS MLX direction.
- Strong MLX community model availability.

Cons:

- Mac-only code path.
- Requires maintaining GGUF and MLX model variants.

## UI Integration

Suggested v1 controls:

- Summary setup/status card in Settings.
- Explicit optional setup artifact download/install flow for the selected summary runtime/model, matching the current CUDA setup pattern.
- One installed model by default, with summary profiles that adjust prompt style, output length, chunk budget, and runtime knobs.
- Profiles: `Concise`, `Balanced`, `Detailed`, and `Action items` if they perform reliably on the same installed model.
- Manual `Generate Summary` button for existing meetings.
- Progress state: loading model, chunk summaries, final merge, saving.
- Meeting detail section with summary, decisions, action items, risks, and open questions.

Suggested defaults:

- Windows RTX 4070: `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` via `llama.cpp` CUDA after validating `qwen35` support and non-thinking mode.
- Mac M4 Pro: `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` via `llama.cpp` Metal first, with an `mlx-lm` spike later.
- Lower-end systems: offer `Qwen3.5-4B Q4_K_M` only as an alternate install choice when the default model is too large, not as an additional required download.
- Fallback if `Qwen3.5` runtime support is not reliable: replace the default with `Qwen3-14B Q4_K_M` for quality or `Qwen3-8B Q4_K_M` for memory, rather than asking users to download multiple models.
- Gemma 4 research path: `Gemma 4 26B A4B` for high-memory systems and `Gemma 4 E4B` for lower-memory comparison, only after pinned `llama.cpp` `gemma4` support is validated.

## Packaging Considerations

- Keep the base app installer lean. Do not bundle the default summary model in the base installer.
- Provide the default summary runtime/model as a larger optional installer/download artifact, installed only after explicit user action from Settings, similar to the CUDA setup flow.
- Store model files under Electron `userData` or a clearly managed model-cache directory.
- Reuse existing model preloading UX patterns where practical.
- Add model-cache inspection/removal UI before shipping large summary models.
- Keep checksums or pinned model filenames for any curated model downloads.
- Artifact metadata should stay data-driven so future summary models can replace the default without rewriting setup UI or generation logic.

## Risks

- A 14B 4-bit model may still be too heavy for some 8 GB GPUs once context/KV cache is included.
- Long transcripts can exceed context or memory budgets without chunking.
- LLM output can hallucinate action owners or decisions if prompts are not strict.
- JSON parsing/repair must be robust before saving generated metadata.
- `llama.cpp` GPU packaging adds new native binaries to the build pipeline.

## Implementation Checklist

### Phase 1: Prototype

- [ ] Prototype `llama.cpp` CUDA with `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` on RTX 4070.
- [ ] Prototype `llama.cpp` Metal with `Qwen3.5-9B Q4_K_M` or `UD-Q4_K_XL` on M4 Pro.
- [ ] Verify `Qwen3.5` thinking can be disabled and structured JSON output remains clean.
- [ ] Prototype lower-memory `Qwen3.5-4B Q4_K_M`.
- [ ] Keep `Qwen3-14B Q4_K_M` as the mature fallback benchmark.
- [ ] Prototype `Gemma 4 E4B Q4_K_M` or `UD-Q4_K_XL` as a low-memory Gemma comparison.
- [ ] Prototype `Gemma 4 26B A4B UD-Q4_K_M` on high-memory systems; try RTX 4070 only with expected partial offload.
- [ ] Compare `Mistral-Nemo-Instruct-2407 Q4_K_M` only if Qwen3.5 long-context behavior, speed, or packaging is not acceptable.
- [ ] Validate JSON-only output reliability.

### Phase 2: Backend

- [ ] Add `backend/summaries/` module.
- [ ] Add transcript chunking and token-budget estimation.
- [ ] Add summary prompt templates and JSON schema validation.
- [ ] Add CLI entry point for Electron IPC.
- [ ] Add model download/cache helpers.

### Phase 3: Electron Bridge

- [ ] Add `summarize-transcript` IPC handler.
- [ ] Add summary progress events.
- [ ] Add preload bridge methods.
- [ ] Save summaries into meeting metadata/output files.

### Phase 4: UI

- [ ] Add summary setup, one-model profile selection, and model-cache status.
- [ ] Add post-transcription summary progress.
- [ ] Add meeting-history summary viewer.
- [ ] Add regenerate summary action.

### Phase 5: Validation

- [ ] Test short meeting summaries.
- [ ] Test long meeting chunked summaries.
- [ ] Test malformed JSON retry/repair.
- [ ] Test Windows CUDA and the selected low-memory alternate install path.
- [ ] Test macOS Metal and the selected low-memory alternate install path.

## Status

Research updated for Qwen3.5, Qwen3, and Gemma options. Ready for pinned-runtime and hardware prototype validation.
