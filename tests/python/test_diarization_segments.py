from backend.diarization.speaker_segments import merge_speaker_labels, temporal_overlap


def test_temporal_overlap_returns_positive_intersection_only():
    assert temporal_overlap({'start': 1.0, 'end': 5.0}, {'start': 3.0, 'end': 8.0}) == 2.0
    assert temporal_overlap({'start': 1.0, 'end': 2.0}, {'start': 2.0, 'end': 3.0}) == 0.0
    assert temporal_overlap({'start': 5.0, 'end': 1.0}, {'start': 0.0, 'end': 3.0}) == 0.0


def test_merge_speaker_labels_uses_largest_overlap_and_normalized_labels():
    transcript_segments = [
        {'start': 0.0, 'end': 5.0, 'text': 'hello'},
        {'start': 5.0, 'end': 9.0, 'text': 'there'},
    ]
    speaker_segments = [
        {'start': 0.0, 'end': 2.0, 'speaker': 'SPEAKER_01'},
        {'start': 2.0, 'end': 8.0, 'speaker': 'SPEAKER_00'},
        {'start': 8.0, 'end': 9.0, 'speaker': 'SPEAKER_01'},
    ]

    merged = merge_speaker_labels(transcript_segments, speaker_segments)

    assert merged == [
        {'start': 0.0, 'end': 5.0, 'text': 'hello', 'speaker': 'Speaker 1'},
        {'start': 5.0, 'end': 9.0, 'text': 'there', 'speaker': 'Speaker 1'},
    ]


def test_merge_speaker_labels_marks_non_overlapping_segments_unknown():
    merged = merge_speaker_labels(
        [{'start': 10.0, 'end': 12.0, 'text': 'late segment'}],
        [{'start': 0.0, 'end': 2.0, 'speaker': 'SPEAKER_00'}],
    )

    assert merged[0]['speaker'] == 'Unknown'


def test_merge_speaker_labels_does_not_mutate_inputs():
    transcript_segments = [{'start': 0.0, 'end': 1.0, 'text': 'original'}]
    speaker_segments = [{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}]

    merged = merge_speaker_labels(transcript_segments, speaker_segments)

    assert merged[0] is not transcript_segments[0]
    assert 'speaker' not in transcript_segments[0]
    assert speaker_segments == [{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}]


def test_merge_speaker_labels_preserves_existing_segment_fields():
    merged = merge_speaker_labels(
        [{'start': 0.0, 'end': 1.0, 'text': 'hello', 'confidence': 0.91}],
        [{'start': 0.0, 'end': 1.0, 'speaker': 'participant-a'}],
    )

    assert merged == [
        {
            'start': 0.0,
            'end': 1.0,
            'text': 'hello',
            'confidence': 0.91,
            'speaker': 'Speaker 1',
        }
    ]
