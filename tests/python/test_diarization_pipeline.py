import json
import os
import sys
import types
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


def test_emit_progress_redacts_token_values(capsys):
    pipeline.emit_progress('loading model', 'Using hf_secret_token for setup', percent=120)
    captured = capsys.readouterr()
    event = json.loads(captured.err)

    assert event == {
        'type': 'progress',
        'feature': 'diarization',
        'phase': 'loading-model',
        'message': 'Using [redacted-token] for setup',
        'percent': 100.0,
    }


def test_pyannote_metrics_are_disabled_for_imported_module():
    assert os.environ['PYANNOTE_METRICS_ENABLED'] == '0'
