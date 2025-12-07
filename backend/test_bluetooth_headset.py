#!/usr/bin/env python3
"""
Bluetooth Headset Audio Test Script

This script tests audio recording with Bluetooth headsets and multi-channel audio devices.
It helps diagnose issues like:
- "Bassy monster movie" audio (sample rate mismatch)
- Distorted/robotic audio (incorrect channel handling)
- Silent recordings (permission or device issues)

Usage:
    python test_bluetooth_headset.py

The script will:
1. List all audio devices and their capabilities
2. Let you select a microphone and desktop audio device
3. Probe sample rates to find working configurations
4. Record a short test clip
5. Analyze the recording for common issues
"""

import sys
import time
import platform
from pathlib import Path

# Platform detection
IS_WINDOWS = platform.system() == 'Windows'
IS_MACOS = platform.system() == 'Darwin'

if IS_WINDOWS:
    try:
        import pyaudiowpatch as pyaudio
    except ImportError:
        print("ERROR: pyaudiowpatch not installed")
        print("Install with: pip install pyaudiowpatch")
        sys.exit(1)
elif IS_MACOS:
    try:
        import sounddevice as sd
    except ImportError:
        print("ERROR: sounddevice not installed")
        print("Install with: pip install sounddevice")
        sys.exit(1)
else:
    print(f"ERROR: Unsupported platform: {platform.system()}")
    sys.exit(1)


def list_devices_windows():
    """List all audio devices on Windows."""
    pa = pyaudio.PyAudio()

    print("\n" + "=" * 70)
    print("AUDIO DEVICE ENUMERATION (Windows)")
    print("=" * 70)

    input_devices = []
    loopback_devices = []

    for i in range(pa.get_device_count()):
        try:
            info = pa.get_device_info_by_index(i)
            name = info.get('name', 'Unknown')

            # Skip system mappers
            if any(blocked in name for blocked in [
                "Microsoft Sound Mapper",
                "Primary Sound Capture Driver",
                "Primary Sound Driver"
            ]):
                continue

            is_loopback = info.get('isLoopbackDevice', False)
            max_input = info.get('maxInputChannels', 0)
            sample_rate = int(info.get('defaultSampleRate', 0))
            host_api = pa.get_host_api_info_by_index(info.get('hostApi', 0)).get('name', 'Unknown')

            device_info = {
                'id': i,
                'name': name,
                'channels': max_input,
                'sample_rate': sample_rate,
                'host_api': host_api,
                'is_loopback': is_loopback
            }

            if is_loopback:
                loopback_devices.append(device_info)
            elif max_input > 0:
                input_devices.append(device_info)

        except Exception as e:
            print(f"  Warning: Could not read device {i}: {e}")

    print("\n--- MICROPHONES (Input Devices) ---")
    for dev in input_devices:
        channels_note = " (MULTI-CHANNEL)" if dev['channels'] > 2 else ""
        print(f"  [{dev['id']:2d}] {dev['name']}")
        print(f"       {dev['sample_rate']} Hz, {dev['channels']} channel(s){channels_note}")
        print(f"       Host API: {dev['host_api']}")

    print("\n--- DESKTOP AUDIO (Loopback Devices) ---")
    for dev in loopback_devices:
        channels_note = " (MULTI-CHANNEL)" if dev['channels'] > 2 else ""
        print(f"  [{dev['id']:2d}] {dev['name']}")
        print(f"       {dev['sample_rate']} Hz, {dev['channels']} channel(s){channels_note}")
        print(f"       Host API: {dev['host_api']}")

    pa.terminate()
    return input_devices, loopback_devices


