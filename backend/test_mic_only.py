"""
Simple mic-only recording test (no desktop audio).
"""

import sys
import time
from datetime import datetime
from device_manager import DeviceManager


def main():
    print("=" * 60)
    print("Microphone-Only Recording Test")
    print("=" * 60)
    print()

    # Get devices
    manager = DeviceManager()
    devices = manager.list_all_devices()

    # Show WASAPI microphones only
    print("Available WASAPI microphones:")
    wasapi_mics = [d for d in devices['input_devices'] if d['host_api'] == 'Windows WASAPI']

    for device in wasapi_mics:
        print(f"  ID {device['id']}: {device['name']} ({device['sample_rate']} Hz)")

    print()

    # Get user input
    try:
        mic_id = int(input("Enter microphone device ID: "))
        duration = int(input("Recording duration in seconds (default 10): ") or "10")
    except ValueError:
        print("Invalid input!")
        sys.exit(1)

    # Generate output filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"mic_only_{timestamp}.wav"

    print()
    print("=" * 60)
    print(f"Recording from mic ID {mic_id} for {duration} seconds...")
    print("=" * 60)
    print()

    # Import here to avoid issues if not installed
    try:
        import pyaudiowpatch as pyaudio
        import numpy as np
        import wave
    except ImportError as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    pa = pyaudio.PyAudio()
    frames = []

    def callback(in_data, frame_count, time_info, status):
        """Simple callback that just stores audio."""
        if status:
            print(f"Status: {status}", file=sys.stderr)

        frames.append(in_data)  # Store raw bytes directly
        return (in_data, pyaudio.paContinue)

    try:
        # Get device info
        device_info = pa.get_device_info_by_index(mic_id)
        sample_rate = int(device_info['defaultSampleRate'])
        channels = int(device_info['maxInputChannels'])

        print(f"Opening stream: {sample_rate} Hz, {channels} channel(s)")
        print()

        # Open stream
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            input_device_index=mic_id,
            frames_per_buffer=4096,
            stream_callback=callback
        )

        stream.start_stream()
        print("🔴 RECORDING - Speak into your microphone!")
        print()

        # Record
        for i in range(duration):
            remaining = duration - i
            print(f"  ⏱  {remaining} seconds remaining...", end='\r')
            time.sleep(1)

        print()
        print()
        print("Stopping...")

        stream.stop_stream()
        stream.close()

        # Save WAV
        print(f"Saving to {output_file}...")
        with wave.open(output_file, 'wb') as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(pa.get_sample_size(pyaudio.paInt16))
            wf.setframerate(sample_rate)
            wf.writeframes(b''.join(frames))

        import os
        file_size = os.path.getsize(output_file)

        print()
        print("=" * 60)
        print("✅ Recording completed!")
        print(f"   File: {output_file}")
        print(f"   Size: {file_size / 1024 / 1024:.2f} MB")
        print(f"   Frames captured: {len(frames)}")
        print(f"   Sample rate: {sample_rate} Hz")
        print("=" * 60)

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        pa.terminate()


if __name__ == "__main__":
    main()
