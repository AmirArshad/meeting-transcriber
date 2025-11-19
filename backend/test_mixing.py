"""
Test script for audio mixing (mic + desktop loopback).
Tests the improved mixing algorithm with full volume.
"""

import sys
import time
from datetime import datetime
from audio_recorder import AudioRecorder

def main():
    print("=" * 60)
    print("MIXING MODE TEST - Mic + Desktop Audio")
    print("=" * 60)
    print()

    # Use known working devices (auto-detected via find_active_audio.py)
    mic_id = 39  # Logitech Webcam C925e (16kHz)
    loopback_id = 41  # ASUS PB287Q (NVIDIA) - Strongest signal
    duration = 10

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"test_mixing_{timestamp}.wav"

    print(f"Configuration:")
    print(f"  Microphone: ID {mic_id} (Logitech Webcam C925e - 16kHz)")
    print(f"  Desktop Audio: ID {loopback_id} (NVIDIA Audio - 48kHz)")
    print(f"  Duration: {duration} seconds")
    print(f"  Volume: FULL (1.0 for both sources)")
    print(f"  Output: {output_file}")
    print()

    # Create recorder with FULL VOLUME
    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,
        mic_volume=1.0,  # Full volume
        desktop_volume=1.0  # Full volume
    )

    try:
        print("INSTRUCTIONS:")
        print("  1. Start playing audio/video on your computer NOW")
        print("  2. Speak into your microphone during the test")
        print("  3. Both sources will be mixed together")
        print()
        input("Press ENTER when ready to start recording...")
        print()

        # Start recording
        print("Starting recording...")
        recorder.start_recording()

        print()
        print("RECORDING - Speak AND play audio!")
        print()

        # Record
        for i in range(duration):
            remaining = duration - i
            print(f"  {remaining} seconds remaining...", end='\r')
            time.sleep(1)

        print()
        print()

        # Stop recording
        print("Stopping recording...")
        recorder.stop_recording()

        print()
        print("=" * 60)
        print("SUCCESS - Mixing test completed!")
        print(f"   File saved: {output_file}")
        print()
        print("NEXT STEPS:")
        print("  1. Play the audio file")
        print("  2. Verify you hear BOTH:")
        print("     - Your voice from the microphone")
        print("     - The desktop audio that was playing")
        print("  3. Check that volume sounds natural (not quiet/tinny)")
        print("=" * 60)

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        recorder.cleanup()

if __name__ == "__main__":
    main()
