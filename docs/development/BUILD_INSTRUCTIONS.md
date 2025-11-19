# Build Instructions

This document explains how to build the Meeting Transcriber installer from source.

## Prerequisites

- Node.js 18+ installed
- Internet connection (for downloading Python and ffmpeg during build)
- Windows 10/11 (64-bit)
- ~2GB free disk space for build artifacts

## Step 1: Install Dependencies

```bash
npm install
```

This installs:

- Electron
- electron-builder (packaging tool)

## Step 2: Prepare Build Resources

This step downloads and prepares:

- Embedded Python 3.11.9 (~30MB)
- Python dependencies from requirements.txt (~100MB)
- ffmpeg binary (~100MB)

```bash
npm run prebuild
```

**Note:** This may take 5-15 minutes depending on your internet speed.

The script will:

1. Download Python embeddable distribution
2. Extract Python
3. Install pip
4. Install all Python dependencies (including faster-whisper)
5. Download ffmpeg essentials

All resources are stored in `build/resources/` and will be bundled into the installer.

## Step 3: Add Application Icon (Required)

You need to provide an application icon:

**File:** `build/icon.ico`
**Format:** Windows ICO format
**Sizes:** 16x16, 32x32, 48x48, 256x256

Quick options:

- Use an online converter: <https://convertio.co/png-ico/>
- Find a free icon: <https://www.flaticon.com/>
- Create with design tools (Photoshop, GIMP, etc.)

**The build will fail without this file!**

## Step 4: Build the Installer

### Option A: Full Installer (Recommended)

Creates a complete NSIS installer (.exe):

```bash
npm run build
```

Output: `dist/Meeting Transcriber Setup 1.0.0.exe` (~600-800MB)

### Option B: Portable Build (For Testing)

Creates an unpacked directory (faster, no installer):

```bash
npm run build:dir
```

Output: `dist/win-unpacked/` - can run directly for testing

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

### Build fails: "Icon not found"

- Make sure `build/icon.ico` exists
- Verify it's a valid ICO file

### Build fails: Python download errors

- Check internet connection
- Try running `npm run prebuild` again
- May need to manually download and place in `build/resources/python/`

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
npm run prebuild
npm run build
```

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
1. Test thoroughly on a clean Windows machine
2. Consider adding auto-update functionality
3. Set up CI/CD for automated builds
4. Implement crash reporting (Sentry, etc.)
5. Add analytics (optional)
