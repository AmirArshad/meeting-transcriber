import tempfile
import types
import os
from typing import Any, cast
from pathlib import Path
import builtins

import pytest

from backend.transcription import faster_whisper_transcriber as fw_transcriber
from backend.transcription.cuda_probe import build_probe_report, find_unsupported_runtime_profiles
from backend.transcription.faster_whisper_transcriber import TranscriberService
from backend.transcription.mlx_whisper_transcriber import MLXWhisperTranscriber
from backend.transcription import nvidia_dll_loader


def test_transcriber_service_rejects_unknown_language():
    with pytest.raises(ValueError, match='Unsupported language'):
        TranscriberService(language='xx')


def test_mlx_transcriber_rejects_unknown_language():
    with pytest.raises(ValueError, match='Unsupported language'):
        MLXWhisperTranscriber(language='xx')


def test_faster_whisper_lock_file_path_uses_private_lock_dir(monkeypatch, tmp_path):
    service = TranscriberService(model_size='small')
    captured = {}
    lock_dir = tmp_path / 'hf-cache-parent' / '.locks'
    expected_lock = lock_dir / 'whisper_model_small.lock'

    class DummyFileLock:
        def __init__(self, path, timeout):
            captured['path'] = path
            captured['timeout'] = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(
        fw_transcriber,
        'get_transcription_download_lock_path',
        lambda model_size: lock_dir / f'whisper_model_{model_size}.lock',
    )
    monkeypatch.setattr('filelock.FileLock', DummyFileLock)
    monkeypatch.setattr(service, '_load_model_internal', lambda: captured.setdefault('loaded', True))
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=object))

    service.load_model()

    assert captured['path'] == expected_lock
    assert captured['timeout'] == 300
    assert captured['loaded'] is True


def test_cuda_probe_detects_unsupported_newer_runtime(tmp_path):
    cuda13_bin = tmp_path / 'cuda13-bin'
    cuda13_bin.mkdir()
    (cuda13_bin / 'cublas64_13.dll').write_text('dll')

    report = build_probe_report(
        profiles=[{
            'id': 'cuda12',
            'requiredDlls': ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll'],
        }],
        supported_profiles=['cuda12'],
        unsupported_hints=[{
            'id': 'cuda13',
            'expectedDllPrefixes': ['cublas64_13', 'cublaslt64_13', 'cudnn64_9'],
        }],
        device_count_getter=lambda: 1,
        load_dll=lambda dll: (_ for _ in ()).throw(OSError(dll)),
        path_value=str(cuda13_bin),
    )

    assert report['deviceAvailable'] is True
    assert report['runtimeLoadable'] is False
    assert report['missingLibraries'] == ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll']
    assert report['unsupportedDetectedProfiles'] == ['cuda13']
    assert report['installedProfile'] == 'cuda13'
    assert report['statusCode'] == 'unsupportedRuntimeMajor'


def test_cuda_probe_reports_ready_supported_runtime():
    report = build_probe_report(
        profiles=[{
            'id': 'cuda12',
            'requiredDlls': ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll'],
        }],
        supported_profiles=['cuda12'],
        unsupported_hints=[],
        device_count_getter=lambda: 1,
        load_dll=lambda dll: object(),
        path_value='',
    )

    assert report['deviceAvailable'] is True
    assert report['runtimeLoadable'] is True
    assert report['missingLibraries'] == []
    assert report['matchedProfile'] == 'cuda12'
    assert report['installedProfile'] == 'cuda12'
    assert report['statusCode'] == 'ready'


def test_cuda_probe_prefers_ready_supported_runtime_even_with_cuda13_on_path(tmp_path):
    cuda13_bin = tmp_path / 'cuda13-bin'
    cuda13_bin.mkdir()
    (cuda13_bin / 'cublas64_13.dll').write_text('dll')

    report = build_probe_report(
        profiles=[{
            'id': 'cuda12',
            'requiredDlls': ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll'],
        }],
        supported_profiles=['cuda12'],
        unsupported_hints=[{
            'id': 'cuda13',
            'expectedDllPrefixes': ['cublas64_13', 'cublaslt64_13'],
        }],
        device_count_getter=lambda: 1,
        load_dll=lambda dll: object(),
        path_value=str(cuda13_bin),
    )

    assert report['runtimeLoadable'] is True
    assert report['matchedProfile'] == 'cuda12'
    assert report['unsupportedDetectedProfiles'] == ['cuda13']
    assert report['installedProfile'] == 'cuda12'
    assert report['statusCode'] == 'ready'


