# Build Instructions

This document explains how to build AvaNevis from source for the supported packaged targets.

## Prerequisites

- Node.js 22.12+ installed; Node 24 is used in CI
- Internet connection (for downloading Python and ffmpeg during build)
- Windows 10/11 (64-bit) for Windows builds
- macOS 13+ on Apple Silicon for macOS builds
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
5. Build and stage the Swift helper on macOS

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

## What Gets Bundled

The installer includes:

- ✅ Electron application (UI)
- ✅ Embedded Python 3.11.9 runtime
- ✅ Platform Python stack from `requirements-*-build.txt` (Windows: `faster-whisper`, `soxr`, `numpy`, …; macOS: `lightning-whisper-mlx`, `scipy`, `mlx`, …; `torch` is installed during build then removed). See [installer size notes](../completed/INSTALLER_SIZE_NOTES.md).
- ✅ ffmpeg binary
- ✅ Backend Python scripts

**NOT included (downloaded on first use):**

- ❌ Whisper AI models (~150-1500MB depending on model size)
- ❌ CUDA/GPU libraries (optional, user opt-in)

## Build Artifacts

After building, you'll have:

```text
dist/
├── AvaNevis-Setup-<version>.exe  # Main installer
├── win-unpacked/                         # Unpacked app (if using build:dir)
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

**Legal:** Installers bundle GPLv3 ffmpeg. Tagged releases must include `ffmpeg-8.0.1.tar.xz` and third-party notices on the same release page. See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

**Installer size (approximate):** Windows ~200–300 MB; macOS ~700–900 MB after arm64 ffmpeg + torch bundle trim (plus Whisper models on first use).

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
