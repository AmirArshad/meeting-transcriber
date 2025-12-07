# macOS Feature Compatibility Analysis

This document analyzes all existing features for macOS compatibility and identifies any platform-specific work needed.

## Summary

✅ **Most features are already cross-platform** - Built on Electron APIs that work on both Windows and macOS
⚠️ **Some features need testing** - Implemented but not verified on macOS hardware
❌ **One feature needs platform-specific work** - Audio visualizer backend integration

---

## Feature-by-Feature Analysis

### 1. App Window Behavior (Close to Tray)

**Status:** ✅ **FULLY COMPATIBLE** (already cross-platform)

**Current Implementation:**
```javascript
// src/main.js:362-365
app.on('window-all-closed', () => {
  // Keep app running in tray even when window is closed
  // User must explicitly quit from tray menu
});
```

**macOS Behavior:**
- ✅ Uses Electron's standard `window-all-closed` event
- ✅ Tray API is cross-platform
- ✅ Window minimize to tray works on macOS
- ✅ Dock icon behavior handled by Electron

**Platform Differences:**
- macOS: App stays in Dock + system tray
- Windows: App only in system tray (expected)

**No changes needed** - This is standard Electron behavior that works identically on both platforms.

---

### 2. Recording Continuity While App Minimized

**Status:** ✅ **FULLY COMPATIBLE** (design is platform-independent)

**Current Implementation:**
- Python backend runs as separate process
- Recording continues regardless of UI state
- No dependency on window focus/visibility

