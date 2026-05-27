# Design: Optional Local AI Add-ons

## Overview

Add speaker diarization and transcript summarization as optional post-install local AI add-ons. Both features stay fully local after model setup and do not change the existing Whisper transcription engines.

This design translates the model research docs into product behavior for Settings, the Home/Record view, transcription, and History.

## Product Decisions

| Area | Decision |
|------|----------|
| Privacy | No cloud diarization, cloud summarization, telemetry, or background uploads. |
| Setup timing | Both add-ons are configured after app install through Settings. |
| Hugging Face token | Users provide their own token during setup. Do not ship or proxy a maintainer-owned token. |
| Transcription engines | Keep current transcription paths unchanged: `faster-whisper` on Windows/CUDA and `lightning-whisper-mlx` on Apple Silicon/Metal. |
| Diarization behavior | If speaker identification is set up, it runs automatically for every transcription. No per-meeting opt-in in v1. |
| Mac diarization | Apple Silicon only, using PyTorch Metal/MPS validation for `pyannote/speaker-diarization-community-1`. If MPS is unavailable or validation fails, fall back to today's normal transcription flow without diarization. CPU-only macOS diarization is not shipped. |
| Summary behavior | Summary generation is always user-triggered, even when the summary model is set up. |
| Summary model footprint | Prefer one installed summary model with selectable profiles. Do not require users to download multiple large models for basic profile selection. |
| Summary distribution | Keep the base installer lean. Install the default summary runtime/model through an explicit optional setup artifact/download flow, similar to CUDA setup. |
| Main entry points | Settings owns setup. Home and History expose prompts/actions that route to Settings when setup is missing. |
| History display | Meeting detail uses `Transcript` and `Summary` tabs. |
| Source of truth | Raw transcript remains the source of truth. Speaker labels and summaries are derived artifacts. |

## Implementation Snapshot

- Add-on setup state and model metadata are catalog-driven through `src/ai-addon-state.js`.
- Summary runtime/model setup downloads pinned llama.cpp/GGUF artifacts only after explicit user action and verifies HTTPS host allowlists, filenames, and checksums before Ready.
- Speaker setup installs managed `pyannote.audio` dependencies under Electron `userData` for Windows CUDA or macOS Apple Silicon MPS only, then validates the accelerator and gated model access before Ready.
- Summary and speaker setup report structured add-on progress with percent/byte counters where available. Settings owns the cancel controls; cancellation aborts active downloads/processes and removes partial setup artifacts without deleting a previously valid install.
- Actual speaker runs use the local pyannote cache populated by setup; missing or incomplete cache is treated as setup drift and asks the user to re-run speaker identification setup instead of downloading implicitly.
- Summary runtime archives extract into a cleaned staging directory with ZIP path-traversal checks; runtime resolution prefers the extracted `llama-cli` location so adjacent Windows DLLs and macOS dylibs remain loadable.
- Speaker tokens are stored only with Electron `safeStorage`; token values are not exposed through status IPC, metadata, progress, transcripts, or summaries.
- Derived artifacts live beside recordings as `*.speakers.json`, `*.summary.json`, and `*.summary.md`; meeting metadata stores concise sidecar references only.
- History displays transcript and summary in separate tabs, warns when a saved summary is stale via `sourceTranscriptHash`, and keeps summary generation manual.
- Summary and diarization runs are serialized in the main process so two local AI backends do not compete for consumer GPU memory.

## Feature States

Use a shared add-on state model so Settings, Home, and History render consistently.

| State | Meaning | Primary action |
|-------|---------|----------------|
| `notConfigured` | User has not completed setup. | Open Settings setup card. |
| `needsAccount` | Diarization needs Hugging Face token or model-term acceptance. | Show token and terms links. |
| `downloading` | Model files or runtime assets are being downloaded. | Show progress and logs. |
| `validating` | App is checking token, model cache, runtime, or checksum. | Disable duplicate actions. |
| `ready` | Add-on can run locally. | Allow feature use. |
| `error` | Last setup or run failed. | Show retry plus reset/remove setup. |
| `unsupported` | Current platform/hardware is not supported by the shipped path. | Explain requirement and hide run controls. |

The state should be stored in a local add-on manifest under Electron `userData`, separate from meeting history. Tokens must not be stored in the manifest.

## Settings UX

Add an `AI Add-ons` area below the existing GPU Acceleration settings. Match the current model/GPU setup pattern: status badge, short explanation, install/setup button, progress bar, log output, retry, and remove/reset.

