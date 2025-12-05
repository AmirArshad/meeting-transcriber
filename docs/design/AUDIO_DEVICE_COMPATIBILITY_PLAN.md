# Audio Device Compatibility & Sample Rate Detection Plan

## Problem Statement

The application currently has a critical bug when recording from Bluetooth headsets where:
1. **Microphone audio records perfectly** (has fallback logic)
2. **Speaker audio from headphones is distorted** - sounds like "bassy monster movie sounds"
3. **Root cause**: Sample rate mismatch in loopback device detection
   - Bluetooth devices often run at 8-16 kHz in headset mode (bidirectional audio)
   - Code assumes reported `defaultSampleRate` is accurate
   - When recording at 48 kHz but device is actually at 16 kHz, audio plays 3x slower with pitch shift
4. **No fallback mechanism exists for loopback devices** (unlike microphone which has robust error handling)

## Goals

1. **Max compatibility**: Support all audio devices regardless of sample rate
2. **Device hot-swapping**: Allow changing devices between recordings in the same session
3. **Robust detection**: Accurately detect actual active sample rate for all device types
4. **Bluetooth support**: Handle Bluetooth headsets' dynamic sample rate switching
5. **Error recovery**: Graceful fallback if initial sample rate detection fails

## Current Architecture Analysis

### Device Selection Flow
- **Frontend** (app.js): User selects devices from dropdowns, stored in localStorage
- **IPC** (main.js): `start-recording` handler receives device IDs, passes to Python
- **Backend** (audio_recorder.py): Creates AudioRecorder instance, opens streams

### Stream Initialization
**Microphone** (audio_recorder.py:214-245):
- ✅ Has fallback logic
- ✅ Tries requested rate, falls back to device default
- ✅ Error handling with multiple attempts

**Loopback** (audio_recorder.py:247-266):
- ❌ NO fallback logic
- ❌ Single attempt with `defaultSampleRate`
- ❌ No validation of actual rate

### Session Management
- **Single recording lifecycle**: AudioRecorder instance created per recording
- **Device changes**: Require app refresh to reload device list
- **No persistent streams**: Clean slate each recording

## Implementation Plan

### Phase 1: Robust Sample Rate Detection for Loopback Devices

**Goal**: Implement comprehensive fallback mechanism for loopback devices

#### 1.1 Add Sample Rate Probe Function
**File**: `backend/audio_recorder.py`

**Location**: Add new method to AudioRecorder class

```python
def _probe_loopback_sample_rate(self, device_id, device_info):
    """
    Probe loopback device to find actual working sample rate.

    Tries common rates in order of preference:
    1. Reported default rate
    2. Common high-quality rates (48000, 44100)
    3. Common Bluetooth rates (32000, 16000, 8000)

    Returns: (working_rate, channels) or raises RuntimeError
    """
    default_rate = int(device_info['defaultSampleRate'])
    channels = int(device_info['maxInputChannels'])

    # Priority order: default first, then high quality, then Bluetooth rates
    rates_to_try = [default_rate]

    # Add standard rates if not already in list
    for rate in [48000, 44100, 32000, 16000, 8000]:
        if rate != default_rate and rate not in rates_to_try:
            rates_to_try.append(rate)

    print(f"Probing loopback device sample rates: {rates_to_try}", file=sys.stderr)

    for rate in rates_to_try:
        try:
            # Attempt to open stream with this rate
            test_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=device_id,
                frames_per_buffer=1024
            )

            # If successful, close and return this rate
            test_stream.close()
            print(f"✓ Loopback device supports {rate} Hz", file=sys.stderr)
            return (rate, channels)

        except Exception as e:
            print(f"  {rate} Hz not supported: {e}", file=sys.stderr)
            continue

    # All rates failed
    raise RuntimeError(
        f"Could not find working sample rate for loopback device {device_id}. "
        f"Tried: {rates_to_try}"
    )
```

