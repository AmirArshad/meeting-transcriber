import numpy as np

from backend.audio.chunked_audio_buffer import ChunkedAudioBuffer


def test_chunked_audio_buffer_round_trips_stereo_chunks():
    buffer = ChunkedAudioBuffer()

    buffer.append(np.array([[0.1, 0.2], [0.3, 0.4]], dtype=np.float64))
    buffer.append(np.array([[0.5, 0.6]], dtype=np.float64))

    combined = buffer.to_array()

    assert combined.shape == (3, 2)
    assert np.allclose(combined, np.array([
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
    ], dtype=np.float64))
    assert len(buffer) == 2
    assert buffer.nbytes == combined.nbytes


def test_chunked_audio_buffer_exposes_latest_chunk_for_level_calculation():
    buffer = ChunkedAudioBuffer()
    buffer.append(np.array([[1.0], [2.0]], dtype=np.float32))
    latest = np.array([[3.0], [4.0]], dtype=np.float32)
    buffer.append(latest)

    assert np.array_equal(buffer[-1], latest)


def test_chunked_audio_buffer_rejects_mismatched_channel_shapes():
    buffer = ChunkedAudioBuffer()
    buffer.append(np.array([[1.0, 2.0]], dtype=np.float32))

    try:
        buffer.append(np.array([[3.0]], dtype=np.float32))
    except ValueError as exc:
        assert 'Mismatched channel count' in str(exc)
    else:
        raise AssertionError('Expected mismatched channel count to raise ValueError')