def list_devices_macos():
    """List all audio devices on macOS."""
    print("\n" + "=" * 70)
    print("AUDIO DEVICE ENUMERATION (macOS)")
    print("=" * 70)

    input_devices = []

    try:
        devices = sd.query_devices()

        print("\n--- MICROPHONES (Input Devices) ---")
        for i, dev in enumerate(devices):
            if dev['max_input_channels'] > 0:
                channels_note = " (MULTI-CHANNEL)" if dev['max_input_channels'] > 2 else ""
                print(f"  [{i:2d}] {dev['name']}")
                print(f"       {int(dev['default_samplerate'])} Hz, {dev['max_input_channels']} channel(s){channels_note}")

                input_devices.append({
                    'id': i,
                    'name': dev['name'],
                    'channels': dev['max_input_channels'],
                    'sample_rate': int(dev['default_samplerate'])
                })

        print("\n--- DESKTOP AUDIO ---")
        print("  macOS uses ScreenCaptureKit for desktop audio (not device-based)")
        print("  Desktop audio capture requires Screen Recording permission")

    except Exception as e:
        print(f"ERROR: Could not enumerate devices: {e}")
        print("Microphone permission may not be granted.")

    return input_devices, []


def probe_sample_rates_windows(device_id, device_info):
    """Probe which sample rates actually work for a Windows device."""
    pa = pyaudio.PyAudio()

    default_rate = int(device_info['sample_rate'])
    channels = int(device_info['channels'])

    # Priority order: default first, then common rates
    rates_to_try = [default_rate]
    for rate in [48000, 44100, 32000, 16000, 8000]:
        if rate != default_rate:
            rates_to_try.append(rate)

    print(f"\n  Probing sample rates for: {device_info['name']}")
    print(f"  Channels: {channels}")
    print(f"  Default rate: {default_rate} Hz")
    print(f"  Testing rates: {rates_to_try}")

    working_rates = []

    for rate in rates_to_try:
        try:
            test_stream = pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=device_id,
                frames_per_buffer=1024
            )
            test_stream.close()
            working_rates.append(rate)
            print(f"    {rate} Hz: OK")
        except Exception as e:
            print(f"    {rate} Hz: FAILED - {str(e)[:50]}")

    pa.terminate()

    if working_rates:
        print(f"\n  Working rates: {working_rates}")
        return working_rates[0], channels
    else:
        print(f"\n  ERROR: No working sample rate found!")
        return None, None


def record_test_clip_windows(mic_id, loopback_id, duration=5):
    """Record a test clip on Windows."""
    from audio.windows_recorder import AudioRecorder

    output_path = Path("recordings") / "test_bluetooth.opus"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"\n" + "=" * 70)
    print(f"RECORDING TEST CLIP")
    print(f"=" * 70)
    print(f"  Duration: {duration} seconds")
    print(f"  Microphone: Device {mic_id}")
    print(f"  Desktop Audio: Device {loopback_id}")
    print(f"  Output: {output_path}")
    print()
    print("  Speak into your microphone and play some desktop audio...")
    print()

    try:
        recorder = AudioRecorder(
            mic_device_id=mic_id,
            loopback_device_id=loopback_id,
            output_path=str(output_path),
            sample_rate=48000,
            preroll_seconds=1.5  # Use preroll for test to capture warm-up issues
        )

        recorder.start_recording()

        for i in range(duration):
            remaining = duration - i
            print(f"  Recording... {remaining}s remaining", end='\r')
            time.sleep(1)

        print()
        recorder.stop_recording()
        recorder.cleanup()

        print(f"\n  Recording saved to: {output_path}")

        # Check file size
        if output_path.exists():
            size_kb = output_path.stat().st_size / 1024
            print(f"  File size: {size_kb:.1f} KB")

            if size_kb < 10:
                print(f"  WARNING: File is very small - may indicate recording issues")

        return str(output_path)

    except Exception as e:
        print(f"\n  ERROR during recording: {e}")
        import traceback
        traceback.print_exc()
        return None


