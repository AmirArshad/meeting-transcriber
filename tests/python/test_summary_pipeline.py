import pytest

from backend.summaries.summary_pipeline import (
    SummaryValidationError,
    chunk_transcript,
    normalize_transcript_segments,
    render_summary_markdown,
    validate_summary_json,
)


def test_normalize_transcript_segments_uses_speaker_labels_when_available():
    normalized = normalize_transcript_segments([
        {'start': 3.2, 'end': 8.9, 'speaker': 'Speaker 2', 'text': '  hello   world '},
        {'start': 9.0, 'end': 11.0, 'text': 'without speaker'},
    ])

    assert normalized[0]['line'] == '[00:03 - 00:08] Speaker 2: hello world'
    assert normalized[1]['line'] == '[00:09 - 00:11] Unknown: without speaker'


def test_chunk_transcript_respects_token_budget_and_timestamps():
    segments = [
        {'start': 0, 'end': 5, 'speaker': 'Speaker 1', 'text': 'a' * 40},
        {'start': 5, 'end': 10, 'speaker': 'Speaker 2', 'text': 'b' * 40},
        {'start': 10, 'end': 15, 'speaker': 'Speaker 1', 'text': 'c' * 40},
    ]

    chunks = chunk_transcript(segments, max_tokens=20)

    assert len(chunks) == 3
    assert chunks[0]['index'] == 1
    assert chunks[0]['start'] == 0.0
    assert chunks[0]['end'] == 5.0
    assert 'Speaker 1' in chunks[0]['text']
    assert chunks[1]['start'] == 5.0
    assert chunks[2]['end'] == 15.0


def test_chunk_transcript_supports_segment_overlap():
    segments = [
        {'start': 0, 'end': 1, 'text': 'a' * 20},
        {'start': 1, 'end': 2, 'text': 'b' * 20},
        {'start': 2, 'end': 3, 'text': 'c' * 20},
    ]

    chunks = chunk_transcript(segments, max_tokens=16, overlap_segments=1)

    assert len(chunks) >= 2
    assert chunks[1]['segments'][0]['text'] == chunks[0]['segments'][-1]['text']


def test_validate_summary_json_requires_structured_object():
    with pytest.raises(SummaryValidationError, match='JSON object'):
        validate_summary_json(['not', 'an', 'object'])

    with pytest.raises(SummaryValidationError, match='non-empty'):
        validate_summary_json({'summary': '', 'topics': []})

    with pytest.raises(SummaryValidationError, match="topics"):
        validate_summary_json({'summary': 'ok', 'topics': 'bad'})


def test_validate_summary_json_normalizes_optional_arrays():
    validated = validate_summary_json({
        'summary': ' Meeting covered launch readiness. ',
        'topics': [{'title': 'Launch'}],
    })

    assert validated['summary'] == 'Meeting covered launch readiness.'
    assert validated['topics'] == [{'title': 'Launch'}]
    assert validated['decisions'] == []
    assert validated['action_items'] == []
    assert validated['risks'] == []
    assert validated['open_questions'] == []


def test_render_summary_markdown_includes_sections_and_metadata():
    markdown = render_summary_markdown(
        {
            'summary': 'The team approved the launch plan.',
            'topics': [{'title': 'Launch plan', 'timestamps': ['00:03']}],
            'decisions': [{'decision': 'Launch on Friday', 'owner': 'Speaker 1', 'timestamp': '00:12'}],
            'action_items': [{'task': 'Send release notes', 'owner': 'Speaker 2', 'due': None}],
            'risks': [],
            'open_questions': [{'question': 'Who covers support?', 'timestamp': '00:18'}],
        },
        {'profile': 'balanced', 'model': 'Qwen3.5-9B', 'generatedAt': '2026-05-16T00:00:00Z'},
    )

    assert markdown.startswith('# Meeting Summary')
    assert '**Profile:** balanced' in markdown
    assert '## Decisions' in markdown
    assert '- Launch on Friday (owner: Speaker 1; timestamp: 00:12)' in markdown
    assert '## Risks\n\nNone captured.' in markdown