def test_cuda_probe_module_invokes_nvidia_dll_loader_at_import():
    from backend.transcription import cuda_probe as probe_module

    # The probe must register pip-installed NVIDIA DLL directories before any
    # ctypes.WinDLL load, otherwise installed CUDA 12 runtime wheels are
    # invisible to the probe and the user sees a misleading
    # "unsupportedRuntimeMajor" error.
    assert probe_module.add_python_nvidia_bin_dirs_to_path is (
        nvidia_dll_loader.add_python_nvidia_bin_dirs_to_path
    )
    source = Path(probe_module.__file__).read_text(encoding='utf-8')
    assert 'add_python_nvidia_bin_dirs_to_path()' in source


def test_nvidia_dll_loader_registers_site_package_bin_dirs(monkeypatch, tmp_path):
    site_packages = tmp_path / 'site-packages'
    cublas_bin = site_packages / 'nvidia' / 'cublas' / 'bin'
    cudnn_bin = site_packages / 'nvidia' / 'cudnn' / 'bin'
    cublas_bin.mkdir(parents=True)
    cudnn_bin.mkdir(parents=True)
    registered = []

    monkeypatch.setattr(nvidia_dll_loader.os, 'name', 'nt')
    monkeypatch.setattr(nvidia_dll_loader.site, 'getsitepackages', lambda: [str(site_packages)])
    monkeypatch.setattr(nvidia_dll_loader.site, 'getusersitepackages', lambda: '')
    monkeypatch.setattr(nvidia_dll_loader.sys, 'path', [])
    monkeypatch.setattr(nvidia_dll_loader, '_NVIDIA_DLL_DIRECTORY_HANDLES', [])
    monkeypatch.setattr(nvidia_dll_loader.os, 'add_dll_directory', lambda dll_dir: registered.append(dll_dir) or object(), raising=False)
    monkeypatch.setenv('PATH', 'original')

    nvidia_dll_loader.add_python_nvidia_bin_dirs_to_path()

    assert registered == [str(cublas_bin), str(cudnn_bin)]
    assert os.environ['PATH'].startswith(f'{cublas_bin}{os.pathsep}{cudnn_bin}{os.pathsep}')


def test_cuda_probe_unsupported_profile_search_dedupes_path_entries(tmp_path):
    cuda_bin = tmp_path / 'cuda-bin'
    cuda_bin.mkdir()
    (cuda_bin / 'cublasLt64_13.dll').write_text('dll')
    path_value = f'{cuda_bin}{os.pathsep}{cuda_bin}'

    detected = find_unsupported_runtime_profiles(
        [{'id': 'cuda13', 'expectedDllPrefixes': ['cublaslt64_13']}],
        path_value=path_value,
    )

    assert detected == ['cuda13']


def test_cuda_probe_unsupported_profile_ignores_shared_cudnn_runtime(tmp_path):
    cuda12_bin = tmp_path / 'cuda12-bin'
    cuda12_bin.mkdir()
    (cuda12_bin / 'cudnn64_9.dll').write_text('dll')

    detected = find_unsupported_runtime_profiles(
        [{'id': 'cuda13', 'expectedDllPrefixes': ['cublas64_13', 'cublaslt64_13']}],
        path_value=str(cuda12_bin),
    )

    assert detected == []


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

    monkeypatch.setattr(service, '_get_download_lock_path', lambda: Path('/tmp/test-locks/whisper_mlx_model_small.lock'))
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


def test_faster_whisper_uses_local_files_only_when_cache_exists(monkeypatch, tmp_path):
    cache_dir = tmp_path / 'hf-cache'
    snapshot_dir = cache_dir / 'models--Systran--faster-whisper-small' / 'snapshots' / 'abc123'
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / 'config.json').write_text('{}')
    (snapshot_dir / 'model.bin').write_bytes(b'weights')
    (snapshot_dir / 'tokenizer.json').write_text('{}')
    (snapshot_dir / 'vocabulary.txt').write_text('tokens')
    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_size, **kwargs):
            captured['model_size'] = model_size
            captured.update(kwargs)
            captured['hf_offline'] = __import__('os').environ.get('HF_HUB_OFFLINE')

    service = TranscriberService(model_size='small', device='cpu', compute_type='int8')
    monkeypatch.setenv('HF_HUB_CACHE', str(cache_dir))
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=FakeWhisperModel))

    service._load_model_internal()

    assert captured['model_size'] == 'small'
    assert captured['local_files_only'] is True
    assert captured['download_root'] == str(cache_dir)
    assert captured['hf_offline'] == '1'
    assert __import__('os').environ.get('HF_HUB_OFFLINE') is None


