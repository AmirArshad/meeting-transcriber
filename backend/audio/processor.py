"""
Audio processing utilities.

Provides audio enhancement, resampling, and normalization functions.
Designed for minimal processing to preserve natural sound quality (like Google Meet).
"""

import sys
import numpy as np
import soxr

from .constants import (
    NORMALIZATION_HIGH_THRESHOLD,
    NORMALIZATION_LOW_THRESHOLD,
    NORMALIZATION_BOOST_TARGET,
    SOFT_LIMIT_THRESHOLD,
)


def resample(audio_data: np.ndarray, original_rate: int, target_rate: int) -> np.ndarray:
    """
    Resample audio using soxr (high-quality, fast resampling).

    Args:
        audio_data: Input audio as int16 numpy array
        original_rate: Original sample rate in Hz
        target_rate: Target sample rate in Hz

    Returns:
        Resampled audio as int16 numpy array
    """
    if original_rate == target_rate:
        return audio_data

    # Convert int16 to float32 for soxr processing
    audio_float = audio_data.astype(np.float32) / 32768.0

    # Resample with soxr (VHQ quality setting - best for voice)
    resampled = soxr.resample(
        audio_float,
        original_rate,
        target_rate,
        quality='VHQ'
    )

    # Convert back to int16
    return (resampled * 32767.0).astype(np.int16)


def enhance_microphone(audio_data: np.ndarray, sample_rate: int, target_channels: int = 2) -> np.ndarray:
    """
    Apply MINIMAL enhancement to microphone audio.

    AUDIO QUALITY FIX: Reduced processing to preserve natural quality
    - Only basic DC offset removal and very gentle normalization
    - Removed aggressive filtering that was degrading quality
    - Google Meet-style: minimal processing, let the codec handle it

    Goal: Natural, unprocessed sound - like Google Meet

    Args:
        audio_data: Input audio as int16 numpy array (interleaved if stereo)
        sample_rate: Sample rate in Hz (for future use)
        target_channels: Number of channels in the audio data (1=mono, 2=stereo)

    Returns:
        Enhanced audio as int16 numpy array
    """
    # Handle empty input
    if len(audio_data) == 0:
        return audio_data

    # Convert to float for processing
    audio_float = audio_data.astype(np.float32) / 32768.0

    # Handle stereo by processing each channel separately
    # Use target_channels to determine layout, not array length guessing
    if target_channels == 2 and len(audio_float) >= 2:
        # Reshape interleaved stereo to (samples, 2)
        # Truncate to even length if needed (shouldn't happen with valid audio)
        if len(audio_float) % 2 != 0:
            audio_float = audio_float[:-1]

        audio_stereo = audio_float.reshape(-1, 2)
        left = audio_stereo[:, 0]
        right = audio_stereo[:, 1]

        # Process each channel
        left_processed = _process_channel(left)
        right_processed = _process_channel(right)

        # Recombine to interleaved format
        audio_processed = np.column_stack((left_processed, right_processed)).flatten()
    else:
        # Mono
        audio_processed = _process_channel(audio_float)

    # Convert back to int16
    return (audio_processed * 32767.0).astype(np.int16)


def _process_channel(channel_data: np.ndarray) -> np.ndarray:
    """
    MINIMAL processing for natural sound quality.

    AUDIO QUALITY FIX: Simplified to match Google Meet's approach
    - Only DC offset removal (essential)
    - Light normalization (preserve dynamics)
    - NO aggressive filtering, gating, or compression

    Args:
        channel_data: Single channel audio as float32 numpy array (-1.0 to 1.0)

    Returns:
        Processed channel as float32 numpy array
    """
    # 1. Remove DC offset (essential - prevents pops/clicks)
    channel_data = channel_data - np.mean(channel_data)

    # 2. Very gentle normalization to -3dB peak
    # This preserves dynamics while ensuring good levels
    peak = np.max(np.abs(channel_data))
    if peak > NORMALIZATION_HIGH_THRESHOLD:
        # Target -3dB (0.7) to leave headroom
        channel_data = channel_data * (NORMALIZATION_HIGH_THRESHOLD / peak)
    elif 0 < peak < NORMALIZATION_LOW_THRESHOLD:
        # Boost very quiet audio (but not silence - prevents division by zero)
        # Gentle boost for quiet mics
        channel_data = channel_data * (NORMALIZATION_BOOST_TARGET / peak)

    # 3. Very soft limiting ONLY if clipping would occur
    # Uses tanh for smooth clipping prevention
    abs_max = np.max(np.abs(channel_data))
    if abs_max > SOFT_LIMIT_THRESHOLD:
        channel_data = np.tanh(channel_data * 0.9) * 0.85

    return channel_data


