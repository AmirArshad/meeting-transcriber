# AvaNevis v2.10

v2.9.0 is released. See the [v2.9.0 release notes](docs/releases/v2.9.0.md)
and [compatibility matrix](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md).

This file is the **scope and status log**. It is not an implementation design.
Sequencing, remaining investigations, and which machines they need live in the
[v2.10 plan index](docs/superpowers/plans/2026-09-06-v2.10.md). Designs are not
implementation or acceptance evidence.

## Status

### Manual acceptance and review handoff — 2026-10-03

The user confirmed all remaining checks were completed manually and good.
Parakeet release acceptance and the last Linux microphone-volume bullet are
closed by user sign-off, retaining current gain behavior. Release preparation is
complete pending adversarial code review. Commit and push on `master` are now
authorized; tag/release publication is not. See the
[manual acceptance record](docs/development/V2_10_LINUX_RELEASE_QUALIFICATION.md).

### Initial automated Linux release preparation — 2026-10-03

Version metadata was prepared as 2.10.0 on `master` for review.
Linux AppImage/pacman/deb builds and packaged verification passed. Baseline/final
regression gates passed; final source gate is 1,085 JS / 818 Python with 2 / 7
skips. Fixed Parakeet memory-error classification before stderr truncation and
persisted actionable guidance without changing runtime/fallback policy.

Real packaged-backend checks passed Qwen English/Spanish and prior-output
preservation, disconnected-network Parakeet CUDA short/repeated inference,
bounded allocation failure preservation, live backend capture recovery, and
controlled capture. Scoped package/profile upgrade evidence is bounded separately.
These are not packaged-renderer UI acceptance. Native desktop control is disabled,
and noninteractive sudo cannot perform a normal system-package upgrade. Source
volume stayed 48%; the reported reset cause remains unresolved, so no gain remedy
was added. Affected acceptance checkboxes were initially left open; the later user
manual sign-off above supersedes that status.

The initial automated pass left the candidate awaiting manual acceptance. See the
[dated Linux evidence and blockers](docs/development/V2_10_LINUX_RELEASE_QUALIFICATION.md)
and [candidate release notes](docs/releases/v2.10.0.md). Windows/macOS historical
results remain unchanged; their deferred checks are not qualified by CachyOS.
No staging, commits, pushes, tags, publication or workflow dispatch occurred.

### Merge scope update — 2026-10-01

Complete available Mac validation and merge the Qwen language branch to `master`.
Linux runtime/hardware checks are deferred until before the v2.10 release and
do not block this merge. The four deferred Parakeet lifecycle checks and Linux
microphone-volume investigation remain release work.

### Mac Qwen validation — 2026-10-01

English/Spanish full-runner and packaged-UI summaries passed on Apple M4 Pro /
macOS 26.7.1. Integration paths passed 9/9 and the near-budget Chinese probe
passed. Packaged build/verification and post-execution signatures passed. Fixed
Windows/Linux test fixtures that inherited the Mac architecture; `test:all`
passed 1,080 JS / 816 Python, with 4 / 9 existing platform/environment skips.
Regeneration confirmation/cancel and restart preservation passed.
[Evidence and limits](docs/development/V2_10_SUMMARY_QUALIFICATION.md).

### Mac dependency audit repair — 2026-10-01

PR #108 exposed three urllib3 2.7.0 advisories inherited from `master` in the
packaged Mac requirements. Updated the pin to 2.8.0 and regenerated the legal
inventory. Pinned-requirements audit, full regressions, fresh Mac package/build
verification, packaged English/Spanish generation and post-execution signatures
passed. Installed Qwen/Parakeet runtime pins stay unchanged. See the summary
evidence for the rebuilt artifact/report hashes.

### User scope update — 2026-09-30

Whisper Large v3 needs a quick functional smoke before exposure, not a
per-platform quality, timing, or memory qualification campaign. Users decide
whether Large suits their machine. Qwen language behavior needs practical
checks with the current model on one runtime, without repeating language-quality
evaluation per OS. These decisions supersede the qualification depth in the
older designs and status prose below. Keep existing runtime integrity/admission,
explicit downloads, cancellation, and preservation of recordings and prior output.

Recording and post-stop encoding assessment is dropped from v2.10. Keep the
Linux microphone-volume investigation. The four deferred Parakeet lifecycle
checks remain release work; this scope update does not waive them.

