"""
Quick test script for audio recording.
Automatically detects devices and records a short test.
"""

import sys
import json
from device_manager import DeviceManager
from audio_recorder import AudioRecorder
import time

def main():
    print("=" * 60)
    print("Audio Recording Test")
    print("=" * 60)
    print()

    # Get devices
    print("Detecting audio devices...")
    manager = DeviceManager()
    devices = manager.list_all_devices()

    # Display available devices
    print("\n--- Available Input Devices (Microphones) ---")
    for device in devices['input_devices']:
        if device['host_api'] == 'Windows WASAPI':  # Prefer WASAPI devices
            print(f"  ID {device['id']}: {device['name']} ({device['sample_rate']} Hz)")

    print("\n--- Available Loopback Devices (Desktop Audio) ---")
    for device in devices['loopback_devices']:
        print(f"  ID {device['id']}: {device['name']} ({device['sample_rate']} Hz)")

    # Get user input
    print("\n" + "=" * 60)
    try:
        mic_id = int(input("Enter microphone device ID: "))
        loopback_input = input("Enter loopback device ID (or press Enter to skip): ").strip()
        loopback_id = int(loopback_input) if loopback_input else -1
        duration = int(input("Recording duration in seconds (default 10): ") or "10")
    except ValueError:
        print("Invalid input!")
        sys.exit(1)

    print()
    print("=" * 60)
    print(f"Recording Configuration:")
    print(f"  Microphone: ID {mic_id}")
    if loopback_id >= 0:
        print(f"  Desktop Audio: ID {loopback_id}")
    else:
        print(f"  Desktop Audio: DISABLED (mic-only mode)")
    print(f"  Duration: {duration} seconds")
    print("=" * 60)
    print()

    # Create output filename
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"test_recording_{timestamp}.wav"

    # Create recorder
    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,
        mic_volume=1.0,  # Full volume
        desktop_volume=1.0  # Full volume
    )

    try:
        # Start recording
        print("Starting recording...")
        recorder.start_recording()

        # Countdown
        print("\n🔴 RECORDING IN PROGRESS")
        print("   - Speak into your microphone")
        print("   - Play some audio/video for desktop audio capture")
        print()

        for i in range(duration):
            remaining = duration - i
            print(f"  ⏱  {remaining} seconds remaining...", end='\r')
            time.sleep(1)

        print("\n")

        # Stop recording
        print("Stopping recording...")
        recorder.stop_recording()

        print()
        print("=" * 60)
        print("✅ Recording completed successfully!")
        print(f"   Saved to: {output_file}")
        print("=" * 60)
        print()
        print("You can now play the file to verify the recording:")
        print(f"  {output_file}")
        print()

    except KeyboardInterrupt:
        print("\n\n⚠️  Recording interrupted by user")
        recorder.stop_recording()
    except Exception as e:
        print(f"\n\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        recorder.cleanup()


if __name__ == "__main__":
    main()
