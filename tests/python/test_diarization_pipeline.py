import json
import os
import sys
import types
import wave
from pathlib import Path

import pytest

from backend.diarization import diarization_pipeline as pipeline


def test_normalize_speaker_count_accepts_auto_and_valid_counts():
    assert pipeline.normalize_speaker_count('auto') is None
    assert pipeline.normalize_speaker_count('') is None
    assert pipeline.normalize_speaker_count('3') == 3

    with pytest.raises(ValueError):
        pipeline.normalize_speaker_count('11')


def test_normalize_required_device_accepts_only_accelerators():
    assert pipeline.normalize_required_device(None) is None
    assert pipeline.normalize_required_device('auto') is None
    assert pipeline.normalize_required_device('CUDA') == 'cuda'
    assert pipeline.normalize_required_device('mps') == 'mps'

    with pytest.raises(ValueError, match='CPU fallback is disabled'):
        pipeline.normalize_required_device('cpu')


def install_fake_torch(monkeypatch, *, cuda_available=False, mps_built=True, mps_available=True):
    class FakeMpsBackend:
        @staticmethod
        def is_built():
            return mps_built

        @staticmethod
        def is_available():
            return mps_available

    fake_torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: cuda_available),
        backends=types.SimpleNamespace(mps=FakeMpsBackend()),
        device=lambda name: f'device:{name}',
        empty=lambda _size, device=None: {'device': device},
    )
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)
    return fake_torch


class FakeTensor:
    def __init__(self, *, cpu_error=None):
        self.cpu_error = cpu_error

    def cpu(self):
        if self.cpu_error:
            raise self.cpu_error
        return self


def test_move_pipeline_to_required_mps_device(monkeypatch):
    install_fake_torch(monkeypatch, cuda_available=False, mps_built=True, mps_available=True)
    calls = []
    fake_pipeline = types.SimpleNamespace(to=lambda device: calls.append(device))

    device = pipeline.move_pipeline_to_best_device(fake_pipeline, required_device='mps')

    assert device == 'mps'
    assert calls == ['device:mps']


def test_required_mps_refuses_cpu_fallback_when_unavailable(monkeypatch):
    install_fake_torch(monkeypatch, cuda_available=False, mps_built=True, mps_available=False)
    fake_pipeline = types.SimpleNamespace(to=lambda _device: None)

    with pytest.raises(RuntimeError, match='MPS acceleration.*CPU fallback is disabled'):
        pipeline.move_pipeline_to_best_device(fake_pipeline, required_device='mps')


def test_required_cuda_behavior_remains_accelerator_only(monkeypatch):
    install_fake_torch(monkeypatch, cuda_available=True, mps_built=False, mps_available=False)
    calls = []
    fake_pipeline = types.SimpleNamespace(to=lambda device: calls.append(device))

    device = pipeline.move_pipeline_to_best_device(fake_pipeline, required_device='cuda')

    assert device == 'cuda'
    assert calls == ['device:cuda']


def test_required_cuda_refuses_cpu_fallback_when_unavailable(monkeypatch):
    install_fake_torch(monkeypatch, cuda_available=False, mps_built=False, mps_available=False)
    fake_pipeline = types.SimpleNamespace(to=lambda _device: None)

    with pytest.raises(RuntimeError, match='CUDA acceleration.*CPU fallback is disabled'):
        pipeline.move_pipeline_to_best_device(fake_pipeline, required_device='cuda')


def test_required_mps_distinguishes_unbuilt_torch(monkeypatch):
    install_fake_torch(monkeypatch, cuda_available=False, mps_built=False, mps_available=True)

    with pytest.raises(RuntimeError, match='PyTorch build with Metal/MPS support.*Reinstall'):
        pipeline.assert_required_device_available('mps')


def test_required_device_probe_wraps_sync_failures(monkeypatch):
    fake_torch = install_fake_torch(monkeypatch, cuda_available=False, mps_built=True, mps_available=True)
    fake_torch.empty = lambda _size, device=None: FakeTensor(cpu_error=RuntimeError('lazy mps fault'))

    with pytest.raises(RuntimeError, match='could not initialize MPS acceleration.*CPU fallback is disabled'):
        pipeline.assert_required_device_available('mps')


def test_required_device_probe_rejects_cpu_directly(monkeypatch):
    install_fake_torch(monkeypatch, cuda_available=True, mps_built=True, mps_available=True)

    with pytest.raises(ValueError, match='CPU fallback is disabled'):
        pipeline.assert_required_device_available('cpu')


