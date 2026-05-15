import numpy as np

from backend.audio.processor import (
    align_audio_lengths,
    downmix_to_stereo,
    enhance_microphone,
    mix_audio,
    mono_to_stereo,
    resample,
)


def test_resample_returns_original_array_when_sample_rates_match():
    audio = np.array([1, -1, 2, -2], dtype=np.int16)

    result = resample(audio, 48000, 48000)

    assert result is audio


def test_resample_rejects_invalid_channel_layout():
    audio = np.array([1, 2, 3], dtype=np.int16)

    try:
        resample(audio, 48000, 16000, num_channels=2)
    except ValueError as exc:
        assert 'not divisible' in str(exc)
    else:
        raise AssertionError('Expected ValueError for invalid interleaved channel layout')


def test_resample_preserves_channel_separation_for_interleaved_stereo():
    audio = np.array(
        [
            32767, 0,
            32767, 0,
            32767, 0,
            32767, 0,
        ],
        dtype=np.int16,
    )

    result = resample(audio, 48000, 24000, num_channels=2)
    stereo = result.reshape(-1, 2)

    assert stereo.shape[1] == 2
    assert np.max(np.abs(stereo[:, 1])) <= 1
    assert np.min(stereo[:, 0]) > 1000


def test_resample_clips_to_int16_range_after_processing():
    audio = np.array([32767, -32768, 32767, -32768], dtype=np.int16)

    result = resample(audio, 48000, 44100)

    assert result.dtype == np.int16
    assert np.max(result.astype(np.int32)) <= 32767
    assert np.min(result.astype(np.int32)) >= -32767


def test_mono_to_stereo_duplicates_each_sample():
    audio = np.array([100, -200, 300], dtype=np.int16)

    result = mono_to_stereo(audio)

    assert np.array_equal(
        result,
        np.array([100, 100, -200, -200, 300, 300], dtype=np.int16),
    )


def test_downmix_to_stereo_uses_first_two_channels():
    audio = np.array(
        [
            1, 2, 3, 4, 5, 6,
            7, 8, 9, 10, 11, 12,
        ],
        dtype=np.int16,
    )

    result = downmix_to_stereo(audio, num_channels=6)

    assert np.array_equal(result, np.array([1, 2, 7, 8], dtype=np.int16))


def test_align_audio_lengths_pads_shorter_audio_with_silence():
    audio1 = np.array([1, 2], dtype=np.int16)
    audio2 = np.array([3, 4, 5, 6], dtype=np.int16)

    padded1, padded2 = align_audio_lengths(audio1, audio2)

    assert np.array_equal(padded1, np.array([1, 2, 0, 0], dtype=np.int16))
    assert np.array_equal(padded2, audio2)


def test_mix_audio_stays_within_int16_bounds():
    mic = np.array([32767, 32767], dtype=np.int16)
    desktop = np.array([32767, 32767], dtype=np.int16)

    mixed = mix_audio(mic, desktop)

    assert mixed.dtype == np.int16
    assert np.max(np.abs(mixed.astype(np.int32))) <= 32767


def test_enhance_microphone_truncates_odd_stereo_input_to_even_length():
    audio = np.array([100, -100, 200, -200, 300], dtype=np.int16)

    result = enhance_microphone(audio, sample_rate=48000, target_channels=2)

    assert result.dtype == np.int16
    assert len(result) == 4
    assert len(result) % 2 == 0
