from pathlib import Path

import pytest

from backend.diarization import guided_transcription as guided


def test_build_diarization_guided_windows_merges_same_speaker_and_pads():
    windows = guided.build_diarization_guided_windows(
        [
            {'start': 0.0, 'end': 2.0, 'speaker': 'SPEAKER_00'},
            {'start': 2.3, 'end': 4.0, 'speaker': 'SPEAKER_00'},
            {'start': 4.2, 'end': 7.0, 'speaker': 'SPEAKER_01'},
        ],
        audio_duration=8.0,
        padding_seconds=0.25,
        max_window_seconds=10.0,
        merge_gap_seconds=0.5,
    )

    assert windows == [
        {
            'start': 0.0,
            'end': 4.0,
            'speaker': 'SPEAKER_00',
            'audioStart': 0.0,
            'audioEnd': 4.25,
        },
        {
            'start': 4.2,
            'end': 7.0,
            'speaker': 'SPEAKER_01',
            'audioStart': 3.95,
            'audioEnd': 7.25,
        },
    ]


def test_build_diarization_guided_windows_splits_long_turns():
    windows = guided.build_diarization_guided_windows(
        [{'start': 0.0, 'end': 45.0, 'speaker': 'SPEAKER_00'}],
        audio_duration=45.0,
        padding_seconds=0.0,
        max_window_seconds=18.0,
    )

    assert [(window['start'], window['end']) for window in windows] == [(0.0, 18.0), (18.0, 36.0), (36.0, 45.0)]


def test_extract_window_text_for_turn_drops_padded_context():
    result = {
        'segments': [
            {'start': 0.0, 'end': 0.3, 'text': 'previous speaker'},
            {'start': 0.4, 'end': 2.0, 'text': 'current speaker words'},
            {'start': 2.4, 'end': 2.8, 'text': 'next speaker'},
        ]
    }
    window = {'start': 10.3, 'end': 12.4, 'audioStart': 10.0, 'audioEnd': 12.8}

    assert guided.extract_window_text_for_turn(result, window) == 'current speaker words'


def test_extract_window_text_for_turn_keeps_text_when_segments_do_not_overlap():
    result = {
        'segments': [
            {'start': 0.0, 'end': 0.2, 'text': 'edge words'},
            {'start': 0.2, 'end': 0.4, 'text': 'kept'},
        ]
    }
    window = {'start': 20.0, 'end': 21.0, 'audioStart': 10.0, 'audioEnd': 21.2}

    assert guided.extract_window_text_for_turn(result, window) == 'edge words kept'


def test_decode_process_output_replaces_invalid_bytes():
    assert guided.decode_process_output(bytearray(b'bad \xe2 byte')) == 'bad � byte'


def test_transcribe_speaker_windows_uses_turn_timestamps_and_speaker(monkeypatch, tmp_path):
    source_audio = tmp_path / 'source.wav'
    source_audio.write_bytes(b'audio')
    calls = []

    class FakeTranscriber:
        def transcribe_file(self, audio_path, save_markdown=False):
            calls.append((Path(audio_path).name, save_markdown))
            return {'segments': [{'start': 0.0, 'end': 1.0, 'text': 'hello there'}]}

    monkeypatch.setattr(guided, 'extract_audio_window', lambda *args, **kwargs: None)

    segments = guided.transcribe_speaker_windows(
        source_audio=source_audio,
        windows=[{'start': 3.0, 'end': 4.0, 'audioStart': 2.8, 'audioEnd': 4.2, 'speaker': 'SPEAKER_00'}],
        transcriber=FakeTranscriber(),
        work_dir=tmp_path,
        ffmpeg_path='ffmpeg',
    )

    assert calls == [('speaker-window-0001.wav', False)]
    assert segments == [{'start': 3.0, 'end': 4.0, 'text': 'hello there', 'speaker': 'SPEAKER_00'}]


def test_resolve_transcriber_backend_rejects_unknown_backend():
    with pytest.raises(ValueError, match='auto, mlx, or faster'):
        guided.resolve_transcriber_backend('cloud')


def test_guided_transcription_runs_diarization_without_token(monkeypatch, tmp_path):
    audio_path = tmp_path / 'meeting.wav'
    audio_path.write_bytes(b'audio')
    output_path = tmp_path / 'meeting.md'
    calls = []

    class FakeTranscriber:
        def load_model(self):
            pass

        def transcribe_file(self, audio_path, save_markdown=False):
            return {'segments': [{'start': 0.0, 'end': 1.0, 'text': 'hello'}]}

        def get_model_info(self):
            return {'device': 'cuda', 'compute_type': 'float16'}

        def cleanup(self):
            pass

    monkeypatch.delenv('HF_TOKEN', raising=False)
    monkeypatch.delenv('HUGGINGFACE_HUB_TOKEN', raising=False)
    monkeypatch.setattr(guided, 'prepare_diarization_audio', lambda _audio_path, _work_dir, ffmpeg_path='ffmpeg': audio_path)
    monkeypatch.setattr(guided, 'get_audio_duration_seconds', lambda _path: 2.0)
    monkeypatch.setattr(guided, 'run_pyannote_diarization', lambda audio, **kwargs: calls.append((audio, kwargs)) or ([{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}], 'exclusive_speaker_diarization', 'mps'))
    monkeypatch.setattr(guided, 'create_transcriber', lambda **_kwargs: FakeTranscriber())
    monkeypatch.setattr(guided, 'extract_audio_window', lambda *args, **kwargs: None)

    result = guided.transcribe_with_diarization_guidance(
        audio_path=str(audio_path),
        output_transcript=str(output_path),
        model_ref='pyannote/test-model',
        required_device='mps',
    )

    assert result['text'] == 'hello'
    assert result['transcriptionDevice'] == 'cuda'
    assert result['transcriptionComputeType'] == 'float16'
    assert output_path.exists()
    assert calls == [(audio_path, {
        'model_ref': 'pyannote/test-model',
        'hf_token': '',
        'speaker_count': None,
        'required_device': 'mps',
    })]
