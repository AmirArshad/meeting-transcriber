import pytest

from backend.summaries.summary_pipeline import (
    SummaryValidationError,
    build_chunk_summary_prompt,
    build_final_merge_prompt,
    chunk_transcript,
    get_summary_profile,
    is_topic_boundary_segment,
    normalize_transcript_segments,
    parse_markdown_transcript,
    parse_timestamp,
    repair_summary_json,
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


def test_parse_timestamp_supports_minute_and_hour_formats():
    assert parse_timestamp('01:05') == 65.0
    assert parse_timestamp('01:02:03') == 3723.0


def test_parse_markdown_transcript_handles_existing_transcript_shapes():
    segments = parse_markdown_transcript('''# Meeting Transcription

## Transcript

**[00:01 - 00:03]**
Hello world

[00:04 - 00:06] **Speaker 2:** Follow up
''')

    assert segments == [
        {'start': 1.0, 'end': 3.0, 'speaker': 'Unknown', 'text': 'Hello world'},
        {'start': 4.0, 'end': 6.0, 'speaker': 'Speaker 2', 'text': 'Follow up'},
    ]


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
        {'start': 0, 'end': 1, 'text': 'short a'},
        {'start': 1, 'end': 2, 'text': 'short b'},
        {'start': 2, 'end': 3, 'text': 'short c'},
    ]

    chunks = chunk_transcript(segments, max_tokens=18, overlap_segments=1)

    assert len(chunks) >= 2
    assert chunks[1]['segments'][0]['text'] == chunks[0]['segments'][-1]['text']


def test_chunk_transcript_drops_overlap_when_it_would_break_budget():
    segments = [
        {'start': 0, 'end': 1, 'text': 'a' * 20},
        {'start': 1, 'end': 2, 'text': 'b' * 80},
        {'start': 2, 'end': 3, 'text': 'c' * 20},
    ]

    chunks = chunk_transcript(segments, max_tokens=18, overlap_segments=1)

    assert all(chunk['estimatedTokens'] <= 30 for chunk in chunks)
    assert chunks[1]['segments'][0]['text'] == 'b' * 80


def test_chunk_transcript_prefers_topic_boundaries_after_threshold():
    segments = [
        {'start': 0, 'end': 5, 'text': 'Project launch status and current blockers.'},
        {'start': 5, 'end': 10, 'text': 'We resolved one launch blocker and kept another open.'},
        {'start': 10, 'end': 15, 'text': 'Next topic is budget planning for the pilot.'},
    ]

    chunks = chunk_transcript(segments, max_tokens=100, min_topic_chunk_tokens=1)

    assert len(chunks) == 2
    assert chunks[0]['end'] == 10.0
    assert chunks[1]['start'] == 10.0
    assert is_topic_boundary_segment(segments[2]) is True


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


def test_get_summary_profile_falls_back_to_balanced():
    assert get_summary_profile('concise')['max_output_tokens'] < get_summary_profile('detailed')['max_output_tokens']
    assert get_summary_profile('missing')['label'] == 'Balanced'


def test_build_chunk_summary_prompt_includes_schema_and_transcript_chunk():
    prompt = build_chunk_summary_prompt(
        {'index': 2, 'text': '[00:01 - 00:03] Speaker 1: Ship it'},
        profile='action-items',
    )

    assert 'Return only valid JSON' in prompt
    assert 'action_items' in prompt
    assert 'Chunk 2 transcript' in prompt
    assert 'Speaker 1: Ship it' in prompt
    assert 'local-only' in prompt
    assert 'Do not output <think> tags' in prompt


def test_build_final_merge_prompt_validates_chunk_summaries():
    prompt = build_final_merge_prompt([
        {'summary': 'Launch approved.', 'topics': [{'title': 'Launch'}]},
    ])

    assert 'Merge these chunk summaries' in prompt
    assert 'Launch approved.' in prompt
    assert '"decisions": []' in prompt
    assert 'Do not output <think> tags' in prompt


def test_repair_summary_json_extracts_fenced_or_wrapped_json():
    repaired = repair_summary_json('Here is JSON:\n```json\n{"summary":"ok","topics":[]}\n```')

    assert repaired['summary'] == 'ok'
    assert repaired['topics'] == []
    assert repaired['action_items'] == []

    with pytest.raises(SummaryValidationError):
        repair_summary_json('no json here')
