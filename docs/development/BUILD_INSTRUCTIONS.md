# Build Instructions

This document explains how to build AvaNevis from source for the supported packaged targets.

## Prerequisites

- Node.js 22.12+ installed; Node 24 is used in CI
- Internet connection (for downloading Python and ffmpeg during build)
- Rust/`cargo` with the toolchain in `native/speakrs-cli/rust-toolchain.toml` for the bundled `speakrs-cli` on Windows, macOS, and Linux
- Windows 10/11 (64-bit) for Windows builds
- macOS 15+ on Apple Silicon for packaged macOS builds
- Linux x86_64 for AppImage, pacman, and experimental deb builds (cannot cross-compile AppImages)
- ~2GB free disk space for build artifacts

## Step 1: Install Dependencies

```bash
npm ci
```

Install Python dependencies for your platform:

### Windows

```bash
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt
```

### macOS

```bash
python3 -m pip install -r requirements-macos.txt -r requirements-dev.txt
```

### Linux

```bash
python3 -m pip install -r requirements-linux.txt -r requirements-dev.txt
```

This installs:

- Electron
- electron-builder (packaging tool)
- Python runtime dependencies for local development
- Python test dependencies

## Step 2: Prepare Build Resources

This step downloads and prepares the packaged runtime resources for the current platform:

- Bundled Python runtime
- Python dependencies from the platform-specific requirements file
- ffmpeg binary
- Bundled `speakrs-cli` (built from `native/speakrs-cli`) plus its validation fixture WAV — Windows and macOS only; Linux Core Beta skips Speakrs
- macOS Swift `audiocapture-helper` binary when building on macOS

```bash
npm run prepare-build
```

**Note:** This may take 5-15 minutes depending on your internet speed.
The build now writes a `build/resources/resource-manifest.json` file and invalidates stale runtime artifacts automatically when pinned downloads, requirements, entitlements, or Swift helper sources change.

The script will:

1. Download the pinned Python runtime for the current platform
2. Verify checksums for runtime downloads and the pinned pip bootstrap wheel
3. Extract Python, bootstrap pip from the pinned wheel, and install platform-specific dependencies
4. Download and verify ffmpeg
5. Build and stage `speakrs-cli` (fails the build if the binary is missing or fails integrity checks)
6. Build and stage the Swift helper on macOS

All resources are stored in `build/resources/` and then bundled via `electron-builder`.

## Step 3: Build the Installer

### Windows installer

Creates a complete NSIS installer (.exe):

```bash
npm run build
```

Output: `dist/AvaNevis-Setup-<version>.exe` (~600-800MB)

### Windows unpacked build (for testing)

Creates an unpacked directory (faster, no installer):

```bash
npm run build:dir
```

Output: `dist/win-unpacked/` - can run directly for testing

### macOS installer

```bash
npm run build:mac
```

Output: `dist/AvaNevis-Setup-<version>.dmg`

### macOS unpacked build (for testing)

```bash
npm run build:mac:dir
```

Output: `dist/mac-arm64/`

### Linux AppImage, pacman, and experimental deb (x86_64, build on Linux)

AppImages cannot be cross-compiled from Windows or macOS. On the Linux build host:

```bash
npm run build:linux
```

Output:

- `dist/AvaNevis-Setup-<version>.AppImage`
- `dist/AvaNevis-Setup-<version>.pkg.tar.zst`
- `dist/AvaNevis-Setup-<version>.deb`

Unpacked directory (faster iteration):

```bash
npm run build:linux:dir
```

Output: `dist/linux-unpacked/` (binary `avanevis`)

Verify layout, static AppImage runtime (rejects legacy FUSE2 markers), bundled Python/ffmpeg/backend isolation, add-on exclusions, pacman `.PKGINFO`, and Debian control metadata:

```bash
npm run verify:linux:packaged -- --unpacked --appimage --pacman --deb
```