def test_build_audio_conversion_command_targets_16khz_mono(tmp_path):
    source = tmp_path / 'meeting.opus'
    target = tmp_path / 'meeting.wav'

    assert pipeline.build_audio_conversion_command('ffmpeg', source, target) == [
        'ffmpeg',
        '-y',
        '-i',
        str(source),
        '-ac',
        '1',
        '-ar',
        '16000',
        str(target),
    ]


def test_load_prepared_audio_for_pipeline_reads_pcm_wav(monkeypatch, tmp_path):
    audio_path = tmp_path / 'meeting.diarization.16k.wav'
    write_wav(audio_path, seconds=1, sample_rate=16000)

    class FakeTensor:
        def __init__(self, length: int):
            self.shape = (length,)
            self.dtype = types.SimpleNamespace(name='float32')

        def to(self, _dtype):
            return self

        def view(self, *_shape):
            return self

        def mean(self, _dim):
            return self

        def unsqueeze(self, _dim):
            self.shape = (1, self.shape[0])
            return self

        def __truediv__(self, _value):
            return self

        def __sub__(self, _value):
            return self

    fake_torch = types.SimpleNamespace(
        frombuffer=lambda raw, dtype: FakeTensor(len(raw) // 2),
        float32=object(),
        int16=object(),
        int32=object(),
        uint8=object(),
    )
    monkeypatch.setitem(sys.modules, 'torch', fake_torch)

    loaded = pipeline.load_prepared_audio_for_pipeline(audio_path)

    assert loaded['sample_rate'] == 16000
    assert loaded['waveform'].shape == (1, 16000)
    assert loaded['waveform'].dtype.name == 'float32'


def write_wav(path: Path, *, seconds: int, sample_rate: int = 16000) -> None:
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b'\x00\x00' * sample_rate * seconds)


def test_should_load_audio_in_memory_respects_duration_limit(tmp_path):
    short_audio = tmp_path / 'short.wav'
    long_audio = tmp_path / 'long.wav'
    write_wav(short_audio, seconds=2)
    write_wav(long_audio, seconds=4)

    assert pipeline.should_load_audio_in_memory(short_audio, max_seconds=2) is True
    assert pipeline.should_load_audio_in_memory(long_audio, max_seconds=2) is False


def test_run_pyannote_diarization_passes_audio_from_memory(monkeypatch, tmp_path):
    audio_path = tmp_path / 'meeting.wav'
    audio_path.write_text('audio', encoding='utf-8')
    calls = []

    class FakePipeline:
        def __call__(self, audio_input, **kwargs):
            calls.append((audio_input, kwargs))
            return {'exclusive_speaker_diarization': [{'start': 0, 'end': 1, 'speaker': 'SPEAKER_00'}]}

    monkeypatch.setattr(pipeline, 'assert_required_device_available', lambda _device: object())
    monkeypatch.setattr(pipeline, 'load_pyannote_pipeline', lambda _model_ref, _token, **_kwargs: FakePipeline())
    monkeypatch.setattr(pipeline, 'move_pipeline_to_best_device', lambda _pipeline, required_device=None: required_device or 'cuda')
    monkeypatch.setattr(pipeline, 'load_prepared_audio_for_pipeline', lambda path: {'waveform': str(path), 'sample_rate': 16000})

    speaker_segments, annotation_source, device = pipeline.run_pyannote_diarization(
        audio_path,
        model_ref='pyannote/test-model',
        hf_token='hf_validtoken123',
        speaker_count=2,
        required_device='cuda',
    )

    assert speaker_segments == [{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}]
    assert annotation_source == 'exclusive_speaker_diarization'
    assert device == 'cuda'
    assert calls == [({'waveform': str(audio_path), 'sample_rate': 16000}, {'num_speakers': 2})]


def test_run_pyannote_diarization_always_passes_in_memory_audio(monkeypatch, tmp_path):
    audio_path = tmp_path / 'meeting.wav'
    audio_path.write_text('audio', encoding='utf-8')
    calls = []

    class FakePipeline:
        def __call__(self, audio_input, **kwargs):
            calls.append((audio_input, kwargs))
            return {'exclusive_speaker_diarization': [{'start': 0, 'end': 1, 'speaker': 'SPEAKER_00'}]}

    monkeypatch.setattr(pipeline, 'assert_required_device_available', lambda _device: object())
    monkeypatch.setattr(pipeline, 'load_pyannote_pipeline', lambda _model_ref, _token, **_kwargs: FakePipeline())
    monkeypatch.setattr(pipeline, 'move_pipeline_to_best_device', lambda _pipeline, required_device=None: required_device or 'cuda')
    monkeypatch.setattr(pipeline, 'should_load_audio_in_memory', lambda _path: False)
    monkeypatch.setattr(pipeline, 'load_prepared_audio_for_pipeline', lambda path: {'waveform': f'loaded:{path}', 'sample_rate': 16000})

    pipeline.run_pyannote_diarization(
        audio_path,
        model_ref='pyannote/test-model',
        hf_token='hf_validtoken123',
        required_device='cuda',
    )

    assert calls == [({'waveform': f'loaded:{audio_path}', 'sample_rate': 16000}, {})]


