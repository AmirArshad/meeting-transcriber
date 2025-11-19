"""
Test script for transcription service.
Tests the faster-whisper integration with recorded audio files.
"""

import sys
import os
from pathlib import Path
from transcriber import TranscriberService


def main():
    print("=" * 60)
    print("Audio Transcription Test")
    print("=" * 60)
    print()

    # Find available audio files in current directory
    audio_files = list(Path('.').glob('*.wav'))

    if not audio_files:
        print("ERROR: No .wav files found in current directory!")
        print("\nPlease record some audio first using:")
        print("  python test_recording.py")
        print("  python test_fix.py")
        print("  python test_mixing.py")
        sys.exit(1)

    # Show available files
    print("Available audio files:")
    for i, file in enumerate(audio_files, 1):
        file_size = file.stat().st_size / (1024 * 1024)  # MB
        print(f"  {i}. {file.name} ({file_size:.2f} MB)")

    print()

    # Get user selection
    try:
        choice = input("Select file number to transcribe (or press Enter for most recent): ").strip()

        if not choice:
            # Use most recent file
            audio_file = max(audio_files, key=lambda f: f.stat().st_mtime)
            print(f"Using most recent: {audio_file.name}")
        else:
            index = int(choice) - 1
            if index < 0 or index >= len(audio_files):
                print("Invalid selection!")
                sys.exit(1)
            audio_file = audio_files[index]

    except ValueError:
        print("Invalid input!")
        sys.exit(1)

    print()

    # Get language preference
    print("Language options:")
    print("  1. English (en) [DEFAULT]")
    print("  2. Spanish (es)")
    print("  3. French (fr)")
    print("  4. German (de)")
    print("  5. Chinese (zh)")
    print("  6. Other (enter code)")
    print()

    lang_choice = input("Select language (or press Enter for English): ").strip()

    language_map = {
        '1': 'en',
        '2': 'es',
        '3': 'fr',
        '4': 'de',
        '5': 'zh',
    }

    if not lang_choice:
        language = 'en'
    elif lang_choice in language_map:
        language = language_map[lang_choice]
    else:
        language = lang_choice

    print()

    # Get model size preference
    print("Model size options:")
    print("  1. base (fastest, good accuracy) [DEFAULT]")
    print("  2. small (slower, better accuracy)")
    print("  3. medium (slow, excellent accuracy)")
    print("  4. tiny (very fast, lower accuracy)")
    print()

    model_choice = input("Select model size (or press Enter for base): ").strip()

    model_map = {
        '1': 'base',
        '2': 'small',
        '3': 'medium',
        '4': 'tiny',
    }

    if not model_choice:
        model_size = 'base'
    elif model_choice in model_map:
        model_size = model_map[model_choice]
    else:
        model_size = model_choice

    print()
    print("=" * 60)
    print("Transcription Configuration:")
    print(f"  File: {audio_file.name}")
    print(f"  Language: {language}")
    print(f"  Model: {model_size}")
    print("=" * 60)
    print()

    # Create transcriber
    transcriber = TranscriberService(
        model_size=model_size,
        language=language,
        device="auto"
    )

    try:
        # Load model (this may take a moment on first run)
        print("Loading Whisper model (this may take a moment on first run)...")
        transcriber.load_model()

        print()
        print("Transcribing audio (this may take a moment)...")
        print()

        # Transcribe
        results = transcriber.transcribe_file(str(audio_file))

        print()
        print("=" * 60)
        print("TRANSCRIPTION COMPLETE!")
        print("=" * 60)
        print()
        print("Summary:")
        print(f"  Audio file: {audio_file.name}")
        print(f"  Duration: {results['duration']:.2f} seconds")
        print(f"  Detected language: {results['language']}")
        print(f"  Segments: {len(results['segments'])}")
        print(f"  Transcript saved: {results['output_file']}")
        print()
        print("Full transcript:")
        print("-" * 60)
        print(results['text'])
        print("-" * 60)
        print()
        print("You can view the formatted transcript with timestamps at:")
        print(f"  {results['output_file']}")
        print()

    except ImportError as e:
        print()
        print("=" * 60)
        print("ERROR: faster-whisper not installed!")
        print("=" * 60)
        print()
        print("Please install it with:")
        print("  pip install faster-whisper")
        print()
        print("This will download the required dependencies.")
        sys.exit(1)

    except Exception as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)

    finally:
        transcriber.cleanup()


if __name__ == "__main__":
    main()