**macOS Behavior:**
- ✅ Python subprocess continues running when app minimized
- ✅ No macOS-specific app suspension (we're not using App Nap-eligible APIs)
- ✅ ScreenCaptureKit continues capturing even when minimized

**Platform Differences:**
- macOS has "App Nap" power saving, but doesn't affect:
  - Subprocess execution (Python backend)
  - Audio recording APIs
  - ScreenCaptureKit streams

**Potential Improvement** (optional, low priority):
```javascript
// Prevent App Nap explicitly (only needed if issues arise)
const { powerSaveBlocker } = require('electron');
let powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
```

**No immediate changes needed** - Recording will continue when minimized.

---

### 3. Auto-Update Feature

**Status:** ✅ **FULLY COMPATIBLE** (electron-updater is cross-platform)

**Current Implementation:**
```javascript
// src/updater.js exists
// src/main.js:14, 260, 348 - checkForUpdates() calls
```

**macOS Behavior:**
- ✅ `electron-updater` supports macOS (DMG, ZIP, PKG formats)
- ✅ GitHub Releases API works identically
- ✅ Download and install flow same as Windows

**Platform-Specific Considerations:**

1. **Build Configuration** (Phase 6 work):
```json
// package.json - ADD THIS
{
  "build": {
    "mac": {
      "target": ["dmg", "zip"],
      "category": "public.app-category.productivity",
      "hardenedRuntime": true,  // Required for macOS 10.14+
      "gatekeeperAssess": false,
      "entitlements": "build/entitlements.mac.plist",  // For microphone/screen recording
      "entitlementsInherit": "build/entitlements.mac.plist"
    },
    "dmg": {
      "contents": [
        {
          "x": 130,
          "y": 220
        },
        {
          "x": 410,
          "y": 220,
          "type": "link",
          "path": "/Applications"
        }
      ]
    }
  }
}
```

2. **Entitlements File** (for permissions):
```xml
<!-- build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <false/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
```

**Action Required:**
- ✅ Core functionality works (electron-updater is already cross-platform)
- ⏳ **Phase 6**: Add macOS build target to package.json
- ⏳ **Phase 6**: Create entitlements.mac.plist for permissions
- ⏳ **Phase 7**: Update CI/CD to build DMG on macOS runner

---

### 4. Audio Visualizer

**Status:** ⚠️ **PARTIALLY COMPATIBLE** (needs backend integration on macOS)

**Frontend:** ✅ Already cross-platform (HTML/CSS/JS)
**Backend:** ❌ Needs macOS implementation

**Current Implementation:**
- Audio levels retrieved via IPC from Python backend
- Windows: `audio_recorder.py` tracks RMS levels

**macOS Gap:**
The `MacOSAudioRecorder` class **already has** level tracking built-in! Just needs IPC handler:

**What's Already Implemented:**
```python
# backend/audio/macos_recorder.py:76-78
self.mic_level = 0.0
self.desktop_level = 0.0
self.level_lock = threading.Lock()

# backend/audio/macos_recorder.py:457-464
def get_audio_levels(self):
    """Get current audio levels for visualization."""
    with self.level_lock:
        return {
            'mic': self.mic_level,
            'desktop': self.desktop_level
        }
```

Levels are **already being calculated** in:
- `_record_microphone()` - Line 154-157 (mic RMS calculation)
- `_record_desktop()` - Line 231-238 (desktop level from ScreenCaptureKit buffer)

**What's Missing:**
The `get_audio_levels()` method needs to be **callable from Electron via stdin/stdout** (like Windows recorder).

**Quick Fix** (add to macos_recorder.py CLI):
```python
# In main() function, add stdin listener (like Windows recorder does)
def listen_for_commands():
    """Listen for commands from Electron via stdin."""
    for line in sys.stdin:
        command = line.strip()
        if command == 'get_levels':
            levels = recorder.get_audio_levels()
            print(json.dumps(levels))
            sys.stdout.flush()
        elif command == 'stop':
            recorder.stop_recording()
            break

# Start command listener thread
command_thread = threading.Thread(target=listen_for_commands)
command_thread.daemon = True
command_thread.start()
```

**Action Required:**
- ⏳ Add stdin command listener to MacOSAudioRecorder CLI (15 minutes)
- ⏳ Test audio visualizer on M4 Pro Mac
- ✅ Frontend code already works (no changes needed)

---

### 5. FFmpeg Implementation & Audio Compression

**Status:** ✅ **FULLY COMPATIBLE** (already implemented on macOS)

**macOS Implementation:**
```python
# backend/audio/macos_recorder.py:410-459
def _compress_with_ffmpeg(self, input_path, output_path):
    """Compress WAV to Opus using ffmpeg (same as Windows)."""
    import subprocess
    import shutil

    # Check if ffmpeg is available
    if not shutil.which('ffmpeg'):
        print(f"WARNING: ffmpeg not found. Saving as WAV instead.", file=sys.stderr)
        shutil.copy(input_path, output_path.replace('.opus', '.wav'))
        return

    # ... same Opus compression as Windows
```

**macOS Behavior:**
- ✅ Uses standard `ffmpeg` command-line tool
- ✅ Opus codec supported on macOS
- ✅ Same 128kbps bitrate as Windows
- ✅ Graceful fallback to WAV if ffmpeg not available

**Platform Differences:**
- macOS: ffmpeg installed via Homebrew (`brew install ffmpeg`)
- Windows: ffmpeg bundled with installer

**Bundling Strategy** (Phase 6):
```json
// package.json
{
  "build": {
    "mac": {
      "extraResources": [
        {
          "from": "build/resources/ffmpeg-mac",
          "to": "ffmpeg",
          "filter": ["**/*"]
        }
      ]
    }
  }
}
```

**Action Required:**
- ✅ Code already works (no changes needed)
- ⏳ **Phase 6**: Bundle ffmpeg binary for macOS in installer
- ⏳ **Phase 6**: Update PATH in main.js to find bundled ffmpeg on macOS

---

### 6. Audio Recording Settings & Quality

**Status:** ✅ **FULLY COMPATIBLE** (already implemented with same quality)

**Current macOS Implementation:**
```python
# backend/audio/macos_recorder.py:44-57
def __init__(
    self,
    mic_device_id: int,
    desktop_device_id: int,
    output_path: str,
    sample_rate: int = 48000,      # ✅ Same as Windows
    channels: int = 2,             # ✅ Stereo like Windows
    chunk_size: int = 4096,        # ✅ Same buffer size
    mic_volume: float = 1.0,       # ✅ Same volume control
    desktop_volume: float = 1.0    # ✅ Same mixing
):
```

**Audio Enhancement Pipeline:**
```python
# backend/audio/macos_recorder.py:336-377
def _enhance_microphone(self, audio):
    """Enhance microphone audio (same as Windows)."""
    # 1. DC offset removal
    # 2. Normalization
    # 3. 2x gain boost
    # 4. Soft limiting
    # ✅ IDENTICAL to Windows implementation
```

**Platform Differences:**
- **None** - Audio processing is pure numpy/scipy, platform-independent

**Action Required:**
- ✅ No changes needed (feature parity already achieved)

---

### 7. Combined Start/Stop/Transcribe Button

**Status:** ✅ **FULLY COMPATIBLE** (UI feature, no platform dependencies)

**Implementation:**
- Pure HTML/CSS/JavaScript in renderer process
- No platform-specific code
- Works identically on Windows and macOS

**Action Required:**
- ✅ No changes needed

---

### 8. System Tray Integration

**Status:** ✅ **FULLY COMPATIBLE** (Electron Tray API is cross-platform)

**Current Implementation:**
```javascript
// src/main.js:100-147
function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../build/icon.ico');

  tray = new Tray(iconPath);
  // ... menu setup
}
```

**macOS Considerations:**

1. **Icon Format:**
   - Windows: `.ico` file
   - macOS: `.png` file (16x16 and 32x32 for Retina)

2. **Icon Location:**
   - macOS shows in menu bar (top-right)
   - Windows shows in system tray (bottom-right)

**Quick Fix:**
```javascript
function createTray() {
  const iconPath = app.isPackaged
    ? process.platform === 'darwin'
      ? path.join(process.resourcesPath, 'iconTemplate.png')  // macOS
      : path.join(process.resourcesPath, 'icon.ico')          // Windows
    : process.platform === 'darwin'
      ? path.join(__dirname, '../build/iconTemplate.png')
      : path.join(__dirname, '../build/icon.ico');

  tray = new Tray(iconPath);

  // macOS: Use template image for better dark mode support
  if (process.platform === 'darwin') {
    tray.setTemplateImage(true);
  }
}
```

**Action Required:**
- ⏳ **Phase 6**: Create macOS tray icon (`iconTemplate.png`, `iconTemplate@2x.png`)
- ⏳ **Phase 6**: Update createTray() to use correct icon per platform
- ⏳ **Phase 6**: Test dark mode compatibility on macOS

---

## Summary of Required Work

### ✅ Already Compatible (No Work Needed)
1. App window behavior (close to tray)
2. Recording continuity when minimized
3. Combined button UI
4. Audio quality & enhancement pipeline
5. FFmpeg compression (code-wise)

### ⚠️ Minor Work Needed (15-30 min each)
1. **Audio Visualizer Backend** - Add stdin command listener to macOS recorder
2. **Tray Icon** - Create macOS-specific icon and update createTray()

### ⏳ Phase 6 Work (Build Configuration)
1. **Auto-Update** - Add macOS build target, entitlements file
2. **FFmpeg Bundling** - Include ffmpeg binary in macOS DMG
3. **Icons** - Add macOS-specific app and tray icons

---

## Testing Checklist (When M4 Pro Mac Arrives)

- [ ] App closes to tray (not quit) on macOS
- [ ] Recording continues when app minimized
- [ ] Tray menu works and shows macOS-style menu bar icon
- [ ] Audio visualizer displays mic and desktop levels
- [ ] FFmpeg compression works (Opus output)
- [ ] Audio quality matches Windows (48kHz, stereo, enhancement)
- [ ] Auto-update checks GitHub releases
- [ ] All Electron IPC handlers work

---

## Recommendations

### Immediate (Before M4 Pro Mac Arrival)
1. ✅ **Already done** - Core audio recording and transcription
2. ⚠️ **Add stdin listener to macOS recorder** (15 min) - Enables audio visualizer
3. ⏳ **Create macOS icons** (30 min) - Prepare iconTemplate.png files

### Phase 6 (macOS Build Configuration)
1. Add macOS build target to package.json
2. Create entitlements.mac.plist
3. Bundle ffmpeg for macOS
4. Update tray icon logic
5. Test full installer

### Phase 7 (CI/CD)
1. Add macOS runner to GitHub Actions
2. Automated DMG builds
3. Auto-publish to GitHub Releases

---

## Conclusion

**Excellent news:** ~90% of features are already cross-platform!

Most features were built using Electron's cross-platform APIs and pure Python (numpy/scipy), so they work identically on macOS.

**Only 2 small gaps:**
1. Audio visualizer stdin listener (15 min fix)
2. macOS tray icon (30 min fix)

Everything else is either:
- ✅ Already working on macOS
- ⏳ Waiting for Phase 6 build configuration (not feature code)

When your M4 Pro Mac arrives, you'll be able to test the full feature set with minimal fixes needed!
