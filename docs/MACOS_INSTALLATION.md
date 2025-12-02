# 🍎 macOS Installation Guide

Complete guide for installing Meeting Transcriber on macOS.

---

## ⚠️ IMPORTANT: The "Damaged" Error

If you see this error:

```
"Meeting Transcriber" is damaged and can't be opened.
You should move it to the Bin.
```

**Don't worry!** The app is NOT damaged. This is macOS's way of saying the app isn't signed with an Apple Developer certificate (which costs $99/year).

---

## ✅ Solution 1: Right-Click Method (Easiest)

### Step-by-Step with Pictures

1. **Download** the `.dmg` file from GitHub Releases

2. **Open** the DMG file (double-click it)

3. **Drag** Meeting Transcriber to the Applications folder

4. **Go to Applications** folder (Cmd+Shift+A in Finder)

5. **Find** "Meeting Transcriber.app"

6. **Right-click** (or Control+Click) on the app icon
   - DO NOT double-click!
   - Right-click opens a context menu

7. **Select "Open"** from the menu
   ```
   [Context Menu]
   ├─ Open              ← Click this!
   ├─ Open With →
   ├─ Show Package Contents
   ├─ Move to Bin
   └─ Get Info
   ```

8. **macOS will show a different dialog:**
   ```
   "Meeting Transcriber" is from an unidentified developer.
   Are you sure you want to open it?

   [Cancel]  [Open]  ← Click "Open"
   ```

9. **Click "Open"** in the confirmation dialog

10. **Done!** The app will launch. Future opens work normally (just double-click).

---

## ✅ Solution 2: Terminal Method (Advanced)

If right-click doesn't work, use Terminal:

```bash
# Method A: Remove quarantine from installed app
xattr -d com.apple.quarantine /Applications/Meeting\ Transcriber.app

# Method B: Remove quarantine from DMG before installing
xattr -d com.apple.quarantine ~/Downloads/Meeting-Transcriber-*.dmg
```

After running this command, you can double-click the app normally.

---

## ✅ Solution 3: System Settings Method

1. **Try to open the app** (you'll see the "damaged" error)
2. Go to **System Settings** (or System Preferences on older macOS)
3. Navigate to **Privacy & Security**
4. Scroll down to the **Security** section
5. You should see a message: `"Meeting Transcriber" was blocked from use because it is not from an identified developer`
6. Click **"Open Anyway"**
7. Try opening the app again
8. Click **"Open"** in the confirmation dialog

---

## 🔐 Required Permissions

After first launch, macOS will ask for permissions:

### 1. Microphone Access
```
"Meeting Transcriber" would like to access the microphone.

[Don't Allow]  [OK]  ← Click "OK"
```

**Why:** Required to record your voice during meetings.

### 2. Screen Recording (for Desktop Audio)
```
"Meeting Transcriber" would like to record this screen.

[Don't Allow]  [OK]  ← Click "OK"
```

**Why:** macOS requires this permission for ScreenCaptureKit to capture system audio. The app does NOT actually record your screen - only system audio.

**Note:** This permission may not appear on first launch. If desktop audio doesn't work, grant it manually:
1. System Settings → Privacy & Security → Screen Recording
2. Toggle ON for "Meeting Transcriber"
3. Restart the app

---

## ❓ Why Does This Happen?

### The Technical Explanation

Apple requires apps to be:
1. **Code-signed** with an Apple Developer certificate ($99/year)
2. **Notarized** by Apple (submitted to Apple for malware scanning)

This is an **open-source project** without commercial funding, so the app isn't signed.

### Is This Safe?

**Yes!** Here's why:
- ✅ **Source code is public** on GitHub - you can audit it
- ✅ **Built by GitHub Actions** - public build logs, no tampering
- ✅ **No telemetry** - 100% local processing, no data sent anywhere
- ✅ **No network access** - except for model downloads (one-time)
- ✅ **Full security audit** - See [SECURITY_AUDIT.md](internal/SECURITY_AUDIT.md)

The app does exactly what it says: records audio and transcribes it locally.

---

## 🐛 Troubleshooting

### "Operation not permitted" when running xattr command

Try with sudo:
```bash
sudo xattr -d com.apple.quarantine /Applications/Meeting\ Transcriber.app
```

### App still won't open after removing quarantine

1. Move the app to Trash
2. Empty Trash
3. Re-download the DMG
4. Run the xattr command on the DMG before installing:
   ```bash
   xattr -d com.apple.quarantine ~/Downloads/Meeting-Transcriber-*.dmg
   ```
5. Install the app
6. Try opening it

### "App is damaged and can't be opened" persists

Check if you have any security software (antivirus, firewall) blocking the app:
1. Check **System Settings → Privacy & Security**
2. Look for any blocks under "Security"
3. Temporarily disable third-party security software
4. Try opening the app

### Still having issues?

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or [open an issue on GitHub](https://github.com/AmirArshad/meeting-transcriber/issues).

---

## 📋 macOS Version Requirements

- **Minimum:** macOS 13 (Ventura)
- **Recommended:** macOS 14 (Sonoma) or later
- **Architecture:**
  - ✅ Apple Silicon (M1/M2/M3/M4) - Full GPU acceleration
  - ⚠️ Intel Mac (x64) - CPU-only fallback (slower transcription)

---

## 🚀 After Installation

Once installed and opened successfully:

1. **First launch:** The app will show a loading screen
2. **Select audio devices:**
   - Microphone: Your built-in mic or external mic
   - Desktop Audio: "System Audio (ScreenCaptureKit)"
3. **Start recording:** Click "Start Recording"
4. **First transcription:** Will download Whisper model (~500MB, one-time)

---

## 📞 Need Help?

- **Quick fixes:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Report bug:** [GitHub Issues](https://github.com/AmirArshad/meeting-transcriber/issues)
- **Ask questions:** [GitHub Discussions](https://github.com/AmirArshad/meeting-transcriber/discussions)

---

**Last Updated:** December 2025
