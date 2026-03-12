import subprocess

import backend.audio.compressor as compressor


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


def test_verify_recording_integrity_returns_true_when_ffprobe_is_unavailable(monkeypatch):
    monkeypatch.setattr(compressor.shutil, 'which', lambda _: None)

    assert compressor.verify_recording_integrity('unused-file-path.opus') is True


def test_get_file_info_returns_empty_when_ffprobe_is_unavailable(monkeypatch):
    monkeypatch.setattr(compressor.shutil, 'which', lambda _: None)

    assert compressor.get_file_info('unused-file-path.opus') == {}
