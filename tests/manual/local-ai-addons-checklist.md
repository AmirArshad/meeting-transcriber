# Local AI Add-ons Manual Checklist

Use this checklist when validating speaker identification or local summaries on target hardware.

## Privacy And Network

- [ ] Confirm no network activity occurs during transcription, diarization, or summary generation.
- [ ] Confirm network activity occurs only when the user explicitly starts summary model/runtime setup, Whisper model setup, CUDA setup, or update checks.
- [ ] Confirm Hugging Face token values never appear in logs, progress events, meeting metadata, transcripts, or summaries.

## Windows CUDA Speaker Identification

- [ ] Use Windows 10/11 x64 with NVIDIA GPU and CUDA setup complete.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Validate setup from Settings and confirm status becomes Ready.
- [ ] Record and transcribe a meeting with 2-4 speakers.
- [ ] Confirm diarization starts automatically only after transcription is saved.
- [ ] Confirm normal transcript remains saved if diarization fails.
- [ ] Confirm `*.speakers.json` is written and meeting metadata references it without token values.
- [ ] Confirm current transcript and History transcript show speaker labels.

## macOS Diarization Policy

- [ ] Confirm speaker identification setup is hidden or marked unsupported unless accelerated Apple Silicon diarization has been explicitly validated.
- [ ] Confirm macOS transcription still works normally when diarization is unavailable.
- [ ] Confirm no CPU-only diarization fallback runs in v1.

## Summary Setup And Generation

- [ ] Start summary setup explicitly from Settings.
- [ ] Confirm the pinned llama.cpp runtime downloads, verifies, and extracts before the model is marked ready.
- [ ] Confirm the pinned GGUF model downloads and checksum-verifies before Ready.
- [ ] Generate a summary from Home after a saved transcript.
- [ ] Generate or regenerate a summary from History.
- [ ] Confirm `*.summary.json` and `*.summary.md` are written and referenced in meeting metadata.
- [ ] Confirm Summary tab reopens the saved summary after app restart.
- [ ] Confirm Copy and Save actions export the saved Markdown summary.
- [ ] Modify/regenerate a transcript and confirm stale summary warning appears until summary is regenerated.

## Long Meeting Validation

- [ ] Validate a 30-60 minute meeting with 2-4 speakers on Windows CUDA.
- [ ] Validate a 1-2 hour transcript summary with the default profile.
- [ ] Validate Concise, Balanced, Detailed, and Action items profiles reuse the installed model.
- [ ] Record processing time, peak RAM/VRAM, model sizes, and quality notes.

## Failure Modes

- [ ] Invalid Hugging Face token shows a clear setup error and does not store plaintext tokens.
- [ ] Missing model-term acceptance shows a clear token/access error.
- [ ] Missing summary model routes the user to Settings and does not start generation.
- [ ] Runtime missing `llama-cli` keeps summary setup out of Ready.
- [ ] Checksum mismatch keeps summary setup out of Ready and explains the mismatch.
- [ ] Summary generation failure leaves transcript files unchanged.