#### 1.2 Update Loopback Initialization
**File**: `backend/audio_recorder.py`
**Lines**: 81-89

**Current code**:
```python
if loopback_device_id >= 0:
    loopback_info = self.pa.get_device_info_by_index(loopback_device_id)
    self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
    self.loopback_channels = int(loopback_info['maxInputChannels'])
    self.mixing_mode = True
```

**New code**:
```python
if loopback_device_id >= 0:
    loopback_info = self.pa.get_device_info_by_index(loopback_device_id)

    # COMPATIBILITY FIX: Probe actual working sample rate instead of trusting default
    # This prevents distorted audio on Bluetooth headsets and other devices
    # where reported rate doesn't match actual operating rate
    try:
        self.loopback_sample_rate, self.loopback_channels = self._probe_loopback_sample_rate(
            loopback_device_id,
            loopback_info
        )
    except RuntimeError as e:
        # If probing fails, fall back to default but warn user
        print(f"Warning: Sample rate probing failed, using default: {e}", file=sys.stderr)
        self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
        self.loopback_channels = int(loopback_info['maxInputChannels'])

    self.mixing_mode = True
```

#### 1.3 Add Fallback Logic to Stream Opening
**File**: `backend/audio_recorder.py`
**Lines**: 247-266

**Current code**: Single attempt with no error recovery

**New code**:
```python
if self.mixing_mode:
    # Open desktop stream with robust fallback
    try:
        self.desktop_stream = self.pa.open(
            format=pyaudio.paInt16,
            channels=self.loopback_channels,
            rate=self.loopback_sample_rate,
            input=True,
            input_device_index=self.loopback_device_id,
            frames_per_buffer=self.chunk_size,
            stream_callback=self._desktop_callback
        )
        print(f"✓ Desktop audio stream opened at {self.loopback_sample_rate} Hz", file=sys.stderr)

    except Exception as e:
        print(f"Failed to open loopback at {self.loopback_sample_rate} Hz: {e}", file=sys.stderr)

        # Try re-probing in case device changed state
        print("Attempting to re-probe loopback device...", file=sys.stderr)
        try:
            loopback_info = self.pa.get_device_info_by_index(self.loopback_device_id)
            self.loopback_sample_rate, self.loopback_channels = self._probe_loopback_sample_rate(
                self.loopback_device_id,
                loopback_info
            )

            # Try again with new rate
            self.desktop_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=self.loopback_channels,
                rate=self.loopback_sample_rate,
                input=True,
                input_device_index=self.loopback_device_id,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._desktop_callback
            )
            print(f"✓ Desktop audio stream opened at {self.loopback_sample_rate} Hz (after re-probe)", file=sys.stderr)

        except Exception as e2:
            # Close mic stream if desktop fails
            if self.mic_stream:
                self.mic_stream.stop_stream()
                self.mic_stream.close()
                self.mic_stream = None
            raise RuntimeError(
                f"Failed to open desktop audio stream after multiple attempts:\n"
                f"  First attempt: {e}\n"
                f"  Re-probe attempt: {e2}\n\n"
                f"Suggestions:\n"
                f"  1. Try selecting a different desktop audio device\n"
                f"  2. Check that the device is not in use by another application\n"
                f"  3. If using Bluetooth, ensure headset is in stereo mode, not headset mode"
            )
```

### Phase 2: Enhanced Device Information Display

**Goal**: Show actual detected sample rates to users for transparency

#### 2.1 Update Device Manager Output
**File**: `backend/device_manager.py`
**Lines**: 62-70

**Enhancement**: Add note about sample rate being "reported default" vs "actual"

```python
device_data = {
    "id": i,
    "name": name,
    "channels": device_info.get("maxInputChannels", 0),
    "sample_rate": int(device_info.get("defaultSampleRate", 44100)),
    "sample_rate_note": "reported",  # NEW: Indicate this is unverified
    "host_api": self.pa.get_host_api_info_by_index(
        device_info.get("hostApi", 0)
    ).get("name", "Unknown")
}
```

