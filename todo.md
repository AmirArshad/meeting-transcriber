# AvaNevis post-v2.9 planning

v2.9.0 is released. Its dependency, Electron 44, reliability, UI refresh,
Linux CUDA/AI, and explicit capture-mode work is historical and should not be
treated as active backlog. See the [v2.9 release notes](docs/releases/v2.9.0.md)
and [compatibility matrix](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md)
for the evidence record.

## v2.10 scope — committed

The following items are in scope for the next release. This is a scope log,
not an implementation design or sequencing plan.

Design links and sequencing boundaries: [v2.10 plan index](docs/superpowers/plans/2026-09-06-v2.10.md).

### Transcription and language support

Design and file-level plan for the four Whisper/language items below: [Language/model policy and Whisper Large](docs/superpowers/plans/2026-09-07-language-model-policy-whisper-large.md). Separate policy/migration, Large qualification, and language-evaluation slices; design only, with no implementation or acceptance evidence yet.

- [ ] Remove Farsi/Persian from the language list because of poor observed performance.
- [ ] Explore whether any other currently listed languages also have poor performance and should be removed.
- [ ] Add Whisper Large as a transcription model option.
- [ ] Remove Tiny and Base model options; Small becomes the smallest available Whisper model.
- [ ] Add optional English-only Parakeet transcription in Settings, targeting Windows, Apple Silicon macOS, and Linux with independent validation gates. Prioritize faster transcription and lower resource use; improved accuracy is optional. Design and qualification/implementation phases: [Parakeet integration plan](docs/superpowers/plans/2026-09-06-parakeet-integration.md). Planned, not implemented or platform-validated.

### Summarisation

Design and file-level plan: [Qwen language support and alternative summarisation models](docs/superpowers/plans/2026-09-07-summary-languages-and-models.md). Independent language-support and alternative-model qualification slices; design only, with no implementation or acceptance evidence yet.

- [ ] Explore which languages the current Qwen summarisation model actually supports.
- [ ] Enable summarisation only for the supported languages retained by the product.
- [ ] Ensure Qwen summary output matches the language of the transcript.
- [ ] Explore whether a better summarisation model than the current Qwen model is now available.

### Settings and navigation UX

Design and implementation slices: [Settings, navigation and keyboard shortcuts](docs/superpowers/plans/2026-09-07-settings-navigation-shortcuts.md). Design only; Speakrs removal will preserve Hugging Face tokens, and no implementation or platform acceptance is claimed.

- [ ] On Linux, remove or redesign the clickable Speakrs tab when Speakrs is the only available speaker-identification engine.
- [ ] Preserve saved Hugging Face tokens when removing Speakrs and remove token warnings from its confirmation; token deletion and warnings apply only to Pyannote removal.
- [ ] Revisit Setup / Install Model / Remove Model terminology in favor of clearer feature enable/disable language, without changing underlying functionality.
- [ ] Add timestamps to the AI Add-ons log in Settings.
- [ ] Improve the Record navigation icon so it does not imply that clicking it starts recording.
- [ ] Consider removing the inactive microphone icon at the top and using that visual position for the Record page icon.
- [ ] Consider using the AvaNevis app logo in place of the current inactive microphone icon.

### Meeting and keyboard UX

- [ ] Save a meeting rename when the user clicks away while editing.
- [ ] Add cross-platform keyboard shortcuts that avoid system shortcut conflicts, including start recording, stop recording, and navigation to Record, History, and Settings. [Design and implementation plan](docs/superpowers/plans/2026-09-07-settings-navigation-shortcuts.md), with app-focused defaults pending platform conflict checks.

### Performance

- [ ] Deliver measured local inference-performance improvements through independently qualified slices. [Design and implementation plan](docs/superpowers/plans/2026-09-06-inference-performance.md): Task 5 records macOS Apple Silicon local evidence only—retain Opus effort 10, existing MLX Whisper defaults, and 32k summary context; no 4k/8k/16k context candidate is qualified. No optimization, Windows/Linux qualification, or hardware/release acceptance is completed; resident workers require a separate lifecycle design.
- [ ] Investigate Linux input-volume defaults when back on a Linux machine: determine why some PipeWire/PulseAudio setups reset the microphone to 50%, measure the resulting capture/transcription quality impact, and assess a safe app-side or setup-side remedy without unexpectedly changing user device settings.

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