v2.10 is partly implemented. No-hardware UX and Whisper choice policy Slice A
have shipped. Parakeet is merged on `master`; its Windows packaged lifecycle
passed on 2026-09-30. Its checkbox stays open until the four deferred lifecycle
checks are recorded.

- Designs exist for inference performance, optional Parakeet, Whisper
  language/model policy, summarisation languages/models, and Settings /
  navigation / shortcuts.
- Whisper choice policy Slice A shipped in PR #102: Persian is off new
  choices; Tiny/Base are retired; Small is the floor; pending jobs keep their
  saved language/model. Slice B (Large v3) is implemented in the workspace and
  passed a quick Windows download/offline transcription smoke on 2026-09-30;
  [results](docs/development/V2_10_LANGUAGE_MODEL_QUALIFICATION.md). Slice C
  (other language removals) was dropped on 2026-09-29.
- Settings, navigation, keyboard shortcuts, and click-away meeting rename
  shipped in PR #103. The AvaNevis rail logo shipped in PR #104.
- Apple Silicon inference qualification (2026-09-14) retained current Opus
  encoding, Whisper defaults, and 32k summary context. No production change.
  Further inference-default changes were dropped on 2026-09-29.
- Linux Parakeet CachyOS CUDA 12 meeting screening is complete
  (2026-09-22). The uncontended batches defer Parakeet against Whisper Small
  and record a speed-versus-VRAM tradeoff against Whisper Medium, with WER
  effectively tied. Evidence is in
  [PARAKEET_COMPATIBILITY.md](docs/development/PARAKEET_COMPATIBILITY.md).
- The approved [three-platform Parakeet plan](docs/superpowers/plans/2026-09-22-parakeet-three-platform-gpu.md)
  supersedes the prior qualification prerequisite. On 2026-09-22, a pinned
  isolated install on an Apple M4 Pro passed live Metal admission and offline
  inference on a 14.22-second local English fixture. The app's compute queue
  and guarded meeting commit saved a timestamped transcript with `mps` /
  `float32` provenance and retained source audio. A retry with the runtime
  unavailable failed closed and kept the prior transcript/audio. This was a
  service-level smoke, not a renderer or packaged-app test. On 2026-09-23, a
  packaged CachyOS RTX 4070 smoke installed and validated managed CUDA 12,
  activated Parakeet, survived app restart with Whisper's English Small
  preference intact, and completed a 14.22-second local English fixture with
  `cuda` / `float32` provenance and retained playable source audio. Linux
  packaged build verification passed for AppImage, pacman, and deb; this is a
  bounded short-clip smoke, not completion of the remaining lifecycle checks.
  On 2026-09-24 a dev-electron lifecycle on the same CachyOS host covered setup
  cancel/repair/validate/remove,
  quit/resume, seams on a repeated short clip, guided Speakrs and guidance
  fallback, runtime-loss fail-closed, and an explicit Whisper retry. On
  2026-09-25 the same dev-electron lifecycle passed on an Apple M4 Pro: Metal
  `mps` / `float32` for Parakeet, `mps` / `float16` for the explicit Whisper
  Small retry, and the same exceptions. On 2026-09-25 the same dev-electron
  lifecycle passed on Windows 11 x64 with an RTX 4070: CUDA `cuda` /
  `float32` for Parakeet, `cuda` / `float16` for the explicit Whisper Small
  retry, and the same exceptions. The first Windows probe failed closed until
  the isolated interpreter loaded the standard-library DLL directory and
  preloaded the pinned CUDA 12 libraries. On 2026-09-29 the same lifecycle
  passed in a packaged arm64 app on the Apple M4 Pro: Metal `mps` /
  `float32` for Parakeet, `mps` / `float16` for the explicit Whisper Small
  retry, and the same exceptions. Network disconnect, memory pressure,
  live recording recovery, and packaged update survival were not run. The
  Windows packaged lifecycle passed on 2026-09-30 after two embedded-Python
  launch fixes, covering setup/activation, restart, quit/resume, cancellation,
  seams, guided work/fallback, runtime loss, explicit Whisper retry, and removal.
  The four deferred checks remain open. Details are in the plan.