Stay on electron-builder 26.x with `"toolsets": { "appimage": "1.0.2" }`. That is the static type2-runtime (no host `fuse2` / `libfuse.so.2`). The runtime still needs the kernel FUSE device (`/dev/fuse`) and typically userspace `fuse3`. Do **not** treat `--appimage-extract-and-run` as proof of the shipped default.

Arch/Omarchy **build host** extra: electron-builder's bundled fpm needs `libcrypt.so.1` (`sudo pacman -S libxcrypt-compat`). That package is not a runtime `pacman.depends` entry.

Linux packages include the native x86_64 Speakrs CLI and validation fixture. CPU faster-whisper is the default transcription path. On supported NVIDIA hosts, explicit managed CUDA 12 setup enables the accelerator preflight for Speakrs. Qwen summaries have a separate CUDA and artifact gate. Model and runtime setup downloads are separate from installer construction.

Do not commit `dist/` or downloaded `build/resources/` runtimes.

## What Gets Bundled

The installer includes:

- ✅ Electron application (UI)
- ✅ Bundled CPython 3.11.18+ standalone runtime (`Lib/`, `DLLs/`, and isolated `python311._pth` on Windows)
- ✅ Platform Python stack from `requirements-*-build.txt` (Windows: `faster-whisper`, `soxr`, `numpy`, …; macOS: `lightning-whisper-mlx`, `soxr`, `scipy`, `mlx`, …; Linux: `faster-whisper` CPU plus Pulse/SoundCard; `torch` is installed during macOS build then removed). See [installer size notes](../completed/INSTALLER_SIZE_NOTES.md).
- ✅ ffmpeg binary
- ✅ `speakrs-cli` (Speakrs 0.7.0; Windows and Linux x64 CUDA, macOS arm64 CoreML). Setup downloads the pinned model files separately.
- ✅ Backend Python scripts
- ✅ Third-party notices under `resources/legal/`

**NOT included (downloaded on first use or during explicit Settings setup):**

- ❌ Whisper AI models (~150-1500MB depending on model size)
- ❌ CUDA/GPU libraries (optional, user opt-in)
- ❌ Speakrs model packs and the Windows ONNX Runtime 1.27.1 archive
- ❌ Pyannote / PyTorch speaker-identification dependencies

## Build Artifacts

After building, you'll have:

```text
dist/
├── AvaNevis-Setup-<version>.exe          # Windows NSIS (Windows builds)
├── AvaNevis-Setup-<version>.dmg          # macOS (macOS builds)
├── AvaNevis-Setup-<version>.AppImage     # Linux portable (Linux builds)
├── AvaNevis-Setup-<version>.pkg.tar.zst  # Linux pacman (Linux builds)
├── AvaNevis-Setup-<version>.deb          # Linux deb, experimental (Linux builds)
├── win-unpacked/                         # Unpacked Windows app (if using build:dir)
├── linux-unpacked/                       # Unpacked Linux app (if using build:linux:dir)
└── builder-*.yaml                        # Build metadata
```

## Testing the Installer

1. **Test the unpacked version first:**

   ```powershell
   npm run build:dir
   .\dist\win-unpacked\AvaNevis.exe
   ```

2. **Then test the full installer:**
   - Run `AvaNevis-Setup-<version>.exe`
   - Install to a test location
   - Verify the app launches
   - Test recording and transcription

## Installer Features

The NSIS installer provides:

- ✅ Custom installation directory selection
- ✅ Desktop shortcut creation
- ✅ Start Menu shortcut
- ✅ Uninstaller
- ✅ License agreement (MIT)
- ✅ Progress bars during installation

## Troubleshooting

### Build fails: Python download errors

- Check internet connection
- Try running `npm run prepare-build` again
- Delete `build/resources/resource-manifest.json` and rerun if you suspect stale resource state

### Installer is too large (>1GB)

- Normal size is 600-800MB
- Check if Whisper models accidentally got bundled
- Ensure recordings/ folder is gitignored

