# Backend - Python Audio Services

This directory contains Python scripts for audio recording and transcription.

## Setup

1. **Create a virtual environment (recommended):**
   ```bash
   python -m venv venv
   venv\Scripts\activate  # On Windows
   ```

2. **Install dependencies:**
   ```bash
   pip install -r ../requirements.txt
   ```

## Testing Device Enumeration

Run the device manager to list all available audio devices:

```bash
python device_manager.py
```

This will output JSON with three categories:
- `input_devices`: Microphones and line-in devices
- `output_devices`: Speakers and headphones
- `loopback_devices`: Virtual devices for capturing desktop audio (WASAPI)

### Expected Output Example:

```json
{
  "input_devices": [
    {
      "id": 0,
      "name": "Microphone (Realtek HD Audio)",
      "channels": 2,
      "sample_rate": 48000,
      "host_api": "Windows WASAPI"
    }
  ],
  "output_devices": [
    {
      "id": 1,
      "name": "Speakers (Realtek HD Audio)",
      "channels": 2,
      "sample_rate": 48000,
      "host_api": "Windows WASAPI"
    }
  ],
  "loopback_devices": [
    {
      "id": 2,
      "name": "Speakers (Realtek HD Audio) [Loopback]",
      "channels": 2,
      "sample_rate": 48000,
      "host_api": "Windows WASAPI"
    }
  ],
  "defaults": {
    "default_input": 0,
    "default_output": 1
  }
}
```

## Testing Audio Recording

Once you've identified your devices, test recording with the audio recorder:

```bash
python audio_recorder.py --mic <MIC_ID> --loopback <LOOPBACK_ID> --duration 10
```

### Example:

Based on your device enumeration, to record from your Logitech webcam mic and desktop audio:

```bash
python audio_recorder.py --mic 39 --loopback 43 --duration 10
```

This will:
1. Record from microphone (ID 39) and desktop audio loopback (ID 43)
2. Mix both audio streams in real-time
3. Record for 10 seconds
4. Save to `recording_YYYYMMDD_HHMMSS.wav`

### Optional Parameters:

```bash
--output filename.wav         # Custom output filename
--sample-rate 48000           # Sample rate in Hz (default: 48000)
--mic-volume 0.7              # Microphone volume multiplier (0.0-1.0)
--desktop-volume 0.5          # Desktop audio volume multiplier (0.0-1.0)
```

### What to Expect:

The recorder will output JSON status messages to stdout:
```json
{"status": "recording", "timestamp": "2025-11-18T10:30:00"}
{"status": "saved", "path": "recording.wav", "size_bytes": 1920044, "duration_seconds": 10.0}
```

Progress messages are sent to stderr for debugging.

## Troubleshooting

**Import Error:** If you get `ImportError: No module named 'pyaudiowpatch'`, install it:
```bash
pip install pyaudiowpatch numpy
```

**No Loopback Devices:** If `loopback_devices` is empty, ensure you're running on Windows with WASAPI support. Loopback devices are Windows-specific.

**Permission Issues:** Some audio devices may require admin privileges to enumerate. Try running as administrator if devices are missing.

**Audio Not Recording:** Make sure:
- The microphone device ID is from the `input_devices` list
- The loopback device ID is from the `loopback_devices` list
- Both devices support the same sample rate (48000 Hz recommended)
- You're actually making sound (play music/video for desktop audio)

**Distorted Audio:** Try adjusting volume levels:
```bash
--mic-volume 0.5 --desktop-volume 0.3
```