def test_run_pyannote_diarization_loads_cached_model_without_token(monkeypatch, tmp_path):
    audio_path = tmp_path / 'meeting.wav'
    audio_path.write_text('audio', encoding='utf-8')
    load_calls = []

    class FakePipeline:
        def __call__(self, audio_input, **kwargs):
            return {'exclusive_speaker_diarization': [{'start': 0, 'end': 1, 'speaker': 'SPEAKER_00'}]}

    def fake_load(model_ref, hf_token='', **kwargs):
        load_calls.append({'model_ref': model_ref, 'hf_token': hf_token, **kwargs})
        return FakePipeline()

    monkeypatch.setattr(pipeline, 'assert_required_device_available', lambda _device: object())
    monkeypatch.setattr(pipeline, 'load_pyannote_pipeline', fake_load)
    monkeypatch.setattr(pipeline, 'move_pipeline_to_best_device', lambda _pipeline, required_device=None: required_device or 'mps')
    monkeypatch.setattr(pipeline, 'load_prepared_audio_for_pipeline', lambda _path: {'waveform': 'waveform', 'sample_rate': 16000})

    speaker_segments, _annotation_source, device = pipeline.run_pyannote_diarization(
        audio_path,
        model_ref='pyannote/test-model',
        required_device='mps',
    )

    assert speaker_segments == [{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}]
    assert device == 'mps'
    assert load_calls == [{'model_ref': 'pyannote/test-model', 'hf_token': '', 'local_files_only': True}]


def test_load_transcript_segments_accepts_list_or_object(tmp_path):
    list_path = tmp_path / 'segments-list.json'
    object_path = tmp_path / 'segments-object.json'
    list_path.write_text(json.dumps([{'start': 0, 'end': 1, 'text': 'hello'}]), encoding='utf-8')
    object_path.write_text(json.dumps({'segments': [{'start': 1, 'end': 2, 'text': 'there'}]}), encoding='utf-8')

    assert pipeline.load_transcript_segments(str(list_path))[0]['text'] == 'hello'
    assert pipeline.load_transcript_segments(str(object_path))[0]['text'] == 'there'


def test_select_annotation_prefers_exclusive_output():
    result = {
        'speaker_diarization': [{'start': 0, 'end': 1, 'speaker': 'SPEAKER_00'}],
        'exclusive_speaker_diarization': [{'start': 1, 'end': 2, 'speaker': 'SPEAKER_01'}],
    }

    annotation, source = pipeline.select_annotation(result)

    assert source == 'exclusive_speaker_diarization'
    assert annotation == result['exclusive_speaker_diarization']


def test_annotation_to_speaker_segments_accepts_list_and_filters_invalid_items():
    assert pipeline.annotation_to_speaker_segments([
        {'start': 0, 'end': 2, 'speaker': 'SPEAKER_00'},
        {'start': 2, 'end': 2, 'speaker': 'SPEAKER_01'},
        {'start': 3, 'end': 4, 'speaker': ''},
    ]) == [{'start': 0.0, 'end': 2.0, 'speaker': 'SPEAKER_00'}]


def test_build_diarization_result_merges_speakers_without_transcript_leakage_in_progress():
    result = pipeline.build_diarization_result(
        audio_path='meeting.opus',
        transcript_segments=[{'start': 0, 'end': 2, 'text': 'hello'}],
        speaker_segments=[{'start': 0, 'end': 2, 'speaker': 'SPEAKER_00'}],
        model_ref='pyannote/speaker-diarization-community-1',
        annotation_source='exclusive_speaker_diarization',
        device='cuda',
    )

    assert result['status'] == 'completed'
    assert result['speakerCount'] == 1
    assert result['segments'][0]['speaker'] == 'Speaker 1'
    assert result['speakerSegments'][0]['speaker'] == 'SPEAKER_00'


