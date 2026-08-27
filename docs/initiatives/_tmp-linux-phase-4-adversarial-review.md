# TEMP — Linux Phase 4 adversarial review prompt

Disposable. Paste the fenced block below into a **fresh** review session as **one** theme (do not combine with other themes from `docs/development/ADVERSARIAL_REVIEW_PROMPTS.md`). Delete this file after the review remediations land.

Branch: `release/linux`. Phase 4 product landing is everything since `2eb90ca` (`Record Omarchy Phase 3 hardware-smoke evidence from 2026-08-27`). This Omarchy host is enough for static review + the live ozone/secret-storage/SNI evidence already recorded. Do **not** start Phase 5 packaging. Do **not** touch `.github/workflows/build-release.yml` (Gate B still open). Do **not** reopen Phase 3 recorder work or run the cancelled 60-minute soak. Do **not** treat `scripts/linux-audio-spike.py` as the product recorder. Do **not** advertise Linux CUDA or add-ons as ready.

```text
You are reviewing AvaNevis — a privacy-first Electron desktop app (mic + desktop audio → local Whisper). Windows: faster-whisper (+ optional CUDA). macOS Apple Silicon: MLX + Swift CoreAudio tap helper. Optional local AI: exclusive Speakrs (token-free) or pyannote diarization, llama.cpp summaries. No cloud transcription / no telemetry.

Canonical contracts: root AGENTS.md. Do not invent a second architecture. Linux Core Beta plan: docs/initiatives/LINUX_SUPPORT.md (Phase 4 + Locked decisions 1, 9, 10, 12).

This review is the close-off of Linux Core Beta Phase 4 *product code* on branch release/linux. Diff-scope: git diff 2eb90ca...HEAD limited to the allowed paths (plus listed tests). Phase 3 recorder is already closed (60-minute soak cancelled by operator 2026-08-27 — not run, not passed). Phase 5 packaging has not started.

Live Omarchy evidence already recorded (do not re-run as a substitute for reading the code):
- Host amiromarchy, Hyprland, WAYLAND_DISPLAY=wayland-1, eDP-1 scale 1.6, org.freedesktop.secrets running.
- password-store + ozone-platform-hint=auto are appended in src/main.js BEFORE app.requestSingleInstanceLock().
- whenReady() log: Linux secret storage backend: gnome_libsecret (not basic_text).
- Ozone spike with ELECTRON_OZONE_PLATFORM_HINT unset: --ozone-platform=x11 → xwayland=True; app default hint=auto → ozone-platform=wayland, xwayland=False; --ozone-platform=wayland → same native Wayland. Shipped default is hint=auto, not a forced --ozone-platform=wayland.
- SNI host this session was quickshell (org.kde.StatusNotifierWatcher), not Waybar. RegisteredStatusNotifierItems included :1.198/StatusNotifierItem. Missing-SNI live (kill the watcher) was not run; constructor throw is unit-tested.
- Side-by-side sharpness screenshots were not taken.

Rules for this session:
- Review ONLY the theme and allowed paths below. Do not review the whole app.
- Prefer reading real code and tests over summarizing docs.
- The hunt list is a starting lens, NOT exhaustive. Also report performance issues, races, security/privacy gaps, platform skew, silent failures, and any other high-impact bugs you find in-scope — including ones we did not think to name.
- Output: (1) verdict, (2) ranked findings with severity / file:symbol / failure scenario / suggested fix, (3) brief “what’s solid”, (4) residual hardware smoke if relevant.
- No mega-refactor plan. No rubber stamp.
- Do not start Phase 5 work in this session. Do not reopen linux_recorder.py. Do not bundle Linux speakrs-cli / ORT / llama.cpp / pyannote CUDA.

Theme: Linux Phase 4 — Electron bootstrap (secret storage + ozone), tray/SNI, CPU Whisper, CUDA unavailable, add-on grey-out.

Allowed paths only:
- src/main-process/linux-electron-bootstrap.js
- src/main.js (Linux command-line switches, whenReady secret/ozone logs, createTray call site — do not tour quit drain / recorder / compute queue)
- src/main-process/cuda-runtime-helpers.js (unsupported-platform CUDA probe/status only)
- src/main-process/transcription-runtime-helpers.js (Linux --device cpu only)
- src/main/gpu-runtime-service.js (non-win32 check-cuda / install-gpu / uninstall-gpu / ensure — do not tour Windows pip install internals)
- src/main/recording-presence-service.js (Linux tray click/SNI, Tray constructor try/catch, close-dialog keepRecordingAction)
- src/main/summary-service.js (unsupported generate-summary fail-closed only)
- src/ai-addon-state.js (LINUX_*_UNAVAILABLE_REASON + linux availability)
- src/renderer/ai-addon-ui-helpers.js (shouldOfferDiarizationSetupFields / unsupported)
- src/renderer/history-detail-helpers.js (Generate Summary disabled + Linux reason)
- src/renderer/app.js (updateAiAddonSettings unsupported cards / token fields / Home CTA — do not tour the whole file)
- src/renderer/index.html (diarization/summary addon card ids only)
- src/renderer/styles.css (.ai-addon-card.is-unsupported only)
- tests/js/linux-electron-bootstrap.test.js
- tests/js/linux-platform-selection.test.js
- tests/js/recording-presence-service.test.js (Linux close dialog / no click / Tray throw)
- tests/js/main-process-helpers.test.js (Linux --device cpu)
- tests/js/ai-addon-ui-helpers.test.js
- tests/js/history-detail-helpers.test.js
- tests/js/summary-service.behavioral.test.js (unsupported generate-summary)
- docs/initiatives/LINUX_SUPPORT.md (only to check claims against code)
- todo.md (only to check claims against code)
- AGENTS.md (Linux Phase 4 / ozone / secret-storage / add-on claims only)
- tests/manual/recording-smoke-checklist.md (Phase 4 tray row only)
- tests/manual/local-ai-addons-checklist.md (Linux grey-out rows only)

Starting lenses (not exclusive):
- password-store / ozone-platform-hint appended after any app.* call so Chromium already bound XWayland or basic_text on Hyprland
- Forced --ozone-platform=wayland as the Linux default (breaks X11 Ubuntu) or hint=auto never actually applied
- getSelectedStorageBackend() reports gnome_libsecret in logs while Chromium still used basic_text (hyphen vs underscore, switch ignored)
- Token/preflight later treating isEncryptionAvailable() alone as enough, or persisting tokens when backend is basic_text
- Logs, progress events, or meeting metadata leaking a Hugging Face token or password-store material
- Linux tray still has a click handler; setContextMenu not re-applied after menu mutation; Tray constructor throw crashes the app
- Close-during-recording on Linux hides the window with no remaining presence (invisible tray + no taskbar) so Stop/Discard is unreachable
- Windows/macOS tray click, close-dialog minimize-vs-hide, or Dock overlay regresses because of the Linux branch
- Linux transcription still passes --device auto/cuda, or a stale CUDA cache skips the CPU UX path
- install-gpu / uninstall-gpu / ensure-compatible-gpu-runtime still spawn pip on Linux; GPU Settings still offers Install GPU
- getDiarizationAvailability / getSummaryAvailability no longer unsupported on linux, or catalog gained linux-x64 Speakrs/ORT/llama.cpp/pyannote CUDA pins
- Setup / validate / Remove / Switch / token stdin / Generate Summary still start on Linux; generate-summary IPC not fail-closed
- Reason strings drift from Locked decision 12; generic “not supported on this platform” shown instead
- Token / speaker-count fields still offered when unsupported; Home “Set up local AI add-ons” CTA still clickable
- Cards greyed in CSS only while buttons remain enabled / IPC still succeeds
- Decision 1 not-mac-means-Windows copy sites (inferRendererHostFamily / permission guidance / GPU settings copy) reintroduced
- Tests weakened, skipped, or Windows/macOS snapshots changed to make Linux pass
- Renderer parseInt of pulse-source: / pulse-monitor: ids (must stay opaque)
- Packaged-only path (AVANEVIS_PACKAGED, AppImage libsecret dlopen) claimed done — that is Phase 5

Also report any other high-impact bugs in these paths.
```