#### 2.2 Display Detected Rate in Frontend
**File**: `src/renderer/app.js`
**Lines**: Around 413-426 (recording progress listener)

**Add new listener for device info updates**:
```javascript
window.electronAPI.onDeviceInfo((info) => {
    // Update UI to show actual detected rates
    if (info.type === 'mic_rate_detected') {
        addLog(`Microphone: Using ${info.rate} Hz (${info.channels} channels)`);
    } else if (info.type === 'loopback_rate_detected') {
        addLog(`Desktop audio: Using ${info.rate} Hz (${info.channels} channels)`);
    }
});
```

**Backend sends device info** (audio_recorder.py after successful probing):
```python
# Emit device info for frontend display
print(json.dumps({
    "type": "device_info",
    "device": "loopback",
    "rate": self.loopback_sample_rate,
    "channels": self.loopback_channels
}))
sys.stdout.flush()
```

### Phase 3: Device Hot-Swapping Support

**Goal**: Allow changing devices between recordings without restarting app

#### 3.1 Current Limitations
- ✅ Device list cached in frontend
- ✅ User can change selections between recordings
- ✅ AudioRecorder instance created fresh each recording
- **No issues identified** - architecture already supports hot-swapping!

#### 3.2 Enhancement: Device List Refresh with Better UX
**File**: `src/renderer/app.js`
**Lines**: 239-271 (loadAudioDevices function)

**Add status indicator during refresh**:
```javascript
async function loadAudioDevices() {
    try {
        // Show loading state
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<span class="btn-icon">⏳</span> Loading...';

        addLog('Loading audio devices...');
        const devices = await window.electronAPI.getAudioDevices();

        // Save current selections
        const prevMicId = micSelect.value;
        const prevDesktopId = desktopSelect.value;

        // Populate dropdowns
        micSelect.innerHTML = '<option value="">Select microphone...</option>';
        devices.inputs.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `${device.name} (${device.sample_rate} Hz)`;
            micSelect.appendChild(option);
        });

        desktopSelect.innerHTML = '<option value="">Select desktop audio...</option>';
        devices.loopbacks.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `${device.name} (${device.sample_rate} Hz)`;
            desktopSelect.appendChild(option);
        });

        // Restore previous selections if still available
        if (micSelect.querySelector(`option[value="${prevMicId}"]`)) {
            micSelect.value = prevMicId;
        } else {
            applySavedSettings(); // Fallback to saved settings
        }

        if (desktopSelect.querySelector(`option[value="${prevDesktopId}"]`)) {
            desktopSelect.value = prevDesktopId;
        } else {
            applySavedSettings();
        }

        addLog(`Found ${devices.inputs.length} microphones and ${devices.loopbacks.length} loopback devices`);

        // Reset button
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = '<span class="btn-icon">🔄</span> Refresh';

    } catch (error) {
        console.error('Failed to load devices:', error);
        addLog(`Error: ${error.message}`, 'error');

        refreshBtn.disabled = false;
        refreshBtn.innerHTML = '<span class="btn-icon">🔄</span> Refresh';
    }
}
```

#### 3.3 Auto-Detect Device Changes (Optional Enhancement)
**Goal**: Detect when Bluetooth headset connects/disconnects

**Implementation**: Poll for device changes every 5 seconds when idle

```javascript
// In app.js init() function
setInterval(async () => {
    if (recordingState === 'idle' && !isInitializing) {
        // Check if device list changed
        const newDevices = await window.electronAPI.getAudioDevices();
        const currentMicCount = micSelect.options.length - 1; // -1 for placeholder
        const currentDesktopCount = desktopSelect.options.length - 1;

        if (newDevices.inputs.length !== currentMicCount ||
            newDevices.loopbacks.length !== currentDesktopCount) {
            addLog('Device list changed - refreshing...', 'info');
            await loadAudioDevices();
        }
    }
}, 5000); // Check every 5 seconds
```

