# Feature: Audio Setup Wizard

## Overview

An interactive setup wizard that helps users configure their audio sources for optimal recording and transcription quality.

## Problem Being Solved

Users have multiple audio devices (monitors with speakers, virtual cables, noise-canceling, etc.) and it's unclear which ones to use:
- **Microphone**: Multiple options (webcam, headset, virtual inputs)
- **Desktop Audio**: Multiple loopback devices, and apps may route audio to different outputs

**Current pain point:** Users must manually identify device IDs and may select the wrong devices, resulting in poor audio quality.

## Solution: First-Time Setup Wizard

### Step 1: Welcome & Purpose
```
Welcome to AvaNevis!

Let's configure your audio sources for the best transcription quality.

This wizard will:
1. Test your microphones
2. Find the best desktop audio source
3. Save your preferences

[Continue]
```

### Step 2: Microphone Selection

**Auto-detect and test all microphones:**

```
Step 1 of 3: Select Your Microphone

We found 4 microphones:
  1. Logitech Webcam C925e
  2. AI Noise-Canceling Microphone
  3. Steam Streaming Microphone
  4. CABLE Output (Virtual)

[Test Microphone 1]  ← Click to record 3-second sample
```

**User clicks "Test" → Records 3 seconds → Plays it back**

```
✓ Test recording saved

[Play Recording] [Use This Microphone]

Quality Score: ★★★★☆ (Good)
Sample Rate: 16kHz
```

### Step 3: Desktop Audio Detection

```
Step 2 of 3: Find Desktop Audio Source

INSTRUCTIONS:
1. Play a YouTube video or music NOW
2. Click "Auto-Detect" below
3. We'll find which audio device is active

[Auto-Detect Desktop Audio]
```

**After clicking:**

```
Testing audio sources... (takes 30 seconds)

🔊 Found it!

Best Source: NVIDIA HDMI Audio (Monitor)
Signal Strength: ★★★★★ (Excellent)
Sample Rate: 48kHz

[Accept] [Test Different Device]
```

### Step 4: Test Recording

```
Step 3 of 3: Test Your Setup

Let's verify everything works together.

INSTRUCTIONS:
1. Play audio/video on your computer
2. Speak into your microphone
3. Click "Record Test"

[Record 10-Second Test]
```

**After recording:**

```
✓ Test Complete!

[Play Recording]

Detected:
- Your voice: ✓ Clear
- Desktop audio: ✓ Clear
- Mixing quality: ✓ Good

[Use These Settings] [Re-Test] [Manual Setup]
```

### Step 5: Save Preferences

```
Setup Complete! ✓

Your settings:
  Microphone: Logitech Webcam C925e (ID: 39)
  Desktop Audio: NVIDIA HDMI Audio (ID: 41)

These will be used for all future recordings.

[You can change these later in Settings]

[Start Using AvaNevis]
```

## Technical Implementation

### Backend Component: `setup_wizard.py`

```python
class SetupWizard:
    def detect_microphones(self) -> List[Device]:
        """Returns all available microphones with quality scores"""

    def test_microphone(self, device_id: int, duration: int = 3) -> TestResult:
        """Records and analyzes mic quality"""

    def detect_desktop_audio(self, duration: int = 30) -> Device:
        """Auto-detects active desktop audio source (like find_active_audio.py)"""

    def test_mixed_recording(self, mic_id: int, loopback_id: int, duration: int = 10) -> TestResult:
        """Tests full setup with both sources"""

    def save_preferences(self, mic_id: int, loopback_id: int):
        """Saves to config file"""
```

### Frontend Component (Electron)

**Pages:**
1. `WelcomeScreen.tsx` - Introduction
2. `MicrophoneSetup.tsx` - Mic selection with testing
3. `DesktopAudioSetup.tsx` - Auto-detection with progress
4. `TestRecording.tsx` - Final verification
5. `Complete.tsx` - Summary and save

**State Management:**
```typescript
interface SetupState {
  selectedMic: DeviceInfo | null
  selectedDesktop: DeviceInfo | null
  micTestResult: TestResult | null
  desktopTestResult: TestResult | null
  finalTestResult: TestResult | null
}
```

## Quality Scoring Algorithm

### Microphone Quality Score (1-5 stars):
- **RMS Level**: Good signal strength (not too quiet)
- **Clarity**: Low noise floor
- **Clipping**: No distortion
- **Sample Rate**: Preference for higher rates

### Desktop Audio Quality Score (1-5 stars):
- **Signal Strength**: RMS > 1000 = 5 stars, RMS > 500 = 4 stars, etc.
- **Consistency**: Stable signal throughout test
- **Sample Rate**: 48kHz preferred

## User Experience Flow

```
First Launch
    ↓
[Setup Wizard]
    ↓
Mic Selection (with testing)
    ↓
Desktop Auto-Detection (30s with progress bar)
    ↓
Final Test (10s recording + playback)
    ↓
Save & Complete
    ↓
[Main App - Ready to Record]
```

## Configuration Storage

### `~/.avanevis/config.json`
```json
{
  "audio": {
    "microphone_id": 39,
    "microphone_name": "Logitech Webcam C925e",
    "desktop_id": 41,
    "desktop_name": "NVIDIA HDMI Audio",
    "sample_rate": 48000,
    "mic_volume": 1.0,
    "desktop_volume": 1.0
  },
  "setup_completed": true,
  "last_updated": "2025-11-19T10:30:00Z"
}
```

## Settings Page (Post-Setup)

Users can re-run setup or manually adjust:

```
Audio Settings

Microphone:  [Logitech Webcam C925e ▼] [Test]
Desktop Audio: [NVIDIA HDMI Audio ▼] [Test]

[Re-run Setup Wizard]
[Advanced Settings]
```

## Priority & Timeline

**Priority:** High (essential for user experience)

**Estimated Effort:**
- Backend (Python): 2-3 days
- Frontend (Electron): 3-4 days
- Testing & Polish: 1-2 days
- **Total**: ~1-2 weeks

**Dependencies:**
- ✅ `find_active_audio.py` (already implemented)
- ✅ Audio recording (working)
- ⏳ Electron UI (in progress)
- ⏳ Config file management (to implement)

## Success Criteria

1. **95% of users complete setup successfully** on first try
2. **Correct devices auto-detected** for users with standard setups
3. **Setup takes < 2 minutes** for typical user
4. **Users can easily re-run** if they change audio hardware

## Future Enhancements

- **Pre-flight check** before each recording (verify devices still available)
- **Auto-update detection** when new devices are connected
- **Profiles** for different setups (e.g., "Home Office", "Conference Room")
- **Cloud sync** of preferences across machines

---

**Status:** Planned for v1.0
**Tracking:** Issue #TBD