def record_test_clip_macos(mic_id, duration=5):
    """Record a test clip on macOS."""
    from audio.macos_recorder import MacOSAudioRecorder

    output_path = Path("recordings") / "test_bluetooth.opus"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"\n" + "=" * 70)
    print(f"RECORDING TEST CLIP")
    print(f"=" * 70)
    print(f"  Duration: {duration} seconds")
    print(f"  Microphone: Device {mic_id}")
    print(f"  Output: {output_path}")
    print()
    print("  Speak into your microphone...")
    print()

    try:
        recorder = MacOSAudioRecorder(
            mic_device_id=mic_id,
            desktop_device_id=-1,  # ScreenCaptureKit handles this
            output_path=str(output_path),
            sample_rate=48000,
            preroll_seconds=1.5  # Use preroll for test
        )

        recorder.start_recording()

        for i in range(duration):
            remaining = duration - i
            print(f"  Recording... {remaining}s remaining", end='\r')
            time.sleep(1)

        print()
        recorder.stop_recording()

        print(f"\n  Recording saved to: {output_path}")

        # Check file size
        if output_path.exists():
            size_kb = output_path.stat().st_size / 1024
            print(f"  File size: {size_kb:.1f} KB")

            if size_kb < 10:
                print(f"  WARNING: File is very small - may indicate recording issues")

        return str(output_path)

    except Exception as e:
        print(f"\n  ERROR during recording: {e}")
        import traceback
        traceback.print_exc()
        return None


