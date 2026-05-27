# Transcription Guide

## How The App Transcribes Meetings Today

AvaNevis records microphone audio and desktop audio separately, then aligns and mixes them after recording stops.

That mixed meeting file is what the app transcribes and saves to history.

This design keeps the recording pipeline reliable while still producing a single playback file and a single meeting transcript.

## Platform Backends

- Windows: `faster-whisper`
- macOS Apple Silicon: `lightning-whisper-mlx`
- Intel Mac development fallback: `faster-whisper` CPU path in `src/main.js`

## Best Results

### Use the right model size

- `small` is the default and a good general choice.
- `medium` usually helps with noisier meetings or heavier overlap.
- `tiny` and `base` are faster but less resilient to real meeting audio.

### Pick the correct language

Whisper quality drops quickly if the selected language does not match the dominant speech in the recording.

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
- If GPU packages are not installed, transcription falls back to CPU.

### macOS

- Apple Silicon packaged builds use MLX/Metal automatically.
- MLX model files are stored in `~/Library/Caches/avanevis/mlx_models`.

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
