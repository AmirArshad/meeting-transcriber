"""
Quick automated test to verify the choppy audio fix.
Uses mic ID 39 (Logitech Webcam C925e) for a 5-second test.
"""

import sys
import time
from datetime import datetime
from audio_recorder import AudioRecorder

def main():
    print("=" * 60)
    print("AUTOMATED TEST - Choppy Audio Fix Verification")
    print("=" * 60)
    print()

    # Use the known working mic from SESSION_NOTES
    mic_id = 39
    loopback_id = -1  # Mic-only mode
    duration = 5

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"test_fix_{timestamp}.wav"

    print(f"Configuration:")
    print(f"  Microphone: ID {mic_id} (Logitech Webcam C925e)")
    print(f"  Mode: Mic-only (no desktop audio)")
    print(f"  Duration: {duration} seconds")
    print(f"  Output: {output_file}")
    print()

    # Create recorder
    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,
        mic_volume=1.0,
        desktop_volume=0.5
    )

    try:
        # Start recording
        print("Starting recording...")
        recorder.start_recording()

        print()
        print("RECORDING - Speak into your microphone!")
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
        print("SUCCESS - Test completed!")
        print(f"   File saved: {output_file}")
        print()
        print("NEXT STEPS:")
        print("  1. Play the audio file to verify it's smooth (not choppy)")
        print("  2. Compare with previous recordings that were choppy")
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
