import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.transcription.parakeet_mlx import MetalParakeet
from backend.transcription.parakeet_transcriber import ParakeetTranscriber
from backend.transcription.parakeet_segments import InvalidParakeetOutput


class FakeAdapter:
    device = 'metal'

    def __init__(self, invalid=False):
        self.calls = []
        self.invalid = invalid

    def transcribe_window(self, pcm, *, input_start, input_end):
        self.calls.append((len(pcm), input_start, input_end))
        if self.invalid:
            raise InvalidParakeetOutput('bad timestamp')
        return [{'start': input_start + .5, 'end': input_start + .7, 'text': 'hello'}]


def test_bounded_transcription_and_complete_output(tmp_path):
    fake = FakeAdapter()
    transcriber = ParakeetTranscriber(model_dir='unused', adapter_id='parakeet-mlx-metal-v1',
                                     ffmpeg='ffmpeg', artifact_revision='pin', runtime_lock_id='lock')
    transcriber.adapter = fake
    transcriber._duration = lambda _: 37.0
    transcriber._decode = lambda audio, start, end: bytes(int((end-start)*16000)*2)
    audio = tmp_path / 'meeting.opus'
    output = tmp_path / 'meeting.md'
    result = transcriber.transcribe_file(str(audio), str(output))
    assert len(fake.calls) == 3
    assert max(call[0] for call in fake.calls) <= 18.7 * 16000 * 2
    assert result['device'] == 'metal'
    assert result['computeType'] == 'float32'
    assert result['duration'] == 37
    assert len(result['segments']) == 3
    assert 'Parakeet v2' in output.read_text()


def test_invalid_chunk_never_publishes_output(tmp_path):
    transcriber = ParakeetTranscriber(model_dir='unused', adapter_id='parakeet-mlx-metal-v1', ffmpeg='ffmpeg')
    transcriber.adapter = FakeAdapter(invalid=True)
    transcriber._duration = lambda _: 5
    transcriber._decode = lambda *args: b'\0' * 1000
    output = tmp_path / 'candidate.md'
    with pytest.raises(InvalidParakeetOutput):
        transcriber.transcribe_file('audio.opus', str(output))
    assert not output.exists()


def test_missing_local_mlx_files_fail_before_import(tmp_path):
    with pytest.raises(FileNotFoundError, match='PARAKEET_ARTIFACT_INVALID'):
        MetalParakeet(str(tmp_path)).load_model()


def test_empty_result_has_explicit_markdown(tmp_path):
    transcriber = ParakeetTranscriber(model_dir='unused', adapter_id='parakeet-mlx-metal-v1', ffmpeg='ffmpeg')
    transcriber.adapter = SimpleNamespace(device='metal', transcribe_window=lambda *args, **kwargs: [])
    transcriber._duration = lambda _: 1.0
    transcriber._decode = lambda *args: b'\0' * 32000
    output = tmp_path / 'candidate.md'
    result = transcriber.transcribe_file('audio.opus', str(output))
    assert result['segments'] == []
    assert result['text'] == ''
    assert 'No speech transcribed.' in output.read_text()


def test_guided_turns_retain_speakers_in_the_candidate(tmp_path):
    transcriber = ParakeetTranscriber(model_dir='unused', adapter_id='parakeet-mlx-metal-v1', ffmpeg='ffmpeg')
    transcriber.adapter = FakeAdapter()
    transcriber._duration = lambda _: 5.0
    transcriber._decode = lambda *args: b'\0' * 32000
    output = tmp_path / 'guided-candidate.md'

    result = transcriber.transcribe_file(
        'audio.opus', str(output), guided_turns={
            'speakerSegments': [{'start': 1.0, 'end': 3.0, 'speaker': 'SPEAKER_00'}],
            'speakerCount': 1,
            'modelRef': 'speakrs-community1-vbx',
            'annotationSource': 'exclusive_speaker_diarization',
            'device': 'cuda',
        },
    )

    assert result['segments'] == [{'start': 1.15, 'end': 1.35, 'text': 'hello', 'speaker': 'Speaker 1'}]
    assert result['diarization']['speakerSegments'][0]['speaker'] == 'SPEAKER_00'
    assert '**Speaker 1:**' in output.read_text()
    assert '\nhello\n' in output.read_text()