- On 2026-09-29, v2.10 dropped extra transcription-language removals,
  alternative summary-model evaluation, and further inference-default changes.
  Apple Silicon already rejected lower Opus effort, MLX decode changes, and a
  smaller summary context. Windows and Linux inference defaults are not being
  pursued.
- Remaining committed work: Parakeet acceptance gates and the Linux
  microphone-volume investigation. Qwen summary-language support is implemented
  in the workspace with bounded one-runtime evidence (2026-09-30).
- CI audit repair — 2026-09-30: the latest pre-Large CI run failed npm audits
  on vulnerable override pins. Updated only brace-expansion, fast-uri and undici
  patch pins and regenerated the lockfile. Clean `npm ci`, zero-vulnerability
  `npm audit --audit-level=high`, `test:all`, Windows `build:dir` and packaged
  Speakrs/layout checks passed locally before commit/push.

## Current next step

Release implementation and remaining manual acceptance are complete as of the
2026-10-03 user sign-off. Run adversarial code review in a fresh session. The
sequencing below records the earlier implementation order.

## How to sequence the work (historical)

Settings, click-away rename, and the transcription **policy** change (Persian /
Tiny / Base off new choices) did not wait on hardware investigations. Whisper
Large passed its quick functional smoke on 2026-09-30; Qwen languages need practical checks
on one runtime without repeated quality evaluation per OS. Extra language removals,
alternative summary models, and inference-default changes were dropped on
2026-09-29. The approved Parakeet plan allows implementation before the
remaining host checks while retaining live GPU admission.

1. **Shipped without hardware qualification:** Settings presentation, keyboard
   shortcuts, click-away rename, and the curated Whisper choice list (Slice A).
2. **Active Parakeet implementation:** Complete guided transcription, engine
   activation and recovery UI, packaging/legal/contracts, and the remaining
   lifecycle checks in the approved three-platform plan. The CachyOS, Mac, and
   Windows dev-electron lifecycles and the packaged Mac lifecycle have passed.
   The Windows packaged lifecycle passed on 2026-09-30; the four deferred
   Parakeet release checks remain. The Linux microphone-volume investigation
   remains on its matching release machine. Qwen summary-language checks and
   matching are complete in the workspace, with bounded evidence recorded
   separately. Details and hosts
   are in the [plan index](docs/superpowers/plans/2026-09-06-v2.10.md).
3. **Implement with focused checks:** Large v3 is implemented and its Windows
   download/cache reuse and ordinary/guided-window smoke passed on 2026-09-30;
   summary-language support is implemented with passing practical checks
   on one runtime.

Keep recordings, transcripts, tokens, scratch reports, and user paths out of
git. Public qualification notes should identify hardware class, OS, app
revision, and artifact hashes — not home directories or meeting content.

## v2.10 scope — committed

### Transcription and language support

Design: [Language/model policy and Whisper Large](docs/superpowers/plans/2026-09-07-language-model-policy-whisper-large.md).
Slice A (curated choices) shipped in PR #102 without Large. Slice B (Large v3)
is implemented in the workspace with a passing Windows functional smoke and
regressions; [evidence and limits](docs/development/V2_10_LANGUAGE_MODEL_QUALIFICATION.md).
Slice C (other language removals) was dropped from
v2.10 on 2026-09-29; the languages still listed stay.

- [x] Remove Farsi/Persian from the language list because of poor observed performance.
- [x] Add Whisper Large (v3) as a transcription model option, keeping Small default.
  Implemented inline on 2026-09-30: canonical v3 runtime/cache/lock identity for
  `large` and `large-v3`, explicit preload, offline ordinary/guided compute and
  saved-preference restoration. Windows 11 / RTX 4070 short-fixture smoke passed
  on CUDA/float16. `npm run test:all` passed (1,062 JS / 734 Python; 4 / 8 skips).
  No performance/memory studies or per-OS qualification campaign.
- [x] Remove Tiny and Base model options; Small becomes the smallest available Whisper model.
- [x] Add optional English-only Parakeet transcription in Settings for Windows CUDA, Apple Silicon Metal, and Linux managed CUDA. The approved [three-platform plan](docs/superpowers/plans/2026-09-22-parakeet-three-platform-gpu.md) governs implementation. The Mac service-level smoke, the CachyOS, Mac, and Windows dev-electron lifecycles, and the packaged Mac lifecycle passed. The Windows packaged lifecycle passed on 2026-09-30. Network disconnect, memory pressure, live recording recovery, and packaged update survival were closed by user-reported manual acceptance on 2026-10-03; see the dated Linux qualification record. Do not claim a speed, memory, or accuracy win from these runs.

