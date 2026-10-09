import json
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

import backend.audio.compressor as compressor


def test_compress_to_opus_returns_real_wav_fallback_path_for_transcription(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'wav fallback bytes')
    output_path.write_bytes(b'bad opus bytes')

    monkeypatch.setattr(
        compressor,
        '_check_recording_integrity',
        lambda *a, **k: compressor._IntegrityCheck(False, False),
    )
    monkeypatch.setattr(
        compressor.subprocess,
        'run',
        lambda *args, **kwargs: subprocess.CompletedProcess(args=['ffmpeg'], returncode=0),
    )

    result, decode_verified = compressor.compress_to_opus(
        str(input_path), str(output_path), sample_rate=48000
    )

    assert result == str(output_path.with_suffix('.wav'))
    assert decode_verified is False
    assert output_path.with_suffix('.wav').read_bytes() == b'wav fallback bytes'
    assert not output_path.exists()


def test_compress_to_opus_falls_back_to_wav_when_ffmpeg_is_missing(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'output.opus'
    input_path.write_bytes(b'fake wav data')

    def raise_file_not_found(*args, **kwargs):
        raise FileNotFoundError('ffmpeg not found')

    monkeypatch.setattr(compressor.subprocess, 'run', raise_file_not_found)

    result, decode_verified = compressor.compress_to_opus(
        str(input_path), str(output_path), sample_rate=48000
    )

    assert result == str(output_path.with_suffix('.wav'))
    assert decode_verified is False
    assert output_path.with_suffix('.wav').read_bytes() == b'fake wav data'
    assert not output_path.exists()


def test_compress_to_opus_falls_back_to_wav_when_ffmpeg_fails(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'output.opus'
    input_path.write_bytes(b'fake wav data')

    def raise_called_process_error(*args, **kwargs):
        raise subprocess.CalledProcessError(1, ['ffmpeg'], stderr=b'boom')

    monkeypatch.setattr(compressor.subprocess, 'run', raise_called_process_error)

    result, decode_verified = compressor.compress_to_opus(
        str(input_path), str(output_path), sample_rate=48000
    )

    assert result == str(output_path.with_suffix('.wav'))
    assert decode_verified is False
    assert output_path.with_suffix('.wav').read_bytes() == b'fake wav data'
    assert not output_path.exists()


def test_compress_to_opus_falls_back_to_wav_when_integrity_check_fails(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'output.opus'
    input_path.write_bytes(b'fake wav data')
    output_path.write_bytes(b'bad opus data')

    monkeypatch.setattr(
        compressor,
        '_check_recording_integrity',
        lambda *a, **k: compressor._IntegrityCheck(False, False),
    )

    def successful_ffmpeg(*args, **kwargs):
        return subprocess.CompletedProcess(args=['ffmpeg'], returncode=0, stdout=b'', stderr=b'')

    monkeypatch.setattr(compressor.subprocess, 'run', successful_ffmpeg)

    result, decode_verified = compressor.compress_to_opus(
        str(input_path), str(output_path), sample_rate=48000
    )

    assert result == str(output_path.with_suffix('.wav'))
    assert decode_verified is False
    assert output_path.with_suffix('.wav').read_bytes() == b'fake wav data'
    assert not output_path.exists()


def test_verify_recording_integrity_returns_false_when_ffprobe_and_ffmpeg_unavailable(monkeypatch):
    monkeypatch.setattr(compressor.shutil, 'which', lambda _: None)

    assert compressor.verify_recording_integrity('unused-file-path.opus', ffmpeg_path=None) is False


def test_verify_recording_integrity_falls_back_to_ffmpeg_decode(tmp_path, monkeypatch):
    audio = tmp_path / 'clip.wav'
    audio.write_bytes(b'RIFF' + b'\x00' * 40)
    monkeypatch.setattr(compressor, 'resolve_ffprobe_path', lambda *_a, **_k: None)
    seen = {}

    def fake_run(cmd, capture_output=True, timeout=600):
        seen['cmd'] = list(cmd)
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=b'', stderr=b'')

    monkeypatch.setattr(compressor.subprocess, 'run', fake_run)
    assert compressor.verify_recording_integrity(str(audio), ffmpeg_path='/bin/ffmpeg') is True
    assert seen['cmd'][0] == '/bin/ffmpeg'
    assert '-i' in seen['cmd']
    assert '-xerror' in seen['cmd']


def test_get_file_info_returns_empty_when_ffprobe_is_unavailable(monkeypatch):
    monkeypatch.setattr(compressor.shutil, 'which', lambda _: None)

    assert compressor.get_file_info('unused-file-path.opus') == {}


def test_compress_and_report_returns_stats_and_optional_verify(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    final_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'x' * 1000)
    final_path.write_bytes(b'y' * 250)

    monkeypatch.setattr(compressor, 'compress_to_opus', lambda *args, **kwargs: (str(final_path), True))
    verified = {'called': False}

    def fake_verify(path, **kwargs):
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
    assert stats['decode_verified'] is True
    assert verified['called'] is True


def test_compress_and_report_skips_verify_when_verify_again_false(tmp_path, monkeypatch):
    """Windows path: verify_again defaults False and must not re-check integrity."""
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    final_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'x' * 1000)
    final_path.write_bytes(b'y' * 250)

    monkeypatch.setattr(compressor, 'compress_to_opus', lambda *args, **kwargs: (str(final_path), False))
    verified = {'called': False}
    monkeypatch.setattr(
        compressor,
        'verify_recording_integrity',
        lambda path, **kwargs: verified.__setitem__('called', True) or True,
    )

    result, stats = compressor.compress_and_report(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        verify_again=False,
    )

    assert result == str(final_path)
    assert stats['ratio'] == 75.0
    assert stats['decode_verified'] is False
    assert verified['called'] is False


def test_compress_to_opus_passes_explicit_ffmpeg_path(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'fake wav')
    seen = {}

    def fake_run(cmd, *args, **kwargs):
        argv = [str(part) for part in cmd]
        if 'libopus' in argv:
            seen['encode'] = argv
            Path(argv[-1]).write_bytes(b'opus')
            return subprocess.CompletedProcess(args=argv, returncode=0, stdout=b'', stderr=b'')
        if '-f' in argv and 'null' in argv:
            seen['decode'] = argv
            return subprocess.CompletedProcess(args=argv, returncode=0, stdout=b'', stderr=b'')
        raise AssertionError(f'unexpected command: {argv}')

    monkeypatch.setattr(compressor.subprocess, 'run', fake_run)
    monkeypatch.setattr(compressor, 'resolve_ffprobe_path', lambda *a, **k: None)

    result, decode_verified = compressor.compress_to_opus(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        ffmpeg_path='/custom/bin/ffmpeg',
    )
    assert result.endswith('.opus')
    assert decode_verified is True
    assert seen['encode'][0] == '/custom/bin/ffmpeg'
    assert seen['decode'][0] == '/custom/bin/ffmpeg'


def test_compress_to_opus_ffprobe_success_is_not_decode_verified(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'fake wav')

    def fake_run(cmd, *args, **kwargs):
        argv = [str(part) for part in cmd]
        if 'libopus' in argv:
            Path(argv[-1]).write_bytes(b'opus')
            return subprocess.CompletedProcess(args=argv, returncode=0, stdout=b'', stderr=b'')
        if Path(argv[0]).name.startswith('ffprobe'):
            return subprocess.CompletedProcess(
                args=argv,
                returncode=0,
                stdout=json.dumps({
                    'format': {'duration': '1.0'},
                    'streams': [{'codec_type': 'audio', 'codec_name': 'opus'}],
                }),
                stderr='',
            )
        raise AssertionError(f'ffprobe success must not null-decode: {argv}')

    monkeypatch.setattr(compressor.subprocess, 'run', fake_run)
    monkeypatch.setattr(compressor, 'resolve_ffprobe_path', lambda *a, **k: '/usr/bin/ffprobe')

    result, decode_verified = compressor.compress_to_opus(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        ffmpeg_path='/custom/bin/ffmpeg',
    )
    assert result.endswith('.opus')
    assert decode_verified is False


def test_compress_and_report_clears_decode_verified_when_verify_again_fails(tmp_path, monkeypatch):
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    final_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'x' * 100)
    final_path.write_bytes(b'y' * 40)
    monkeypatch.setattr(compressor, 'compress_to_opus', lambda *args, **kwargs: (str(final_path), True))
    monkeypatch.setattr(compressor, 'verify_recording_integrity', lambda *a, **k: False)

    _result, stats = compressor.compress_and_report(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        verify_again=True,
    )
    assert stats['decode_verified'] is False


