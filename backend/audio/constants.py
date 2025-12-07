"""
Audio recording constants and configuration.

Centralizes magic numbers and configuration values for the audio recording system.
"""

# Sample rates
DEFAULT_SAMPLE_RATE = 48000  # Hz - Standard high-quality rate (matches Google Meet)
COMMON_SAMPLE_RATES = [48000, 44100, 32000, 16000, 8000]  # For device probing

# Channels
DEFAULT_CHANNELS = 2  # Stereo output

# Buffer sizes
DEFAULT_CHUNK_SIZE = 4096  # frames per buffer
WINDOWS_CHUNK_MULTIPLIER = 4  # Larger buffers on Windows for background resilience

# Preroll (device warm-up)
DEFAULT_PREROLL_SECONDS = 1.5  # Discard first 1.5s for device warm-up
# In production, the 3-second countdown handles warm-up, so preroll can be 0

# Timeline reconstruction (WASAPI gap handling)
MAX_SILENCE_CHUNK_SECONDS = 10  # Cap individual silence allocations at 10 seconds
# This prevents massive single allocations for long gaps
# 10 seconds * 48000 Hz * 2 channels = 960,000 samples * 2 bytes = ~1.9 MB per chunk

GAP_THRESHOLD_SECONDS = 0.1  # Only count gaps > 100ms (ignore normal frame jitter)

# Audio processing
NORMALIZATION_TARGET_DB = -3  # Target -3dB (0.7 linear) for headroom
NORMALIZATION_HIGH_THRESHOLD = 0.7  # Normalize down if peak > 0.7
NORMALIZATION_LOW_THRESHOLD = 0.1  # Boost if peak < 0.1
NORMALIZATION_BOOST_TARGET = 0.3  # Target level when boosting quiet audio
SOFT_LIMIT_THRESHOLD = 0.95  # Apply soft limiting if abs max > 0.95

# Mixing
MIC_BOOST_DB = 6  # 6 dB boost (2x linear) to make voice more prominent
MIC_BOOST_LINEAR = 2.0

# Compression (ffmpeg)
OPUS_BITRATE = '128k'  # Higher bitrate for archival/transcription quality
OPUS_COMPRESSION_LEVEL = 10  # Maximum quality (0-10)
OPUS_APPLICATION = 'audio'  # Audio mode (better quality than 'voip')

# Watchdog
WATCHDOG_CHECK_INTERVAL = 5  # seconds
WATCHDOG_STALL_THRESHOLD = 10  # seconds - warn if no callback for this long

# Level visualization
LEVEL_UPDATE_FPS = 5  # Updates per second (was 20, reduced for performance)
LEVEL_SUBSAMPLE_FACTOR = 8  # Subsample audio by this factor for level calculation
