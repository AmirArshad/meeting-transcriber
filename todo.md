# AvaNevis v2.9.0 — Active Work

**Release objective:** compatibility-led dependency maintenance, targeted reliability follow-through, and an Omarchy-inspired visual-system refresh. This release remains privacy-first and local-only on Windows x64, macOS 13+ arm64, and Linux x64 Core Beta (Omarchy supported; other distributions experimental).

**Source plan:** [v2.9.0 implementation plan](docs/superpowers/plans/2026-08-28-v2.9.0.md). Detailed completed work remains in git history, [release notes](docs/releases/), and the linked initiative documents.

## Next up — release foundation

- [x] [Risk: Medium] Create `feature/v2.9-dependency-hygiene`; establish a per-platform resolver matrix before changing any package pin. Record Python 3.11 runtime/build results, CUDA/MLX/Whisper/Speakrs compatibility, SBOMs, and the offline transcription smoke. Evidence: [`docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md).
- [x] [Risk: Low] Correct the Linux `FileLock` inconsistency: `requirements-linux.txt` must require `filelock>=3.32.3`; `requirements-linux-build.txt` must pin `filelock==3.32.3`. Include this in v2.9.0, not as a speculative independent release.
- [x] [Risk: Medium] Task 2 on this Windows PC: pytest 9.1.1; PyAV 18.1.0 after Windows/Linux packaged decode smoke; setuptools 84 on Windows/Linux build files only. Separate commits. See the matrix.
- [x] [Risk: High] **Switch to the Mac** for the rest of Task 2: trial `torch==2.13.0` + `setuptools==84` in `requirements-macos-build.txt` (Torch is still pruned after pip; this only unlocks the resolver). Same Mac session: Numba 0.67 with llvmlite 0.49, native `pip check`, packaged MLX transcription, and ScreenCaptureKit-fallback smoke. Reject any candidate that fails those gates. Do not bump Pyannote’s separate `torch==2.8.0` add-on pin.
- [x] [Risk: High] Trial the explicit-transitive pin trim on macOS. **Rejected** (2026-08-28): do not delete pins. 14 hold older versions or the typer/click/colorama graph; 20 others match today but are range-locks. Windows/Linux trim still pending. Keep `onnxruntime`, `tokenizers`, and `av`. See the matrix.
- [x] [Risk: High] On this Mac, bump stale `requirements-macos-build.txt` pins to current resolve (keep the lock; do not float). **Clusters 1–4 accepted** (2026-08-28): huggingface-hub 1.29.0 + transitives; typer 0.27.2 / drop unused macOS colorama / keep click; mlx 0.32.2; remaining floats `cffi` 2.1.1, `regex` 2026.7.19, `Pygments` 2.21.0, `annotated-doc` 0.0.5. `filelock` stays 3.32.3. Do not bump PyObjC or `sounddevice` unless capture gates pass. See the matrix.
- [x] [Risk: High] Evaluate macOS PyObjC separately with capture as the gate. **Accepted** (2026-08-28): coordinated bump of all seven packaged pins to **12.2.2**. Cocoa and Quartz were **not** removed (Foundation imports; AVFoundation requires Quartz). ScreenCaptureKit fallback preserved. See the matrix.
- [ ] [Risk: High] Optional: evaluate macOS `sounddevice` 0.4.6 → 0.5.6 as its own capture-gated cluster after PyObjC. Reject if CoreAudio tap peak is not `>> 0.001`. Windows/Linux Task 3 trim remains on those hosts.

## Dedicated Electron 44 compatibility lane

- [ ] [Risk: High] Create `feature/v2.9-electron-44` from the v2.9 integration branch. Treat Dependabot PR #86 (`electron` 42.9.0 → 44.x) as a compatibility upgrade, not an automatic dependency bump. Verify all CI suites, electron-builder 26 packaging, Windows x64 recording, macOS 13+ arm64 recorder/helper, and Linux Core Beta packaging/tray/safeStorage/PipeWire capture before it may join v2.9.0.

## Reliability follow-through

- [ ] [Risk: Low] On Omarchy hardware, visually confirm idle/recording Linux tray icons and a no-SNI-host close/minimize pass; re-check unplugged HDMI endpoint filtering; record evidence without upgrading experimental distributions to supported.
- [ ] [Risk: Medium] Decide whether `get-audio-devices.defaults` should populate first-run selections. Keep user-saved selections authoritative and validate the behavior on Windows, macOS, and Linux hardware before shipping.
- [ ] [Risk: Medium] Correct the shared macOS/Linux desktop-leading-pad duration geometry only in its own focused change, with capture-recovery duration tests and macOS hardware validation. Do not broaden it into a recorder redesign.
- [ ] [Risk: Medium] Make a documented decision on macOS late-desktop-capture behavior: retain its current conservative policy unless an isolated hardware-tested change proves that preserving committed frames is safe.

## UI refresh and future layout foundation

- [ ] [Risk: Medium] Create `feature/v2.9-ui-foundation`; use the installed Anthropic `frontend-design` skill to define and apply a calm, functional Omarchy-inspired visual system across the existing Record, History, and Settings navigation.
- [ ] [Risk: Medium] Standardize the shell, section headers, buttons, cards, controls, focus states, responsive history/detail layout, and reduced-motion behavior without adding a cloud UI, account state, networking, or new persistence schema.
- [ ] [Risk: Low] Preserve a stable meeting-detail action region and semantic layout boundaries that a later private-sync feature can extend. The future concept is documented in [Meeting objects and private sync](docs/initiatives/MEETING_OBJECTS_AND_PRIVATE_SYNC.md); it is explicitly out of scope for v2.9.0.

## Explicitly deferred

- [ ] [Risk: High] Linux AI add-on phases 6–9 (CUDA, Speakrs/Pyannote, and summaries) are **v3.0+ only**. Linux stays CPU `faster-whisper`; add-ons remain greyed `unsupported`; no CPU fallback is added.
- [ ] [Risk: Low] Apple Developer signing/notarization remains deferred until enrollment. Keep current ad-hoc macOS packaging checks intact.
- [ ] [Risk: High] Do not delete Pyannote or its token IPC; Speakrs and Pyannote remain user-selectable exclusive engines.

## Branch and release order

1. `feature/v2.9-backlog-and-skill` — this plan, backlog cleanup, future initiative, and cross-tool frontend-design setup.
2. `feature/v2.9-dependency-hygiene` — resolver matrix, FileLock correction, safe dependency updates, and transitive-pin review.
3. `feature/v2.9-ui-foundation` — visual system and bounded layout foundations.
4. `feature/v2.9-reliability-follow-through` — only the focused recorder/device changes whose validation gates pass.
5. `feature/v2.9-electron-44` — independent compatibility lane; merge only after its complete gate.
6. `release/v2.9.0` — integration/release-only branch after each accepted lane is independently green. Do not combine unrelated high-risk upgrades.

## Recently shipped / historical reference

- Linux Core Beta shipped in v2.8.0. Omarchy remains the only supported Linux target; Phase 3’s 60-minute soak was cancelled and is not claimed as passed. See [Linux support](docs/initiatives/LINUX_SUPPORT.md) and [Linux experimental beta guide](docs/guides/LINUX_EXPERIMENTAL.md).
- Speakrs/Pyannote migration, completed Linux Core Beta phases, and earlier release hygiene are documented in their initiative and release records; they are intentionally not duplicated here.