### Speaker Identification Card

Status labels:

| State | Label |
|-------|-------|
| `notConfigured` | Not set up |
| `needsAccount` | Token required |
| `downloading` | Downloading |
| `validating` | Validating |
| `ready` | Ready, runs automatically |
| `error` | Setup failed |
| `unsupported` | Unsupported |

Controls:

| Control | Behavior |
|---------|----------|
| `Set Up Speaker Identification` | Starts guided setup. |
| Hugging Face token input | Stored with Electron `safeStorage`; never written to meeting metadata or logs. |
| `Accept Model Terms` link | Opens `pyannote/speaker-diarization-community-1` page. |
| `Test Token` | Validates token and model access before marking setup ready. |
| Speaker count | Default `Auto`. Optional fixed count should start with 2-4 speaker meeting presets. |
| `Remove Setup` | Deletes local diarization setup state and stops automatic diarization for future transcriptions. |
| `Cancel Download` | Aborts in-progress setup and removes partial managed dependency downloads. Existing ready setup is preserved when cancellation happens during validation. |

Users should bring their own Hugging Face token. A maintainer-owned token should not be embedded in the app, bundled in resources, downloaded from the release, or hidden behind an AvaNevis endpoint because it would be extractable, revocable for everyone after abuse, and tied to the maintainer's account and model-term obligations.

The setup UI should make the token flow explicit:

1. Create or sign in to a Hugging Face account.
2. Accept the `pyannote/speaker-diarization-community-1` model terms.
3. Create a read-only access token.
4. Paste the token into AvaNevis.
5. Click `Test Token`.

The app should store the token with Electron `safeStorage`, redact it in the UI after saving, and never write it to logs, crash output, meeting metadata, or derived transcript files.

Setup-ready definition:

- Hugging Face token is present and valid.
- User has access to `pyannote/speaker-diarization-community-1`.
- Required Python dependencies and model cache are present or can be downloaded explicitly.
- The main process resolves the pyannote model reference from the catalog; renderer-provided model refs are ignored.
- Runtime device policy is valid for the platform. Windows requires CUDA. macOS requires Apple Silicon plus `torch.backends.mps.is_built()` and `torch.backends.mps.is_available()` from the managed dependency environment. CPU-only diarization is not a v1 shipping path.
- App-spawned diarization processes set `PYANNOTE_METRICS_ENABLED=0`.

Once ready, speaker identification is considered active. To disable it, the user removes setup or resets the add-on. This avoids a separate toggle that would conflict with the rule that configured diarization always runs.

If macOS MPS acceleration is unavailable, not validated, or fails at runtime, the app should continue with the current transcription-only flow and show speaker identification as unavailable or failed rather than silently running a slow CPU diarization path.

### Summary Card

Status labels:

| State | Label |
|-------|-------|
| `notConfigured` | Not set up |
| `downloading` | Downloading model |
| `validating` | Validating runtime |
| `ready` | Ready |
| `error` | Setup failed |
| `unsupported` | Unsupported |

Controls:

| Control | Behavior |
|---------|----------|
| `Set Up Summaries` | Downloads/configures the selected local summary model. |
| Summary profile | Selects output style, detail level, chunk budget, and runtime knobs for the installed model. |
| `Remove Model` | Deletes local summary model cache after confirmation. |
| `Validate` | Confirms runtime, model file, checksum, and a tiny JSON-only smoke prompt. |
| `Cancel Download` | Aborts in-progress runtime/model setup, removes partial `.download` files and newly staged artifacts, and preserves an existing ready model/runtime when cancellation happens during validation. |

Summary setup should use a larger optional installer/download artifact rather than bundling the model in the base app. The flow should match the existing CUDA setup pattern: the user explicitly starts setup, the app downloads a pinned artifact for the current platform/runtime, verifies HTTPS host allowlists, filenames, and checksums, unpacks or stages it into the managed model cache, and then validates the local runtime. No summary model or runtime download should happen automatically in the background.

Hugging Face-hosted public GGUF summary artifacts should use the bundled Python `huggingface_hub`/`hf_xet` downloader so the app can use Hugging Face's accelerated Xet transfer path on Windows and macOS. This path remains unauthenticated for public summary models and must not reuse the diarization token; the app still performs pinned SHA-256 verification after download. Canceling setup must terminate the downloader subprocess (`taskkill` on Windows, `SIGTERM`/`SIGKILL` on macOS) before cleanup finishes.

