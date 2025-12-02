# 🔧 Troubleshooting Guide

Common issues and solutions for Meeting Transcriber.

---

## macOS Issues

### ❌ "Meeting Transcriber is damaged and can't be opened"

**Symptom:** When trying to open the app, macOS shows an error saying the app is damaged and suggests moving it to the Bin.

**Cause:** This is **NOT** actual file damage. It's macOS **Gatekeeper** blocking unsigned applications. The app builds successfully but isn't code-signed with an Apple Developer certificate ($99/year).

**Solution 1: Right-Click Method (Recommended)**
1. **Don't** double-click the app
2. **Right-click** (or Ctrl+click) on "Meeting Transcriber.app" in Applications
3. Select **"Open"** from the context menu
4. Click **"Open"** in the confirmation dialog
5. The app will now launch
6. Future launches work normally (just double-click)

**Solution 2: Terminal Method**
```bash
# Remove the quarantine flag
xattr -d com.apple.quarantine /Applications/Meeting\ Transcriber.app

# Or for the DMG file before installing:
xattr -d com.apple.quarantine ~/Downloads/Meeting-Transcriber-*.dmg
```

**Solution 3: System Settings (macOS Ventura+)**
1. Try to open the app (you'll see the "damaged" error)
2. Go to **System Settings** → **Privacy & Security**
3. Scroll down to the "Security" section
4. You should see a message about Meeting Transcriber being blocked
5. Click **"Open Anyway"**

**Why This Happens:**
- macOS requires apps to be **code-signed** and **notarized** by Apple
- Code signing requires an Apple Developer account ($99/year)
- This is an open-source project without commercial funding
- The "damaged" message is misleading - it should say "unsigned"

**Is This Safe?**
- Yes! You can verify the source code on GitHub
- The app is built by GitHub Actions (public build logs)
- No telemetry or tracking - 100% local processing
- See [SECURITY_AUDIT.md](internal/SECURITY_AUDIT.md) for full audit

---

### ⚠️ "Meeting Transcriber wants to access your microphone"

**Symptom:** macOS shows a permission request for microphone access.

**Solution:** Click **"OK"** to grant permission. This is required for the app to record audio.

**If you accidentally denied permission:**
1. Go to **System Settings** → **Privacy & Security** → **Microphone**
2. Find "Meeting Transcriber" in the list
3. Toggle it **ON**
4. Restart the app

---

### ⚠️ Screen Recording Permission (for Desktop Audio)

**Symptom:** Desktop audio capture doesn't work, or you see warnings about Screen Recording permission.

**Cause:** macOS requires "Screen Recording" permission for ScreenCaptureKit to capture system audio (even though we're not recording the screen).

**Solution:**
1. Go to **System Settings** → **Privacy & Security** → **Screen Recording**
2. Find "Meeting Transcriber" in the list
3. Toggle it **ON**
4. Restart the app

**Note:** This permission is only used to capture desktop audio via ScreenCaptureKit. No screenshots or screen recordings are taken.

---

### 🐌 Slow Transcription on Intel Mac

**Symptom:** Transcription is very slow compared to Apple Silicon Macs.

**Cause:** Intel Macs don't have Metal GPU support for MLX Whisper, so the app uses CPU-based faster-whisper instead.

**Solution:**
- This is expected behavior on Intel Macs
- The app automatically detects Intel architecture and uses CPU fallback
- Consider using a smaller model size (Settings → Model Size → "tiny" or "base")
- Apple Silicon Macs (M1/M2/M3/M4) are 5-10x faster with Metal GPU

---

## Windows Issues

### 🛡️ Windows SmartScreen Warning

**Symptom:** Windows shows "Windows protected your PC" warning when installing.

**Cause:** The installer isn't signed with an Extended Validation (EV) certificate.

**Solution:**
1. Click **"More info"**
2. Click **"Run anyway"**
3. Continue with installation

**Why This Happens:**
- EV code signing certificates cost $300-500/year
- This is an open-source project without commercial funding
- Windows SmartScreen blocks unsigned installers by default

---

### 🎤 No Audio Devices Found

**Symptom:** Microphone or desktop audio dropdowns are empty.

**Solution:**
1. Ensure your audio devices are connected and enabled
2. Go to Windows **Settings** → **System** → **Sound**
3. Verify your devices appear there
4. Restart the app
5. Click "Refresh Devices" button

**For WASAPI loopback (desktop audio):**
- Requires Windows 10 or later
- Loopback devices appear as "Speakers (Loopback)" or similar
- If missing, try updating audio drivers

---

### 💥 App Crashes on Recording Start

**Symptom:** App crashes immediately when starting a recording.

**Possible Causes:**
1. **Antivirus blocking Python process** - Add exception for Meeting Transcriber
2. **Missing audio drivers** - Update audio drivers from manufacturer
3. **Conflicting audio software** - Close other recording apps (OBS, Audacity, etc.)

**Solution:**
1. Check Windows Event Viewer for error details
2. Run app from Command Prompt to see Python errors:
   ```cmd
   cd "C:\Program Files\Meeting Transcriber"
   "Meeting Transcriber.exe"
   ```
3. Report issue on GitHub with error logs

---

## General Issues

### 📥 Model Download Fails

**Symptom:** "Failed to download Whisper model" error during first transcription.

**Solution:**
1. Check internet connection
2. Try again - downloads are resumable
3. Manually download model:
   ```bash
   # Windows (PowerShell)
   cd "$env:USERPROFILE\.cache\huggingface\hub"

   # macOS/Linux
   cd ~/.cache/huggingface/hub

   # Then retry transcription
   ```

---

### 🔇 No Desktop Audio in Recording

**Symptom:** Recording only captures microphone, not desktop audio.

**Windows:**
- Ensure you selected a **loopback device** (not regular output)
- Device should say "Loopback" or "WASAPI" in the name
- Check Windows audio is playing during recording

**macOS:**
- Grant **Screen Recording** permission (required for ScreenCaptureKit)
- System Settings → Privacy & Security → Screen Recording
- Toggle ON for Meeting Transcriber
- Restart the app

---

### 🐌 Transcription is Very Slow

**Symptoms:** Transcription takes much longer than the recording length.

**Solutions:**

1. **Check GPU Status:**
   - Go to Settings tab
   - Check GPU Acceleration status
   - If disabled, install GPU support (if you have compatible GPU)

2. **Use Smaller Model:**
   - Settings → Model Size → Select "tiny" or "base"
   - Smaller models are faster but slightly less accurate

3. **Close Other Apps:**
   - Close GPU-intensive apps (games, video editing, etc.)
   - Close other transcription jobs

**Expected Times (with GPU):**
- **Apple Silicon (Metal):** ~0.1x realtime (40min recording → 4min transcription)
- **NVIDIA GPU (CUDA):** ~0.15x realtime (40min recording → 6min transcription)
- **CPU Only:** ~1-2x realtime (40min recording → 40-80min transcription)

---

### 📁 Where Are My Recordings Saved?

**Windows:**
```
C:\Users\<YourUsername>\AppData\Roaming\Meeting Transcriber\recordings\
```

**macOS:**
```
~/Library/Application Support/Meeting Transcriber/recordings/
```

To open in File Explorer/Finder:
1. Go to History tab
2. Right-click a meeting
3. Select "Show in Folder"

---

### 🗑️ How to Completely Uninstall

**Windows:**
1. Uninstall via Settings → Apps → Meeting Transcriber
2. Delete data folder: `%APPDATA%\Meeting Transcriber`
3. Delete cache: `%USERPROFILE%\.cache\huggingface`

**macOS:**
1. Drag app to Trash from Applications
2. Delete data: `~/Library/Application Support/Meeting Transcriber`
3. Delete cache: `~/.cache/huggingface`

---

## Still Having Issues?

1. **Check Existing Issues:** [GitHub Issues](https://github.com/AmirArshad/meeting-transcriber/issues)
2. **Enable Debug Mode:**
   - Windows: Run from Command Prompt
   - macOS: Run from Terminal with `open -a "Meeting Transcriber"`
   - Check Console.app (macOS) or Event Viewer (Windows) for errors
3. **Report a Bug:** [Create New Issue](https://github.com/AmirArshad/meeting-transcriber/issues/new)
   - Include OS version
   - Include error messages
   - Include steps to reproduce

---

## Contact

- **GitHub Issues:** https://github.com/AmirArshad/meeting-transcriber/issues
- **Documentation:** https://github.com/AmirArshad/meeting-transcriber/tree/master/docs

---

**Last Updated:** December 2025
