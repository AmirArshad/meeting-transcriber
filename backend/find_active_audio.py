"""
Diagnostic tool to find which loopback device is actually receiving audio.

This helps identify the correct desktop audio source when you have multiple
audio outputs (monitors with speakers, virtual cables, etc).
"""

import sys
import time
import numpy as np
import pyaudiowpatch as pyaudio
from device_manager import DeviceManager


def monitor_loopback_device(device_id, duration=5):
    """Monitor a loopback device and return RMS level."""
    pa = pyaudio.PyAudio()

    try:
        device_info = pa.get_device_info_by_index(device_id)
        sample_rate = int(device_info['defaultSampleRate'])
        channels = int(device_info['maxInputChannels'])

        frames = []

        def callback(in_data, frame_count, time_info, status):
            frames.append(np.frombuffer(in_data, dtype=np.int16))
            return (in_data, pyaudio.paContinue)

        stream = pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            input_device_index=device_id,
            frames_per_buffer=4096,
            stream_callback=callback
        )

        stream.start_stream()
        time.sleep(duration)
        stream.stop_stream()
        stream.close()

        # Calculate RMS
        if frames:
            audio = np.concatenate(frames)
            rms = np.sqrt(np.mean(audio.astype(np.float32)**2))
            max_amp = np.max(np.abs(audio))
            return rms, max_amp
        else:
            return 0, 0

    except Exception as e:
        print(f"Error monitoring device {device_id}: {e}", file=sys.stderr)
        return 0, 0
    finally:
        pa.terminate()


def main():
    print("=" * 60)
    print("Active Audio Source Finder")
    print("=" * 60)
    print()
    print("This tool helps you find which loopback device is")
    print("receiving audio from your applications (Chrome, etc).")
    print()

    # Get devices
    manager = DeviceManager()
    devices = manager.list_all_devices()
    loopback_devices = devices['loopback_devices']

    if not loopback_devices:
        print("ERROR: No loopback devices found!")
        print("Make sure you have Windows WASAPI loopback support.")
        sys.exit(1)

    print("Available loopback devices:")
    for device in loopback_devices:
        print(f"  ID {device['id']}: {device['name']}")

    print()
    print("=" * 60)
    print("TEST INSTRUCTIONS:")
    print("=" * 60)
    print()
    print("1. Start playing audio NOW (YouTube, podcast, music, etc)")
    print("2. Make sure it's playing at reasonable volume")
    print("3. Keep it playing for the next 30 seconds")
    print()

    input("Press ENTER when audio is playing...")
    print()

    print("=" * 60)
    print("Testing each loopback device (5 seconds each)...")
    print("=" * 60)
    print()

    results = []

    for device in loopback_devices:
        device_id = device['id']
        device_name = device['name']

        print(f"Testing ID {device_id}: {device_name[:50]}...")

        rms, max_amp = monitor_loopback_device(device_id, duration=5)

        results.append({
            'id': device_id,
            'name': device_name,
            'rms': rms,
            'max_amp': max_amp
        })

        # Visual indicator
        if rms > 1000:
            indicator = "🔊🔊🔊 STRONG SIGNAL"
        elif rms > 500:
            indicator = "🔊🔊 GOOD SIGNAL"
        elif rms > 100:
            indicator = "🔊 WEAK SIGNAL"
        elif rms > 10:
            indicator = "📻 VERY WEAK"
        else:
            indicator = "🔇 SILENT"

        print(f"  RMS: {rms:.0f}, Max: {max_amp}, {indicator}")
        print()

    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print()

    # Sort by RMS (loudest first)
    results.sort(key=lambda x: x['rms'], reverse=True)

    print("Devices ranked by audio level (loudest first):")
    print()

    for i, result in enumerate(results, 1):
        rms = result['rms']
        max_amp = result['max_amp']
        device_id = result['id']
        device_name = result['name']

        if rms > 1000:
            status = "✅ BEST CHOICE - Strong audio signal"
        elif rms > 500:
            status = "✅ GOOD - Decent signal"
        elif rms > 100:
            status = "⚠️  WEAK - May work but quality lower"
        elif rms > 10:
            status = "❌ TOO QUIET - Not recommended"
        else:
            status = "❌ SILENT - No audio detected"

        print(f"{i}. ID {device_id}: {device_name}")
        print(f"   RMS: {rms:.0f}, Max: {max_amp}")
        print(f"   {status}")
        print()

    # Recommendation
    best = results[0]

    print("=" * 60)
    print("RECOMMENDATION")
    print("=" * 60)
    print()

    if best['rms'] > 500:
        print(f"✅ Use device ID {best['id']}:")
        print(f"   {best['name']}")
        print()
        print(f"This device has the strongest signal (RMS: {best['rms']:.0f})")
        print()
        print("Update your recording scripts to use this ID:")
        print(f"  loopback_id = {best['id']}")
    elif best['rms'] > 100:
        print(f"⚠️  Best available is ID {best['id']}, but signal is weak:")
        print(f"   {best['name']}")
        print()
        print("Suggestions:")
        print("  1. Increase system volume")
        print("  2. Check if audio is playing on the right output device")
        print("  3. In Windows Sound settings, verify default playback device")
    else:
        print("❌ NO AUDIO DETECTED on any loopback device!")
        print()
        print("Troubleshooting:")
        print("  1. Make sure audio is actually playing")
        print("  2. Check Windows Sound settings")
        print("  3. Try playing audio on different output devices")
        print("  4. Verify WASAPI loopback is enabled")

    print()
    print("=" * 60)


if __name__ == "__main__":
    main()
