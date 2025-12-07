"""
Timeline reconstruction for WASAPI loopback audio.

WASAPI loopback devices only send callbacks when there's actual audio playing.
This means gaps in playback result in missing frames, not silence frames.
This module reconstructs the full timeline with proper silence gaps.
"""

import sys
import numpy as np

from .constants import MAX_SILENCE_CHUNK_SECONDS, GAP_THRESHOLD_SECONDS


def reconstruct_desktop_timeline(
    desktop_frames: list,
    mic_frames: list,
    mic_first_capture_time: float,
    mic_sample_rate: int,
    mic_channels: int,
    loopback_sample_rate: int,
    loopback_channels: int
) -> np.ndarray:
    """
    Reconstruct desktop audio timeline from timestamped frames.

    WASAPI loopback only sends callbacks when there's actual audio playing.
    This means gaps in playback result in missing frames, not silence frames.
    We use the timestamps stored with each frame to reconstruct the full
    timeline, inserting silence where there were gaps.

    MEMORY OPTIMIZATION: Instead of pre-allocating a massive buffer for the
    full duration (which could be 1GB+ for 90-minute recordings), we build
    the output incrementally by appending chunks. This keeps peak memory
    lower and avoids allocating zeros for long silent periods upfront.

    Args:
        desktop_frames: List of (timestamp, audio_data) tuples
        mic_frames: List of mic audio data (bytes) - used to calculate target duration
        mic_first_capture_time: Timestamp when mic started capturing (reference point)
        mic_sample_rate: Microphone sample rate in Hz
        mic_channels: Number of microphone channels
        loopback_sample_rate: Desktop audio sample rate in Hz
        loopback_channels: Number of desktop audio channels

    Returns:
        numpy array of int16 audio samples with gaps filled with silence
    """
    if not desktop_frames:
        return np.array([], dtype=np.int16)

    # Reference time is when mic started capturing (our timeline starts here)
    if mic_first_capture_time is None:
        # Fallback: use first desktop frame timestamp as reference
        reference_time = desktop_frames[0][0]
    else:
        reference_time = mic_first_capture_time

    # Calculate actual mic duration from real byte count, not assumed chunk size
    # PyAudio callbacks can deliver varying frame counts under CPU pressure
    mic_total_bytes = sum(len(frame) for frame in mic_frames)
    mic_total_samples = mic_total_bytes // 2  # int16 = 2 bytes per sample
    mic_duration_seconds = mic_total_samples / mic_sample_rate / mic_channels

    # Target length in desktop samples
    target_samples = int(mic_duration_seconds * loopback_sample_rate * loopback_channels)

    print(f"  Reconstructing desktop timeline:", file=sys.stderr)
    print(f"    Reference time: mic first capture", file=sys.stderr)
    print(f"    Target duration: {mic_duration_seconds:.2f}s ({target_samples} samples)", file=sys.stderr)
    print(f"    Desktop frames: {len(desktop_frames)}", file=sys.stderr)

    # Maximum silence chunk size to prevent massive single allocations
    max_silence_chunk = int(loopback_sample_rate * loopback_channels * MAX_SILENCE_CHUNK_SECONDS)

    # INCREMENTAL BUILD: Collect chunks instead of pre-allocating full buffer
    output_chunks = []
    current_sample_position = 0

    # Track stats for debug output
    total_gap_duration = 0.0
    gap_count = 0
    skipped_frames = 0

    # Process each frame in order (should already be sorted by timestamp)
    for timestamp, frame_data in desktop_frames:
        # Calculate where this frame should be placed
        time_offset = timestamp - reference_time

        # Skip frames that are before our reference
        if time_offset < 0:
            skipped_frames += 1
            continue

        # Calculate target sample position for this frame
        target_position = int(time_offset * loopback_sample_rate * loopback_channels)

        # Convert frame data to numpy array
        frame_samples = np.frombuffer(frame_data, dtype=np.int16)

        # Handle frame overlap (can happen due to timestamp jitter)
        if target_position < current_sample_position:
            overlap = current_sample_position - target_position
            if overlap >= len(frame_samples):
                # Entire frame is in the past, skip it
                skipped_frames += 1
                continue
            else:
                # Partial overlap - trim the beginning of the frame
                frame_samples = frame_samples[overlap:]
                target_position = current_sample_position

        # If there's a gap (target is ahead of current), insert silence
        if target_position > current_sample_position:
            gap_samples = target_position - current_sample_position
            gap_duration = gap_samples / loopback_sample_rate / loopback_channels

            # Only count as a "gap" if > threshold (ignore normal frame jitter)
            if gap_duration > GAP_THRESHOLD_SECONDS:
                gap_count += 1
                total_gap_duration += gap_duration

            # Insert silence in chunks to avoid massive single allocation
            _append_silence_chunked(output_chunks, gap_samples, max_silence_chunk)
            current_sample_position = target_position

        # Don't exceed target length
        remaining_space = target_samples - current_sample_position
        if remaining_space <= 0:
            break

        if len(frame_samples) > remaining_space:
            frame_samples = frame_samples[:remaining_space]

        # Append the audio frame
        output_chunks.append(frame_samples)
        current_sample_position += len(frame_samples)

    # Pad with silence at the end if needed
    if current_sample_position < target_samples:
        final_padding = target_samples - current_sample_position
        _append_silence_chunked(output_chunks, final_padding, max_silence_chunk)

    # Single concatenation at the end (numpy optimizes this)
    if output_chunks:
        output = np.concatenate(output_chunks)
    else:
        # Warn if we have no output chunks despite having frames
        print(f"    WARNING: No audio chunks produced despite {len(desktop_frames)} frames!", file=sys.stderr)
        print(f"    This may indicate a timing issue (all frames before reference time)", file=sys.stderr)
        # Build empty output in chunks too
        empty_chunks = []
        _append_silence_chunked(empty_chunks, target_samples, max_silence_chunk)
        output = np.concatenate(empty_chunks) if empty_chunks else np.array([], dtype=np.int16)

    # Debug output
    if gap_count > 0:
        print(f"    Gaps detected: {gap_count} gaps, total {total_gap_duration:.2f}s of silence inserted", file=sys.stderr)
    else:
        print(f"    No significant gaps detected (continuous audio)", file=sys.stderr)

    if skipped_frames > 0:
        print(f"    Skipped frames: {skipped_frames} (due to overlap or before reference)", file=sys.stderr)

    return output


def _append_silence_chunked(chunks: list, num_samples: int, max_chunk_size: int) -> None:
    """
    Append silence to chunks list in smaller pieces to avoid massive allocations.

    Args:
        chunks: List to append silence chunks to (modified in place)
        num_samples: Total number of silence samples to add
        max_chunk_size: Maximum size of each individual silence chunk
    """
    remaining = num_samples
    while remaining > 0:
        chunk_size = min(remaining, max_chunk_size)
        chunks.append(np.zeros(chunk_size, dtype=np.int16))
        remaining -= chunk_size
