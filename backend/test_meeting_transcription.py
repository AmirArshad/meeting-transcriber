"""
Test script for meeting transcription (mixed audio).

This tests the full workflow:
1. Record mic + desktop audio together
2. Transcribe with a LARGER Whisper model (better for multiple speakers)
3. Verify transcription quality
"""

import sys
import time
from datetime import datetime
from audio_recorder import AudioRecorder
from transcriber import TranscriberService


def main():
    print("=" * 60)
    print("Meeting Transcription Test (Full Workflow)")
    print("=" * 60)
    print()

    # Known working devices (auto-detected via find_active_audio.py)
    mic_id = 39  # Logitech Webcam C925e (16kHz)
    loopback_id = 41  # ASUS PB287Q (NVIDIA) - Strongest signal

    # Get duration
    try:
        duration = int(input("Recording duration in seconds (default 10): ") or "10")
    except ValueError:
        duration = 10

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"meeting_test_{timestamp}.wav"

    print()
    print("=" * 60)
    print("STEP 1: Recording (Mic + Desktop Audio)")
    print("=" * 60)
    print()
    print(f"Configuration:")
    print(f"  Microphone: ID {mic_id} (your voice)")
    print(f"  Desktop Audio: ID {loopback_id} (other participants)")
    print(f"  Duration: {duration} seconds")
    print(f"  Output: {output_file}")
    print()
    print("INSTRUCTIONS:")
    print("  1. Start playing a video/podcast with clear speech")
    print("  2. Speak clearly into your microphone during recording")
    print("  3. Both sources will be mixed at FULL QUALITY (48kHz)")
    print()

    input("Press ENTER when ready to record...")
    print()

    # Create recorder with FULL volume
    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,  # Force 48kHz for quality
        mic_volume=1.0,
        desktop_volume=1.0
    )

    try:
        # Start recording
        print("Starting recording...")
        recorder.start_recording()

        print()
        print("RECORDING - Speak AND play desktop audio!")
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
        print("Recording complete!")
        print(f"File saved: {output_file}")
        print("=" * 60)
        print()

        # Check file properties
        import wave
        with wave.open(output_file, 'rb') as w:
            rate = w.getframerate()
            channels = w.getnchannels()
            duration_sec = w.getnframes() / rate

        print(f"Audio properties:")
        print(f"  Sample rate: {rate} Hz")
        print(f"  Channels: {channels}")
        print(f"  Duration: {duration_sec:.2f} seconds")
        print()

        if rate != 48000:
            print(f"WARNING: Expected 48kHz but got {rate} Hz!")
            print(f"This may indicate a bug in mixing mode.")
            print()

        # Ask about transcription
        proceed = input("Proceed with transcription? (Y/n): ").strip().lower()
        if proceed and proceed != 'y' and proceed != 'yes' and proceed != '':
            print("Skipping transcription.")
            return

        print()
        print("=" * 60)
        print("STEP 2: Transcription")
        print("=" * 60)
        print()

        # Ask for model size
        print("Model selection:")
        print("  1. base   - Fast, good for clean audio")
        print("  2. small  - Slower, better for mixed audio [RECOMMENDED]")
        print("  3. medium - Slow, best quality for noisy/multiple speakers")
        print()

        model_choice = input("Select model (default: small): ").strip() or "2"
        model_map = {'1': 'base', '2': 'small', '3': 'medium'}
        model_size = model_map.get(model_choice, 'small')

        print()
        print(f"Using '{model_size}' model...")
        print("This may take a moment to download on first use.")
        print()

        # Create transcriber
        transcriber = TranscriberService(
            model_size=model_size,
            language="en",
            device="auto"
        )

        # Load model
        transcriber.load_model()

        # Transcribe
        print()
        print("Transcribing... (this may take a while for mixed audio)")
        results = transcriber.transcribe_file(output_file)

        print()
        print("=" * 60)
        print("STEP 3: Results")
        print("=" * 60)
        print()
        print(f"Detected language: {results['language']}")
        print(f"Segments: {len(results['segments'])}")
        print(f"Transcript saved: {results['output_file']}")
        print()
        print("Full transcript:")
        print("-" * 60)
        print(results['text'])
        print("-" * 60)
        print()
        print(f"Detailed transcript with timestamps: {results['output_file']}")
        print()

        # Evaluate quality
        word_count = len(results['text'].split())
        print(f"Word count: {word_count}")
        print()

        if word_count < 10:
            print("WARNING: Very few words transcribed!")
            print("Possible issues:")
            print("  - Audio quality too low")
            print("  - Too much background noise")
            print("  - Multiple speakers talking over each other")
            print("  - Try using a larger model (medium)")
        else:
            print(f"SUCCESS: Transcription looks reasonable!")

        print()
        print("=" * 60)

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        recorder.cleanup()
        if 'transcriber' in locals():
            transcriber.cleanup()


if __name__ == "__main__":
    main()
