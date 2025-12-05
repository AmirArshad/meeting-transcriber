"""
Interactive test for Bluetooth headset recording compatibility fix.

This script tests the sample rate detection and fallback logic that fixes
the "bassy monster movie" audio distortion bug with Bluetooth headsets.

Run this with Bluetooth headset connected to verify:
1. Sample rate probing works correctly
2. Audio is not distorted (correct pitch)
3. Both mic and loopback record properly
4. Device switching works between test runs
"""

import sys
import time
from pathlib import Path

try:
    from device_manager import DeviceManager
    from audio_recorder import AudioRecorder
except ImportError as e:
    print(f"ERROR: Failed to import modules: {e}")
    print("Make sure you're running from the backend directory")
    sys.exit(1)


def main():
    print("=" * 70)
    print("Bluetooth Headset Recording Compatibility Test")
    print("=" * 70)
    print()
    print("This test validates the sample rate detection fix for Bluetooth")
    print("devices that was causing distorted 'bassy monster movie' audio.")
    print()

    # List devices
    print("Scanning audio devices...")
    manager = DeviceManager()
    devices = manager.list_all_devices()

    print()
    print("Available MICROPHONES:")
    print("-" * 70)
    for device in devices['input_devices']:
        print(f"  ID {device['id']:2d}: {device['name']}")
        print(f"          {device['sample_rate']} Hz, {device['channels']} ch, {device['host_api']}")
    print()

    print("Available LOOPBACK DEVICES (Desktop Audio):")
    print("-" * 70)
    for device in devices['loopback_devices']:
        print(f"  ID {device['id']:2d}: {device['name']}")
        print(f"          {device['sample_rate']} Hz, {device['channels']} ch, {device['host_api']}")
    print()

    # Get user input
    print("=" * 70)
    print("TEST SETUP")
    print("=" * 70)
    print()

    try:
        mic_id = int(input("Select MICROPHONE ID: "))
        loopback_id = int(input("Select LOOPBACK DEVICE ID: "))
    except (ValueError, KeyboardInterrupt):
        print("\nTest cancelled.")
        sys.exit(0)

    print()
    print("=" * 70)
    print("TEST RECORDING")
    print("=" * 70)
    print()
    print("Starting 10-second test recording...")
    print()
    print("IMPORTANT:")
    print("  1. SPEAK into your microphone")
    print("  2. PLAY some audio (YouTube, music, etc.) so it comes through speakers")
    print("  3. Keep both going for 10 seconds")
    print()

    input("Press ENTER when ready to start...")
    print()

    # Create output path
    output_path = Path("test_bluetooth_recording.wav")

    # Create recorder - this will trigger sample rate probing
    print("Initializing audio recorder...")
    print()

    try:
        recorder = AudioRecorder(
            mic_device_id=mic_id,
            loopback_device_id=loopback_id,
            output_path=str(output_path)
        )

        print()
        print("-" * 70)
        print("Starting recording... (10 seconds)")
        print("-" * 70)
        print()

        recorder.start_recording()

        # Countdown
        for i in range(10, 0, -1):
            print(f"Recording... {i} seconds remaining", end='\r')
            time.sleep(1)

        print()
        print()
        print("Stopping recording...")
        recorder.stop_recording()

        print()
        print("=" * 70)
        print("TEST COMPLETE!")
        print("=" * 70)
        print()

        # Find the actual output file (recorder may save as .opus or .wav)
        opus_path = output_path.with_suffix('.opus')
        wav_path = output_path.with_suffix('.wav')

        actual_file = None
        if opus_path.exists():
            actual_file = opus_path
        elif wav_path.exists():
            actual_file = wav_path
        elif output_path.exists():
            actual_file = output_path

        if actual_file:
            print(f"Recording saved to: {actual_file}")
            print()
            print("VALIDATION CHECKLIST:")
            print("  1. ✓ Sample rate probing completed (see logs above)")
            print("  2. ⏳ Listen to the recording and verify:")
            print("     - Microphone audio has NORMAL pitch (not slow/deep)")
            print("     - Desktop audio has NORMAL pitch (not slow/deep)")
            print("     - No 'bassy monster movie' distortion")
            print("     - Both audio sources are clearly audible")
            print()
            if actual_file == wav_path:
                print("Note: File saved as WAV (ffmpeg not found in PATH)")
                print("      This is OK for testing - just a larger file size")
                print()
            print("If audio sounds normal, the fix is working! ✓")
            print()
        else:
            print(f"Warning: Could not find output file")
            print(f"Expected locations:")
            print(f"  - {opus_path}")
            print(f"  - {wav_path}")
            print(f"  - {output_path}")

    except KeyboardInterrupt:
        print("\n\nTest interrupted by user.")
        sys.exit(0)

    except Exception as e:
        print()
        print("=" * 70)
        print("ERROR DURING TEST")
        print("=" * 70)
        print()
        print(f"Error: {e}")
        print()
        print("This may indicate:")
        print("  - Device is in use by another application")
        print("  - Bluetooth device needs to be reconnected")
        print("  - Device drivers need to be updated")
        print()
        sys.exit(1)

    finally:
        # Cleanup
        try:
            recorder.cleanup()
        except:
            pass

    print()
    print("=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    print()
    print("The fix implements:")
    print("  ✓ Sample rate probing (tries 48k, 44.1k, 32k, 16k, 8k)")
    print("  ✓ Automatic fallback if device changes state")
    print("  ✓ Clear error messages with troubleshooting steps")
    print("  ✓ Support for device hot-swapping between recordings")
    print()
    print("You can now test with different devices by running this script again.")
    print()


if __name__ == '__main__':
    main()
