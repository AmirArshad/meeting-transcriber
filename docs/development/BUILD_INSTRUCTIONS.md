# Build Instructions

This document explains how to build AvaNevis from source for the supported packaged targets.

## Prerequisites

- Node.js 22.12+ installed; Node 24 is used in CI
- Internet connection (for downloading Python and ffmpeg during build)
- Rust/`cargo` with the toolchain in `native/speakrs-cli/rust-toolchain.toml` (needed to build bundled `speakrs-cli` on Windows and macOS; Linux Core Beta skips Speakrs)
- Windows 10/11 (64-bit) for Windows builds
- macOS 13+ on Apple Silicon for macOS builds
- Linux x86_64 for AppImage and pacman builds (cannot cross-compile AppImages)
- ~2GB free disk space for build artifacts

## Step 1: Install Dependencies

```bash
npm install
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

### Linux AppImage and pacman (x86_64, build on Linux)

AppImages cannot be cross-compiled from Windows or macOS. On the Linux build host:

```bash
npm run build:linux
```

Output:

- `dist/AvaNevis-Setup-<version>.AppImage`
- `dist/AvaNevis-Setup-<version>.pkg.tar.zst`

Unpacked directory (faster iteration):

```bash
npm run build:linux:dir
```

Output: `dist/linux-unpacked/` (binary `avanevis`)

Verify layout, static AppImage runtime (rejects legacy FUSE2 markers), bundled Python/ffmpeg/backend isolation, add-on exclusions, and pacman `.PKGINFO`:

```bash
npm run verify:linux:packaged -- --unpacked --appimage --pacman
```

Stay on electron-builder 26.x with `"toolsets": { "appimage": "1.0.2" }`. That is the static type2-runtime (no host `fuse2` / `libfuse.so.2`). The runtime still needs the kernel FUSE device (`/dev/fuse`) and typically userspace `fuse3`. Do **not** treat `--appimage-extract-and-run` as proof of the shipped default.

Arch/Omarchy **build host** extra: electron-builder's bundled fpm needs `libcrypt.so.1` (`sudo pacman -S libxcrypt-compat`). That package is not a runtime `pacman.depends` entry.

Linux packages **omit** `speakrs-cli`, ONNX Runtime CUDA archives, llama.cpp, and pyannote CUDA wheels. Transcription is CPU faster-whisper. Add-ons stay greyed `unsupported`.

Do not commit `dist/` or downloaded `build/resources/` runtimes.

## What Gets Bundled

The installer includes:

- ✅ Electron application (UI)
- ✅ Embedded Python 3.11.9 runtime
- ✅ Platform Python stack from `requirements-*-build.txt` (Windows: `faster-whisper`, `soxr`, `numpy`, …; macOS: `lightning-whisper-mlx`, `soxr`, `scipy`, `mlx`, …; Linux: `faster-whisper` CPU plus Pulse/SoundCard; `torch` is installed during macOS build then removed). See [installer size notes](../completed/INSTALLER_SIZE_NOTES.md).
- ✅ ffmpeg binary
- ✅ `speakrs-cli` (Speakrs engine binary; model packs stay setup-time) — **Windows and macOS only**. Linux Core Beta does not bundle it.
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

**Legal:** Installers bundle GPLv3 ffmpeg and the Apache-2.0 Speakrs CLI. Tagged releases must include `ffmpeg-8.0.1.tar.xz` and third-party notices on the same release page. See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

**Installer size (approximate):** Windows ~200–300 MB; macOS ~700–900 MB after arm64 ffmpeg + torch bundle trim (plus Whisper models on first use). Linux AppImage ~310 MB and pacman archive ~280 MB as built on Omarchy 2026-08-28 (installed pacman size ~850 MB); Whisper models still download on first use.

### Linux packaged smoke

After `npm run build:linux` or `build:linux:dir`:

```bash
npm run verify:linux:packaged -- --unpacked --appimage --pacman
```

Optional generic `safeStorage` round-trip (Omarchy / a real Linux desktop with a Secret Service — no Hugging Face token):

```bash
AVANEVIS_SAFESTORAGE_SMOKE=1 ./dist/AvaNevis-Setup-<version>.AppImage
```

Expect exit 0, backend `gnome_libsecret` (not `basic_text`), bundled Python/ffmpeg/backend paths, and `diarization`/`summary` `supported: false`.

GitHub Release attach of Linux artifacts waits on Gate B ([issue #76](https://github.com/AmirArshad/meeting-transcriber/issues/76)). Do not add a Linux job to `.github/workflows/build-release.yml` while that issue is open.

### macOS packaged smoke (no Apple Developer account required)

After `npm run build:mac:dir`:

```bash
npm run verify:mac:packaged
```

Checks arm64 ffmpeg, ad-hoc codesign validity, `libopus` encode, bundled MLX imports, absence of bundled `torch`, and prints bundle sizes.

## Code Signing (Optional — paid Apple / Windows certs)

**Default builds are unsigned/ad-hoc signed.** Users install via the Gatekeeper workaround documented in [MACOS_INSTALLATION.md](../guides/MACOS_INSTALLATION.md). No Apple Developer Program ($99/year) is required for local builds or CI smoke tests.

When you enroll in the Apple Developer Program later, set GitHub Actions secrets and uncomment the env block in `.github/workflows/build-release.yml`:

| Secret | Purpose |
|--------|---------|
| `MACOS_CERTIFICATE_BASE64` | Developer ID Application `.p12` (base64) |
| `MACOS_CERTIFICATE_PASSWORD` | Certificate export password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Team ID |

Then set `"notarize": true` in `package.json` `build.mac` (currently `false` so CI/release builds do not require Apple credentials).

Windows EV/standard code signing (optional, separate cost):

```json
"win": {
  "certificateFile": "path/to/cert.pfx",
  "certificatePassword": "..."
}
```

## Next Steps

After building the installer:

1. Test thoroughly on a clean target machine
2. Verify packaged resources match the current platform/runtime inputs
3. Set up or verify CI/CD release automation
