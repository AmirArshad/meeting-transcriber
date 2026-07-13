"""
Audio processing utilities.

Provides audio enhancement, resampling, and normalization functions.
Designed for minimal processing to preserve natural sound quality (like Google Meet).
"""

import sys
from dataclasses import dataclass

import numpy as np
import soxr

from .constants import (
    NORMALIZATION_HIGH_THRESHOLD,
    NORMALIZATION_LOW_THRESHOLD,
    NORMALIZATION_BOOST_TARGET,
    SOFT_LIMIT_THRESHOLD,
    CENTER_CHANNEL_ATTENUATION,
    SURROUND_CHANNEL_ATTENUATION,
)


def resample(
    audio_data: np.ndarray,
    original_rate: int,
    target_rate: int,
    num_channels: int = 1,
) -> np.ndarray:
    """
    Resample audio using soxr (high-quality, fast resampling).

    Args:
        audio_data: Input audio as int16 numpy array
        original_rate: Original sample rate in Hz
        target_rate: Target sample rate in Hz
        num_channels: Number of interleaved channels in the audio data

    Returns:
        Resampled audio as int16 numpy array
    """
    if original_rate == target_rate:
        return audio_data

    if len(audio_data) == 0:
        return audio_data

    if num_channels < 1:
        raise ValueError("num_channels must be at least 1")

    if len(audio_data) % num_channels != 0:
        raise ValueError(
            f"Audio length {len(audio_data)} is not divisible by num_channels={num_channels}"
        )

    # Convert int16 to float32 for soxr processing
    audio_float = audio_data.astype(np.float32) / 32768.0

    if num_channels == 1:
        audio_frames = audio_float
    else:
        audio_frames = audio_float.reshape(-1, num_channels)

    # Resample with soxr (VHQ quality setting - best for voice)
    resampled = soxr.resample(
        audio_frames,
        original_rate,
        target_rate,
        quality='VHQ'
    )

    if num_channels > 1:
        resampled = resampled.reshape(-1)

    # Convert back to int16
    resampled = np.clip(resampled, -1.0, 1.0)
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

    # MEMORY: process in place on a single float32 buffer. Long recordings (e.g. a
    # 1h stereo meeting is hundreds of MB as int16) previously triggered MemoryError
    # because the old path allocated several extra full-size copies at once
    # (audio_float + per-channel copies + column_stack + flatten). Operating on
    # strided channel views in place keeps peak memory to roughly one float buffer.
    audio_float = audio_data.astype(np.float32)
    audio_float /= 32768.0

    # Handle stereo by processing each channel separately
    # Use target_channels to determine layout, not array length guessing
    if target_channels == 2 and len(audio_float) >= 2:
        # Reshape interleaved stereo to (samples, 2)
        # Truncate to even length if needed (shouldn't happen with valid audio)
        if len(audio_float) % 2 != 0:
            audio_float = audio_float[:-1]

        audio_stereo = audio_float.reshape(-1, 2)
        # Strided views into audio_float; processing in place mutates audio_float
        # directly so it stays interleaved without any recombination copy.
        _process_channel_inplace(audio_stereo[:, 0])
        _process_channel_inplace(audio_stereo[:, 1])
    else:
        # Mono
        _process_channel_inplace(audio_float)

    # Convert back to int16 (in-place scale, single output copy)
    audio_float *= 32767.0
    return audio_float.astype(np.int16)


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