Runtime archives are staged defensively: ZIP entries must resolve inside the extraction directory, extraction destinations are created explicitly, stale extraction staging is removed before reinstall, extracted archive layout is preserved for native library loading, and runtime validation invokes only the runtime/model smoke path rather than passing transcript generation arguments.

Generation runs `llama-cli` in non-interactive single-turn/simple-IO mode for the pinned runtime. The current Qwen3.5 catalog path disables reasoning output for structured JSON summaries; add catalog-level runtime flag metadata before adding a summary model that needs different behavior.

Initial installed model:

| Slot | Model |
|------|-------|
| Default summary model | `Qwen3.5-9B` 4-bit GGUF after pinned `llama.cpp` CUDA/Metal validation. |

Selectable profiles should use that one installed model where possible:

| Profile | Behavior |
|---------|----------|
| Concise | Shorter overview, fewer bullets, smaller output budget. |
| Balanced | Default meeting notes: overview, topics, decisions, action items, risks, open questions. |
| Detailed | More topic coverage and evidence timestamps, larger output budget. |
| Action items | Prioritizes owners, tasks, due dates, blockers, and follow-up questions. |

Fallback model options should be installer/setup alternatives, not profile requirements:

| Profile | Model |
|---------|-------|
| Low memory install | `Qwen3.5-4B` 4-bit GGUF only if the default model is too large for the user's hardware. |
| Mature runtime install | `Qwen3-14B` 4-bit GGUF only if `Qwen3.5` runtime support is not acceptable. |
| Long context fallback | `Mistral-Nemo-Instruct-2407` 4-bit GGUF if needed. |
| Research | Gemma 4 variants after exact `llama.cpp` `gemma4` validation. |

There should be no auto-summary toggle in v1. Setup only means the installed model is available when the user clicks `Generate Summary`.

## Home/Record UX

The existing Record tab acts as Home.

### Prompt Priority

Render setup prompts in this order so users are not asked to configure downstream add-ons before the base system is ready.

| Priority | Prompt | Blocking |
|----------|--------|----------|
| 1 | Required Whisper model first-time setup | Yes |
| 2 | Missing permissions or audio devices | Yes for recording |
| 3 | Missing CUDA on Windows/NVIDIA | No, but highest non-blocking CTA |
| 4 | Missing speaker identification setup | No |
| 5 | Missing summary setup | No |

Speaker identification setup must be gated behind CUDA readiness on Windows/NVIDIA systems. If CUDA is missing, show the CUDA CTA and hide the diarization setup CTA. After CUDA is installed, the Home prompt can ask the user to set up speaker identification.

For macOS, use the validated MPS diarization policy instead of the CUDA gate. If Apple Silicon MPS acceleration is unavailable, setup must fail closed or be shown as unsupported, and the app must keep the current transcription-only flow.

### Speaker Identification Prompt

Show when all are true:

- The base app is initialized.
- A platform-supported diarization runtime is available.
- On Windows/NVIDIA, CUDA is installed and detected.
- On macOS, Apple Silicon MPS diarization is supported and setup has not already failed accelerator validation.
- Speaker identification is not configured.
- No higher-priority setup prompt is visible.

Prompt copy direction:

```text
Add speaker labels to future transcripts
Set up local speaker identification in Settings. Once ready, it will run automatically after transcription.
```

Primary action: `Set Up in Settings`.

### Summary Setup Prompt

Show as a lower-priority card or inline callout. It should not block recording or transcription.

Prompt copy direction:

```text
Generate local meeting summaries
Set up the local summary model to create decisions, action items, risks, and open questions on demand.
```

Primary action: `Set Up in Settings`.

### Post-Transcription Actions

After a meeting is transcribed and saved, show a `Generate Summary` action alongside `Copy` and `Save`.

Button behavior:

| Summary state | Behavior |
|---------------|----------|
| `ready` | Start summary generation for the current saved meeting. |
| `notConfigured` or `error` | Navigate to Settings and focus the Summary card. |
| `downloading` or `validating` | Show progress and disable duplicate generation. |
| `unsupported` | Explain why summaries are unavailable. |

Summary generation must never start automatically after transcription.

Saved summaries include a `sourceTranscriptHash`. If a transcript changes after generation, History should mark the summary as stale and offer regeneration instead of silently treating it as current.

## Transcription Flow

When speaker identification is ready, new recordings use a diarization-guided transcription path so speaker labels are based on pyannote turns before Whisper chunks are created. If guided transcription fails, AvaNevis saves a normal transcript, persists diarization error metadata, and keeps the transcript usable.

