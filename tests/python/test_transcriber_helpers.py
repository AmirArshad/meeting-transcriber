import tempfile
import types
from typing import Any, cast
from pathlib import Path

import pytest

from backend.transcription.faster_whisper_transcriber import TranscriberService
from backend.transcription.mlx_whisper_transcriber import MLXWhisperTranscriber


def test_transcriber_service_rejects_unknown_language():
    with pytest.raises(ValueError, match='Unsupported language'):
        TranscriberService(language='xx')


def test_mlx_transcriber_rejects_unknown_language():
    with pytest.raises(ValueError, match='Unsupported language'):
        MLXWhisperTranscriber(language='xx')


def test_faster_whisper_lock_file_path_uses_tempdir(monkeypatch):
    service = TranscriberService(model_size='small')
    captured = {}

    class DummyFileLock:
        def __init__(self, path, timeout):
            captured['path'] = path
            captured['timeout'] = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr('filelock.FileLock', DummyFileLock)
    monkeypatch.setattr(service, '_load_model_internal', lambda: captured.setdefault('loaded', True))
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=object))

    service.load_model()

    assert str(captured['path']).endswith('whisper_model_small.lock')
    assert captured['timeout'] == 300
    assert captured['loaded'] is True


def test_mlx_lock_timeout_raises_helpful_runtime_error(monkeypatch):
    service = MLXWhisperTranscriber(model_size='small')

    class DummyTimeout(Exception):
        pass

    class DummyFileLock:
        def __init__(self, path, timeout):
            self.path = path
            self.timeout = timeout

        def __enter__(self):
            raise DummyTimeout()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(tempfile, 'gettempdir', lambda: '/tmp/test-locks')
    monkeypatch.setattr('filelock.FileLock', DummyFileLock)
    monkeypatch.setattr('filelock.Timeout', DummyTimeout)
    monkeypatch.setitem(__import__('sys').modules, 'lightning_whisper_mlx', types.SimpleNamespace())
    monkeypatch.setitem(__import__('sys').modules, 'huggingface_hub', types.SimpleNamespace())

    with pytest.raises(RuntimeError, match='Timeout waiting for model download lock'):
        service.load_model()


def test_faster_whisper_lock_timeout_raises_helpful_runtime_error(monkeypatch):
    service = TranscriberService(model_size='small')

    class DummyTimeout(Exception):
        pass

    class DummyFileLock:
        def __init__(self, path, timeout):
            self.path = path
            self.timeout = timeout

        def __enter__(self):
            raise DummyTimeout()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr('filelock.FileLock', DummyFileLock)
    monkeypatch.setattr('filelock.Timeout', DummyTimeout)
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=object))

    with pytest.raises(RuntimeError, match='Timeout waiting for model download lock'):
        service.load_model()


def test_mlx_transcriber_uses_writable_cache_dir_without_chdir(monkeypatch, tmp_path):
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='fa'))
    cache_dir = tmp_path / 'mlx-cache'
    monkeypatch.setattr(service, '_get_cache_dir', lambda: cache_dir)
    service.cache_dir = cache_dir
    service.model_dir = cache_dir / 'mlx_models' / service.model_storage_dir

    captured = {}

    def fake_download_model_files():
        captured['cache_dir'] = service.cache_dir
        captured['model_dir'] = service.model_dir

    monkeypatch.setattr(service, '_download_model_files', fake_download_model_files)

    original_cwd = Path(__import__('os').getcwd())

    service._load_model_internal()

    assert captured['cache_dir'] == cache_dir
    assert captured['model_dir'] == cache_dir / 'mlx_models' / 'whisper-small-mlx'
    assert Path(__import__('os').getcwd()) == original_cwd


def test_mlx_transcriber_get_model_info_reports_cache_and_repo(tmp_path, monkeypatch):
    service = cast(Any, MLXWhisperTranscriber(model_size='large', language='en'))
    monkeypatch.setattr(service, '_get_cache_dir', lambda: tmp_path / 'cache-root')
    service.cache_dir = tmp_path / 'cache-root'
    service.model_dir = service.cache_dir / 'mlx_models' / service.model_storage_dir

    info = service.get_model_info()

    assert info['backend'] == 'lightning-whisper-mlx'
    assert info['model_key'] == 'distil-large-v3'
    assert info['model_repo'] == 'mustafaaljadery/distil-whisper-mlx'
    assert info['cache_dir'] == str(tmp_path / 'cache-root')
    assert info['model_dir'] == str(tmp_path / 'cache-root' / 'mlx_models' / 'distil-large-v3')


def test_mlx_transcriber_loads_multilingual_models_for_non_english_languages():
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='fa'))

    info = service.get_model_info()

    assert info['model_key'] == 'small'
    assert info['model_repo'] == 'mlx-community/whisper-small-mlx'
    assert info['model_dir'].endswith('mlx_models/whisper-small-mlx')


def test_mlx_transcriber_probes_wave_duration_when_segments_have_no_end(tmp_path):
    audio_path = tmp_path / 'sample.wav'
    import wave

    with wave.open(str(audio_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b'\x00\x00' * 16000)

    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    service.model_ready = True
    captured = {}

    def fake_transcribe_audio(audio_path_value):
        captured['audio_path'] = audio_path_value
        return {'text': 'hello world', 'segments': []}

    service._transcribe_audio = fake_transcribe_audio
    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['duration'] == pytest.approx(1.0, rel=1e-3)
    assert result['language'] == 'en'
    assert captured['audio_path'] == str(audio_path)


def test_mlx_transcriber_passes_requested_language_to_backend(tmp_path, monkeypatch):
    audio_path = tmp_path / 'sample.wav'
    import wave

    with wave.open(str(audio_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b'\x00\x00' * 8000)

    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='fa'))
    service.model_ready = True

    captured = {}

    def fake_transcribe_audio(audio_path_value):
        captured['audio_path'] = audio_path_value
        captured['model_dir'] = str(service.model_dir)
        captured['language'] = service.language
        return {'text': 'salam', 'segments': [], 'language': 'fa'}

    service._transcribe_audio = fake_transcribe_audio

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['language'] == 'fa'
    assert captured['language'] == 'fa'
    assert captured['model_dir'].endswith('mlx_models/whisper-small-mlx')


def test_get_model_info_for_faster_whisper_includes_runtime_state():
    service = cast(Any, TranscriberService(model_size='base', language='en', device='cpu', compute_type='int8'))

    info = service.get_model_info()

    assert info['backend'] == 'faster-whisper'
    assert info['model_size'] == 'base'
    assert info['device'] == 'cpu'
