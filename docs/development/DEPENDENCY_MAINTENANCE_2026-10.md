# Dependency maintenance — October 2026

This record follows the [2026-10-08 assessment](DEPENDENCY_ASSESSMENT_2026-10-08.md). It covers
the maintenance scope in the [upgrade prompt](../superpowers/plans/2026-10-08-dependency-upgrades-prompt.md),
done on the local branch `chore/dependency-maintenance-2026-10`. Evidence was refreshed on
2026-10-08 on a Windows 11 x64 host: RTX 4070, driver 617.42, Node 24, repo `.venv` Python 3.11.
Linux evidence comes from WSL Ubuntu (glibc 2.43). That is a real x86_64 glibc userland, but it
is **not** an Omarchy/CachyOS desktop acceptance. No Mac was available. Nothing was staged,
committed, pushed or published. No remote repository settings were changed.

## Changes and decisions

### Security closures

- **Parakeet macOS lock**: msgpack 1.1.2 → **1.2.3** and urllib3 2.7.0 → **2.8.0**.
  - Both entries were regenerated from real wheel bytes by the new `scripts/update-parakeet-lock-wheel.js`, covering URL, size, SHA-256, license and sorted extracted files. `--verify` re-downloads every wheel in a lock and checks it.
  - The new `lockDigest` is `3a1dae0f…d7eb`. Installed runtimes under the old digest report `repair-required`. Repair or removal now also prunes superseded runtime generations, so the vulnerable wheels don't linger on disk.
  - Before this change, the new audit pipeline reports PYSEC-2026-3625 (msgpack) and PYSEC-2026-4175/4176/4177 (urllib3) against this lock. After it, all three Parakeet locks audit clean.
  - The Windows and Linux CUDA locks were already clean and are unchanged.
- **Bootstrap pip**: 26.0.1 → **26.2.1**, with verified PyPI URL and SHA-256.
- **Rust**: rustls 0.23.43 → **0.23.45**, a two-line change to `Cargo.lock`. `cargo audit` reports RUSTSEC-2026-0285 on the old lock and nothing on the new one (272 crates, no warnings). `cargo test --locked` passes.
- **pyannote add-on**: closure B, chosen by the user on both platforms.
  - New pins: pyannote.audio **4.0.7**, torch **2.13.0**, torchaudio **2.11.0**, torchcodec **0.16.0**, plus torchvision **0.28.0** on Windows. CUDA stays on 12.6 wheels.
  - Torch 2.13.0 clears every published Torch advisory. torchaudio 2.11.0 is its final maintenance line and carries no torch pin. TorchCodec ≥0.12 is required for torch ≥2.11.
  - pyannote 4.0.3+ is required for lightning 2.6+, so fresh 4.0.1 installs would resolve a newer, incompatible lightning.
  - The artifact ids changed to `pyannote-audio-4.0.7-*`. Existing installs report "out of date" (status `error`, never ready), and setup removes the superseded directories.
  - The backend passes waveform dicts, so the TorchCodec file-decoding path in pyannote 4.0.7 `core/io.py` is never reached.
- **Obsolete add-on state** is repair-required for both add-ons and never falsely ready. Repair and uninstall escape paths are unchanged.

### Electron and packaging tooling

- **Electron 44.1.0 → 44.7.0** (lockfile regenerated). Packaged tray/dialog/recording checks remain host gates.
- **electron-builder stays at 26.16.1.** Version 26.17.0 resolves and its provenance checks out, but it is held. It still depends on `@electron/get` 3.x, which carries global-agent → roarr → sprintf-js, so it fixes nothing below. A packaging-toolchain change also needs installer builds on all three hosts. Dependabot now proposes it separately from Electron.
- **Narrow exception: sprintf-js ≤1.1.3, [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), moderate.** All 8 moderate `npm audit` findings are this one advisory.
  - Path: electron-builder → app-builder-lib → `@electron/get@3.1.0` → global-agent → roarr → sprintf-js.
  - It is build-time only (a devDependency, never packaged). `@electron/get` loads global-agent only when `ELECTRON_GET_USE_PROXY` is set. roarr's format strings are library-controlled.
  - npm's only offered "fix" is a downgrade to electron-builder 26.5.0. Every `@electron/get` 3.x release has the optional global-agent dependency.
  - **Owner:** repository maintainer. **Expires:** 2027-01-31, or as soon as an electron-builder release moves to `@electron/get` ≥4. CI fails on high/critical and only reports moderate findings.

### Python build pins

- Common bumps: AnyIO 4.15.1, filelock 3.32.7, tokenizers 0.23.2, protobuf 7.36.2, huggingface-hub 1.33.0, hf-xet 1.7.0, fsspec 2026.9.0, typer 0.27.3, tqdm 4.70.1, idna 3.20, and base onnxruntime 1.30.0 on Windows and Linux.
  - None of these change native Speakrs ORT or Parakeet GPU ORT.