### App doesn't launch after install

- Check Windows Event Viewer for errors
- Try running from command line to see error messages
- Verify Python dependencies installed correctly

## Clean Build

To start fresh:

```bash
npm run clean
rm -rf build/resources
npm run prepare-build
npm run build
```

On Windows PowerShell, replace `rm -rf build/resources` with:

```powershell
Remove-Item -Recurse -Force build/resources
```

## Test Before Building

Before creating installers, run the regression suite:

```bash
npm run test:all
```

See [TESTING.md](TESTING.md) for the full test setup and platform-specific commands.

## Distribution

Once built, you can distribute the installer:

- Upload to file sharing service
- Host on **GitHub Releases** (recommended — CI attaches FFmpeg source and legal files; see [RELEASE_COMPLIANCE.md](RELEASE_COMPLIANCE.md))
- Share direct download link

**Legal:** Installers bundle GPLv3 ffmpeg and the Apache-2.0 Speakrs CLI. Tagged releases must include `ffmpeg-8.1.2.tar.xz` and third-party notices on the same release page. See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

**Installer size (approximate):** Windows ~200–300 MB; macOS ~700–900 MB after arm64 ffmpeg + torch bundle trim (plus Whisper models on first use). Linux AppImage ~310 MB and pacman archive ~280 MB as built on Omarchy 2026-08-28 (installed pacman size ~850 MB); Whisper models still download on first use.

### Linux packaged smoke

After `npm run build:linux` or `build:linux:dir`:

```bash
npm run verify:linux:packaged -- --unpacked --appimage --pacman --deb
```

Optional generic `safeStorage` round-trip (Omarchy / a real Linux desktop with a Secret Service — no Hugging Face token):

```bash
AVANEVIS_ALLOW_SMOKE_HOOKS=1 AVANEVIS_SAFESTORAGE_SMOKE=1 ./dist/AvaNevis-Setup-<version>.AppImage
```

Expect exit 0, backend `gnome_libsecret` (not `basic_text`), bundled Python/ffmpeg/backend paths, and `diarization`/`summary` `supported: false`.

The smoke hook exits the app, so packaged builds require **both** variables. `AVANEVIS_SAFESTORAGE_SMOKE=1` alone is ignored in a packaged build (it logs a warning and starts normally), so a stray environment variable cannot terminate a user's install at startup. Unpackaged `npm start` needs only `AVANEVIS_SAFESTORAGE_SMOKE=1`.

Omarchy packaged UI (2026-08-28): Settings add-on cards stay greyed `unsupported`; Open third-party notices opens `resources/legal/THIRD_PARTY_NOTICES.md` inside the AppImage mount; a short AppImage recording transcribes with bundled `faster_whisper_transcriber --device cpu`. That is not a 60-minute soak. Ubuntu 24.04 **desktop** smoke is still open. Other distros are experimental betas — see [LINUX_EXPERIMENTAL.md](../guides/LINUX_EXPERIMENTAL.md).

GitHub Release builds include AppImage, pacman, and experimental `.deb` after Gate B ([issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76)) closed on 2026-08-28. Certificate-less macOS builds explicitly use a complete ad-hoc bundle signature; Developer-ID signing/notarization remains a future enrollment step.

### macOS packaged smoke (no Apple Developer account required)

After `npm run build:mac:dir`:

```bash
npm run verify:mac:packaged
```

Checks arm64 ffmpeg, ad-hoc codesign validity, `libopus` encode, bundled MLX imports, absence of bundled `torch`, and prints bundle sizes.

### macOS & Windows signing identity guards

`package.json` keeps `build.mac.identity: "-"` and `build.mac.notarize: false` so certificate-less builds produce a **complete ad-hoc bundle signature** instead of electron-builder silently skipping signing (the Gate B / [issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76) root cause). `npm run build:mac` runs `scripts/check-mac-signing-identity.js --preflight` / `--run`, which:

