import json
import os
from pathlib import Path

import pytest

from backend.diarization import diarization_pipeline as pipeline


def test_normalize_speaker_count_accepts_auto_and_valid_counts():
    assert pipeline.normalize_speaker_count('auto') is None
    assert pipeline.normalize_speaker_count('') is None
    assert pipeline.normalize_speaker_count('3') == 3

    with pytest.raises(ValueError):
        pipeline.normalize_speaker_count('11')


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