### Phase 4: Bluetooth Device Optimization

**Goal**: Provide guidance for Bluetooth headset users

#### 4.1 Detect Bluetooth Devices
**File**: `backend/device_manager.py`

**Add Bluetooth detection logic**:
```python
def _is_bluetooth_device(self, device_name):
    """Check if device name suggests it's Bluetooth."""
    bluetooth_keywords = [
        'bluetooth', 'bt', 'wireless', 'airpods', 'buds',
        'wh-', 'wf-', 'jabra', 'bose', 'sony', 'beats'
    ]
    name_lower = device_name.lower()
    return any(keyword in name_lower for keyword in bluetooth_keywords)

# In list_all_devices():
device_data = {
    "id": i,
    "name": name,
    "channels": device_info.get("maxInputChannels", 0),
    "sample_rate": int(device_info.get("defaultSampleRate", 44100)),
    "is_bluetooth": self._is_bluetooth_device(name),  # NEW
    "host_api": self.pa.get_host_api_info_by_index(
        device_info.get("hostApi", 0)
    ).get("name", "Unknown")
}
```

#### 4.2 Display Bluetooth Warning in Frontend
**File**: `src/renderer/app.js`

**Add warning when Bluetooth loopback is selected**:
```javascript
desktopSelect.addEventListener('change', () => {
    saveSettings({ desktopId: desktopSelect.value });

    // Check if selected device is Bluetooth
    const selectedOption = desktopSelect.options[desktopSelect.selectedIndex];
    if (selectedOption.textContent.toLowerCase().includes('bluetooth')) {
        addLog('⚠️  Bluetooth device detected. For best quality, ensure headset is in stereo mode.', 'warning');
    }
});
```

### Phase 5: Testing & Validation

#### 5.1 Unit Tests
**File**: `backend/test_sample_rate_detection.py` (NEW)

```python
"""
Test sample rate detection and fallback logic.
"""
import unittest
from audio_recorder import AudioRecorder
import pyaudiowpatch as pyaudio

class TestSampleRateDetection(unittest.TestCase):
    def test_probe_sample_rate_success(self):
        """Test that probing finds a working sample rate."""
        pa = pyaudio.PyAudio()

        # Get first loopback device
        for i in range(pa.get_device_count()):
            device_info = pa.get_device_info_by_index(i)
            if device_info.get('isLoopbackDevice', False):
                recorder = AudioRecorder(
                    mic_device_id=0,
                    loopback_device_id=i,
                    output_path='test.wav'
                )

                # Should not raise
                rate, channels = recorder._probe_loopback_sample_rate(i, device_info)

                self.assertGreater(rate, 0)
                self.assertGreater(channels, 0)

                recorder.cleanup()
                break

        pa.terminate()

    def test_invalid_device_fails_gracefully(self):
        """Test that invalid device ID fails with clear error."""
        recorder = AudioRecorder(
            mic_device_id=0,
            loopback_device_id=99999,  # Invalid
            output_path='test.wav'
        )

        with self.assertRaises(RuntimeError):
            recorder.start_recording()

        recorder.cleanup()

if __name__ == '__main__':
    unittest.main()
```

#### 5.2 Integration Test
**File**: `backend/test_bluetooth_headset.py` (NEW)