```text
recording stops
  -> if speaker identification is ready, run pyannote diarization first
  -> build padded speaker windows from diarization turns
  -> transcribe speaker windows with Whisper
  -> save speaker-labeled transcript and speaker sidecar
  -> save meeting metadata
  -> render transcript on Home
```

Implementation notes:

- Run diarization before Whisper chunking when setup is ready; keep the post-hoc diarization merge as a fallback/legacy path only.
- Use padded speaker windows so Whisper has boundary context, but assign text back to the unpadded speaker turn when timestamps are available.
- Use the same source audio file for diarization and transcription windows.
- Main-process path checks must keep audio, transcript, speaker sidecar, and generated summary sidecars inside the recordings directory.
- On macOS, only run diarization with the MPS device required by the main process. On Windows, require CUDA where platform policy says CUDA is required. If the required accelerator is unavailable, refuse CPU fallback and save the normal transcript without speaker labels.
- Prefer `exclusive_speaker_diarization` for timestamp alignment.
- Write guided transcripts through hidden temporary Markdown files before replacing the final transcript path; clean up stale guided temp files on startup.
- Preserve the unlabeled transcript data or source hash for debugging/regeneration if practical.
- If guided diarization/transcription fails, save the meeting with the normal transcript, mark the diarization run as failed, and show a warning. Do not discard the transcript.

The final transcript display should include speaker labels when available:

```markdown
[00:03:12 - 00:03:20] **Speaker 1:** Let's start with the launch timeline.
[00:03:20 - 00:03:31] **Speaker 2:** The blocker is still QA capacity.
```

## Summary Flow

Summaries are generated only from explicit user action on Home or History.

```text
user clicks Generate Summary
  -> verify summary add-on is ready
  -> load saved transcript and segment metadata
  -> chunk transcript by token budget
  -> generate chunk summaries as JSON
  -> merge final structured summary
  -> validate/repair JSON
  -> save summary JSON and Markdown
  -> update Home or History UI
```

Guidelines:

- Prefer speaker-labeled transcript when available.
- Work without diarization by using `Unknown` or omitted owners.
- Include evidence timestamps in structured output.
- Disable model thinking mode for Qwen models where applicable.
- Validate JSON before writing meeting metadata.
- A failed summary run should not alter the transcript.
- Save summary sidecars through unique process/timestamp temp filenames before replacing existing outputs.
- Summary generation runs through the main-process local AI compute queue shared with diarization.

## History UX

Meeting detail should replace the single transcript section with tabs.

Tabs:

| Tab | Contents |
|-----|----------|
| `Transcript` | Existing Markdown transcript viewer, copy action, save action, timestamp styling, and audio playback sync. |
| `Summary` | Generated summary if present, empty state if absent, generation status, regenerate action, and save/copy summary actions when useful. |

Summary tab empty state:

```text
No summary yet
Generate a local summary for this meeting. Your transcript stays on this device.
```

Primary action: `Generate Summary`.

If the summary model is missing, `Generate Summary` navigates to Settings and focuses the Summary card instead of opening an error dialog.

If a summary already exists:

- Render sections for overview, topics, decisions, action items, risks, and open questions.
- Show generation metadata: model profile, generated time, and source transcript timestamp/hash.
- Offer `Regenerate` with confirmation if it will replace the saved summary.

## Persistence Shape

Keep meeting history writes inside the existing `backend/meeting_manager.py` locking and atomic-write path. Store large derived outputs as files and store only references plus concise metadata in `meetings.json`.

AI metadata updates are intentionally narrow: only `diarization` and `summary` are accepted at the top level, sidecar paths must stay inside the recordings directory, `sourceTranscriptHash` must be a `sha256:<64 hex>` value, and string metadata is whitespace-normalized and length-capped before persistence.

Suggested meeting metadata additions:

```json
{
  "id": "meeting_20260107_104555",
  "audioPath": "...",
  "transcriptPath": "...",
  "ai": {
    "diarization": {
      "status": "completed",
      "model": "pyannote/speaker-diarization-community-1",
      "completedAt": "2026-01-07T10:58:12Z",
      "speakerCount": 3,
      "segmentsPath": ".../meeting_20260107_104555.speakers.json",
      "error": null
    },
    "summary": {
      "status": "completed",
      "modelProfile": "balanced",
      "model": "Qwen3.5-9B-Q4_K_M",
      "generatedAt": "2026-01-07T11:03:44Z",
      "sourceTranscriptHash": "sha256:...",
      "jsonPath": ".../meeting_20260107_104555.summary.json",
      "markdownPath": ".../meeting_20260107_104555.summary.md",
      "error": null
    }
  }
}
```

