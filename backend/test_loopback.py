"""
Test loopback devices to find which one is receiving desktop audio.
"""

import sys
import time
import numpy as np

try:
    import pyaudiowpatch as pyaudio
except ImportError:
    print("ERROR: pyaudiowpatch not installed")
    sys.exit(1)

from device_manager import DeviceManager


def test_loopback_device(device_id, duration=3):
    """
    Test a loopback device to see if it's receiving audio.

    Returns:
        (is_active, max_level, avg_level)
    """
    pa = pyaudio.PyAudio()
    device_info = pa.get_device_info_by_index(device_id)

    chunks_received = 0
    audio_levels = []

    def callback(in_data, frame_count, time_info, status):
        nonlocal chunks_received
        chunks_received += 1

        # Calculate audio level
        audio_data = np.frombuffer(in_data, dtype=np.int16)
        level = np.abs(audio_data).mean()
        audio_levels.append(level)

        return (in_data, pyaudio.paContinue)

    try:
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=int(device_info['maxInputChannels']),
            rate=int(device_info['defaultSampleRate']),
            input=True,
            input_device_index=device_id,
            frames_per_buffer=1024,
            stream_callback=callback
        )

        stream.start_stream()

        # Monitor for specified duration
        for i in range(duration):
            time.sleep(1)
            print(f"  Monitoring... {i+1}/{duration}s", end='\r')

        print()  # New line

        stream.stop_stream()
        stream.close()

        # Calculate stats
        max_level = max(audio_levels) if audio_levels else 0
        avg_level = np.mean(audio_levels) if audio_levels else 0

        pa.terminate()

        return (chunks_received > 0, max_level, avg_level)

    except Exception as e:
        pa.terminate()
        return (False, 0, 0)


def main():
    print("=" * 70)
    print("Loopback Device Tester")
    print("=" * 70)
    print()
    print("This tool will test all loopback devices to find which one is")
    print("receiving desktop audio.")
    print()
    print("IMPORTANT: Play some music or a video NOW and keep it playing!")
    print()

    input("Press Enter when audio is playing...")

    # Get devices
    manager = DeviceManager()
    devices = manager.list_all_devices()

    loopback_devices = devices['loopback_devices']

    if not loopback_devices:
        print("ERROR: No loopback devices found!")
        sys.exit(1)

    print()
    print(f"Found {len(loopback_devices)} loopback device(s). Testing each for 3 seconds...")
    print()

    results = []

    for device in loopback_devices:
        device_id = device['id']
        device_name = device['name']

        print(f"Testing ID {device_id}: {device_name}")
        is_active, max_level, avg_level = test_loopback_device(device_id, duration=3)

        if is_active:
            status = "✓ ACTIVE" if avg_level > 100 else "⚠ WEAK SIGNAL"
            print(f"  {status} - Avg level: {avg_level:.0f}, Max: {max_level:.0f}")
        else:
            print(f"  ✗ NO AUDIO")

        results.append({
            'id': device_id,
            'name': device_name,
            'avg_level': avg_level,
            'max_level': max_level
        })

        print()

    # Show summary
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print()

    # Sort by average level (highest first)
    results.sort(key=lambda x: x['avg_level'], reverse=True)

    active_devices = [r for r in results if r['avg_level'] > 100]

    if active_devices:
        print("✓ Active loopback devices (receiving audio):")
        print()
        for r in active_devices:
            print(f"  ID {r['id']}: {r['name']}")
            print(f"    Average level: {r['avg_level']:.0f}")
            print()

        best = active_devices[0]
        print("=" * 70)
        print(f"RECOMMENDED: Use device ID {best['id']} for desktop audio")
        print(f"  {best['name']}")
        print("=" * 70)
        print()
        print("Use this command to test recording:")
        print(f"  python audio_recorder.py --mic 39 --loopback {best['id']} --duration 10")
        print()
    else:
        print("✗ No loopback devices are receiving audio!")
        print()
        print("Possible reasons:")
        print("  1. No audio is currently playing")
        print("  2. Audio is playing on a different output device")
        print("  3. System audio is muted")
        print()
        print("Try:")
        print("  - Play a YouTube video or music")
        print("  - Check Windows Sound settings (which device is default)")
        print("  - Unmute system audio")
        print()


if __name__ == "__main__":
    main()
