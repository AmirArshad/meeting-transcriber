# Feature: Transcript Summaries

## Overview

Add local AI-generated meeting summaries after transcription completes. The feature should turn a timestamped transcript into concise meeting notes, action items, decisions, risks, and follow-up questions without uploading audio or text.

## 2026 Research Update

The best current approach is a local instruction LLM, not a legacy task-specific summarization model. Meeting summaries need instruction following, structured extraction, long-context handling, and predictable output formatting.

Recommended models and runtimes:

| Target | Recommended model | Runtime | Notes |
|--------|-------------------|---------|-------|
| Best quality default | `Qwen3-14B` 4-bit | `llama.cpp` GGUF on CUDA/Metal, or `mlx-lm` on Mac | Strong instruction following, Apache-2.0, 32k native context. GGUF `Q4_K_M` is about 9 GB; MLX 4-bit is about 8.3 GB. |
| Long-transcript option | `Mistral-Nemo-Instruct-2407` 4-bit | `llama.cpp` GGUF on CUDA/Metal, or `mlx-lm` on Mac | 128k context and smaller 4-bit footprint. GGUF `Q4_K_M` is about 7.5 GB; MLX 4-bit is about 6.9 GB. |
| Lower-end option | `Qwen3-8B` 4-bit | `llama.cpp` GGUF on CUDA/Metal | Easier fit for 8 GB GPUs and lower-memory Apple Silicon. GGUF `Q4_K_M` is about 5 GB. |
| Small fallback | `Phi-4-mini-instruct` | `llama.cpp` GGUF or ONNX Runtime GenAI | 128k context and low memory, but lower summary quality than Qwen3-14B or Mistral-Nemo. |

Runtime recommendation:

- Use `llama.cpp`/GGUF first for one cross-platform summary engine with CUDA on NVIDIA and Metal on Apple Silicon.
- Consider `mlx-lm` as a Mac-only optimization path after the cross-platform path works; the app already packages MLX for Whisper on Apple Silicon.
- Avoid `transformers`/full PyTorch LLM inference for summaries in v1 because packaging and VRAM/RAM footprint are heavier than GGUF/MLX.

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

- `Qwen3-14B`: 12k-20k transcript tokens per chunk.
- `Mistral-Nemo`: 20k-60k transcript tokens per chunk when long-context mode is selected.
- `Qwen3-8B`: 8k-12k transcript tokens per chunk.

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

- Summary toggle in Settings.
- Model selection: `Balanced`, `High quality`, `Long context`, `Low memory`.
- Manual `Generate Summary` button for existing meetings.
- Progress state: loading model, chunk summaries, final merge, saving.
- Meeting detail section with summary, decisions, action items, risks, and open questions.

Suggested defaults:

- Windows RTX 4070: `Qwen3-14B Q4_K_M` via `llama.cpp` CUDA.
- Mac M4 Pro: `Qwen3-14B 4-bit` via `llama.cpp` Metal first, with an `mlx-lm` spike later.
- Lower-end systems: `Qwen3-8B Q4_K_M`.

## Packaging Considerations

- Do not bundle all models in the installer; download on demand with explicit user action.
- Store model files under Electron `userData` or a clearly managed model-cache directory.
- Reuse existing model preloading UX patterns where practical.
- Add model-cache inspection/removal UI before shipping large summary models.
- Keep checksums or pinned model filenames for any curated model downloads.

## Risks

- A 14B 4-bit model may still be too heavy for some 8 GB GPUs once context/KV cache is included.
- Long transcripts can exceed context or memory budgets without chunking.
- LLM output can hallucinate action owners or decisions if prompts are not strict.
- JSON parsing/repair must be robust before saving generated metadata.
- `llama.cpp` GPU packaging adds new native binaries to the build pipeline.

## Implementation Checklist

### Phase 1: Prototype

- [ ] Prototype `llama.cpp` CUDA with `Qwen3-14B Q4_K_M` on RTX 4070.
- [ ] Prototype `llama.cpp` Metal with `Qwen3-14B Q4_K_M` on M4 Pro.
- [ ] Prototype lower-memory `Qwen3-8B Q4_K_M`.
- [ ] Compare `Mistral-Nemo-Instruct-2407 Q4_K_M` for long transcripts.
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

- [ ] Add summary settings and model selection.
- [ ] Add post-transcription summary progress.
- [ ] Add meeting-history summary viewer.
- [ ] Add regenerate summary action.

### Phase 5: Validation

- [ ] Test short meeting summaries.
- [ ] Test long meeting chunked summaries.
- [ ] Test malformed JSON retry/repair.
- [ ] Test Windows CUDA and CPU fallback.
- [ ] Test macOS Metal and CPU fallback.

## Status

Research complete. Ready for prototype planning.
