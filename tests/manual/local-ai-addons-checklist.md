# Local AI Add-ons Manual Checklist

Use this checklist when validating speaker identification or local summaries on target hardware.

## Privacy And Network

- [ ] Confirm no network activity occurs during transcription, diarization, or summary generation.
- [ ] Confirm network activity occurs only when the user explicitly starts summary model/runtime setup, Whisper model setup, CUDA setup, or update checks.
- [ ] Confirm pyannote/PyTorch dependency downloads occur only when the user explicitly starts **Pyannote** speaker identification setup.
- [ ] Confirm Speakrs model-pack / Windows ORT downloads occur only when the user explicitly starts **Speakrs** setup.
- [ ] Confirm Hugging Face token values never appear in logs, progress events, meeting metadata, transcripts, or summaries.
- [ ] Confirm bearer tokens, legacy `Authorization: token ...`, `token=` / `access_token=` / `api_key=` values, `X-Api-Key`, and URL credentials are redacted from setup/runtime errors.

## Windows CUDA Pyannote Speaker Identification

- [ ] Use Windows 10/11 x64 with NVIDIA GPU and CUDA setup complete.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Confirm speaker setup does not download dependencies until a token is entered.
- [ ] Start speaker setup and confirm managed dependencies install under Electron `userData/ai-addons/dependencies/diarization`.
- [ ] Cancel speaker setup during dependency download/install and confirm setup returns to Not configured, partial dependency files are removed, and token values are not logged.
- [ ] Re-run speaker setup after cancellation and confirm stale dependency artifact directories are removed while the current artifact installs cleanly.
- [ ] Validate setup from Settings and confirm status becomes Ready.
- [ ] Record and transcribe a meeting with 2-4 speakers.
- [ ] Confirm speaker-guided transcription starts automatically when setup is ready: pyannote runs first, then Whisper transcribes speaker-shaped windows.
- [ ] Confirm normal transcript remains saved if diarization fails.
- [ ] Confirm `*.speakers.json` is written and meeting metadata references it without token values.
- [ ] Confirm History shows a per-recording speaker-identification failure message if guided transcription falls back to normal transcription.
- [ ] Confirm current transcript and History transcript show speaker labels.
- [ ] Attempt a second diarization/summary run while one local AI backend is active and confirm the app serializes work instead of launching concurrent GPU-heavy processes.

## macOS Pyannote Diarization Policy

- [ ] Use Apple Silicon macOS only; confirm Intel macOS is unsupported for speaker identification.
- [ ] Enter the user's own Hugging Face token after accepting `pyannote/speaker-diarization-community-1` terms.
- [ ] Confirm speaker setup installs managed dependencies under Electron `userData/ai-addons/dependencies/diarization` only after explicit setup.
- [ ] Confirm setup validates PyTorch Metal/MPS availability from the managed dependency environment before status becomes Ready.
- [ ] Temporarily make MPS unavailable or force validation failure and confirm setup stays Error/Unsupported with clear Metal/MPS copy.
- [ ] Record and transcribe a meeting with 2-4 speakers and confirm speaker-guided transcription uses MPS, writes `*.speakers.json`, and speaker labels appear.
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

## Speakrs / Pyannote Selector