### Summarisation

Design: [Qwen language support and alternative summarisation models](docs/superpowers/plans/2026-09-07-summary-languages-and-models.md).
Slice A is implemented in the workspace with practical checks on the installed
Qwen3.5 9B model and one Windows CUDA runtime;
[evidence and limits](docs/development/V2_10_SUMMARY_QUALIFICATION.md).
Alternative-model evaluation (slice B) remains out of v2.10.

- [x] Explore which languages the current Qwen summarisation model actually supports.
  15/15 synthetic generation fixtures passed for the 11 retained IDs, including
  Chinese/Panjabi script cases and Portuguese variants. Local classifier controls
  passed 15/15 language cases and 2/2 indeterminate short/mixed cases.
- [x] Enable summarisation only for the supported languages retained by the product.
  `en/es/fr/de/zh/ja/it/pa/hi/ko/pt` are enabled for the installed 9B model under
  the existing runtime gates. Replacement entries and removed/unknown IDs are
  unavailable; no model selector, downloads or new runtime policy.
- [x] Ensure Qwen summary output matches the language of the transcript.
  Confirm transcript language against its hash; propagate it through chunk,
  merge, JSON repair and grounded regeneration. Local input/prose checks fail
  closed with the existing bounded repair budget. Localized Markdown and
  language/model/policy provenance are saved without changing meeting language.
  Real two-chunk/merge, repair/retry, sidecar and negative checks passed. Focused
  regressions and `npm run test:all` passed; prior-summary, queue/cancel/quit and
  finalization protections remain covered.
  Adversarial-review follow-up (2026-09-30): localized denial guards now reject
  all 13 retained-language/script examples with one shared retry and prior-file
  protection. Policy v2 uses unrestricted actual-language classification and
  explicit predominant-share admission; Marathi was a demonstrated v1 false
  positive. Five neighbor controls reject closest supported confirmations;
  balanced input fails admission, and the above-floor names-only control is
  indeterminate. Every regeneration opens an editable confirmation dialog.
  Short Chinese/Hindi and predominant Spanish/Hindi Concise checks pass;
  corrected chunk/merge/repair/sidecar paths pass 9/9. `test:all`: 1,079 JS and
  814 Python passed (4/8 existing skips), both syntax gates passed.
  Evidence now distinguishes pipeline
  self-classification from manual content inspection and Windows-only coverage.
  The near-full Chinese chunk failure was reproduced and traced to character
  undercounting: 55,814 runtime input tokens exceeded the unchanged 32,768
  context. The fix committed as `7496cfb` estimates UTF-8 bytes and bounds quoted
  repair output to 12,000 bytes. The near-budget Chinese check, the original
  input through three chunks/merge, and a forced near-budget JSON repair passed.
  `test:all`: 1,079 JS / 817 Python passed, with 4 / 8 existing skips and both
  syntax gates passing. Estimates remain heuristic; arbitrary oversized segments
  and large merges are not qualified. Apple Silicon English/Spanish functional
  smokes passed on 2026-10-01.
  Linux CUDA functional smokes are deferred until before the v2.10 release;
  they do not block merging this branch. See the evidence document for report
  hashes and limits.

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

- [x] Save a meeting rename when the user clicks away while editing. Shipped in PR #103; not part of the Settings/shortcuts plan.
- [x] Add cross-platform keyboard shortcuts that avoid system shortcut conflicts, including start recording, stop recording, and navigation to Record, History, and Settings. Design is in the Settings/shortcuts plan; remaining packaged acceptance was confirmed manually by the user on 2026-10-03.

### Linux microphone volume

- [x] Investigate Linux input-volume defaults: determine why some PipeWire/PulseAudio setups reset the microphone to 50%, measure capture/transcription impact, and assess a safe app-side or setup-side remedy without unexpectedly changing user device settings. Linux desktop session only. Investigation recorded on 2026-10-03: measured source volume stayed 48%, reset attribution was not established, and current gain behavior was retained. The user confirmed manual checks were good and accepted closure; no device-gain remedy was added.

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
