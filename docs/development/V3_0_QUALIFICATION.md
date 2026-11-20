# AvaNevis v3.0.0 qualification record

Working branch: `release/3.0`  
Last updated: 2026-11-20 (CachyOS Linux x86_64 orchestrator pass; Windows and macOS native qualification pending on target hosts)

## Dependency & Upstream Decisions (Checked 2026-11-20)

| Surface | Decision & live upstream check | SHA-256 / package evidence |
|---|---|---|
| Bundled CPython (`win32`, `darwin`, `linux`) | **Upgraded to unified Astral standalone `3.11.18+20261110`** across all three platforms (`build/download-manifest.js`, `build/prepare-resources.js`). Replaced Windows `3.11.9-embed-amd64.zip` with `install_only.tar.gz` (`Lib/`, `DLLs/`, explicitly authored isolated `python311._pth`) and updated macOS from `3.11.17+20261003` to `3.11.18+20261110`. | Windows x64: `5ca7e23bbcc8933a75f4ae9c3a5e5d1ffae5fd143aec9a9d77cf5124cc6e0eef` (49,079,288 B)<br>macOS arm64: `73f1ed14486aa278d331e95f7d6d452f5cfb69d90b418e26e62fd4846d53557d` (27,111,938 B)<br>Linux x64: `ac0b758b6ae4ba1cb87f7091eb6bb17c9a383a9bcdb5c18493cdd4f34e35ae8c` |
| Electron | **Held on qualified `46.0.0-alpha.11`** (`src/ai-addon-token-store.js` and `src/main-process/linux-electron-bootstrap.js` retain exact `46.0.0-alpha.11` guard). Live `npm view electron` on 2026-11-20: latest stable is `45.4.1`; `46.x` stream has `46.0.0-alpha.1` through `46.0.0-alpha.12` and **no published `46.x` stable release yet**. | `npm view electron dist-tags` (`latest: 45.4.1`, `alpha-46-x-y: 46.0.0-alpha.12`) |
| FFmpeg | **Held cleanly on matched `8.1.2`** across all three OS binaries + corresponding GPLv3 source tarball. Live upstream check on 2026-11-20: `ffmpeg.org/releases/` has `8.1.3` and `9.0`–`9.1`; `GyanD/codexffmpeg` has `8.1.2` and `9.0`–`9.0.2` (no `8.1.3`); `shaka-project/static-ffmpeg-binaries` tops out at `n8.1.2-2` (2026-11-07, still FFmpeg `n8.1.2` — identical Linux x64 SHA-256 `9eac5b2b5076db5ff853a6fa0dcd6b8de7d0cac8481eadda6c47cd935825f1ee`, updated macOS arm64 `bae78d98...`). No matched version > `8.1.2` exists yet across all 3 platforms + source. | `ffmpeg-8.1.2.tar.xz` verified SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` via `npm run legal:release-assets` |
| `picomatch` / npm audit | **Clean (`0 vulnerabilities`)** in both production (`npm audit --omit=dev`) and full (`npm audit`) dev-graph scans on 2026-11-20. Installed `picomatch@4.0.7` (resolved under `tinyglobby@0.2.17` / `fdir@6.5.0` via `electron-builder@26.18.0`) is the latest `4.x` release on npm. `electron-builder` remains pinned compatibly at `^26.18.0`. | `npm audit --omit=dev` -> `found 0 vulnerabilities`<br>`npm audit` -> `found 0 vulnerabilities` |

## CachyOS Linux x86_64 Evidence

Host environment: CachyOS Linux x86_64, Node `v26.13.1`, npm `11.20.0`, `.venv` CPython `3.11.16`, system `/usr/bin/ffmpeg` `n9.0.2` (plus packaged pinned FFmpeg `n8.1.2` verified during Linux build).

### Phase 1 — Reliability, Caption-Scale Timing & Subtitle Export
- **Task 1.1 (`75a7c28`):** Decoupled slow recorder-temp cleanup & filesystem/duration scans from `meetings.json.lock` into `scan_recovery.lock` (`backend/meetings/scan_import.py`, `backend/meeting_manager.py`).
  - Verified with `127 passed` (`test_meeting_manager.py`, `test_recorder_temp_and_scan_recovery.py`, `test_phase6_meeting_helpers.py`, `test_capture_recovery.py`), `9/9` JS gate tests (`recordings-maintenance-gate.test.js`), and multi-process contention regression proving `list_meetings`, `update_meeting`, `add_meeting`, and `delete_meeting` succeed without lock timeout while a recovery scan is held open.
- **Task 1.2 (`534007e`):** Added schema-v1 `.captions.json` sidecar generation (`backend/transcription/captions.py`, `faster_whisper_transcriber.py`, `mlx_whisper_transcriber.py`, `parakeet_transcriber.py`, `guided_transcription.py`), atomic commit/invalidation/CRLF hash normalization/delete cleanup in `backend/meeting_manager.py`, pure SRT/WebVTT/TXT serializers in `src/renderer/subtitle-export-helpers.js`, hash-verified main IPC `save-transcript-as` in `src/main/file-export-ipc.js`, and format-picker modal in `src/renderer/` (leaving Summary Save As unchanged).
  - Verified with `183 passed, 1 skipped` (Windows-only DLL loader test skipped), `82/82` focused JS tests (including IPC snapshot & facade checks), and real offline CachyOS CPU faster-whisper (`small`, `tests/fixtures/speakrs-two-speaker-16k.wav`) fixture run producing 4 pre-merge caption cues vs 1 merged Markdown segment, real `.srt`/`.vtt` exports, `CAPTIONS_STALE` rejection on manual `.md` edit, and clean sidecar deletion.

### Phase 2 — Runtime Upgrades, Upstream Audits & Signing Wiring
- **Task 2.1 (`333ceef`):** Downloaded and verified live Astral `3.11.18+20261110` Windows & macOS archives (`sha256` match verified locally), ported `build/prepare-resources.js` Windows extraction to traversal-guarded `tar -tzf`/`tar -xzf` + deterministic isolated `python311._pth`, updated inventory/Parakeet/installer scripts and unit tests (`66 passed, 1 skipped` prepared-Windows test), and verified `check-build-requirements-closure.py linux windows` (`ok` for both).
- **Task 2.2:** Verified Linux FFmpeg import (`audio-import-service.test.js` `6/6` passed), SIGKILL/temp recovery (`test_capture_recovery.py` + `test_recorder_temp_and_scan_recovery.py` `57/57` passed), `npm audit` & `npm audit --omit=dev` (`0 vulnerabilities`), and `npm run legal:release-assets` (`ffmpeg-8.1.2.tar.xz` verified and staged).
- **Task 2.3 (`1a78c8c` + `84f4a68`):** Implemented repo-side Windows Authenticode & macOS Developer ID signing/notarization wiring (`build/after-pack.js`, `build/mac-sign.js`, `scripts/check-win-signing-config.js`, `scripts/check-mac-signing-identity.js`, `scripts/notarize-macos-dmg.sh`, `scripts/verify-macos-*.sh`, `scripts/verify-windows-installer.ps1`, `package.json`, `.github/workflows/build-release.yml`, `tests/js/signing-packaging.test.js`, plus `tests/js/renderer-helper-characterization.test.js` helper registration fix); native signed artifact builds & `AVANEVIS_REQUIRE_SIGNED_RELEASE=1` verification remain open pending signing credentials and Windows/macOS runs.

### Final CachyOS Release-Gate Evidence (HEAD `84f4a68` + final qualification record)
- `npm run test:all` -> **exit 0**: `test:syntax` checked 73 files under `src/`, `test:js` **1181 passed / 0 failed / 1 skipped** (platform skip), `test:python` **889 passed / 8 skipped** (39.86s), `test:python-syntax` checked `backend/` cleanly.
- `npm audit --omit=dev` -> `found 0 vulnerabilities`; `npm audit` -> `found 0 vulnerabilities`.
- `.venv/bin/python scripts/check-build-requirements-closure.py linux` -> `ok requirements-linux-build.txt`.
- `npm run legal:release-assets` -> **exit 0** (`ffmpeg-8.1.2.tar.xz` SHA-256 verified, 68 direct Python pins).
- `npm run build:linux` & `npm run verify:linux:packaged -- --unpacked --appimage --pacman --deb` -> **exit 0** (packaged Astral CPython `3.11.18`, FFmpeg `n8.1.2`, Speakrs `0.7.0` CUDA):
  - `dist/AvaNevis-Setup-2.12.0.AppImage` (`360M`): `384aee88595b11935ce474e30c518eeec9f18ec64d41e73e9fa291ef87063d7c`
  - `dist/AvaNevis-Setup-2.12.0.pkg.tar.zst` (`330M`): `dd94d6ae5795d6d797c97c054dae51055c87543e9e4936395c91c8d14b398b4d`
  - `dist/AvaNevis-Setup-2.12.0.deb` (`271M`): `4838896c7d29ae9b7801290ecee83b1220aa6ea0699566b23acd37379f9853de`
- Packaged binary smokes on `dist/linux-unpacked/resources`:
  - `AVANEVIS_TEST_FFMPEG="$PWD/build/resources/ffmpeg/ffmpeg" node --test tests/js/audio-import-service.test.js` -> **6 passed / 0 failed**.
  - `HF_HUB_OFFLINE=1` packaged CPython `3.11.18` `faster_whisper_transcriber` (`small`, CPU `int8`, `tests/fixtures/speakrs-two-speaker-16k.wav`) -> **1** merged Markdown segment vs **4** segment cues (`sourceTranscriptHash` matched `sha256` cleanly, `serializeCuesToSrt` / `serializeCuesToVtt` -> valid `.srt` and `WEBVTT`).
  - `tests/python/test_recorder_temp_and_scan_recovery.py` -> **16 passed**.
- `python3 scripts/agents/validate_setup.py` -> **exit 0** (16 canonical skills validated).

## Open Windows & macOS Qualification Gates (Cannot Run on Linux)

1. **Windows 10/11 x64:**
   - Run `npm run test:all` and `python scripts/check-build-requirements-closure.py windows`.
   - Run `npm run prepare-build` and verify bundled Astral Python `3.11.18+20261110` (`python311._pth`, `DLLs/_ctypes.pyd`, Parakeet isolated `-S -P` launch via `node --test tests/js/parakeet-runtime.test.js`, Whisper CPU/CUDA, Speakrs CUDA).
   - Build & sign NSIS installer with `AVANEVIS_REQUIRE_SIGNED_RELEASE=1` + signing secrets (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` or Azure Trusted Signing) and verify `Get-AuthenticodeSignature` + `node scripts/verify-speakrs-packaging.js --packaged` + NSIS install/uninstall (`scripts/verify-windows-installer.ps1`).
   - Complete physical-device capture, DPAPI token migration smoke, add-on setup/repair (including gated Pyannote with an authorized token), Windows 10 + 11 checks, SRT/VTT caption export, and Speakrs multi-speaker check.
