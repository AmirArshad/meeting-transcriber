# AvaNevis v2.10

v2.9.0 is released. See the [v2.9.0 release notes](docs/releases/v2.9.0.md)
and [compatibility matrix](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md).

This file is the **scope and status log**. It is not an implementation design.
Sequencing, remaining investigations, and which machines they need live in the
[v2.10 plan index](docs/superpowers/plans/2026-09-06-v2.10.md). Designs are not
implementation or acceptance evidence.

## Status

v2.10 is designed. Almost none of it is implemented.

- Designs exist for inference performance, optional Parakeet, Whisper
  language/model policy, summarisation languages/models, and Settings /
  navigation / shortcuts.
- The only executed qualification is local inference performance on Apple
  Silicon (2026-09-14): keep current Opus encoding, Whisper defaults, and 32k
  summary context. No production change. Windows and Linux are unqualified.
- Click-away meeting rename is in scope and still needs a short design.
- No checkbox in the committed scope below is complete.

## How to sequence the work

Settings and the transcription **policy** change (Persian / Tiny / Base off
new choices) do not wait on hardware investigations. New engines, Whisper
Large, extra language removals, summary-language claims, and inference default
changes do.

1. **Can start now:** Settings presentation, keyboard shortcuts, click-away
   rename (design first), and the curated Whisper choice list.
2. **Investigate next, on the matching release machines:** Parakeet,
   Whisper Large, other listed languages, Qwen summary languages, a local
   output-language check, alternative summary models, Linux mic volume, and
   Windows/Linux inference only if a speed change is still in play. Details
   and hosts are in the [plan index](docs/superpowers/plans/2026-09-06-v2.10.md).
3. **Implement after those results:** Parakeet, Large, summary-language
   gating, any extra language removals, any replacement summary model, and any
   inference default change.

Keep recordings, transcripts, tokens, scratch reports, and user paths out of
git. Public qualification notes should identify hardware class, OS, app
revision, and artifact hashes — not home directories or meeting content.

## v2.10 scope — committed

### Transcription and language support

Design: [Language/model policy and Whisper Large](docs/superpowers/plans/2026-09-07-language-model-policy-whisper-large.md).
Slice A (curated choices) can ship without Large or extra language removals.
Slice B (Large) and slice C (other languages) need qualification first.

- [ ] Remove Farsi/Persian from the language list because of poor observed performance.
- [ ] Explore whether any other currently listed languages also have poor performance and should be removed.
- [ ] Add Whisper Large as a transcription model option.
- [ ] Remove Tiny and Base model options; Small becomes the smallest available Whisper model.
- [ ] Add optional English-only Parakeet transcription in Settings, targeting Windows, Apple Silicon macOS, and Linux with independent validation gates. Prioritize faster transcription and lower resource use; improved accuracy is optional. Design: [Parakeet integration](docs/superpowers/plans/2026-09-06-parakeet-integration.md). Qualify a runtime per platform before implementation.

### Summarisation

Design: [Qwen language support and alternative summarisation models](docs/superpowers/plans/2026-09-07-summary-languages-and-models.md).
Language qualification (slice A) and alternative-model evaluation (slice B)
are independent. Do not claim supported languages or a better model until
those results exist.

- [ ] Explore which languages the current Qwen summarisation model actually supports.
- [ ] Enable summarisation only for the supported languages retained by the product.
- [ ] Ensure Qwen summary output matches the language of the transcript.
- [ ] Explore whether a better summarisation model than the current Qwen model is now available.

### Settings and navigation UX

Design: [Settings, navigation and keyboard shortcuts](docs/superpowers/plans/2026-09-07-settings-navigation-shortcuts.md).
This slice does not wait on model investigations. Removing Speakrs must
preserve any saved Hugging Face token; token deletion applies only to
Pyannote removal.

- [x] On Linux, remove or redesign the clickable Speakrs tab when Speakrs is the only available speaker-identification engine.
- [x] Preserve saved Hugging Face tokens when removing Speakrs and remove token warnings from its confirmation; token deletion and warnings apply only to Pyannote removal.
- [x] Revisit Setup / Install Model / Remove Model terminology in favor of clearer feature enable/disable language, without changing underlying functionality.
- [x] Add timestamps to the AI Add-ons log in Settings.
- [x] Improve the Record navigation icon so it does not imply that clicking it starts recording.
- [x] Consider removing the inactive microphone icon at the top and using that visual position for the Record page icon.
- [x] Add the AvaNevis app logo above the Record page icon in the rail. Decorative only; Record keeps the microphone treatment.

### Meeting and keyboard UX

- [x] Save a meeting rename when the user clicks away while editing. Still needs a short design; not part of the Settings/shortcuts plan.
- [x] Add cross-platform keyboard shortcuts that avoid system shortcut conflicts, including start recording, stop recording, and navigation to Record, History, and Settings. Design is in the Settings/shortcuts plan; packaged conflict checks remain on each OS.

### Performance

- [ ] Deliver measured local inference-performance improvements through independently qualified slices. Design: [Inference performance](docs/superpowers/plans/2026-09-06-inference-performance.md). Apple Silicon evidence retains Opus effort 10, existing MLX Whisper defaults, and 32k summary context. No optimization is qualified. Windows/Linux qualification is only needed if a default change is still being pursued. Persistent workers need a separate design.
- [ ] Investigate Linux input-volume defaults: determine why some PipeWire/PulseAudio setups reset the microphone to 50%, measure capture/transcription impact, and assess a safe app-side or setup-side remedy without unexpectedly changing user device settings. Linux desktop session only.

## Deferred beyond v2.10

- [x] Perform a live CachyOS/Omarchy install smoke; verified working on the supported Linux setup.
- [ ] Claim `avanevis-bin` on the AUR and revisit AUR publishing automation later, likely around/after v3 rather than in v2.10.
- [ ] Revisit Apple Developer signing/notarization later, likely around/after v3 and only when enrollment/timing make it worthwhile; retain ad-hoc macOS packaging checks meanwhile.
- [ ] Revisit the pre-existing `run-recording-preflight` trusted-renderer-sender observation only as a separate security task.

## Release history

- **v2.9.0 — released:** Electron 44.1.0, dependency hygiene, reliability follow-through, Omarchy-inspired UI refresh, Linux CUDA/AI gates, and explicit Mic + Desktop / Mic Only / Desktop Only capture modes.
- **v2.8.0 — released:** Linux Core Beta for Omarchy 4 and CachyOS x86_64 Hyprland/Wayland + PipeWire.

## Agent setup maintenance

- [x] Canonical four-tool instructions and skill links — implemented and preservation-audited; see [audit](docs/development/AGENT_SETUP_AUDIT.md).