- Windows only: PyAudioWPatch 0.2.12.9 and CTranslate2 4.8.2.
  - 4.8.2 gave identical CUDA and CPU transcripts on this host. WASAPI enumeration found 23 devices, with loopback and microphone reads working.
  - Linux stays on CTranslate2 4.8.1 until a managed-CUDA host check.
- macOS only: Numba 0.68.0 and llvmlite 0.50.0 as a pair, plus charset-normalizer 3.5.2 and MarkupSafe 3.0.4.
  - The Parakeet macOS lock keeps its own numba 0.67 / llvmlite 0.49 for artifact isolation. mlx stays 0.32.2.
- `scripts/check-build-requirements-closure.py` verifies that each build file is exactly the resolved closure for its target, and all three pass. Cross-host runs ignore Windows-marker-only colorama; CI runs each target on a matching runner.
- `legal/PYTHON-BUNDLED-PACKAGES.md` was regenerated with its generator.

### Bundled runtimes

- **macOS and Linux CPython 3.11.7+20240107 → 3.11.17+20261003** (python-build-standalone, astral-sh URLs).
  - The archive SHA-256 matches all three sources: the GitHub asset digest, release `SHA256SUMS`, and the downloaded bytes. The values are `3663b71c…d612` for macOS and `c624af93…58b8` for Linux.
  - `gh attestation verify` passed for both archives: signed by upstream `release.yml` on `main`, source digest `5e46737f`.
  - Layout is unchanged apart from additions: a new `bin/python`, plus a Tcl thread dylib on macOS.
  - In WSL, the Linux interpreter reports OpenSSL 3.5.9, SQLite 3.53.1 and zlib 1.3.2. All Linux build pins installed binary-only. CTranslate2, faster-whisper, onnxruntime, PyAV and tokenizers import.
  - The repo Python suite under this interpreter gave 821 passed / 10 skipped / 1 failed. The failure is `test_pulse_port_unavailable_matches_the_real_pulsectl_enum_value`, because headless WSL lacks `libpulse.so.0`; CI installs `libpulse0`.
- **Windows stays on the official embedded 3.11.9.** No official 3.11.17 embedded archive exists, and standalone CPython is not a drop-in replacement for the embedded layout (`python311._pth`, `python311.zip`, isolated import roots, Parakeet private roots). That needs a separate layout qualification.
- **FFmpeg stays at 8.0.1 on every platform.**
  - shaka-project publishes n8.0.3 for macOS and Linux, and ffmpeg.org publishes the 8.0.3 source and signature. Gyan, the Windows provider, publishes no 8.0.3 build on either GitHub or gyan.dev; it goes from 8.0.1 to 8.1.
  - No 8.1.3 exists from either binary provider. 8.1.2 is the only matching newer set.
  - Mixed versions would need two corresponding-source bundles. Moving to 8.1.2 is a minor-line qualification with Opus, recovery and import testing on every host, so the user must decide that.
  - The new inventory extractor fails if any FFmpeg binary version differs from the bundled source version.

## Recurrence prevention

- **Dependabot** (`.github/dependabot.yml`):
  - New Cargo coverage (`/native/speakrs-cli`) and GitHub Actions coverage (`/`).
  - Electron runtime is now separate from the electron-builder packaging toolchain.
  - New groups for Numba/llvmlite and PyObjC.
  - Python 3.11 ceilings: NumPy <2.5, SciPy <1.18, PyAV <19, NetworkX <3.7, librosa <1, huggingface-hub <2 (tokenizers), mpmath <1.4 (SymPy).
  - The tiktoken ignore stays, with a review date of 2027-01-31.
  - Speakrs and ORT minor/major updates are excluded because those need per-GPU qualification.
- **CI** (`.github/workflows/ci.yml`):
  - Workflow-wide `permissions: contents: read`.
  - Weekly scheduled run; only the security jobs run on the schedule.
  - Security jobs:
    - Build-pin audits and closure checks for Windows, macOS and **Linux**, each on a matching runner.
    - Parakeet lock and bootstrap pip audits through the inventory extractor, with an intentionally vulnerable canary that must produce findings.
    - A report of native runtime versions for manual advisory review.
    - Resolved pyannote closure audits on Windows and macOS runners, using `qualify-pyannote-runtime.py --resolve-only`. This resolves the same 97-distribution closure as a real install, in about 30 s.
    - `cargo audit --deny warnings`.
  - Pinned tooling: pip-audit 2.10.1 and cargo-audit 0.22.2.
  - Backend test jobs now install with `-c requirements-<target>-build.txt`, so tests exercise the versions that ship. All three targets resolve under those constraints.