Derived files:

| File | Purpose |
|------|---------|
| `*.speakers.json` | Raw diarization turns and merged segment speaker labels. |
| `*.summary.json` | Validated structured summary object. |
| `*.summary.md` | Rendered summary for display/export. |

Do not store Hugging Face tokens, model download URLs with secrets, prompts containing sensitive transcript text, or raw LLM logs in meeting metadata.

## IPC And Progress Events

Add IPC around stable feature boundaries instead of wiring UI directly to backend scripts.

Candidate handlers:

| Handler | Purpose |
|---------|---------|
| `get-ai-addon-status` | Return diarization and summary setup states. |
| `setup-diarization` | Validate token, download/check model, write add-on manifest. |
| `remove-diarization-setup` | Remove token/cache references according to user choice. |
| `setup-summary-model` | Download/check selected GGUF/runtime assets. |
| `remove-summary-model` | Remove selected summary model cache. |
| `generate-summary` | Generate or regenerate a summary for one meeting. |

Setup/remove/validate actions are serialized through the add-on setup queue. Compute-heavy summary and diarization runs are serialized through a separate main-process compute queue to avoid concurrent `llama-cli`/pyannote GPU pressure.

Candidate progress events:

| Event | Payload |
|-------|---------|
| `ai-addon-progress` | `{ feature, phase, message, percent? }` |
| `diarization-progress` | `{ meetingId, phase, message }` |
| `summary-progress` | `{ meetingId, phase, chunkIndex?, chunkTotal?, message }` |

Progress must avoid emitting transcript text or token values to logs. Redaction keys are shared by setup progress and backend progress parsing to avoid drift.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Invalid HF token | Keep diarization not ready, focus token input, do not run automatically. |
| HF terms not accepted | Show terms link and keep setup in `needsAccount`. |
| macOS diarization acceleration unavailable | Keep setup unsupported or fail setup/run closed with clear Metal/MPS copy, and continue with the current transcription-only flow. |
| Diarization runtime error | Save normal transcript, mark diarization `error`, warn user. |
| Summary model missing | Route `Generate Summary` to Settings. |
| Summary malformed JSON | Retry/repair; if still invalid, save no summary and show error. |
| Unsafe runtime archive path | Reject extraction and keep setup out of Ready. |
| Unallowed summary download host | Reject download before network transfer and keep setup out of Ready. |
| User deletes model cache externally | Next status check returns `notConfigured` or `error` and offers repair. |
| Transcript changed after summary | Mark summary stale using `sourceTranscriptHash` and offer regenerate. |

## Validation

Automated coverage:

- Unit-test add-on state normalization.
- Unit-test Home prompt priority, especially CUDA before diarization on Windows/NVIDIA.
- Unit-test speaker/segment overlap merge behavior.
- Unit-test summary JSON validation and malformed-output retry behavior.
- Unit-test meeting metadata persistence with derived artifact references.
- Unit-test summary download host allowlists and ZIP traversal guards.
- Unit-test summary/diarization metadata sanitization and catalog-resolved model refs.
- JS tests for History `Transcript` / `Summary` tab state.

Manual coverage:

- RTX 4070 12 GB: CUDA transcription remains unchanged, diarization runs after setup, summary generation runs only on click.
- M4 Pro: Metal transcription remains unchanged, diarization setup validates PyTorch MPS before Ready, runtime forces MPS with no CPU fallback, and summary generation works through `llama.cpp` Metal or chosen validated runtime.
- 1-2 hour meetings with 2-4 speakers.
- Missing CUDA hides diarization setup prompt until CUDA is installed.
- macOS without PyTorch MPS availability keeps the existing transcription-only flow and never runs CPU-only diarization.
- Missing summary setup makes Home/History `Generate Summary` navigate to Settings.
- Generated summaries persist and reopen in History.

## Related Docs

- [Speaker diarization research](FEATURE_SPEAKER_DIARIZATION.md)
- [Transcript summaries research](FEATURE_TRANSCRIPT_SUMMARIES.md)
- [Local AI implementation plan](PLAN_LOCAL_AI_FEATURES.md)
- [Roadmap](../initiatives/ROADMAP.md)