def _process_channel_inplace(channel: np.ndarray) -> None:
    """
    In-place equivalent of ``_process_channel`` for memory-sensitive paths.

    Mutates ``channel`` directly (which may be a non-contiguous strided view into
    a larger interleaved buffer) so long recordings can be enhanced without
    allocating extra full-size copies. Peak magnitudes are computed from
    min/max instead of ``np.abs`` to avoid a temporary array the size of the
    channel.

    Args:
        channel: Single channel audio as a float32 array/view (-1.0 to 1.0)
    """
    # 1. Remove DC offset (essential - prevents pops/clicks)
    channel -= channel.mean()

    # 2. Very gentle normalization to -3dB peak (preserves dynamics)
    peak = max(abs(float(channel.min())), abs(float(channel.max())))
    if peak > NORMALIZATION_HIGH_THRESHOLD:
        channel *= NORMALIZATION_HIGH_THRESHOLD / peak
    elif 0 < peak < NORMALIZATION_LOW_THRESHOLD:
        channel *= NORMALIZATION_BOOST_TARGET / peak

    # 3. Very soft limiting ONLY if clipping would occur
    abs_max = max(abs(float(channel.min())), abs(float(channel.max())))
    if abs_max > SOFT_LIMIT_THRESHOLD:
        channel *= 0.9
        np.tanh(channel, out=channel)
        channel *= 0.85


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
    # MEMORY: build the mix in place to avoid holding mic_float, desktop_float and
    # the result as separate full-size float buffers simultaneously (this matters
    # for long recordings where each buffer can be >1 GiB).
    mixed = mic_audio.astype(np.float32)
    mixed *= (mic_volume * mic_boost) / 32768.0

    desktop_float = desktop_audio.astype(np.float32)
    desktop_float *= desktop_volume / 32768.0
    mixed += desktop_float
    del desktop_float

    # Soft limiting if clipping would occur
    max_val = max(abs(float(mixed.min())), abs(float(mixed.max())))
    if max_val > 1.0:
        mixed *= 0.85
        np.tanh(mixed, out=mixed)

    mixed *= 32767.0
    return mixed.astype(np.int16)


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


class StatefulResampler:
    """Chunked soxr.ResampleStream wrapper that keeps filter state across chunks.

    Input/output are float32 frames shaped ``(n, channels)`` or mono ``(n,)``.
    Quality defaults to ``VHQ`` to match the whole-array ``resample()`` path.
    """

    def __init__(
        self,
        original_rate: int,
        target_rate: int,
        num_channels: int = 1,
        *,
        quality: str = "VHQ",
    ) -> None:
        if num_channels < 1:
            raise ValueError("num_channels must be at least 1")
        self.original_rate = int(original_rate)
        self.target_rate = int(target_rate)
        self.num_channels = int(num_channels)
        self._passthrough = self.original_rate == self.target_rate
        self._stream = None
        if not self._passthrough:
            self._stream = soxr.ResampleStream(
                self.original_rate,
                self.target_rate,
                self.num_channels,
                dtype="float32",
                quality=quality,
            )

    def process(self, frames: np.ndarray, *, last: bool = False) -> np.ndarray:
        if frames.size == 0 and not last:
            return np.zeros((0, self.num_channels), dtype=np.float32) if self.num_channels > 1 else np.zeros(0, dtype=np.float32)

        if self.num_channels == 1:
            mono = np.asarray(frames, dtype=np.float32).reshape(-1)
            if self._passthrough:
                return mono
            assert self._stream is not None
            return np.asarray(self._stream.resample_chunk(mono, last=last), dtype=np.float32)

        shaped = np.asarray(frames, dtype=np.float32)
        if shaped.ndim == 1:
            if shaped.size % self.num_channels != 0:
                raise ValueError(
                    f"Audio length {shaped.size} is not divisible by num_channels={self.num_channels}"
                )
            shaped = shaped.reshape(-1, self.num_channels)
        elif shaped.shape[1] != self.num_channels:
            raise ValueError(
                f"Expected {self.num_channels} channels, got shape {shaped.shape}"
            )
        if self._passthrough:
            return shaped
        assert self._stream is not None
        return np.asarray(self._stream.resample_chunk(shaped, last=last), dtype=np.float32)


def downmix_windows_frames_to_stereo(frames: np.ndarray, num_channels: int) -> np.ndarray:
    """Windows profile: keep front left/right (channels 0/1); duplicate mono."""
    if num_channels <= 0:
        raise ValueError("num_channels must be positive")
    data = np.asarray(frames)
    if data.size == 0:
        return np.zeros((0, 2), dtype=np.float32)
    if data.ndim == 1:
        if data.size % num_channels != 0:
            raise ValueError(
                f"Audio length {data.size} is not divisible by num_channels={num_channels}"
            )
        data = data.reshape(-1, num_channels)
    if num_channels == 1:
        mono = data.reshape(-1)
        return np.column_stack([mono, mono]).astype(np.float32, copy=False)
    if num_channels == 2:
        return data[:, :2].astype(np.float32, copy=False)
    return data[:, :2].astype(np.float32, copy=False)