- Uses ad-hoc signing (`identity: "-"`) for cert-less local/PR builds when `AVANEVIS_REQUIRE_SIGNED_RELEASE` is unset/`0`.
- Fails closed if `identity: "-"` is invoked directly alongside signing env vars (`CSC_LINK`, `CSC_NAME`, `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID`, `APPLEID`, `APPLE_API_KEY`) unless managed by `--preflight`/`--run` or acknowledged with `AVANEVIS_ALLOW_ADHOC_MAC_SIGNING=1`.
- Dynamically injects `-c.forceCodeSigning=true`, `-c.mac.gatekeeperAssess=true`, `-c.mac.identity=...`, and `-c.mac.notarize=true` when Developer ID + notarization credentials are set (`build/mac-sign.js` signs with `@electron/osx-sign`, refreshes `speakrs-integrity.json`, and re-seals only outer `.app` without `--deep` before notarization).
- Rejects ad-hoc builds (`AVANEVIS_REQUIRE_SIGNED_RELEASE=1`) unless both Developer ID signing and Apple notarization credentials are present.

On Windows, `npm run build` / `build:dir` runs `scripts/check-win-signing-config.js --preflight` / `--run` (`build/after-pack.js` refreshes `resources/bin/speakrs-integrity.json` after `extraResources` Authenticode signing so Speakrs raw-byte checks pass).

## Code Signing & Notarization (Paid Apple / Windows Certs)

**Default PR/local builds remain unsigned/ad-hoc signed** so contributors and PR CI do not need paid signing certificates (users on unsigned local builds use the Gatekeeper note in [MACOS_INSTALLATION.md](../guides/MACOS_INSTALLATION.md)).

To enable signed/notarized CI builds in `.github/workflows/build-release.yml` (tags `v*.*.*` always enforce `AVANEVIS_REQUIRE_SIGNED_RELEASE=1`; `workflow_dispatch` supports a `require_signed_release` toggle), configure GitHub Actions repository secrets:

| Platform | Secret | Purpose |
|---|---|---|
| macOS | `CSC_LINK` | Base64 `.p12` Developer ID Application certificate |
| macOS | `CSC_KEY_PASSWORD` | `.p12` export password |
| macOS | `CSC_NAME` | Optional certificate name qualifier when multiple certs exist |
| macOS | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | Apple ID `notarytool` credentials (or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`) |
| Windows (PFX) | `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` | Base64 Authenticode PFX certificate & password (`signtool` SHA-256 + RFC 3161 DigiCert timestamp) |
| Windows (Azure) | `WINDOWS_AZURE_ENDPOINT` + `WINDOWS_AZURE_CODE_SIGNING_ACCOUNT` + `WINDOWS_AZURE_CERT_PROFILE` + `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` (+ optional `WINDOWS_AZURE_PUBLISHER_NAME`) | Microsoft Azure Trusted Signing (`TrustedSigning` module) |

Verification scripts:

- `bash scripts/notarize-macos-dmg.sh` — signs DMG with `--timestamp` (when cert is available), submits to `xcrun notarytool submit --wait`, staples, and validates.
- `bash scripts/verify-macos-packaged-app.sh` and `bash scripts/verify-macos-installer.sh` — verify `codesign --verify --deep --strict`, Developer ID `Authority`, `xcrun stapler validate`, and `spctl --assess` when Developer ID signed or `AVANEVIS_REQUIRE_SIGNED_RELEASE=1`.
- `./scripts/verify-windows-installer.ps1 -SignaturesOnly` — validates `Get-AuthenticodeSignature` (`Valid` + RFC 3161 `TimeStamperCertificate`) on `AvaNevis-Setup-<ver>.exe`, `dist/win-unpacked/AvaNevis.exe`, and `resources/bin/speakrs-cli.exe`.

## Next Steps

After building the installer:

1. Test thoroughly on a clean target machine
2. Verify packaged resources match the current platform/runtime inputs
3. Set up or verify CI/CD release automation
