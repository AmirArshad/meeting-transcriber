import tempfile
import types

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

    with pytest.raises(RuntimeError, match='Timeout waiting for model download lock'):
        service.load_model()