- **Actions** in both workflows are pinned to full commit SHAs with version comments: checkout v7.0.1, setup-node v7.1.0, setup-python v7.0.0, cache v6.1.0, markdownlint v24.2.0, link-check 1.0.17, upload-artifact v7.0.2, download-artifact v8.0.2, action-gh-release v3.0.3.
  - The breaking changes in these majors (removed `pip-install` input, removed dummy `NODE_AUTH_TOKEN`, ESM migration) don't affect inputs used here.
  - `build-release.yml` now grants `contents: write` only to `publish-release`.
  - A test asserts every `uses:` in both workflows is SHA-pinned.
- **Inventory tooling**:
  - `scripts/extract-dependency-inventory.js` turns the Parakeet locks, pyannote artifacts, bootstrap wheel and native downloads into exact `name==version` audit inputs. It normalizes aliases and strips local version labels.
  - It fails on empty, loose, mismatched or conflicting entries.
  - `scripts/pip_audit_inventory.py` exits 0 when clean, 1 on findings, and 2 when the audit did not run or skipped pins, so tool failures never look clean.
  - Tests: `tests/js/extract-dependency-inventory.test.js` and `tests/python/test_pip_audit_inventory.py`.
- **Not done here:**
  - Post-pruning per-platform release SBOMs need a prepared build on each host. The extractor's `--json` output is the optional-runtime inventory to pair with them.
  - Hashing every build wheel (`--require-hashes`) remains a follow-up.

## Open Dependabot PR dispositions (refreshed 2026-10-08)