def test_build_diarization_result_splits_coarse_transcript_segments_by_speaker_turns():
    result = pipeline.build_diarization_result(
        audio_path='meeting.opus',
        transcript_segments=[{
            'start': 0,
            'end': 30,
            'text': 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
        }],
        speaker_segments=[
            {'start': 10, 'end': 20, 'speaker': 'SPEAKER_01'},
            {'start': 20, 'end': 30, 'speaker': 'SPEAKER_00'},
            {'start': 0, 'end': 10, 'speaker': 'SPEAKER_00'},
        ],
        model_ref='pyannote/speaker-diarization-community-1',
        annotation_source='exclusive_speaker_diarization',
        device='mps',
    )

    assert [segment['speaker'] for segment in result['segments']] == ['Speaker 1', 'Speaker 2', 'Speaker 1']
    assert [(segment['start'], segment['end']) for segment in result['segments']] == [(0, 10), (10, 20), (20, 30)]
    assert 'alpha' in result['segments'][0]['text']
    assert 'lima' in result['segments'][-1]['text']


def test_build_diarization_result_splits_short_text_across_longest_speaker_blocks():
    result = pipeline.build_diarization_result(
        audio_path='meeting.opus',
        transcript_segments=[{'start': 0, 'end': 30, 'text': 'yes'}],
        speaker_segments=[
            {'start': 0, 'end': 2, 'speaker': 'SPEAKER_00'},
            {'start': 2, 'end': 20, 'speaker': 'SPEAKER_01'},
            {'start': 20, 'end': 30, 'speaker': 'SPEAKER_00'},
        ],
        model_ref='pyannote/speaker-diarization-community-1',
        annotation_source='exclusive_speaker_diarization',
        device='mps',
    )

    assert result['segments'] == [{
        'start': 2,
        'end': 20,
        'text': 'yes',
        'speaker': 'Speaker 2',
    }]


def test_save_diarization_result_writes_json_sidecar(tmp_path):
    output_path = tmp_path / 'meeting.speakers.json'
    pipeline.save_diarization_result(str(output_path), {'status': 'completed', 'segments': []})

    assert json.loads(output_path.read_text(encoding='utf-8'))['status'] == 'completed'
    assert not list(tmp_path.glob('*.tmp'))


def test_validate_pyannote_setup_requires_token(monkeypatch):
    monkeypatch.delenv('HF_TOKEN', raising=False)
    monkeypatch.delenv('HUGGINGFACE_HUB_TOKEN', raising=False)

    with pytest.raises(ValueError, match='token is required'):
        pipeline.validate_pyannote_setup()


def test_read_hf_token_from_stdin(monkeypatch):
    monkeypatch.setattr(pipeline.sys.stdin, 'readline', lambda: 'hf_stdin_token_value\n')
    assert pipeline._read_hf_token_from_stdin() == 'hf_stdin_token_value'


def test_validate_pyannote_setup_loads_model_and_moves_device(monkeypatch):
    calls = {}

    def fake_load(model_ref, hf_token):
        calls['model_ref'] = model_ref
        calls['hf_token'] = hf_token
        return object()

    monkeypatch.setenv('HF_TOKEN', 'hf_validtoken123')
    monkeypatch.setattr(pipeline, 'load_pyannote_pipeline', fake_load)
    monkeypatch.setattr(pipeline, 'move_pipeline_to_best_device', lambda _pipeline, required_device=None: 'cuda')

    result = pipeline.validate_pyannote_setup(model_ref='pyannote/test-model')

    assert result == {
        'status': 'ready',
        'model': 'pyannote/test-model',
        'device': 'cuda',
    }
    assert calls == {'model_ref': 'pyannote/test-model', 'hf_token': 'hf_validtoken123'}


def test_validate_pyannote_setup_checks_required_mps_before_ready(monkeypatch):
    calls = []

    monkeypatch.setenv('HF_TOKEN', 'hf_validtoken123')
    monkeypatch.setattr(pipeline, 'assert_required_device_available', lambda device: calls.append(f'check:{device}') or f'device:{device}')
    monkeypatch.setattr(pipeline, 'load_pyannote_pipeline', lambda _model_ref, _hf_token: object())
    monkeypatch.setattr(pipeline, 'move_pipeline_to_best_device', lambda _pipeline, required_device=None: calls.append(f'move:{required_device}') or required_device)

    result = pipeline.validate_pyannote_setup(model_ref='pyannote/test-model', required_device='mps')

    assert result['device'] == 'mps'
    assert calls == ['check:mps', 'move:mps']