2. **macOS 15+ arm64 (Apple Silicon):**
   - Run `npm run test:all` and `python3 scripts/check-build-requirements-closure.py macos`.
   - Run `npm run prepare-build` and verify Astral `3.11.18+20261110` (`requirements-macos-build.txt` wheels, `lightning-whisper-mlx`/Metal, CoreAudio helper, Speakrs CoreML).
   - Build, Developer ID sign, notarize, and staple `.app` + `.dmg` with `AVANEVIS_REQUIRE_SIGNED_RELEASE=1` + Apple secrets, then verify `codesign --verify --deep --strict`, `spctl --assess`, `xcrun stapler validate`, `scripts/verify-macos-installer.sh`, and `node scripts/verify-speakrs-packaging.js --packaged`.
   - Complete isolated Keychain token migration smoke, permission-prompt variants, SRT/VTT caption export, Speakrs multi-speaker check, and macOS 15 check.
3. **Upstream Watch Before Tagging v3.0.0:**
   - Recheck npm for stable **Electron 46.x**; if published, upgrade off `46.0.0-alpha.11`, verify Chromium `os_crypt/async` Linux keyring `v11`/`v12` handling, and run `scripts/run-electron-token-migration-smoke.js` on all 3 OSes.
   - Recheck upstream FFmpeg (`GyanD`, `shaka-project`, `ffmpeg.org`); only bump past `8.1.2` if a matched version is available across all 3 OSes + corresponding source tarball.
