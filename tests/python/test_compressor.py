import subprocess

import backend.audio.compressor as compressor


def test_compress_to_opus_returns_real_wav_fallback_path_for_transcription(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'wav fallback bytes')
    output_path.write_bytes(b'bad opus bytes')

    monkeypatch.setattr(compressor, 'verify_recording_integrity', lambda _: False)
    monkeypatch.setattr(
        compressor.subprocess,
        'run',
        lambda *args, **kwargs: subprocess.CompletedProcess(args=['ffmpeg'], returncode=0),
    )

    result = compressor.compress_to_opus(str(input_path), str(output_path), sample_rate=48000)

    assert result == str(output_path.with_suffix('.wav'))
    assert output_path.with_suffix('.wav').read_bytes() == b'wav fallback bytes'
    assert not output_path.exists()


def test_compress_to_opus_falls_back_to_wav_when_ffmpeg_is_missing(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'output.opus'
    input_path.write_bytes(b'fake wav data')

    def raise_file_not_found(*args, **kwargs):
        raise FileNotFoundError('ffmpeg not found')

    monkeypatch.setattr(compressor.subprocess, 'run', raise_file_not_found)

    result = compressor.compress_to_opus(str(input_path), str(output_path), sample_rate=48000)

    assert result == str(output_path.with_suffix('.wav'))
    assert output_path.with_suffix('.wav').read_bytes() == b'fake wav data'
    assert not output_path.exists()


def test_compress_to_opus_falls_back_to_wav_when_ffmpeg_fails(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'output.opus'
    input_path.write_bytes(b'fake wav data')

    def raise_called_process_error(*args, **kwargs):
        raise subprocess.CalledProcessError(1, ['ffmpeg'], stderr=b'boom')

    monkeypatch.setattr(compressor.subprocess, 'run', raise_called_process_error)

    result = compressor.compress_to_opus(str(input_path), str(output_path), sample_rate=48000)

    assert result == str(output_path.with_suffix('.wav'))
    assert output_path.with_suffix('.wav').read_bytes() == b'fake wav data'
    assert not output_path.exists()


def test_compress_to_opus_falls_back_to_wav_when_integrity_check_fails(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'output.opus'
    input_path.write_bytes(b'fake wav data')
    output_path.write_bytes(b'bad opus data')

    monkeypatch.setattr(compressor, 'verify_recording_integrity', lambda _: False)

    def successful_ffmpeg(*args, **kwargs):
        return subprocess.CompletedProcess(args=['ffmpeg'], returncode=0, stdout=b'', stderr=b'')

    monkeypatch.setattr(compressor.subprocess, 'run', successful_ffmpeg)

    result = compressor.compress_to_opus(str(input_path), str(output_path), sample_rate=48000)

    assert result == str(output_path.with_suffix('.wav'))
    assert output_path.with_suffix('.wav').read_bytes() == b'fake wav data'
    assert not output_path.exists()


def test_verify_recording_integrity_returns_true_when_ffprobe_is_unavailable(monkeypatch):
    monkeypatch.setattr(compressor.shutil, 'which', lambda _: None)

    assert compressor.verify_recording_integrity('unused-file-path.opus') is True


def test_get_file_info_returns_empty_when_ffprobe_is_unavailable(monkeypatch):
    monkeypatch.setattr(compressor.shutil, 'which', lambda _: None)

    assert compressor.get_file_info('unused-file-path.opus') == {}


def test_compress_and_report_returns_stats_and_optional_verify(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    final_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'x' * 1000)
    final_path.write_bytes(b'y' * 250)

    monkeypatch.setattr(compressor, 'compress_to_opus', lambda *args, **kwargs: str(final_path))
    verified = {'called': False}

    def fake_verify(path):
        verified['called'] = True
        assert path == str(final_path)
        return True

    monkeypatch.setattr(compressor, 'verify_recording_integrity', fake_verify)

    result, stats = compressor.compress_and_report(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        verify_again=True,
        progress_message='Compressing...',
    )

    assert result == str(final_path)
    assert stats['input_size'] == 1000
    assert stats['output_size'] == 250
    assert stats['ratio'] == 75.0
    assert verified['called'] is True


def test_compress_and_report_skips_verify_when_verify_again_false(tmp_path, monkeypatch):
    """Windows path: verify_again defaults False and must not re-check integrity."""
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    final_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'x' * 1000)
    final_path.write_bytes(b'y' * 250)

    monkeypatch.setattr(compressor, 'compress_to_opus', lambda *args, **kwargs: str(final_path))
    verified = {'called': False}
    monkeypatch.setattr(
        compressor,
        'verify_recording_integrity',
        lambda path: verified.__setitem__('called', True) or True,
    )

    result, stats = compressor.compress_and_report(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        verify_again=False,
    )

    assert result == str(final_path)
    assert stats['ratio'] == 75.0
    assert verified['called'] is False
