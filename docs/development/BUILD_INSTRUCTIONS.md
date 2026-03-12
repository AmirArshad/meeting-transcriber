# Build Instructions

This document explains how to build Meeting Transcriber from source for the supported packaged targets.

## Prerequisites

- Node.js 18+ installed
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
The build now writes a `build/resources/resource-manifest.json` file and invalidates stale runtime artifacts automatically when the pinned downloads, requirements, or helper build inputs change.

The script will:

1. Download the pinned Python runtime for the current platform
2. Verify the downloaded artifact checksum
3. Extract Python and install platform-specific dependencies
4. Download and verify ffmpeg
5. Build and stage the Swift helper on macOS

All resources are stored in `build/resources/` and then bundled via `electron-builder`.

## Step 3: Build the Installer

### Windows installer

Creates a complete NSIS installer (.exe):

```bash
npm run build
```

Output: `dist/Meeting Transcriber Setup 1.0.0.exe` (~600-800MB)

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

Output: `dist/Meeting Transcriber-Setup-<version>.dmg`

### macOS unpacked build (for testing)

```bash
npm run build:mac:dir
```

Output: `dist/mac-arm64/`

## What Gets Bundled

The installer includes:

- ✅ Electron application (UI)
- ✅ Embedded Python 3.11.9 runtime
- ✅ All Python dependencies (faster-whisper, numpy, scipy, etc.)
- ✅ ffmpeg binary
- ✅ Backend Python scripts

**NOT included (downloaded on first use):**

- ❌ Whisper AI models (~150-1500MB depending on model size)
- ❌ CUDA/GPU libraries (optional, user opt-in)

## Build Artifacts

After building, you'll have:

```text
dist/
├── Meeting Transcriber Setup 1.0.0.exe  # Main installer
├── win-unpacked/                         # Unpacked app (if using build:dir)
└── builder-*.yaml                        # Build metadata
```

## Testing the Installer

1. **Test the unpacked version first:**

   ```bash
   npm run build:dir
   cd dist/win-unpacked
   "Meeting Transcriber.exe"
   ```

2. **Then test the full installer:**
   - Run `Meeting Transcriber Setup 1.0.0.exe`
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
# Remove build artifacts
rmdir /s /q dist
rmdir /s /q build\resources

# Rebuild everything
npm run prepare-build
npm run build
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
- Host on GitHub releases
- Share direct download link

**Installer size:** ~600-800MB
**Installed size:** ~1.2-1.5GB (plus Whisper models on first use)

## Code Signing (Optional)

For production distribution, you should code-sign the installer:

1. Obtain a code signing certificate
2. Add to electron-builder config in package.json:

   ```json
   "win": {
     "certificateFile": "path/to/cert.pfx",
     "certificatePassword": "..."
   }
   ```

This removes "Unknown Publisher" warnings.

## Next Steps

After building the installer:

1. Test thoroughly on a clean target machine
2. Verify packaged resources match the current platform/runtime inputs
3. Set up or verify CI/CD release automation
