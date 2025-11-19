"""
Meeting recording script optimized for transcription.

Records microphone and desktop audio to SEPARATE files for better transcription:
- mic_TIMESTAMP.wav - Your voice (for transcription)
- desktop_TIMESTAMP.wav - Desktop audio (for reference/playback)

This avoids the "multiple voices" problem that confuses Whisper.
"""

import sys
import time
from datetime import datetime
from audio_recorder import AudioRecorder


def main():
    print("=" * 60)
    print("Meeting Recorder (Separate Tracks)")
    print("=" * 60)
    print()
    print("This records mic and desktop audio to SEPARATE files:")
    print("  - Mic audio: For clean transcription of YOUR voice")
    print("  - Desktop audio: For reference (other meeting participants)")
    print()

    # Use known working devices from SESSION_NOTES
    mic_id = 39  # Logitech Webcam C925e (16kHz)
    loopback_id = 43  # Speakers (Realtek) Loopback (48kHz)

    # Get duration from user
    try:
        duration = int(input("Recording duration in seconds (default 60): ") or "60")
    except ValueError:
        print("Invalid input, using 60 seconds")
        duration = 60

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    mic_file = f"meeting_mic_{timestamp}.wav"
    desktop_file = f"meeting_desktop_{timestamp}.wav"

    print()
    print(f"Configuration:")
    print(f"  Microphone: ID {mic_id} (Logitech Webcam C925e)")
    print(f"  Desktop Audio: ID {loopback_id} (Speakers Realtek)")
    print(f"  Duration: {duration} seconds")
    print(f"  Mic output: {mic_file}")
    print(f"  Desktop output: {desktop_file}")
    print()

    input("Press ENTER when ready to start recording...")
    print()

    # Create two separate recorders
    mic_recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=-1,  # Mic-only
        output_path=mic_file,
        sample_rate=48000,
        mic_volume=1.0
    )

    desktop_recorder = AudioRecorder(
        mic_device_id=loopback_id,  # Use loopback as "mic"
        loopback_device_id=-1,  # No actual loopback
        output_path=desktop_file,
        sample_rate=48000,
        mic_volume=1.0
    )

    try:
        # Start both recorders
        print("Starting recording...")
        mic_recorder.start_recording()
        desktop_recorder.start_recording()

        print()
        print("RECORDING IN PROGRESS")
        print("  Mic: Capturing your voice")
        print("  Desktop: Capturing desktop audio")
        print()

        # Record
        for i in range(duration):
            remaining = duration - i
            print(f"  {remaining} seconds remaining...", end='\r')
            time.sleep(1)

        print()
        print()

        # Stop both recorders
        print("Stopping recording...")
        mic_recorder.stop_recording()
        desktop_recorder.stop_recording()

        print()
        print("=" * 60)
        print("SUCCESS - Recording completed!")
        print("=" * 60)
        print()
        print("Files saved:")
        print(f"  1. {mic_file} - Your voice (transcribe this)")
        print(f"  2. {desktop_file} - Desktop audio (reference)")
        print()
        print("NEXT STEPS:")
        print("  1. Transcribe your voice:")
        print(f"     python test_transcribe.py")
        print(f"     Select: {mic_file}")
        print()
        print("  2. (Optional) Listen to desktop audio for reference")
        print("=" * 60)

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        mic_recorder.cleanup()
        desktop_recorder.cleanup()


if __name__ == "__main__":
    main()