**Manual test script for Bluetooth devices**:
```python
"""
Interactive test for Bluetooth headset recording.

Run this with Bluetooth headset connected to verify:
1. Sample rate detection works
2. Audio is not distorted
3. Both mic and loopback record properly
"""

import sys
from device_manager import DeviceManager
from audio_recorder import AudioRecorder
import time

def main():
    print("=" * 70)
    print("Bluetooth Headset Recording Test")
    print("=" * 70)
    print()

    # List devices
    manager = DeviceManager()
    devices = manager.list_all_devices()

    print("Available microphones:")
    for device in devices['input_devices']:
        bt_mark = " [BLUETOOTH]" if device.get('is_bluetooth', False) else ""
        print(f"  {device['id']}: {device['name']}{bt_mark}")
    print()

    print("Available loopback devices:")
    for device in devices['loopback_devices']:
        bt_mark = " [BLUETOOTH]" if device.get('is_bluetooth', False) else ""
        print(f"  {device['id']}: {device['name']}{bt_mark}")
    print()

    # Get user input
    mic_id = int(input("Select microphone ID: "))
    loopback_id = int(input("Select loopback device ID: "))

    print()
    print("Starting 10-second test recording...")
    print("Speak into your microphone AND play some audio!")
    print()

    # Create recorder
    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path='test_bluetooth.wav'
    )

    try:
        recorder.start_recording()
        time.sleep(10)
        recorder.stop_recording()

        print()
        print("=" * 70)
        print("Recording complete!")
        print("=" * 70)
        print()
        print("Check test_bluetooth.opus to verify:")
        print("  1. Microphone audio sounds normal")
        print("  2. Desktop audio sounds normal (NOT slow/bassy)")
        print("  3. No distortion or artifacts")
        print()

    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
    finally:
        recorder.cleanup()

if __name__ == '__main__':
    main()
```

#### 5.3 Manual Test Checklist

**Test Scenarios**:
1. ✅ **Standard USB microphone + HDMI audio** - Should work as before
2. ✅ **Bluetooth headset (mic + loopback)** - Should detect correct sample rate
3. ✅ **Switch devices between recordings** - Should work without restart
4. ✅ **Device disconnected mid-session** - Should show clear error
5. ✅ **Multiple loopback devices** - Should select correct one

**Validation Criteria**:
- Audio playback sounds normal (correct pitch, no distortion)
- Sample rates logged match device capabilities
- No crashes or hangs
- Clear error messages if devices fail

## Implementation Timeline

### Phase 1: Critical Fix (2-3 hours)
- Implement sample rate probing
- Add loopback fallback logic
- Test with Bluetooth headset

### Phase 2: Enhanced Display (1 hour)
- Update device info display
- Show detected rates in UI

### Phase 3: Hot-swap Enhancement (30 min)
- Improve device refresh UX
- Test device switching

### Phase 4: Bluetooth Optimization (1 hour)
- Add Bluetooth detection
- Display warnings/tips

### Phase 5: Testing (1-2 hours)
- Write unit tests
- Manual testing with multiple devices
- Document test results

**Total Estimated Time**: 6-8 hours

## Risks & Mitigations

### Risk 1: Sample Rate Probing Causes Delays
**Impact**: Recording start time increases
**Mitigation**:
- Probe only once during __init__
- Cache results per session
- Typical probe time: <500ms

### Risk 2: Some Devices Don't Support Standard Rates
**Impact**: Probing fails, no fallback works
**Mitigation**:
- Try wide range of rates (48k down to 8k)
- Ultimate fallback: mic-only mode
- Clear error message guides user to troubleshoot

### Risk 3: Bluetooth Sample Rate Changes Mid-Recording
**Impact**: Recording corrupted if rate changes
**Mitigation**:
- Document best practices (keep headset in one mode)
- Detect rate mismatches via callback errors
- Future enhancement: detect and handle mid-recording changes

## Success Criteria

1. ✅ Bluetooth headset recording produces normal-sounding audio
2. ✅ All sample rates (8kHz to 48kHz) handled correctly
3. ✅ Device switching works without app restart
4. ✅ Clear error messages guide users to solutions
5. ✅ No regression for existing working devices

## Future Enhancements

### V2: Advanced Sample Rate Handling
- Real-time detection of sample rate changes
- Automatic resampling on-the-fly
- Support for non-standard sample rates

### V3: Device Profiles
- Remember optimal settings per device
- Auto-select best devices when multiple available
- Device-specific audio processing profiles

### V4: Windows Audio API Integration
- Direct WASAPI integration (bypass PyAudio limitations)
- More accurate sample rate detection
- Lower latency, better control