def test_faster_whisper_explicit_cache_root_overrides_diarization_hf_cache(monkeypatch, tmp_path):
    transcription_cache = tmp_path / 'transcription-hf-cache'
    diarization_cache = tmp_path / 'diarization-hf-cache'
    snapshot_dir = transcription_cache / 'models--Systran--faster-whisper-small' / 'snapshots' / 'abc123'
    snapshot_dir.mkdir(parents=True)
    diarization_cache.mkdir()
    (snapshot_dir / 'config.json').write_text('{}')
    (snapshot_dir / 'model.bin').write_bytes(b'weights')
    (snapshot_dir / 'tokenizer.json').write_text('{}')
    (snapshot_dir / 'vocabulary.txt').write_text('tokens')
    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_size, **kwargs):
            captured['model_size'] = model_size
            captured.update(kwargs)

    service = TranscriberService(model_size='small', device='cpu', compute_type='int8')
    monkeypatch.setenv('HF_HUB_CACHE', str(diarization_cache))
    monkeypatch.setenv('AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR', str(transcription_cache))
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=FakeWhisperModel))

    service._load_model_internal()

    assert captured['local_files_only'] is True
    assert captured['download_root'] == str(transcription_cache)


def test_faster_whisper_allows_download_when_cache_snapshot_is_incomplete(monkeypatch, tmp_path):
    cache_dir = tmp_path / 'hf-cache'
    snapshot_dir = cache_dir / 'models--Systran--faster-whisper-small' / 'snapshots' / 'abc123'
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / 'config.json').write_text('{}')
    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_size, **kwargs):
            captured['model_size'] = model_size
            captured.update(kwargs)
            captured['hf_offline'] = __import__('os').environ.get('HF_HUB_OFFLINE')

    service = TranscriberService(model_size='small', device='cpu', compute_type='int8')
    monkeypatch.setenv('HF_HUB_CACHE', str(cache_dir))
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=FakeWhisperModel))

    service._load_model_internal()

    assert captured['local_files_only'] is False
    assert captured['download_root'] == str(cache_dir)
    assert captured['hf_offline'] is None


def test_faster_whisper_cache_dir_requires_exact_folder_name(monkeypatch, tmp_path):
    cache_dir = tmp_path / 'hf-cache'
    decoy_dir = cache_dir / 'models--Systran--faster-whisper-small-extra' / 'snapshots' / 'abc123'
    decoy_dir.mkdir(parents=True)
    (decoy_dir / 'config.json').write_text('{}')
    (decoy_dir / 'model.bin').write_bytes(b'weights')
    (decoy_dir / 'tokenizer.json').write_text('{}')
    (decoy_dir / 'vocabulary.txt').write_text('tokens')
    monkeypatch.setenv('HF_HUB_CACHE', str(cache_dir))

    assert fw_transcriber.has_cached_faster_whisper_model('small') is False


def test_mlx_cache_requires_non_empty_model_files(tmp_path):
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    service.cache_dir = tmp_path / 'cache-root'
    service.model_dir = service.cache_dir / 'mlx_models' / service.model_storage_dir
    service.model_dir.mkdir(parents=True)
    (service.model_dir / 'weights.npz').write_text('')
    (service.model_dir / 'config.json').write_text('{}')

    assert service._required_model_files_cached() is False


def test_faster_whisper_allows_download_when_cache_is_missing(monkeypatch, tmp_path):
    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_size, **kwargs):
            captured['model_size'] = model_size
            captured.update(kwargs)
            captured['hf_offline'] = __import__('os').environ.get('HF_HUB_OFFLINE')

    service = TranscriberService(model_size='small', device='cpu', compute_type='int8')
    monkeypatch.setenv('HF_HUB_CACHE', str(tmp_path / 'missing-cache'))
    monkeypatch.setitem(__import__('sys').modules, 'faster_whisper', types.SimpleNamespace(WhisperModel=FakeWhisperModel))

    service._load_model_internal()

    assert captured['local_files_only'] is False
    assert captured['download_root'] == str(tmp_path / 'missing-cache')
    assert captured['hf_offline'] is None


