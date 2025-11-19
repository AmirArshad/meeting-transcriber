"""
Diagnostic test to identify the source of choppy audio.
Records with detailed logging to understand buffer behavior.
"""

import sys
import time
from datetime import datetime
from audio_recorder import AudioRecorder


def main():
    print("=" * 60)
    print("DIAGNOSTIC TEST - Buffer Analysis")
    print("=" * 60)
    print()

    mic_id = 39
    loopback_id = 41
    duration = 10

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"diagnostic_{timestamp}.wav"

    print(f"Recording {duration} seconds with detailed diagnostics...")
    print(f"Output: {output_file}")
    print()
    print("Watch for warnings about:")
    print("  - Buffer overflows (dropping chunks)")
    print("  - Mic-only or Desktop-only fallbacks")
    print("  - Mixer thread issues")
    print()

    input("Press ENTER to start...")
    print()

    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,
        mic_volume=1.0,
        desktop_volume=1.0
    )

    try:
        recorder.start_recording()

        print("RECORDING...")
        for i in range(duration):
            remaining = duration - i
            print(f"  {remaining} seconds remaining...", end='\r')
            time.sleep(1)

        print()
        print()
        recorder.stop_recording()

        print()
        print("=" * 60)
        print("Recording complete!")
        print(f"File: {output_file}")
        print()
        print("Check the console output above for any warnings.")
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