- [ ] Settings shows two cards: Speakrs and Pyannote. Apple Silicon marks Speakrs as Recommended; Windows does not.
- [ ] Keyboard: native radio group. Tab lands on the selected card, arrow keys move between Speakrs and Pyannote, and a visible focus ring appears. Mouse click still selects. Disabled cards skip keyboard navigation.
- [ ] Cards stay equal height and aligned at 100–200% zoom; they stack on a narrow Settings pane rather than overflowing.
- [ ] New-user Home speaker prompt shows the same two cards and Set Up starts Speakrs (no token field).
- [ ] Token fields and speaker-count stay **visually** hidden while Speakrs is selected (`.ai-addon-field[hidden]` must beat `display: flex`); they appear only for Pyannote. `needsAccount` still appears for Pyannote. Switching away from Pyannote clears typed tokens. Home and Settings never mix each other's token values.
- [ ] When the other engine is installed, Settings/Home primary button reads **Switch model** (not Set Up). Selecting the other card leaves that button enabled. After setup reaches Ready, engine cards/radios must stay enabled (not stuck dimmed) so Speakrs→Pyannote is possible.
- [ ] Switch Speakrs → Pyannote from a Ready Speakrs install: confirm copy appears, Speakrs pack/ORT is deleted, token field is shown (leave blank to reuse a saved token), shared CUDA pip (`nvidia-cublas`) remains.
- [ ] Switch Pyannote → Speakrs: confirm copy appears, pyannote deps/HF cache are deleted, **saved Hugging Face token is kept**, token UI hides, shared CUDA pip remains. Switching back to Pyannote with an empty token field reuses that saved token. Token-only Pyannote (saved token, no model tree) still requires this confirm and still enables Remove.
- [ ] Remove deletes only the active engine (and any saved Hugging Face token) and leaves `engine` as the last choice so re-setup is one click.
- [ ] Setup/Remove/Switch is rejected while setup is running or compute/preload/GPU-runtime work is pending. A job that starts after setup is queued must not begin exclusive deletion.
- [ ] Packaged missing bundled `speakrs-cli`: Home and Settings show the incomplete-install / Reinstall AvaNevis copy. Set Up is disabled for Speakrs (it cannot restore the bundled binary). Do not tell the user to re-run speaker setup. No Python `FileNotFoundError` or traceback. Dev-mode missing CLI keeps the dev copy and does not show Reinstall AvaNevis.
- [ ] Windows Speakrs setup: no token field; downloads the model pack and ORT; Ready; a new recording uses CUDA guided transcription and writes `*.speakers.json` without token values.
- [ ] macOS Speakrs setup: Apple Silicon CoreML-only (no CPU fallback); no token field; Ready; a new recording uses `coreml` guided transcription and writes `*.speakers.json`.
- [ ] Settings > About credits Speakrs (Apache-2.0) and pyannote (CC BY 4.0). Open third-party notices includes the Speakrs pack table and bundled `speakrs-cli`.

## Linux (first version — add-ons stay greyed `unsupported`)

Speaker identification and local summaries are **out of scope for the first Linux version** (Core Beta, Phases 0–5 in `docs/initiatives/LINUX_SUPPORT.md`). There is no Omarchy host with NVIDIA CUDA to validate those add-ons; do not ship a CPU fallback. Home/Settings/History must show the features **visible but greyed out**, with copy that they are not available on Linux in this version and will return in a future Linux update. Setup, switch, token, and Generate Summary must not start.

- [ ] **Phase 0:** catalog status is `unsupported` (`tests/js/linux-platform-selection.test.js`).
- [ ] **Phase 4:** Settings cards are visually greyed; Set Up / Install Model / Validate / Remove / Switch / token fields disabled; Home AI add-on CTA does not offer setup; History Generate Summary disabled; Linux-specific future-version copy is shown.
- [ ] **Later version (Phases 6–9, needs Omarchy + NVIDIA):** Linux CUDA Whisper; Speakrs/Pyannote CUDA-only; pinned Linux llama.cpp summaries. Do not run these rows on CPU-only Omarchy.

## Failure Modes

- [ ] Invalid Hugging Face token shows a clear setup error and does not store plaintext tokens.
- [ ] Missing model-term acceptance shows a clear token/access error.
- [ ] Missing summary model routes the user to Settings and does not start generation.
- [ ] Runtime missing `llama-cli` keeps summary setup out of Ready.
- [ ] Checksum mismatch keeps summary setup out of Ready and explains the mismatch.
- [ ] Untrusted summary/runtime download host keeps setup out of Ready.
- [ ] Unsafe ZIP entries that escape the extraction directory are rejected before extraction.
- [ ] Summary generation failure leaves transcript files unchanged.