def test_faster_whisper_signature_probe_fails_closed(monkeypatch):
    def fail_signature(_value):
        raise ValueError('signature unavailable')

    monkeypatch.setattr(fw_transcriber, 'signature', fail_signature)

    assert fw_transcriber.whisper_model_supports_local_files_only(object) is False
    assert fw_transcriber.whisper_model_supports_download_root(object) is False


def test_faster_whisper_does_not_pass_optional_kwargs_when_signature_probe_fails(monkeypatch):
    def fail_signature(_value):
        raise ValueError('signature unavailable')

    captured = {}

    class FakeWhisperModel:
        def __init__(self, model_size, device, compute_type):
            captured['model_size'] = model_size
            captured['device'] = device
            captured['compute_type'] = compute_type

    service = TranscriberService(model_size='small', device='cpu', compute_type='int8')
    monkeypatch.setattr(fw_transcriber, 'signature', fail_signature)

    service._create_whisper_model(FakeWhisperModel, device='cpu', compute_type='int8', local_files_only=True)

    assert captured == {
        'model_size': 'small',
        'device': 'cpu',
        'compute_type': 'int8',
    }


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


def test_mlx_transcriber_skips_hf_download_when_model_files_are_cached(tmp_path, monkeypatch):
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    service.cache_dir = tmp_path / 'cache-root'
    service.model_dir = service.cache_dir / 'mlx_models' / service.model_storage_dir
    service.model_dir.mkdir(parents=True)
    (service.model_dir / 'weights.npz').write_text('weights')
    (service.model_dir / 'config.json').write_text('{}')

    def fail_download(*_args, **_kwargs):
        raise AssertionError('hf_hub_download should not run for cached MLX model files')

    monkeypatch.setitem(__import__('sys').modules, 'huggingface_hub', types.SimpleNamespace(hf_hub_download=fail_download))

    service._download_model_files()


def test_mlx_transcriber_does_not_import_hf_hub_when_model_files_are_cached(tmp_path, monkeypatch):
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    service.cache_dir = tmp_path / 'cache-root'
    service.model_dir = service.cache_dir / 'mlx_models' / service.model_storage_dir
    service.model_dir.mkdir(parents=True)
    (service.model_dir / 'weights.npz').write_text('weights')
    (service.model_dir / 'config.json').write_text('{}')

    original_import = builtins.__import__

    def fail_hf_import(name, *args, **kwargs):
        if name == 'huggingface_hub':
            raise AssertionError('huggingface_hub should not be imported for cached MLX model files')
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', fail_hf_import)

    service._download_model_files()


def test_mlx_transcriber_get_model_info_reports_cache_and_repo(tmp_path, monkeypatch):
    service = cast(Any, MLXWhisperTranscriber(model_size='large', language='en'))
    monkeypatch.setattr(service, '_get_cache_dir', lambda: tmp_path / 'cache-root')
    service.cache_dir = tmp_path / 'cache-root'
    service.model_dir = service.cache_dir / 'mlx_models' / service.model_storage_dir

    info = service.get_model_info()

    assert info['backend'] == 'lightning-whisper-mlx'
    assert info['model_key'] == 'large-v3'
    assert info['model_repo'] == 'mlx-community/whisper-large-v3-mlx'
    assert info['cache_dir'] == str(tmp_path / 'cache-root')
    assert info['model_dir'] == str(tmp_path / 'cache-root' / 'mlx_models' / 'whisper-large-v3-mlx')