def downmix_macos_frames_to_stereo(frames: np.ndarray, num_channels: int) -> np.ndarray:
    """macOS profile: fold center/surround with the shipped attenuation constants."""
    if num_channels <= 0:
        raise ValueError("num_channels must be positive")
    data = np.asarray(frames)
    if data.size == 0:
        return np.zeros((0, 2), dtype=np.float32)
    if data.ndim == 1:
        if data.size % num_channels != 0:
            raise ValueError(
                f"Audio length {data.size} is not divisible by num_channels={num_channels}"
            )
        data = data.reshape(-1, num_channels)
    if num_channels == 1:
        mono = data.reshape(-1).astype(np.float32, copy=False)
        return np.column_stack([mono, mono])
    if num_channels == 2:
        return data[:, :2].astype(np.float32, copy=False)

    left = data[:, 0].astype(np.float32, copy=True)
    right = data[:, 1].astype(np.float32, copy=True)
    if num_channels >= 3:
        center = data[:, 2].astype(np.float32) * CENTER_CHANNEL_ATTENUATION
        left += center
        right += center
    if num_channels > 3:
        for index in range(3, num_channels):
            ch = data[:, index].astype(np.float32) * SURROUND_CHANNEL_ATTENUATION
            left += ch
            right += ch
    return np.column_stack([left, right])


@dataclass
class ChannelEnhancePlan:
    """Global DC/normalize/soft-limit decisions for one float channel."""

    mean: float = 0.0
    scale: float = 1.0
    soft_limit: bool = False


def plan_channel_enhance(samples: np.ndarray) -> ChannelEnhancePlan:
    """Compute the same decisions ``_process_channel_inplace`` would apply globally."""
    if samples.size == 0:
        return ChannelEnhancePlan()
    channel = np.asarray(samples, dtype=np.float32)
    mean = float(channel.mean())
    centered = channel - mean
    peak = max(abs(float(centered.min())), abs(float(centered.max()))) if centered.size else 0.0
    scale = 1.0
    if peak > NORMALIZATION_HIGH_THRESHOLD:
        scale = NORMALIZATION_HIGH_THRESHOLD / peak
    elif 0 < peak < NORMALIZATION_LOW_THRESHOLD:
        scale = NORMALIZATION_BOOST_TARGET / peak
    scaled = centered * scale
    abs_max = max(abs(float(scaled.min())), abs(float(scaled.max()))) if scaled.size else 0.0
    return ChannelEnhancePlan(mean=mean, scale=scale, soft_limit=abs_max > SOFT_LIMIT_THRESHOLD)


def apply_channel_enhance_inplace(channel: np.ndarray, plan: ChannelEnhancePlan) -> None:
    """Apply a precomputed enhance plan to a float32 channel view (chunk-safe)."""
    if channel.size == 0:
        return
    channel -= plan.mean
    if plan.scale != 1.0:
        channel *= plan.scale
    if plan.soft_limit:
        channel *= 0.9
        np.tanh(channel, out=channel)
        channel *= 0.85


def plan_stereo_enhance(frames: np.ndarray) -> tuple[ChannelEnhancePlan, ChannelEnhancePlan]:
    """Plan left/right enhance from stereo float frames shaped ``(n, 2)``."""
    data = np.asarray(frames, dtype=np.float32)
    if data.size == 0:
        return ChannelEnhancePlan(), ChannelEnhancePlan()
    if data.ndim == 1:
        data = data.reshape(-1, 2)
    return plan_channel_enhance(data[:, 0]), plan_channel_enhance(data[:, 1])


def apply_stereo_enhance_inplace(
    frames: np.ndarray,
    left_plan: ChannelEnhancePlan,
    right_plan: ChannelEnhancePlan,
) -> None:
    data = np.asarray(frames, dtype=np.float32)
    if data.size == 0:
        return
    if data.ndim == 1:
        data = data.reshape(-1, 2)
    apply_channel_enhance_inplace(data[:, 0], left_plan)
    apply_channel_enhance_inplace(data[:, 1], right_plan)
