"""
Automated test for the full meeting transcription workflow.
Tests the new post-processing mix recorder (V2) with transcription.
"""

import sys
import time
from datetime import datetime
from audio_recorder import AudioRecorder
from transcriber import TranscriberService


def main():
    print("=" * 60)
    print("Full Workflow Test (V2 Recorder + Transcription)")
    print("=" * 60)
    print()

    # Known working devices
    mic_id = 39  # Logitech Webcam C925e
    loopback_id = 41  # NVIDIA HDMI - Strongest signal
    duration = 10

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"workflow_test_{timestamp}.wav"

    print("Configuration:")
    print(f"  Microphone: ID {mic_id}")
    print(f"  Desktop Audio: ID {loopback_id}")
    print(f"  Duration: {duration} seconds")
    print(f"  Output: {output_file}")
    print()
    print("INSTRUCTIONS:")
    print("  1. Play a video/podcast with speech")
    print("  2. Speak into your microphone during recording")
    print("  3. Both sources will be mixed at 48kHz")
    print()

    # Create recorder
    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,
        mic_volume=1.0,
        desktop_volume=1.0
    )

    try:
        print("=" * 60)
        print("STEP 1: Recording")
        print("=" * 60)
        print()

        # Start recording
        recorder.start_recording()

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
        recorder.stop_recording()

        print()
        print("=" * 60)
        print("Recording Complete!")
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
            print(f"This indicates a regression in the V2 recorder.")
            print()
        else:
            print("Sample rate is correct (48kHz)")
            print()

        print("=" * 60)
        print("STEP 2: Transcription")
        print("=" * 60)
        print()

        # Use small model (good balance of speed/quality)
        model_size = 'small'
        print(f"Using '{model_size}' model...")
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
        print("Transcribing...")
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

        # Evaluate quality
        word_count = len(results['text'].split())
        print(f"Word count: {word_count}")
        print()

        if word_count < 10:
            print("WARNING: Very few words transcribed!")
            print("This may indicate audio quality issues.")
        else:
            print(f"SUCCESS: Transcription looks good!")

        print()
        print("=" * 60)
        print("Test Complete!")
        print("=" * 60)
        print()
        print("Files created:")
        print(f"  Audio: {output_file}")
        print(f"  Transcript: {results['output_file']}")

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
