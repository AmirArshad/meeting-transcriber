# Local AI Add-ons Manual Checklist

Use this checklist when validating speaker identification or local summaries on target hardware.

## Privacy And Network

- [ ] Confirm no network activity occurs during transcription, diarization, or summary generation.
- [ ] Confirm network activity occurs only when the user explicitly starts summary model/runtime setup, Whisper model setup, CUDA setup, or update checks.
- [ ] Confirm pyannote/PyTorch dependency downloads occur only when the user explicitly starts speaker identification setup.
- [ ] Confirm Hugging Face token values never appear in logs, progress events, meeting metadata, transcripts, or summaries.
- [ ] Confirm bearer tokens, legacy `Authorization: token ...`, `token=` / `access_token=` / `api_key=` values, `X-Api-Key`, and URL credentials are redacted from setup/runtime errors.

## Windows CUDA Speaker Identification

- [ ] Use Windows 10/11 x64 with NVIDIA GPU and CUDA setup complete.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Confirm speaker setup does not download dependencies until a token is entered.
- [ ] Start speaker setup and confirm managed dependencies install under Electron `userData/ai-addons/dependencies/diarization`.
- [ ] Cancel speaker setup during dependency download/install and confirm setup returns to Not configured, partial dependency files are removed, and token values are not logged.
- [ ] Re-run speaker setup after cancellation and confirm stale dependency artifact directories are removed while the current artifact installs cleanly.
- [ ] Validate setup from Settings and confirm status becomes Ready.
- [ ] Record and transcribe a meeting with 2-4 speakers.
- [ ] Confirm diarization starts automatically only after transcription is saved.
- [ ] Confirm normal transcript remains saved if diarization fails.
- [ ] Confirm `*.speakers.json` is written and meeting metadata references it without token values.
- [ ] Confirm current transcript and History transcript show speaker labels.
- [ ] Attempt a second diarization/summary run while one local AI backend is active and confirm the app serializes work instead of launching concurrent GPU-heavy processes.

## macOS Diarization Policy

- [ ] Use Apple Silicon macOS only; confirm Intel macOS is unsupported for speaker identification.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Confirm speaker setup installs managed dependencies under Electron `userData/ai-addons/dependencies/diarization` only after explicit setup.
- [ ] Confirm setup validates PyTorch Metal/MPS availability from the managed dependency environment before status becomes Ready.
- [ ] Temporarily make MPS unavailable or force validation failure and confirm setup stays Error/Unsupported with clear Metal/MPS copy.
- [ ] Record and transcribe a meeting with 2-4 speakers and confirm diarization runs after transcription using MPS, writes `*.speakers.json`, and speaker labels appear.
- [ ] Confirm macOS transcription still works normally when diarization setup or runtime fails.
- [ ] Confirm no CPU-only diarization fallback runs in setup or at runtime.
- [ ] Cancel speaker setup during dependency download/install and confirm partial dependency files are removed and token values are not logged.

## Summary Setup And Generation

- [ ] Start summary setup explicitly from Settings.
- [ ] Confirm Settings shows progress and a Cancel Download action while runtime/model setup is active.
- [ ] Cancel summary setup during runtime download and confirm partial `.download` files and newly staged runtime artifacts are removed.
- [ ] Cancel summary setup during validation after a previously ready install and confirm the existing model/runtime remain Ready.
- [ ] Confirm the pinned llama.cpp runtime downloads, verifies, and extracts before the model is marked ready.
- [ ] Confirm unsafe or unparseable ZIP/`tar.gz` runtime entries are rejected before extraction.
- [ ] Confirm runtime archives extract into a cleaned staging directory and summary execution uses the extracted `llama-cli` location with adjacent native libraries intact.
- [ ] Confirm the pinned GGUF model downloads through Hugging Face `huggingface_hub`/`hf_xet` on Hugging Face-hosted artifacts and checksum-verifies before Ready.
- [ ] Confirm Hugging Face model downloads write temporary files only under the managed summary cache and checksum-verify before moving into place.
- [ ] Cancel summary setup during the Hugging Face model download and confirm the downloader subprocess exits, partial files are removed, and no diarization token is used.
- [ ] Generate a summary from Home after a saved transcript.
- [ ] Generate or regenerate a summary from History.
- [ ] Confirm `*.summary.json` and `*.summary.md` are written and referenced in meeting metadata.
- [ ] Confirm Summary tab reopens the saved summary after app restart.
- [ ] Confirm Copy and Save actions export the saved Markdown summary.
- [ ] Modify/regenerate a transcript and confirm stale summary warning appears until summary is regenerated.

## Long Meeting Validation

- [ ] Validate a 30-60 minute meeting with 2-4 speakers on Windows CUDA.
- [ ] Validate a 30+ minute Apple Silicon transcription for transcript completeness with the default MLX batch size. Only test `AVANEVIS_MLX_WHISPER_BATCH_SIZE` overrides as a controlled performance experiment.
- [ ] Validate a 1-2 hour transcript summary with the default profile.
- [ ] Validate Concise, Balanced, Detailed, and Action items profiles reuse the installed model.
- [ ] Record processing time, peak RAM/VRAM, model sizes, and quality notes.

## Failure Modes

- [ ] Invalid Hugging Face token shows a clear setup error and does not store plaintext tokens.
- [ ] Missing model-term acceptance shows a clear token/access error.
- [ ] Missing summary model routes the user to Settings and does not start generation.
- [ ] Runtime missing `llama-cli` keeps summary setup out of Ready.
- [ ] Checksum mismatch keeps summary setup out of Ready and explains the mismatch.
- [ ] Untrusted summary/runtime download host keeps setup out of Ready.
- [ ] Unsafe ZIP entries that escape the extraction directory are rejected before extraction.
- [ ] Summary generation failure leaves transcript files unchanged.