def test_mlx_transcriber_uses_standard_models_for_english():
    small = MLXWhisperTranscriber(model_size='small', language='en')
    medium = MLXWhisperTranscriber(model_size='medium', language='en')
    large = MLXWhisperTranscriber(model_size='large', language='en')

    assert small.get_model_info()['model_key'] == 'small'
    assert small.get_model_info()['model_repo'] == 'mlx-community/whisper-small-mlx'
    assert Path(small.get_model_info()['model_dir']).parts[-2:] == ('mlx_models', 'whisper-small-mlx')
    assert medium.get_model_info()['model_key'] == 'medium'
    assert medium.get_model_info()['model_repo'] == 'mlx-community/whisper-medium-mlx'
    assert Path(medium.get_model_info()['model_dir']).parts[-2:] == ('mlx_models', 'whisper-medium-mlx')
    assert large.get_model_info()['model_key'] == 'large-v3'
    assert large.get_model_info()['model_repo'] == 'mlx-community/whisper-large-v3-mlx'
    assert Path(large.get_model_info()['model_dir']).parts[-2:] == ('mlx_models', 'whisper-large-v3-mlx')


def test_mlx_transcriber_loads_multilingual_models_for_non_english_languages():
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='fa'))

    info = service.get_model_info()

    assert info['model_key'] == 'small'
    assert info['model_repo'] == 'mlx-community/whisper-small-mlx'
    assert Path(info['model_dir']).parts[-2:] == ('mlx_models', 'whisper-small-mlx')


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


