# Transcription Guide

## How The App Transcribes Meetings Today

AvaNevis records microphone audio and desktop audio separately, then aligns and mixes them after recording stops.

That mixed meeting file is what the app transcribes and saves to history.

This design keeps the recording pipeline reliable while still producing a single playback file and a single meeting transcript.

## Whisper Platform Backends

- Windows: `faster-whisper`
- Linux: CPU `faster-whisper` by default; optional verified managed CUDA 12
- macOS Apple Silicon: `lightning-whisper-mlx`
- Intel Mac development fallback: `faster-whisper` CPU path (selected via `getTranscriberModule` in `src/main-process/transcription-runtime-helpers.js`; packaged macOS builds are Apple Silicon only)

## Best Results

### Use the right model size

- `small` is the default and a good general choice.
- `medium` usually helps with noisier meetings or heavier overlap.
- `large-v3` is available through explicit model setup and needs more memory and
  disk space. Choose it according to your machine and meeting needs.
- Tiny/Base are retired from new choices. Existing preferences move to Small;
  previously queued jobs retain their saved model.

### Pick the correct language

Whisper quality drops quickly if the selected language does not match the dominant speech in the recording.
Persian is retired from new choices; previously queued work keeps its saved language.

### Optional English-only Parakeet (v2.10)

Set up and activate Parakeet v2 in Settings for Windows CUDA, Apple Silicon Metal
or Linux managed CUDA 12. Whisper remains the default. Parakeet requires its
pinned runtime/model/VAD artifacts and a supported accelerator; it has no CPU or
cloud fallback. Unavailable or damaged setup fails recoverably, with Repair and
Remove paths. You can explicitly retry a meeting with Whisper.

The engine/model/language selected when capture starts is retained for queued
work and interrupted-capture recovery. Changing Settings later does not rewrite
an existing request. No universal speed, memory or accuracy improvement is claimed.

### Keep the source audio clean

- use a decent microphone
- avoid clipping or extremely low mic volume
- keep system audio audible and stable
- reduce unnecessary notification sounds during meetings

### Expect overlap to remain hard

Whisper is much better on clean, turn-based speech than on several people talking at once.

## What The App Is Optimized For

- local-only transcription
- full-meeting notes and playback
- timestamped transcript output
- one saved meeting record per recording session

## Known Limitations

- Speaker diarization and transcript summaries are optional local AI add-ons (explicit setup; see feature docs below).
- Real-time transcription is not implemented.
- Transcription, guided speaker transcription, diarization, and summaries run one at a time through the main-process compute queue (model download/preload is separate).
- The UI does not currently expose a separate-track transcription mode for mic-only transcripts.
- Very noisy or heavily overlapping meetings will still be harder to transcribe accurately.

## GPU Notes

### Windows

- CUDA acceleration is optional.
- If GPU packages are not installed, Whisper can run on CPU. Parakeet requires CUDA.

### macOS

- Apple Silicon packaged builds use MLX/Metal automatically.
- MLX model files are stored in `~/Library/Caches/avanevis/mlx_models`.

### Linux

- Whisper uses CPU until optional managed CUDA 12 setup is admitted.
- An installed but unusable managed runtime fails closed; use Repair or Uninstall
  to restore an admitted GPU runtime or return Whisper to CPU.
- Parakeet, speaker labels and Qwen summaries require their supported CUDA setup;
  those features have no CPU/cloud fallback.

## Practical Recommendations

1. Start with the default `small` model.
2. Move to `medium` if the meeting is noisy or has frequent overlap.
3. Confirm both mic and desktop audio are actually present before relying on the transcript.
4. For recorder changes, validate with the manual checklist in `tests/manual/recording-smoke-checklist.md`.

## Related Docs

- Root [`AGENTS.md`](../../AGENTS.md) — transcription cache locations, offline behavior, compute queue
- [Meeting transcription and history](MEETING_TRANSCRIPTION.md)
- [Speaker diarization](../completed/FEATURE_SPEAKER_DIARIZATION.md)
- [Transcript summaries](../completed/FEATURE_TRANSCRIPT_SUMMARIES.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [GPU setup](../development/SETUP_GPU.md)