def test_pyannote_torch_load_compat_scopes_weights_only_override(monkeypatch):
    monkeypatch.delenv('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD', raising=False)

    with pipeline.pyannote_torch_load_compat():
        assert os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] == '1'

    assert 'TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD' not in os.environ


def test_pyannote_torch_load_compat_restores_existing_override(monkeypatch):
    monkeypatch.setenv('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD', '0')

    with pipeline.pyannote_torch_load_compat():
        assert os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] == '1'

    assert os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] == '0'


def test_hugging_face_offline_mode_restores_environment(monkeypatch):
    monkeypatch.delenv('HF_HUB_OFFLINE', raising=False)
    monkeypatch.setenv('TRANSFORMERS_OFFLINE', '0')

    with pipeline.hugging_face_offline_mode(True):
        assert os.environ['HF_HUB_OFFLINE'] == '1'
        assert os.environ['TRANSFORMERS_OFFLINE'] == '1'

    assert 'HF_HUB_OFFLINE' not in os.environ
    assert os.environ['TRANSFORMERS_OFFLINE'] == '0'


def test_load_pyannote_pipeline_uses_scoped_torch_load_compat(monkeypatch):
    calls = []

    class FakePipeline:
        @staticmethod
        def from_pretrained(model_ref, token=None, use_auth_token=None, local_files_only=None):
            calls.append({
                'model_ref': model_ref,
                'token': token,
                'use_auth_token': use_auth_token,
                'local_files_only': local_files_only,
                'override': os.environ.get('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'),
                'offline': os.environ.get('HF_HUB_OFFLINE'),
            })
            return {'loaded': model_ref}

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)
    monkeypatch.delenv('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD', raising=False)

    loaded = pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123')

    assert loaded == {'loaded': 'pyannote/test-model'}
    assert calls == [{
        'model_ref': 'pyannote/test-model',
        'token': 'hf_validtoken123',
        'use_auth_token': None,
        'local_files_only': False,
        'override': '1',
        'offline': None,
    }]
    assert 'TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD' not in os.environ


def test_load_pyannote_pipeline_omits_unsupported_local_files_only(monkeypatch):
    calls = []

    class FakePipeline:
        @staticmethod
        def from_pretrained(model_ref, token=None):
            calls.append({
                'model_ref': model_ref,
                'token': token,
                'offline': os.environ.get('HF_HUB_OFFLINE'),
            })
            return {'loaded': model_ref}

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    loaded = pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123', local_files_only=True)

    assert loaded == {'loaded': 'pyannote/test-model'}
    assert calls == [{
        'model_ref': 'pyannote/test-model',
        'token': 'hf_validtoken123',
        'offline': '1',
    }]
    assert 'HF_HUB_OFFLINE' not in os.environ


def test_load_pyannote_pipeline_supports_legacy_auth_token_signature(monkeypatch):
    calls = []

    class FakePipeline:
        @staticmethod
        def from_pretrained(model_ref, use_auth_token=None):
            calls.append({
                'model_ref': model_ref,
                'use_auth_token': use_auth_token,
            })
            return {'loaded': model_ref}

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    loaded = pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123')

    assert loaded == {'loaded': 'pyannote/test-model'}
    assert calls == [{
        'model_ref': 'pyannote/test-model',
        'use_auth_token': 'hf_validtoken123',
    }]


def test_load_pyannote_pipeline_wraps_legacy_auth_token_offline_rejection(monkeypatch):
    class FakePipeline:
        @staticmethod
        def from_pretrained(model_ref, use_auth_token=None):
            return {'loaded': model_ref, 'token': use_auth_token}

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    with pytest.raises(RuntimeError, match='model cache is missing or incomplete') as exc_info:
        pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123', local_files_only=True)

    assert isinstance(exc_info.value.__cause__, RuntimeError)
    assert 'too old to enforce offline cached execution' in str(exc_info.value.__cause__)
    assert 'HF_HUB_OFFLINE' not in os.environ


def test_load_pyannote_pipeline_supports_offline_cached_execution(monkeypatch):
    calls = []

    class FakePipeline:
        @staticmethod
        def from_pretrained(model_ref, token=None, use_auth_token=None, local_files_only=None):
            calls.append({
                'model_ref': model_ref,
                'token': token,
                'local_files_only': local_files_only,
                'offline': os.environ.get('HF_HUB_OFFLINE'),
            })
            return {'loaded': model_ref}

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)
    monkeypatch.delenv('HF_HUB_OFFLINE', raising=False)

    loaded = pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123', local_files_only=True)

    assert loaded == {'loaded': 'pyannote/test-model'}
    assert calls == [{
        'model_ref': 'pyannote/test-model',
        'token': 'hf_validtoken123',
        'local_files_only': True,
        'offline': '1',
    }]
    assert 'HF_HUB_OFFLINE' not in os.environ