def test_log_recorder_ffmpeg_path_uses_stderr(monkeypatch, capsys):
    monkeypatch.setenv('AVANEVIS_FFMPEG', '/opt/AvaNevis/ffmpeg/ffmpeg')
    assert compressor.log_recorder_ffmpeg_path() == '/opt/AvaNevis/ffmpeg/ffmpeg'
    captured = capsys.readouterr()
    assert captured.out == ''
    assert captured.err == 'Recorder ffmpeg: /opt/AvaNevis/ffmpeg/ffmpeg\n'


def _ogg_crc(data: bytes) -> int:
    crc = 0
    for byte in data:
        index = ((crc >> 24) ^ byte) & 0xFF
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _OGG_CRC_TABLE[index]
    return crc


def _ogg_crc_table() -> list[int]:
    table = []
    for index in range(256):
        remainder = index << 24
        for _ in range(8):
            if remainder & 0x80000000:
                remainder = ((remainder << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                remainder = (remainder << 1) & 0xFFFFFFFF
        table.append(remainder)
    return table


_OGG_CRC_TABLE = _ogg_crc_table()


def _ogg_pages(data: bytes) -> list[bytearray]:
    pages = []
    offset = 0
    while offset + 27 <= len(data) and data[offset:offset + 4] == b'OggS':
        segment_count = data[offset + 26]
        header_len = 27 + segment_count
        body_len = sum(data[offset + 27:offset + header_len])
        end = offset + header_len + body_len
        pages.append(bytearray(data[offset:end]))
        offset = end
    if not pages or offset != len(data):
        raise AssertionError('fixture is not a complete Ogg Opus file')
    return pages


def _recrc_ogg_page(page: bytearray) -> bytearray:
    page = bytearray(page)
    page[22:26] = b'\x00\x00\x00\x00'
    page[22:26] = struct.pack('<I', _ogg_crc(bytes(page)))
    return page


def _corrupt_opus_packet_header(opus_bytes: bytes) -> bytes:
    """Keep a valid Ogg container while making the audio packet undecodable.

    ffprobe still reports a positive-duration Opus stream. ffmpeg ``-xerror``
    rejects the packet header.
    """
    pages = _ogg_pages(opus_bytes)
    audio = pages[-1]
    body_start = 27 + audio[26]
    audio[body_start] = 0x03
    pages[-1] = _recrc_ogg_page(audio)
    return b''.join(pages)


def _write_silence_wav(path: Path) -> None:
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(b'\x00\x00' * 4800)


def test_compress_to_opus_disappearing_ffprobe_is_not_a_decode(tmp_path, monkeypatch):
    """Probe success must stay unverified when ffprobe vanishes before a later lookup."""
    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'fake wav')
    lookups = {'n': 0}
    null_decodes = {'n': 0}

    def flipping_resolve(ffmpeg_path=None):
        lookups['n'] += 1
        if lookups['n'] == 1:
            return '/usr/bin/ffprobe'
        return None

    probe_json = json.dumps({
        'format': {'duration': '1.0'},
        'streams': [{'codec_type': 'audio', 'codec_name': 'opus'}],
    })

    def fake_run(cmd, *args, **kwargs):
        argv = [str(part) for part in cmd]
        if 'libopus' in argv:
            Path(argv[-1]).write_bytes(b'OggS-probe-only')
            return subprocess.CompletedProcess(args=argv, returncode=0, stdout=b'', stderr=b'')
        if Path(argv[0]).name.startswith('ffprobe'):
            return subprocess.CompletedProcess(
                args=argv, returncode=0, stdout=probe_json, stderr=''
            )
        if '-f' in argv and 'null' in argv:
            null_decodes['n'] += 1
            return subprocess.CompletedProcess(
                args=argv, returncode=183, stdout=b'', stderr=b'decode failed'
            )
        raise AssertionError(f'unexpected command: {argv}')

    monkeypatch.setattr(compressor, 'resolve_ffprobe_path', flipping_resolve)
    monkeypatch.setattr(compressor.subprocess, 'run', fake_run)

    result, decode_verified = compressor.compress_to_opus(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        ffmpeg_path='/custom/bin/ffmpeg',
    )

    assert result.endswith('.opus')
    assert lookups['n'] >= 1
    assert null_decodes['n'] == 0
    assert decode_verified is False


def test_disappearing_ffprobe_does_not_verify_a_corrupt_opus(tmp_path, monkeypatch):
    """Real ffprobe can accept an Opus packet that a later ffmpeg decode rejects."""
    ffmpeg = shutil.which('ffmpeg')
    ffprobe = shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        pytest.skip('ffmpeg and ffprobe are required')

    tone = tmp_path / 'tone.wav'
    encoded = tmp_path / 'tone.opus'
    _write_silence_wav(tone)
    encoded_run = subprocess.run(
        [ffmpeg, '-y', '-i', str(tone), '-c:a', 'libopus', '-b:a', '32k', str(encoded)],
        capture_output=True,
    )
    if encoded_run.returncode != 0:
        pytest.skip('ffmpeg libopus encode is unavailable')
    corrupted = _corrupt_opus_packet_header(encoded.read_bytes())

    lookups = {'n': 0}
    null_decodes = {'n': 0}
    real_run = compressor.subprocess.run

    def flipping_resolve(ffmpeg_path=None):
        lookups['n'] += 1
        if lookups['n'] == 1:
            return ffprobe
        return None

    def wrapped_run(cmd, *args, **kwargs):
        argv = [str(part) for part in cmd]
        if 'libopus' in argv:
            Path(argv[-1]).write_bytes(corrupted)
            return subprocess.CompletedProcess(args=argv, returncode=0, stdout=b'', stderr=b'')
        if '-f' in argv and 'null' in argv:
            null_decodes['n'] += 1
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(compressor, 'resolve_ffprobe_path', flipping_resolve)
    monkeypatch.setattr(compressor.subprocess, 'run', wrapped_run)

    input_path = tmp_path / 'input.wav'
    output_path = tmp_path / 'meeting.opus'
    input_path.write_bytes(b'fake wav')
    result, decode_verified = compressor.compress_to_opus(
        str(input_path),
        str(output_path),
        sample_rate=48000,
        ffmpeg_path=ffmpeg,
    )

    assert result.endswith('.opus')
    assert lookups['n'] >= 1
    assert null_decodes['n'] == 0
    assert decode_verified is False
    follow_up = real_run(
        [ffmpeg, '-v', 'error', '-xerror', '-i', result, '-f', 'null', '-'],
        capture_output=True,
    )
    assert follow_up.returncode != 0


def test_platform_recorders_log_ffmpeg_at_startup():
    root = Path(__file__).resolve().parents[2] / 'backend' / 'audio'
    for name in ('windows_recorder.py', 'macos_recorder.py', 'linux_recorder.py'):
        source = (root / name).read_text(encoding='utf-8')
        main = source.split('def main(', 1)[1]
        assert 'log_recorder_ffmpeg_path()' in main[:2500]