def downmix_to_stereo(audio_data: np.ndarray, num_channels: int) -> np.ndarray:
    """
    Downmix multi-channel audio to stereo.

    Uses front left/right channels (FL/FR) which are typically channels 0 and 1.
    For proper 5.1/7.1 downmix, would need channel routing, but this works for most cases.

    Args:
        audio_data: Input audio as int16 numpy array (interleaved channels)
        num_channels: Number of channels in the input

    Returns:
        Stereo audio as int16 numpy array
    """
    if num_channels <= 2:
        return audio_data

    print(f"  Downmixing from {num_channels} channels to stereo...", file=sys.stderr)

    # Reshape to (samples, channels)
    multichannel = audio_data.reshape(-1, num_channels)

    # Use first two channels (Front Left, Front Right)
    stereo = multichannel[:, :2]

    # Flatten back to 1D interleaved array
    return stereo.flatten().astype(np.int16)


def mono_to_stereo(audio_data: np.ndarray) -> np.ndarray:
    """
    Convert mono audio to stereo by duplicating the channel.

    Args:
        audio_data: Mono audio as int16 numpy array

    Returns:
        Stereo audio as int16 numpy array (interleaved)
    """
    return np.repeat(audio_data, 2)


def mix_audio(
    mic_audio: np.ndarray,
    desktop_audio: np.ndarray,
    mic_volume: float = 1.0,
    desktop_volume: float = 1.0,
    mic_boost: float = 2.0
) -> np.ndarray:
    """
    Mix microphone and desktop audio together.

    Args:
        mic_audio: Microphone audio as int16 numpy array
        desktop_audio: Desktop audio as int16 numpy array
        mic_volume: Volume multiplier for mic (0.0 to 1.0)
        desktop_volume: Volume multiplier for desktop (0.0 to 1.0)
        mic_boost: Additional boost for mic to make voice prominent (default 2.0 = 6dB)

    Returns:
        Mixed audio as int16 numpy array
    """
    # Convert to float
    mic_float = mic_audio.astype(np.float32) / 32768.0 * mic_volume * mic_boost
    desktop_float = desktop_audio.astype(np.float32) / 32768.0 * desktop_volume

    mixed = mic_float + desktop_float

    # Soft limiting if clipping would occur
    max_val = np.max(np.abs(mixed))
    if max_val > 1.0:
        mixed = np.tanh(mixed * 0.85)

    return (mixed * 32767.0).astype(np.int16)


def align_audio_lengths(audio1: np.ndarray, audio2: np.ndarray) -> tuple:
    """
    Pad the shorter audio array with silence to match the longer one.

    Args:
        audio1: First audio array as int16
        audio2: Second audio array as int16

    Returns:
        Tuple of (padded_audio1, padded_audio2) with equal lengths
    """
    len1, len2 = len(audio1), len(audio2)
    max_length = max(len1, len2)

    if len1 < max_length:
        padding = np.zeros(max_length - len1, dtype=np.int16)
        audio1 = np.concatenate([audio1, padding])

    if len2 < max_length:
        padding = np.zeros(max_length - len2, dtype=np.int16)
        audio2 = np.concatenate([audio2, padding])

    return audio1, audio2