def test_load_pyannote_pipeline_omits_token_for_offline_cached_execution(monkeypatch):
    calls = []

    class FakePipeline:
        @staticmethod
        def from_pretrained(model_ref, token=None, local_files_only=None):
            calls.append({
                'model_ref': model_ref,
                'token': token,
                'local_files_only': local_files_only,
                'offline': os.environ.get('HF_HUB_OFFLINE'),
            })
            return {'loaded': model_ref}

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)
    monkeypatch.delenv('HF_HUB_OFFLINE', raising=False)

    loaded = pipeline.load_pyannote_pipeline('pyannote/test-model', local_files_only=True)

    assert loaded == {'loaded': 'pyannote/test-model'}
    assert calls == [{
        'model_ref': 'pyannote/test-model',
        'token': False,
        'local_files_only': True,
        'offline': '1',
    }]
    assert 'HF_HUB_OFFLINE' not in os.environ


def test_load_pyannote_pipeline_reports_auth_probe_failure_without_reinstall_prompt(monkeypatch):
    class FakePipeline:
        @staticmethod
        def from_pretrained(*_args, **_kwargs):
            raise PermissionError('[Errno 13] Permission denied: \'.\'')

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    with pytest.raises(RuntimeError, match='auth settings') as exc_info:
        pipeline.load_pyannote_pipeline('pyannote/test-model', local_files_only=True)

    message = str(exc_info.value)
    assert 'Existing speaker setup was not removed' in message
    assert 'Re-run speaker identification setup' not in message
    assert '\n' not in message


def test_load_pyannote_pipeline_offline_error_message_is_single_line(monkeypatch):
    class FakePipeline:
        @staticmethod
        def from_pretrained(*_args, **_kwargs):
            raise OSError('not found in cache\nGatedRepoError: access required\nhf_secret_token_value')

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    with pytest.raises(RuntimeError, match='model cache is missing or incomplete') as exc_info:
        pipeline.load_pyannote_pipeline('pyannote/test-model', local_files_only=True)

    message = str(exc_info.value)
    assert '\n' not in message
    assert 'hf_secret_token_value' not in message
    assert '[redacted-token]' in message
    assert 'Re-run speaker identification setup' in message


def test_load_pyannote_pipeline_reports_missing_offline_cache(monkeypatch):
    class FakePipeline:
        @staticmethod
        def from_pretrained(*_args, **_kwargs):
            raise OSError('not found in cache')

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    with pytest.raises(RuntimeError, match='model cache is missing or incomplete'):
        pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123', local_files_only=True)


def test_load_pyannote_pipeline_wraps_non_oserror_offline_failures(monkeypatch):
    class FakeLocalEntryNotFoundError(Exception):
        pass

    class FakePipeline:
        @staticmethod
        def from_pretrained(*_args, **_kwargs):
            raise FakeLocalEntryNotFoundError('missing cached snapshot')

    fake_pyannote_audio = types.SimpleNamespace(Pipeline=FakePipeline)
    monkeypatch.setitem(sys.modules, 'pyannote', types.SimpleNamespace(audio=fake_pyannote_audio))
    monkeypatch.setitem(sys.modules, 'pyannote.audio', fake_pyannote_audio)

    with pytest.raises(RuntimeError, match='model cache is missing or incomplete'):
        pipeline.load_pyannote_pipeline('pyannote/test-model', 'hf_validtoken123', local_files_only=True)


def test_emit_progress_redacts_token_values(capsys):
    pipeline.emit_progress('loading model', 'Using hf_secret_token Authorization: token ghp_secret X-Api-Key: key123 api_key=third for setup', percent=120)
    captured = capsys.readouterr()
    event = json.loads(captured.err)

    assert event == {
        'type': 'progress',
        'feature': 'diarization',
        'phase': 'loading-model',
        'message': 'Using [redacted-token] Authorization: token [redacted-token] X-Api-Key: [redacted-token] api_key=[redacted-token] for setup',
        'percent': 100.0,
    }


def test_pyannote_metrics_are_disabled_for_imported_module():
    assert os.environ['PYANNOTE_METRICS_ENABLED'] == '0'