def test_mlx_transcriber_normalizes_list_shaped_segments(tmp_path):
    audio_path = tmp_path / 'sample.wav'
    import wave

    with wave.open(str(audio_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b'\x00\x00' * 16000)

    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    service.model_ready = True

    def fake_transcribe_audio(_audio_path_value):
        return {'text': 'hello world', 'segments': [[0, 1.2, ' hello'], [1.2, 2.4, 'world ']]}

    service._transcribe_audio = fake_transcribe_audio

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['text'] == 'hello world'
    assert result['segments'] == [{'start': 0.0, 'end': 2.4, 'text': 'hello world'}]


def test_mlx_transcriber_prefers_file_duration_over_inflated_segment_end(tmp_path):
    audio_path = tmp_path / 'sample.wav'
    import wave

    with wave.open(str(audio_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b'\x00\x00' * 16000)

    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    service.model_ready = True

    def fake_transcribe_audio(_audio_path_value):
        return {'text': 'hello world', 'segments': [{'start': 0, 'end': 2048, 'text': 'hello world'}]}

    service._transcribe_audio = fake_transcribe_audio

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['duration'] == pytest.approx(1.0, rel=1e-3)
    assert result['segments'] == [{'start': 0.0, 'end': 1.0, 'text': 'hello world'}]


def test_mlx_transcriber_repairs_lightning_mlx_frame_timestamps(tmp_path):
    audio_path = tmp_path / 'sample.wav'
    import wave

    with wave.open(str(audio_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b'\x00\x00' * 16000 * 150)

    service = cast(Any, MLXWhisperTranscriber(model_size='base', language='en'))
    service.model_ready = True

    def fake_transcribe_audio(_audio_path_value):
        return {
            'text': 'one two',
            'segments': [[0, 3000, 'one'], [3000, 6000, 'two'], [6000, 15000, '']],
        }

    service._transcribe_audio = fake_transcribe_audio

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['duration'] == pytest.approx(150.0, rel=1e-3)
    assert result['segments'] == [
        {'start': 0.0, 'end': 30.0, 'text': 'one'},
        {'start': 30.0, 'end': 60.0, 'text': 'two'},
    ]


def test_mlx_transcriber_repairs_lightning_mlx_millisecond_timestamps(tmp_path):
    audio_path = tmp_path / 'sample.wav'
    import wave

    with wave.open(str(audio_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b'\x00\x00' * 16000 * 12)

    service = cast(Any, MLXWhisperTranscriber(model_size='base', language='en'))
    service.model_ready = True

    def fake_transcribe_audio(_audio_path_value):
        return {'text': 'hello', 'segments': [[0, 12000, 'hello']]}

    service._transcribe_audio = fake_transcribe_audio

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['duration'] == pytest.approx(12.0, rel=1e-3)
    assert result['segments'] == [{'start': 0.0, 'end': 12.0, 'text': 'hello'}]


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
    assert Path(captured['model_dir']).parts[-2:] == ('mlx_models', 'whisper-small-mlx')


def test_mlx_transcriber_uses_safe_single_chunk_batch_size(monkeypatch):
    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))
    captured = {}

    def fake_transcribe_audio(audio_path, **kwargs):
        captured['audio_path'] = audio_path
        captured.update(kwargs)
        return {'text': 'full transcript', 'segments': []}

    monkeypatch.setitem(
        __import__('sys').modules,
        'lightning_whisper_mlx.transcribe',
        types.SimpleNamespace(transcribe_audio=fake_transcribe_audio),
    )

    result = service._transcribe_audio('/tmp/audio.opus')

    assert result['text'] == 'full transcript'
    assert captured['audio_path'] == '/tmp/audio.opus'
    assert captured['path_or_hf_repo'] == str(service.model_dir)
    assert captured['language'] == 'en'
    assert captured['batch_size'] == 1


def test_mlx_transcriber_allows_bounded_batch_size_override(monkeypatch):
    monkeypatch.setenv('AVANEVIS_MLX_WHISPER_BATCH_SIZE', '64')

    service = cast(Any, MLXWhisperTranscriber(model_size='small', language='en'))

    assert service.batch_size == 16


def test_get_model_info_for_faster_whisper_includes_runtime_state():
    service = cast(Any, TranscriberService(model_size='base', language='en', device='cpu', compute_type='int8'))

    info = service.get_model_info()

    assert info['backend'] == 'faster-whisper'
    assert info['model_size'] == 'base'
    assert info['device'] == 'cpu'


def test_transcribe_file_retries_on_retryable_cuda_runtime_error(monkeypatch, tmp_path):
    audio_path = tmp_path / 'sample.opus'
    audio_path.write_bytes(b'audio')
    service = TranscriberService(model_size='small', language='en', device='auto')
    calls = {'attempt': 0}

    class Segment:
        def __init__(self, start, end, text):
            self.start = start
            self.end = end
            self.text = text

    class Info:
        language = 'en'
        duration = 3.0

    class Model:
        def transcribe(self, *_args, **_kwargs):
            calls['attempt'] += 1
            if calls['attempt'] == 1:
                raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded')
            return iter([Segment(0.0, 3.0, 'hello')]), Info()

    service.model = Model()
    monkeypatch.setattr(service, 'load_model', lambda: setattr(service, 'model', Model()))

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['text'] == 'hello'
    assert calls['attempt'] == 2
    assert service.device == 'cpu'


def test_transcribe_file_retries_on_cuda13_runtime_error(monkeypatch, tmp_path):
    audio_path = tmp_path / 'sample.opus'
    audio_path.write_bytes(b'audio')
    service = TranscriberService(model_size='small', language='en', device='auto')
    calls = {'attempt': 0}

    class Segment:
        def __init__(self, start, end, text):
            self.start = start
            self.end = end
            self.text = text

    class Info:
        language = 'en'
        duration = 2.0

    class Model:
        def transcribe(self, *_args, **_kwargs):
            calls['attempt'] += 1
            if calls['attempt'] == 1:
                raise RuntimeError('Library cublas64_13.dll is not found or cannot be loaded')
            return iter([Segment(0.0, 2.0, 'ok')]), Info()

    service.model = Model()
    monkeypatch.setattr(service, 'load_model', lambda: setattr(service, 'model', Model()))

    result = service.transcribe_file(str(audio_path), save_markdown=False)

    assert result['text'] == 'ok'
    assert calls['attempt'] == 2
    assert service.device == 'cpu'


def test_transcribe_file_does_not_retry_non_cuda_errors(tmp_path):
    audio_path = tmp_path / 'sample.opus'
    audio_path.write_bytes(b'audio')
    service = TranscriberService(model_size='small', language='en', device='auto')

    class Model:
        def transcribe(self, *_args, **_kwargs):
            raise RuntimeError('invalid model cache')

    service.model = Model()

    with pytest.raises(RuntimeError, match='invalid model cache'):
        service.transcribe_file(str(audio_path), save_markdown=False)


def test_transcribe_file_does_not_retry_generic_load_errors(tmp_path):
    audio_path = tmp_path / 'sample.opus'
    audio_path.write_bytes(b'audio')
    service = TranscriberService(model_size='small', language='en', device='auto')
    calls = {'attempt': 0}

    class Model:
        def transcribe(self, *_args, **_kwargs):
            calls['attempt'] += 1
            raise RuntimeError('Library foo.dll cannot be loaded')

    service.model = Model()

    with pytest.raises(RuntimeError, match='foo\\.dll cannot be loaded'):
        service.transcribe_file(str(audio_path), save_markdown=False)

    assert calls['attempt'] == 1