def analyze_recording(file_path):
    """Analyze a recording for common issues."""
    import subprocess
    import shutil

    print(f"\n" + "=" * 70)
    print(f"RECORDING ANALYSIS")
    print(f"=" * 70)

    if not Path(file_path).exists():
        print(f"  ERROR: File not found: {file_path}")
        return

    # Try to use ffprobe for analysis
    ffprobe_path = shutil.which('ffprobe')
    if not ffprobe_path:
        print(f"  Note: ffprobe not found, skipping detailed analysis")
        print(f"  Install ffmpeg to enable audio analysis")
        return

    try:
        cmd = [
            ffprobe_path,
            '-v', 'error',
            '-show_format',
            '-show_streams',
            '-of', 'json',
            file_path
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if result.returncode == 0:
            import json
            probe_data = json.loads(result.stdout)

            if 'format' in probe_data:
                fmt = probe_data['format']
                duration = float(fmt.get('duration', 0))
                bitrate = int(fmt.get('bit_rate', 0)) // 1000

                print(f"\n  Format: {fmt.get('format_name', 'unknown')}")
                print(f"  Duration: {duration:.1f} seconds")
                print(f"  Bitrate: {bitrate} kbps")

            if 'streams' in probe_data:
                for stream in probe_data['streams']:
                    if stream.get('codec_type') == 'audio':
                        print(f"\n  Audio Stream:")
                        print(f"    Codec: {stream.get('codec_name', 'unknown')}")
                        print(f"    Sample Rate: {stream.get('sample_rate', 'unknown')} Hz")
                        print(f"    Channels: {stream.get('channels', 'unknown')}")

            # Check for common issues
            print(f"\n  Quality Check:")

            if duration < 1:
                print(f"    [FAIL] Recording too short (< 1 second)")
            else:
                print(f"    [OK] Recording duration looks good")

            if bitrate > 0 and bitrate < 32:
                print(f"    [WARN] Low bitrate may indicate quality issues")
            else:
                print(f"    [OK] Bitrate looks reasonable")

        else:
            print(f"  ffprobe error: {result.stderr}")

    except Exception as e:
        print(f"  Error analyzing file: {e}")


def main():
    """Main entry point for the test script."""
    print("=" * 70)
    print("BLUETOOTH HEADSET / MULTI-CHANNEL AUDIO TEST")
    print("=" * 70)
    print()
    print("This script tests audio recording with Bluetooth headsets and")
    print("multi-channel audio devices to diagnose common issues like:")
    print("  - 'Bassy monster movie' audio (sample rate mismatch)")
    print("  - Distorted/robotic audio (incorrect channel handling)")
    print("  - Silent recordings (permission or device issues)")
    print()

    # List devices
    if IS_WINDOWS:
        input_devices, loopback_devices = list_devices_windows()
    else:
        input_devices, loopback_devices = list_devices_macos()

    if not input_devices:
        print("\nERROR: No input devices found!")
        print("Check that your microphone is connected and permissions are granted.")
        sys.exit(1)

    # Let user select devices
    print("\n" + "=" * 70)
    print("DEVICE SELECTION")
    print("=" * 70)

    print("\nSelect a MICROPHONE device:")
    for i, dev in enumerate(input_devices):
        print(f"  [{i}] {dev['name']} ({dev['sample_rate']} Hz, {dev['channels']} ch)")

    while True:
        try:
            mic_choice = input("\nEnter microphone number (or 'q' to quit): ").strip()
            if mic_choice.lower() == 'q':
                print("Exiting...")
                sys.exit(0)
            mic_idx = int(mic_choice)
            if 0 <= mic_idx < len(input_devices):
                mic_device = input_devices[mic_idx]
                break
            print("Invalid selection, try again.")
        except ValueError:
            print("Please enter a number.")

    loopback_device = None
    if IS_WINDOWS and loopback_devices:
        print("\nSelect a DESKTOP AUDIO device (or press Enter to skip):")
        for i, dev in enumerate(loopback_devices):
            print(f"  [{i}] {dev['name']} ({dev['sample_rate']} Hz, {dev['channels']} ch)")

        while True:
            try:
                loopback_choice = input("\nEnter desktop audio number (or Enter to skip): ").strip()
                if not loopback_choice:
                    break
                loopback_idx = int(loopback_choice)
                if 0 <= loopback_idx < len(loopback_devices):
                    loopback_device = loopback_devices[loopback_idx]
                    break
                print("Invalid selection, try again.")
            except ValueError:
                print("Please enter a number or press Enter to skip.")

    # Probe sample rates
    print("\n" + "=" * 70)
    print("SAMPLE RATE PROBING")
    print("=" * 70)

    if IS_WINDOWS:
        mic_rate, mic_channels = probe_sample_rates_windows(mic_device['id'], mic_device)

        if loopback_device:
            lb_rate, lb_channels = probe_sample_rates_windows(loopback_device['id'], loopback_device)
        else:
            lb_rate, lb_channels = None, None
    else:
        # macOS sounddevice handles sample rates automatically
        mic_rate = mic_device['sample_rate']
        mic_channels = mic_device['channels']
        print(f"\n  macOS: Using device's default rate ({mic_rate} Hz)")

    # Record test clip
    print("\n" + "=" * 70)
    print("READY TO RECORD TEST CLIP")
    print("=" * 70)
    print()
    print(f"  Microphone: {mic_device['name']}")
    if loopback_device:
        print(f"  Desktop Audio: {loopback_device['name']}")
    print()

    input("Press ENTER to start 30-second test recording...")

    if IS_WINDOWS:
        loopback_id = loopback_device['id'] if loopback_device else -1
        output_file = record_test_clip_windows(mic_device['id'], loopback_id, duration=30)
    else:
        output_file = record_test_clip_macos(mic_device['id'], duration=30)

    # Analyze recording
    if output_file:
        analyze_recording(output_file)

    print("\n" + "=" * 70)
    print("TEST COMPLETE")
    print("=" * 70)
    print()
    print("If you experienced issues:")
    print("  1. Try selecting a different device")
    print("  2. For Bluetooth, ensure 'Stereo' mode (not 'Hands-Free')")
    print("  3. Check that no other app is using the microphone")
    print("  4. On Windows, try disabling audio enhancements")
    print()

    if output_file:
        print(f"Test recording saved to: {output_file}")
        print("Listen to it to verify audio quality!")


if __name__ == "__main__":
    main()
