# 🍎 macOS Installation Guide

Complete guide for installing AvaNevis on macOS.

## Install AvaNevis

AvaNevis v2.12 requires Apple Silicon and macOS 15 (Sequoia) or later.
On macOS 14, use [v2.10.3](https://github.com/AmirArshad/meeting-transcriber/releases/tag/v2.10.3).

1. Download the `AvaNevis-Setup-<version>.dmg` from [GitHub Releases](https://github.com/AmirArshad/meeting-transcriber/releases).
2. Open the DMG and drag AvaNevis to Applications.
3. Open AvaNevis from Applications. The app is ad-hoc signed and has no Apple notarization. If macOS blocks it because it cannot verify the developer, open **System Settings → Privacy & Security** after trying to launch the app and choose **Open Anyway**. [Apple’s instructions](https://support.apple.com/en-us/102445)

## 🔐 Required Permissions

After first launch, macOS will ask for permissions:

### 1. Microphone Access
```
"AvaNevis" would like to access the microphone.

[Don't Allow]  [OK]  ← Click "OK"
```

**Why:** Required to record your voice during meetings.

### 2. Desktop Audio Access

On macOS 14.2 or later, AvaNevis uses a CoreAudio process tap for system audio. macOS may show a **System Audio Recording** permission prompt.

```
"AvaNevis" would like to access system audio.

[Don't Allow]  [OK]  ← Click "OK"
```

**Why:** Required to capture desktop/system audio locally. AvaNevis records audio only; no screen video is saved.

If desktop audio does not work, check this permission manually:

1. System Settings → Privacy & Security → System Audio Recording, Local Network, or the audio-related permission macOS shows for AvaNevis on your version
2. Toggle ON for "AvaNevis"
3. Restart the app

### 3. Screen Recording Fallback Permission

If the CoreAudio path is unavailable or fails, AvaNevis falls back to ScreenCaptureKit. macOS may then ask for Screen Recording:

```
"AvaNevis" would like to record this screen.

[Don't Allow]  [OK]  ← Click "OK"
```

**Why:** ScreenCaptureKit may require this permission to capture system audio. The app does NOT save screen video.

**Note:** This permission may not appear on first launch. If desktop audio doesn't work, grant it manually:
1. System Settings → Privacy & Security → Screen Recording
2. Toggle ON for "AvaNevis"
3. Restart the app

---

## Troubleshooting

If macOS reports that AvaNevis is damaged, download a fresh copy from GitHub
Releases. If the message persists, report the exact error and your macOS version
so the release artifact can be checked.

### Still having issues?

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or [open an issue on GitHub](https://github.com/AmirArshad/meeting-transcriber/issues).

---

## 📋 macOS Version Requirements

- **Minimum for v2.12:** macOS 15 (Sequoia) on Apple Silicon
- CoreAudio system-audio capture is available on this supported baseline; the helper retains its separate compatibility checks.
- **Architecture:**
  - ✅ Apple Silicon (M1 or newer) — packaged target
  - ❌ Intel Mac (x64) - packaged releases are not supported

If you are building from source for development only, the repo still contains an Intel Mac CPU fallback path.

---

## 🚀 After Installation

Once installed and opened successfully:

1. **First launch:** The app will show a loading screen
2. **Select audio devices:**
   - Microphone: Your built-in mic or external mic
   - Desktop Audio: "System Audio" (CoreAudio tap on macOS 14.2+, ScreenCaptureKit fallback otherwise)
3. **Start recording:** Click "Start Recording"
4. **First transcription:** Will download Whisper model (~500MB, one-time)

---

## 📞 Need Help?

- **Quick fixes:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Report bug:** [GitHub Issues](https://github.com/AmirArshad/meeting-transcriber/issues)
- **Ask questions:** [GitHub Discussions](https://github.com/AmirArshad/meeting-transcriber/discussions)

---

**Last Updated:** December 2025