def test_guided_turns_without_usable_windows_do_not_load_parakeet(monkeypatch):
    transcriber = ParakeetTranscriber(model_dir='unused', adapter_id='parakeet-mlx-metal-v1', ffmpeg='ffmpeg')
    transcriber._duration = lambda _: 5.0
    monkeypatch.setattr(transcriber, 'load_model', lambda: pytest.fail('must not load for empty guidance'))

    with pytest.raises(RuntimeError, match='PARAKEET_GUIDED_NO_WINDOWS'):
        transcriber.transcribe_file('audio.opus', guided_turns={
            'speakerSegments': [{'start': 1.0, 'end': 1.2, 'speaker': 'SPEAKER_00'}],
        })


def test_onnx_token_count_mismatch_fails_closed():
    from backend.transcription.parakeet_onnx import CudaParakeet
    adapter = CudaParakeet('unused')
    adapter.model = SimpleNamespace(recognize=lambda *args, **kwargs: [
        SimpleNamespace(start=0.0, end=1.0, tokens=[' hello'], timestamps=[]),
    ])
    with pytest.raises(InvalidParakeetOutput, match='differ'):
        adapter.transcribe_window(b'\0' * 32000, input_start=0, input_end=1)


def test_duration_uses_bundled_ffmpeg_when_ffprobe_is_absent(monkeypatch):
    from backend.transcription import parakeet_transcriber as module
    calls = []
    monkeypatch.setattr(module.shutil, 'which', lambda _: None)
    monkeypatch.setattr(module.subprocess, 'run', lambda args, **kwargs: (
        calls.append(args) or SimpleNamespace(stderr='Duration: 00:00:37.25, start: 0.0')
    ))
    transcriber = ParakeetTranscriber(model_dir='unused', adapter_id='parakeet-mlx-metal-v1',
                                     ffmpeg='/bundle/bin/ffmpeg')
    assert transcriber._duration('meeting.opus') == 37.25
    assert calls[0][0] == '/bundle/bin/ffmpeg'


def test_metal_loader_uses_local_config_weights_float32_and_gpu(tmp_path, monkeypatch):
    import sys
    from types import ModuleType
    model_dir = tmp_path / 'model'
    model_dir.mkdir()
    (model_dir / 'config.json').write_text('{"target":"pinned"}', encoding='utf-8')
    (model_dir / 'model.safetensors').write_bytes(b'pinned-weights')
    events = []

    class Array:
        def __init__(self, value=4):
            self.value = value

        def sum(self):
            return self

        def astype(self, dtype):
            events.append(('cast', dtype))
            return self

        def __float__(self):
            return float(self.value)

    class Model:
        def load_weights(self, path):
            events.append(('weights', path))

        def parameters(self):
            return {'weight': Array()}

        def update(self, params):
            events.append(('update', params))

    core = ModuleType('mlx.core')
    core.gpu = object()
    core.float32 = object()
    core.metal = SimpleNamespace(is_available=lambda: True)
    core.set_default_device = lambda device: events.append(('device', device))
    core.ones = lambda shape, dtype: Array()
    core.eval = lambda *values: events.append(('eval', len(values)))
    mlx = ModuleType('mlx')
    mlx.core = core
    utils = ModuleType('mlx.utils')
    utils.tree_flatten = lambda params: list(params.items())
    utils.tree_unflatten = dict
    parakeet = ModuleType('parakeet_mlx')
    parakeet_utils = ModuleType('parakeet_mlx.utils')
    parakeet_utils.from_config = lambda config: (events.append(('config', config)) or Model())
    for name, module in [('mlx', mlx), ('mlx.core', core), ('mlx.utils', utils),
                         ('parakeet_mlx', parakeet), ('parakeet_mlx.utils', parakeet_utils)]:
        monkeypatch.setitem(sys.modules, name, module)
    adapter = MetalParakeet(str(model_dir))
    adapter.load_model()
    assert ('device', core.gpu) in events
    assert ('config', {'target': 'pinned'}) in events
    assert ('weights', str(model_dir / 'model.safetensors')) in events
    assert ('cast', core.float32) in events
    assert adapter.model is not None
