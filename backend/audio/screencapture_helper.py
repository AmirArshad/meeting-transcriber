"""
ScreenCaptureKit helper for macOS desktop audio capture.

This module uses PyObjC to interface with Apple's ScreenCaptureKit framework
to capture system audio output (desktop audio) on macOS 13+.

IMPORTANT: To capture system audio, we must capture the DISPLAY, not windows.
ScreenCaptureKit routes audio to the content being captured:
- Capturing a display → Captures all system audio output
- Capturing a window → Captures only that window's audio

LIMITATION: ScreenCaptureKit only captures audio routed to the display.
- ✅ Works: Audio playing through built-in speakers or external display speakers
- ❌ May not work: Audio playing through headphones, AirPods, or Bluetooth devices
- Workaround: Use built-in speakers or install BlackHole virtual audio device

This is a macOS limitation - ScreenCaptureKit captures display audio, not system-wide audio.
On Windows, WASAPI loopback captures all system audio regardless of output device.

Requirements:
- macOS 13 Ventura or later
- Screen Recording permission granted
- PyObjC frameworks: ScreenCaptureKit, CoreAudio, AVFoundation
"""

import sys
import threading
import time
import numpy as np
from typing import Optional, Callable


class ScreenCaptureAudioRecorder:
    """
    Captures desktop audio using ScreenCaptureKit on macOS 13+.

    Uses PyObjC to interface with Apple's ScreenCaptureKit framework.
    Requires Screen Recording permission.
    """

    def __init__(self, sample_rate: int = 48000, channels: int = 2):
        """
        Initialize the ScreenCaptureKit audio recorder.

        Args:
            sample_rate: Target sample rate (default: 48000 Hz - matches Windows)
            channels: Number of audio channels (default: 2 for stereo)
        """
        self.sample_rate = sample_rate
        self.channels = channels
        self.is_recording = False
        self.audio_buffer = []
        self.stream = None
        self.content_filter = None
        self.stream_config = None
        self.delegate = None

        # Import PyObjC frameworks
        try:
            from Foundation import NSObject
            from ScreenCaptureKit import (
                SCShareableContent,
                SCContentFilter,
                SCStreamConfiguration,
                SCStream,
                SCStreamOutputType
            )
            from AVFoundation import AVAudioFormat

            self.NSObject = NSObject
            self.SCShareableContent = SCShareableContent
            self.SCContentFilter = SCContentFilter
            self.SCStreamConfiguration = SCStreamConfiguration
            self.SCStream = SCStream
            self.SCStreamOutputType = SCStreamOutputType
            self.AVAudioFormat = AVAudioFormat

        except ImportError as e:
            raise ImportError(
                f"Failed to import PyObjC frameworks: {e}\n"
                "Make sure you have installed:\n"
                "  pip install pyobjc-framework-ScreenCaptureKit\n"
                "  pip install pyobjc-framework-AVFoundation\n"
                "  pip install pyobjc-framework-CoreAudio"
            )

    def _create_stream_delegate(self):
        """
        Create a delegate to handle audio samples from ScreenCaptureKit.

        The delegate receives audio buffers from the capture stream and
        converts them to numpy arrays for processing.
        """
        from Foundation import NSObject
        from objc import python_method

        recorder = self  # Capture reference for delegate

        class StreamDelegate(NSObject):
            """Delegate that receives audio samples from SCStream."""

            def __init__(self):
                super().__init__()
                self.sample_count = 0
                self.first_sample_logged = False

            @python_method
            def stream_didOutputSampleBuffer_ofType_(self, stream, sample_buffer, output_type):
                """
                Called when the stream outputs a new sample buffer.

                Args:
                    stream: The SCStream instance
                    sample_buffer: CMSampleBuffer containing audio data
                    output_type: Type of output (audio or video)
                """
                # DEBUG: Log that we received a callback
                if not self.first_sample_logged:
                    print(f"DEBUG: Delegate callback received! output_type={output_type}", file=sys.stderr)
                    print(f"DEBUG: Expected audio type: {recorder.SCStreamOutputType.SCStreamOutputTypeAudio}", file=sys.stderr)
                    self.first_sample_logged = True

                # Only process audio samples
                if output_type != recorder.SCStreamOutputType.SCStreamOutputTypeAudio:
                    if not self.first_sample_logged:
                        print(f"DEBUG: Skipping non-audio sample (type={output_type})", file=sys.stderr)
                    return

                if not recorder.is_recording:
                    print(f"DEBUG: Received sample but is_recording=False", file=sys.stderr)
                    return

                try:
                    # Extract audio data from CMSampleBuffer
                    audio_data = self._extract_audio_from_sample_buffer(sample_buffer)

                    if audio_data is not None and len(audio_data) > 0:
                        recorder.audio_buffer.append(audio_data)
                        self.sample_count += 1

                        # Log first few samples
                        if self.sample_count <= 3:
                            print(f"DEBUG: Successfully captured audio sample #{self.sample_count}: {len(audio_data)} samples", file=sys.stderr)
                    else:
                        print(f"DEBUG: Audio extraction returned None or empty", file=sys.stderr)

                except Exception as e:
                    print(f"Error processing audio sample: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)

            @python_method
            def _extract_audio_from_sample_buffer(self, sample_buffer):
                """
                Extract audio data from CMSampleBuffer and convert to numpy array.

                Args:
                    sample_buffer: CMSampleBuffer containing audio data

                Returns:
                    numpy array with audio samples, or None if extraction fails
                """
                try:
                    from CoreMedia import (
                        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer,
                        CMSampleBufferGetNumSamples
                    )
                    from CoreAudio import AudioBufferList

                    # Get the number of samples
                    num_samples = CMSampleBufferGetNumSamples(sample_buffer)

                    if self.sample_count == 0:
                        print(f"DEBUG: First sample has {num_samples} samples", file=sys.stderr)

                    if num_samples == 0:
                        if self.sample_count == 0:
                            print(f"DEBUG: First sample has 0 samples - buffer may be empty", file=sys.stderr)
                        return None

                    # Get the audio buffer list
                    status, audio_buffer_list, block_buffer = \
                        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                            sample_buffer, None, None, 0, None, None, None
                        )

                    if status != 0:
                        if self.sample_count == 0:
                            print(f"DEBUG: CMSampleBufferGetAudioBufferList failed with status={status}", file=sys.stderr)
                        return None

                    # Extract audio data from the buffer list
                    # ScreenCaptureKit typically provides float32 PCM data
                    if audio_buffer_list.mNumberBuffers > 0:
                        buffer = audio_buffer_list.mBuffers[0]

                        if self.sample_count == 0:
                            print(f"DEBUG: Buffer info - mNumberBuffers={audio_buffer_list.mNumberBuffers}, mDataByteSize={buffer.mDataByteSize}", file=sys.stderr)

                        # Convert to numpy array
                        # Assuming float32 format (typical for ScreenCaptureKit)
                        import ctypes
                        audio_data = ctypes.cast(
                            buffer.mData,
                            ctypes.POINTER(ctypes.c_float * (buffer.mDataByteSize // 4))
                        ).contents

                        # Convert to numpy array and reshape for stereo
                        samples = np.array(audio_data, dtype=np.float32)

                        # If stereo, reshape to (n_samples, 2)
                        if recorder.channels == 2 and len(samples) % 2 == 0:
                            samples = samples.reshape(-1, 2)

                        return samples
                    else:
                        if self.sample_count == 0:
                            print(f"DEBUG: audio_buffer_list has 0 buffers", file=sys.stderr)

                    return None

                except Exception as e:
                    print(f"Error extracting audio from buffer: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    return None

            @python_method
            def stream_didStopWithError_(self, stream, error):
                """Called when the stream stops, possibly with an error."""
                if error:
                    print(f"ScreenCaptureKit stream stopped with error: {error}", file=sys.stderr)
                else:
                    print("ScreenCaptureKit stream stopped normally", file=sys.stderr)

        return StreamDelegate.alloc().init()

    def start_recording(self) -> bool:
        """
        Start capturing desktop audio.

        Returns:
            True if recording started successfully, False otherwise
        """
        if self.is_recording:
            print("Already recording", file=sys.stderr)
            return False

        try:
            print("Starting ScreenCaptureKit audio capture...", file=sys.stderr)

            # Use a flag to track if setup completed
            setup_complete = [False]
            setup_error = [None]

            # Get shareable content (displays and windows)
            # This is async in the ScreenCaptureKit API
            def get_content_callback(content, error):
                if error:
                    error_str = str(error)
                    print(f"Error getting shareable content: {error_str}", file=sys.stderr)

                    # Check if it's a permission error
                    if "not authorized" in error_str.lower() or "permission" in error_str.lower():
                        print(f"", file=sys.stderr)
                        print(f"⚠️  SCREEN RECORDING PERMISSION REQUIRED", file=sys.stderr)
                        print(f"", file=sys.stderr)
                        print(f"Meeting Transcriber needs Screen Recording permission to capture", file=sys.stderr)
                        print(f"desktop audio (system sound). No screen video is recorded.", file=sys.stderr)
                        print(f"", file=sys.stderr)
                        print(f"To grant permission:", file=sys.stderr)
                        print(f"  1. Open System Settings", file=sys.stderr)
                        print(f"  2. Go to Privacy & Security > Screen Recording", file=sys.stderr)
                        print(f"  3. Enable 'Meeting Transcriber'", file=sys.stderr)
                        print(f"  4. Restart the app", file=sys.stderr)
                        print(f"", file=sys.stderr)

                    setup_error[0] = error_str
                    setup_complete[0] = True
                    return

                try:
                    print(f"DEBUG: Setting up ScreenCaptureKit stream...", file=sys.stderr)

                    # Create content filter for desktop audio
                    # CRITICAL: To capture system audio, we need to capture the display
                    # Using desktop independent window won't capture audio from other apps

                    # Get the main display
                    displays = content.displays if content else []
                    if not displays:
                        print(f"ERROR: No displays found in shareable content", file=sys.stderr)
                        setup_error[0] = "No displays available"
                        setup_complete[0] = True
                        return

                    main_display = displays[0]  # Use first display (usually main display)
                    print(f"DEBUG: Using display: {main_display}", file=sys.stderr)

                    # Create content filter that captures the display
                    # This will capture system audio output
                    self.content_filter = self.SCContentFilter.alloc().initWithDisplay_excludingWindows_(
                        main_display,
                        []  # Don't exclude any windows
                    )
                    print(f"DEBUG: Content filter created for display capture", file=sys.stderr)

                    # Configure the stream
                    self.stream_config = self.SCStreamConfiguration.alloc().init()

                    # Set audio capture parameters
                    self.stream_config.setCapturesAudio_(True)
                    self.stream_config.setExcludesCurrentProcessAudio_(True)  # Don't capture our own app

                    # Set audio format
                    self.stream_config.setSampleRate_(self.sample_rate)
                    self.stream_config.setChannelCount_(self.channels)

                    print(f"DEBUG: Stream config - capturesAudio={self.stream_config.capturesAudio()}, sampleRate={self.stream_config.sampleRate()}, channels={self.stream_config.channelCount()}", file=sys.stderr)

                    # Disable video capture (we only want audio)
                    self.stream_config.setWidth_(1)
                    self.stream_config.setHeight_(1)
                    self.stream_config.setMinimumFrameInterval_(1.0)  # Minimum frame rate for video

                    # Create the stream delegate
                    self.delegate = self._create_stream_delegate()
                    print(f"DEBUG: Delegate created: {self.delegate}", file=sys.stderr)

                    # Create the stream
                    self.stream = self.SCStream.alloc().initWithFilter_configuration_delegate_(
                        self.content_filter,
                        self.stream_config,
                        self.delegate
                    )
                    print(f"DEBUG: Stream created successfully", file=sys.stderr)

                    import ctypes
                    # Get global dispatch queue to ensure callbacks run in background
                    # This avoids deadlock with the main thread loop
                    _lib = ctypes.CDLL("/usr/lib/libSystem.dylib")
                    _lib.dispatch_get_global_queue.restype = ctypes.c_void_p
                    # DISPATCH_QUEUE_PRIORITY_DEFAULT = 0, flags = 0
                    queue = _lib.dispatch_get_global_queue(0, 0)

                    # Add the delegate as a stream output
                    # CRITICAL: This is required to receive sample buffers
                    self.stream.addStreamOutput_type_sampleHandlerQueue_error_(
                        self.delegate,
                        self.SCStreamOutputType.SCStreamOutputTypeAudio,
                        queue,
                        None
                    )
                    print(f"DEBUG: Added stream output with background queue", file=sys.stderr)

                    # Start the stream
                    def start_completion_handler(error):
                        if error:
                            print(f"Error starting stream: {error}", file=sys.stderr)
                            self.is_recording = False
                            setup_error[0] = str(error)
                        else:
                            print("ScreenCaptureKit stream started successfully", file=sys.stderr)
                            self.is_recording = True
                        setup_complete[0] = True

                    self.stream.startCaptureWithCompletionHandler_(start_completion_handler)

                except Exception as e:
                    print(f"Error setting up ScreenCaptureKit stream: {e}", file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    self.is_recording = False
                    setup_error[0] = str(e)
                    setup_complete[0] = True

            # Request shareable content asynchronously
            self.SCShareableContent.getShareableContentWithCompletionHandler_(get_content_callback)

            # Wait for setup to complete (max 5 seconds)
            for i in range(50):  # 50 * 0.1s = 5 seconds max
                if setup_complete[0]:
                    break
                time.sleep(0.1)

            if not setup_complete[0]:
                print("ERROR: ScreenCaptureKit setup timeout", file=sys.stderr)
                return False

            if setup_error[0]:
                print(f"ERROR: ScreenCaptureKit setup failed: {setup_error[0]}", file=sys.stderr)
                return False

            if not self.is_recording:
                print("ERROR: ScreenCaptureKit failed to start recording", file=sys.stderr)
                return False

            print("ScreenCaptureKit recording started successfully!", file=sys.stderr)
            print("", file=sys.stderr)
            print("ℹ️  NOTE: Desktop audio capture works best with built-in speakers.", file=sys.stderr)
            print("   If using headphones/AirPods, desktop audio may not be captured.", file=sys.stderr)
            print("   This is a macOS limitation - ScreenCaptureKit captures display audio only.", file=sys.stderr)
            print("", file=sys.stderr)
            return True

        except Exception as e:
            print(f"Error starting ScreenCaptureKit recording: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            return False

    def stop_recording(self) -> Optional[np.ndarray]:
        """
        Stop capturing desktop audio and return the recorded data.

        Returns:
            numpy array with shape (n_samples, channels) containing audio data,
            or None if no audio was captured
        """
        if not self.is_recording:
            return None

        print("Stopping ScreenCaptureKit audio capture...", file=sys.stderr)
        self.is_recording = False

        # Stop the stream
        if self.stream:
            def stop_completion_handler(error):
                if error:
                    print(f"Error stopping stream: {error}", file=sys.stderr)

            self.stream.stopCaptureWithCompletionHandler_(stop_completion_handler)
            time.sleep(0.5)  # Wait for stream to stop

        # Concatenate all audio buffers
        if not self.audio_buffer:
            print("No desktop audio captured", file=sys.stderr)
            print("", file=sys.stderr)
            print("⚠️  If you just granted Screen Recording permission, please restart the app.", file=sys.stderr)
            print("   macOS requires an app restart after granting this permission.", file=sys.stderr)
            print("", file=sys.stderr)
            return None

        try:
            audio_data = np.concatenate(self.audio_buffer, axis=0)
            print(f"Captured {len(audio_data)} desktop audio samples", file=sys.stderr)

            # Clear buffer
            self.audio_buffer = []

            return audio_data

        except Exception as e:
            print(f"Error concatenating audio buffers: {e}", file=sys.stderr)
            return None

    def cleanup(self):
        """Clean up resources."""
        if self.is_recording:
            self.stop_recording()

        self.stream = None
        self.content_filter = None
        self.stream_config = None
        self.delegate = None


def check_screen_recording_permission() -> bool:
    """
    Check if the app has Screen Recording permission.

    Returns:
        True if permission is granted, False otherwise
    """
    try:
        from ScreenCaptureKit import SCShareableContent
        from Foundation import NSRunLoop, NSDate

        # Try to get shareable content
        # This will trigger a permission request if not already granted
        permission_granted = [False]  # Use list to allow modification in callback

        def completion_handler(content, error):
            if error:
                print(f"No Screen Recording permission: {error}", file=sys.stderr)
                permission_granted[0] = False
            else:
                permission_granted[0] = True

        SCShareableContent.getShareableContentWithCompletionHandler_(completion_handler)

        # Wait for callback (run loop for 2 seconds max)
        timeout = NSDate.dateWithTimeIntervalSinceNow_(2.0)
        NSRunLoop.currentRunLoop().runUntilDate_(timeout)

        return permission_granted[0]

    except Exception as e:
        print(f"Error checking Screen Recording permission: {e}", file=sys.stderr)
        return False


# CLI test
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Test ScreenCaptureKit audio capture")
    parser.add_argument("--duration", type=int, default=5, help="Recording duration in seconds")
    parser.add_argument("--output", default="test_desktop.wav", help="Output WAV file")

    args = parser.parse_args()

    print("Testing ScreenCaptureKit audio capture...")
    print(f"Duration: {args.duration} seconds")
    print(f"Output: {args.output}")
    print()

    # Check permission
    print("Checking Screen Recording permission...")
    if not check_screen_recording_permission():
        print("ERROR: Screen Recording permission not granted!")
        print("Please grant Screen Recording permission in System Settings > Privacy & Security")
        sys.exit(1)

    print("Permission granted!")
    print()

    # Create recorder
    recorder = ScreenCaptureAudioRecorder(sample_rate=44100, channels=2)

    # Start recording
    if not recorder.start_recording():
        print("Failed to start recording")
        sys.exit(1)

    print(f"Recording for {args.duration} seconds...")
    time.sleep(args.duration)

    # Stop and get audio
    audio_data = recorder.stop_recording()

    if audio_data is None:
        print("No audio captured")
        sys.exit(1)

    # Save to WAV
    print(f"Saving to {args.output}...")
    import scipy.io.wavfile as wavfile

    # Convert float32 to int16 for WAV
    audio_int16 = (audio_data * 32767).astype(np.int16)
    wavfile.write(args.output, 44100, audio_int16)

    print(f"Saved {len(audio_data)} samples")
    print("Done!")

    recorder.cleanup()