| PR | Disposition |
|---|---|
| [#112 onnxruntime 1.30.0](https://github.com/AmirArshad/meeting-transcriber/pull/112) | 8/8 green. Superseded by this branch (base ORT only); close after merge. |
| [#111 AnyIO 4.15.1](https://github.com/AmirArshad/meeting-transcriber/pull/111) | Only "Electron Frontend & Build Smoke" failed. Superseded by this branch; full local JS/Python gates pass on Windows with 4.15.1. Watch for the Windows EPERM rename flake on this branch's CI. |
| [#109 llvmlite 0.50.0](https://github.com/AmirArshad/meeting-transcriber/pull/109) | Cannot resolve alone against Numba 0.67. Superseded by the paired Numba 0.68 / llvmlite 0.50 update; the new group prevents recurrence. |
| [#110 NumPy 2.5.3](https://github.com/AmirArshad/meeting-transcriber/pull/110), [#93 SciPy 1.18.1](https://github.com/AmirArshad/meeting-transcriber/pull/93) | Require Python ≥3.12. Hold for the interpreter migration; the new ceilings stop re-proposals. |
| [#101 Electron 44.3.0](https://github.com/AmirArshad/meeting-transcriber/pull/101) | Superseded by 44.7.0. Its diff also carries plan/todo and benchmark files, so review those before closing; don't assume it is a bot-only bump. |

PRs were not commented on, merged or closed.

## GitHub settings to enable (repository admin)

The alerts API returned 403 ("Dependabot alerts are disabled"). Under **Settings → Advanced Security**
(older UI: **Code security and analysis**), enable:

1. **Dependency graph**
2. **Dependabot alerts**
3. **Dependabot security updates**
4. Optionally, **Grouped security updates**

After enabling them, `gh api repos/AmirArshad/meeting-transcriber/dependabot/alerts` should return
a list instead of 403. The custom catalogs remain covered by the CI extractor, not by these settings.

## Holds (Python 3.11 maintenance phase)

- NumPy 2.5+, SciPy 1.18+, PyAV 19+ and NetworkX 3.7 require Python ≥3.12. librosa 1.x is held too.
- huggingface-hub 2.x is held while tokenizers requires <2.
- mpmath 1.4+ is held while SymPy requires <1.4.
- tiktoken stays at 0.3.3 while lightning-whisper-mlx pins it.
- No CUDA 13, Whisper-engine replacement or broad native GPU/llama.cpp changes.

## Python 3.13 qualification follow-up (proposal)

Python 3.11 security support ends in October 2027. Target a migration decision in Q1 2027, with
3.12 as the compatibility fallback.

1. **Blockers found today.** At the current pins, every Windows and Linux build package has a cp313 or pure-Python wheel. On macOS only **tiktoken 0.3.3** lacks one, and it is pinned by lightning-whisper-mlx. Resolve that by replacing or forking the MLX Whisper adapter, or by qualifying a newer tiktoken with it.
2. **Artifacts to regenerate.** Wheel availability does not mean compatibility; all of these are cp311-specific today:
   - the three Parakeet locks (regenerate with `update-parakeet-lock-wheel.js` against new tags);
   - the pyannote artifacts (new resolved closures through `qualify-pyannote-runtime.py`);
   - the Windows embedded layout (`python313._pth`/`.zip`, new official embed archive);
   - the python-build-standalone archives for macOS and Linux.
3. **Process.** Branch per platform. Run the closure check, then the full JS/Python suites under the packaged interpreter. Then do GPU smokes (CUDA Whisper, Parakeet, Speakrs, summaries) and the recording/add-on manual checklists on each host. Drop the Dependabot ceilings only after the new baseline lands.

## Remaining host gates

- **macOS 14+ arm64:**
  - Python 3.11.17 packaged build and `scripts/verify-macos-packaged-app.sh`.
  - Parakeet Metal install, smoke and repair from the old lock digest.
  - MLX Whisper with Numba 0.68 / llvmlite 0.50.
  - `python scripts/qualify-pyannote-runtime.py --work-dir <tmp>`, expecting `device: mps`.
  - Tray, dialog and recording checks on Electron 44.7.0.
- **Linux (Omarchy/CachyOS):**
  - Python 3.11.17 AppImage/pacman/deb build and launch.
  - The recording smoke checklist.
  - Managed-CUDA transcription before moving CTranslate2 to 4.8.2.
  - Parakeet Linux CUDA repair; its lock is unchanged.
- **Windows:**
  - Packaged installer build and launch on Electron 44.7.0. Done 2026-10-08 on this host (Node 22.15.0, npm 10.9.2).
    - `npm run build` exit 0. A first attempt exited 1 during electron-builder's node-module collection (`spawn powershell.exe ENOENT`) because this shell had `pwsh.exe` on `PATH` and not Windows PowerShell 5.1. electron-builder 26.16.1 spawns `powershell.exe` directly. The retry prepended `C:\Windows\System32\WindowsPowerShell\v1.0` to `PATH` and exited 0. It packaged `electron=44.7.0` and wrote the NSIS installer. Signing was skipped (no certificate configured).
    - Installer: `D:\Projects\meeting-transcriber\dist\AvaNevis-Setup-2.10.0.exe`, 234,927,325 bytes (224.0 MiB). The NSIS installer was not run.
    - `dist\win-unpacked\AvaNevis.exe` with `ELECTRON_RUN_AS_NODE=1` printed `process.versions`: electron `44.7.0`, chrome `152.0.7977.130`, node `24.21.0`.
    - The same unpacked executable launched as a GUI. The visible window title was `AvaNevis Meeting Recorder & Transcriber`. File → Exit then left no `AvaNevis` process running.
  - pyannote 4.0.7 real diarization with a user token and the gated model. Still open. Only random-weight CUDA inference was run here. On 2026-10-08 this profile had no `diarization-huggingface-token.bin`, no `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN`, and no cached `pyannote/speaker-diarization-community-1` files, so the gated model was not loaded.
- **All hosts:** `tests/manual/recording-smoke-checklist.md` and `tests/manual/local-ai-addons-checklist.md`.
  - **Windows automated subset, 2026-10-08** (not the full checklists; no 30–60 minute meeting, no disk-reserve test, no NSIS install):
    - `backend/device_manager.py` exit 0. WASAPI mic `45` Logitech Webcam C925e, loopback `56` VG27AQML1A.
    - `audio.windows_recorder --mic 45 --loopback 56 --capture-mode mic-and-desktop`, stdin `stop` after 12 s, exit 0. Opus 11.264 s, 210,064 bytes. Levels near stop: mic 0.118, desktop 0.558. Both spools opened. Stop stages were `post_processing_started`, `audio_normalizing`, `audio_mixing`, `audio_encoding`, `post_processing_complete`.
    - Packaged `resources/python/python.exe` (`ctranslate2` 4.8.2, `faster-whisper` 1.2.1, NumPy 2.4.6) transcribed that file with `--model base --device cuda` exit 0: `device: cuda`, `computeType: float16`. Transcript contains the fixture speech (Hazel, design review, testing and accessibility). `HF_HUB_OFFLINE=1` used the existing cache.
    - Installed Speakrs (`speakrs-community1-vbx`, ORT from `runtimes/speakrs-ort`, CUDA 12 cublas/cudnn from the dev venv) on that recording and on `tests/fixtures/speakrs-two-speaker-16k.wav`: both exit 0, `device: cuda`, `annotationSource: exclusive_speaker_diarization`. Both assigned only `SPEAKER_00` (`speakerCount: 1`). Speaker labels were written. This pass does not show a two-speaker split.
    - Installed Qwen3.5 9B summary, profile `balanced`, exit 0. Wrote `summary.json` and `summary.md` for that transcript. No token values in the sidecar.
