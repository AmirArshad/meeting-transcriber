import pytest

from backend.summaries.summary_pipeline import (
    SummaryValidationError,
    assert_summary_grounded_in_transcript,
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


def test_parse_markdown_transcript_handles_guided_speaker_header_lines():
    segments = parse_markdown_transcript('''# Meeting Transcription

## Transcript

**[00:03 - 00:10]** **Speaker 1:**
Hello, hello, this is another test.

**[00:10 - 00:12]** **Speaker 2:**
Hello, I'm his friend
''')

    assert segments == [
        {
            'start': 3.0,
            'end': 10.0,
            'speaker': 'Speaker 1',
            'text': 'Hello, hello, this is another test.',
        },
        {
            'start': 10.0,
            'end': 12.0,
            'speaker': 'Speaker 2',
            'text': "Hello, I'm his friend",
        },
    ]


def test_parse_markdown_transcript_skips_empty_body_without_eating_next_header():
    segments = parse_markdown_transcript('''## Transcript

**[00:01 - 00:03]**

**[00:03 - 00:05]**
Hello world
''')

    assert segments == [
        {'start': 3.0, 'end': 5.0, 'speaker': 'Unknown', 'text': 'Hello world'},
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


def test_multilingual_chunk_estimate_counts_utf8_bytes():
    from backend.summaries.summary_pipeline import estimate_token_count

    assert estimate_token_count('Launch approved.') == 4
    assert estimate_token_count('讨论项目进展') == 5
    assert estimate_token_count('') == 0


def test_original_near_full_chinese_fixture_is_split():
    import json
    from pathlib import Path

    fixture_path = Path(__file__).parents[1] / 'manual' / 'summary-language-fixtures.json'
    prose = json.loads(fixture_path.read_text(encoding='utf-8'))['zh']
    # Original --long-only reproduction: 25,590 character-estimated tokens.
    segments = [{'text': prose}] * 853
    chunks = chunk_transcript(segments, max_tokens=25868, overlap_segments=1)

    assert len(chunks) > 1
    assert all(chunk['estimatedTokens'] <= 25868 for chunk in chunks)
    assert sum(len(chunk['segments']) for chunk in chunks) - (len(chunks) - 1) == len(segments)


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

    assert markdown.startswith('# Summary')
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
    assert 'Do not claim the transcript is missing' in prompt


def test_assert_summary_grounded_rejects_cli_chrome_denials():
    chunk = '[00:03 - 00:10] Speaker 1: Hello, this is a speaker test with real dialogue.'
    grounded = assert_summary_grounded_in_transcript(
        {'summary': 'Speakers tested audio capture.', 'topics': []},
        chunk,
    )
    assert grounded['summary'] == 'Speakers tested audio capture.'

    with pytest.raises(SummaryValidationError, match='denied transcript content'):
        assert_summary_grounded_in_transcript(
            {
                'summary': 'No meeting content was provided in the input transcript; only system status and exit commands were observed.',
                'topics': [],
            },
            chunk,
        )


def test_assert_summary_grounded_allows_affirmative_transcript_phrasing():
    chunk = '[00:03 - 00:10] Speaker 1: Hello, this is a speaker test with real dialogue.'
    for overview in (
        'The team reviewed the transcript provided by the vendor and approved it.',
        'Speaker 1 confirmed the transcript was available for the audit.',
        'They agreed to add an exit command to the CLI tool.',
        'Content was found to be duplicated across two slides.',
    ):
        grounded = assert_summary_grounded_in_transcript(
            {'summary': overview, 'topics': []},
            chunk,
        )
        assert grounded['summary'] == overview


def test_assert_summary_grounded_applies_to_non_latin_transcripts():
    chunk = '[00:03 - 00:10] Speaker 1: این یک متن آزمایشی فارسی برای خلاصه‌سازی جلسه است.'
    with pytest.raises(SummaryValidationError, match='denied transcript content'):
        assert_summary_grounded_in_transcript(
            {
                'summary': 'No meeting content was provided; only exit commands were observed.',
                'topics': [],
            },
            chunk,
        )


def test_repair_summary_json_rejects_schema_placeholder_echo():
    with pytest.raises(SummaryValidationError, match='schema example'):
        repair_summary_json('{"summary":"short grounded overview","topics":[]}')


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


def test_tag_templates_registry_prompts_validation_and_rendering():
    from backend.meetings.normalization import VALID_RECORDING_TAGS
    from backend.summaries.templates import (
        SUMMARY_TEMPLATES,
        TEMPLATE_VERSION,
        get_template,
        render_schema_instruction,
        resolve_template_id,
    )
    from backend.summaries.language_labels import (
        LANGUAGE_LABELS,
        TAG_DISPLAY_LABELS,
        TAG_META_LABELS,
        TEMPLATE_FIELD_LABELS,
        TEMPLATE_SECTION_LABELS,
    )

    assert TEMPLATE_VERSION == 'tag-templates-v1'
    assert set(VALID_RECORDING_TAGS) == set(SUMMARY_TEMPLATES.keys())
    assert resolve_template_id(None) == 'meeting'
    assert resolve_template_id('voice memo') == 'voice-note'
    assert resolve_template_id(None, fallback='other') == 'other'

    # All 13 language rows cover every tag, section key, and field metadata label.
    assert set(TAG_DISPLAY_LABELS.keys()) == set(LANGUAGE_LABELS.keys())
    assert set(TAG_META_LABELS.keys()) == set(LANGUAGE_LABELS.keys())
    assert set(TEMPLATE_SECTION_LABELS.keys()) == set(LANGUAGE_LABELS.keys())
    assert set(TEMPLATE_FIELD_LABELS.keys()) == set(LANGUAGE_LABELS.keys())
    all_section_keys = {
        field
        for tmpl in SUMMARY_TEMPLATES.values()
        for field in tmpl['array_fields']
    }
    for lang in LANGUAGE_LABELS:
        assert set(TAG_DISPLAY_LABELS[lang].keys()) == set(VALID_RECORDING_TAGS)
        assert all_section_keys.issubset(set(TEMPLATE_SECTION_LABELS[lang].keys()))
        assert all(bool(str(TAG_DISPLAY_LABELS[lang][t]).strip()) for t in VALID_RECORDING_TAGS)

    # Every template builds valid chunk/merge prompts, validates empty payloads, and renders markdown.
    for tag in VALID_RECORDING_TAGS:
        tmpl = get_template(tag)
        schema_text = render_schema_instruction(tag)
        for field in tmpl['array_fields']:
            assert f'"{field}"' in schema_text

        for profile in ('action-items', 'concise', 'balanced', 'detailed'):
            chunk_prompt = build_chunk_summary_prompt(
                {'index': 1, 'text': '[00:01 - 00:05] Speaker 1: Substantive test point.'},
                profile=profile,
                tag=tag,
            )
            assert tmpl['persona'] in chunk_prompt

        merge_prompt = build_final_merge_prompt([{'summary': 'Overview text'}], tag=tag)
        assert tmpl['merge_persona'] in merge_prompt

        validated = validate_summary_json({'summary': 'Overview text'}, tag=tag)
        for field in tmpl['array_fields']:
            assert validated[field] == []

        rendered_empty = render_summary_markdown(
            validated,
            {'profile': 'balanced', 'model': 'Qwen', 'generatedAt': '2026-11-21T00:00:00Z', 'tag': tag},
        )
        assert '**Tag:**' in rendered_empty
        if tag == 'meeting':
            assert 'None captured.' in rendered_empty
        else:
            assert 'None captured.' not in rendered_empty

    # Legacy call without tag still uses meeting schema and shows None captured.
    legacy_md = render_summary_markdown({'summary': 'Legacy overview'})
    assert '## Action Items\n\nNone captured.' in legacy_md



def test_template_synonyms_detail_fallback_and_script_detection():
    brainstorm = render_summary_markdown({
        'summary': 'Overview', 'problem_or_goal': [{'goal': 'Ship release'}],
        'next_experiments': [{'experiment': 'Test the build'}],
    }, {'template': 'brainstorm'})
    assert 'Ship release' in brainstorm
    other = render_summary_markdown({
        'summary': 'Overview', 'key_points': [{'summary': 'Detail alone'}],
        'next_steps': [{'task': 'Follow up'}],
    }, {'template': 'other'})
    assert 'Detail alone' in other and 'Untitled: Detail alone' not in other
    assert 'Follow up' in other
    lecture = render_summary_markdown({
        'summary': '简短', 'core_concepts': [{'concept': '學習課程'}],
    }, {'template': 'lecture', 'language': 'zh'})
    assert '學習' in lecture
    from backend.summaries.language_labels import get_localized_labels
    assert get_localized_labels('zh-Hant')['sections']['core_concepts'] in lecture


@pytest.mark.parametrize('noun', ['recording', 'audio', 'appointment', 'call', 'interview', 'lecture', 'podcast', 'video', 'voice-note', 'voice note', 'brainstorm', 'music', 'session'])
def test_denials_for_all_recording_types_are_rejected(noun):
    with pytest.raises(SummaryValidationError):
        assert_summary_grounded_in_transcript(
            {'summary': f'No {noun} transcript was provided.'},
            'The speaker described several substantive ideas during this session.',
        )


def test_summary_speaker_overlay_preserves_sidecar_and_transcript(tmp_path):
    import json
    from backend.summaries.summary_runner import hash_transcript_text, load_summary_segments

    text = '[00:01 - 00:03] **Speaker 1:** Hello\n'
    transcript = tmp_path / 'meeting.md'
    transcript.write_text(text, encoding='utf-8')
    sidecar = tmp_path / 'meeting.speakers.json'
    sidecar.write_text(json.dumps({'sourceTranscriptHash': hash_transcript_text(text), 'segments': [
        {'start': 1, 'end': 3, 'speaker': 'Speaker 1', 'text': 'Hello'}
    ]}), encoding='utf-8')
    assert load_summary_segments(str(transcript), str(sidecar), {'Speaker 1': 'Alice'})[0]['speaker'] == 'Alice'
    assert load_summary_segments(str(transcript), None, {'Speaker 1': 'Alice'})[0]['speaker'] == 'Alice'
    assert transcript.read_text(encoding='utf-8') == text
    assert json.loads(sidecar.read_text())['segments'][0]['speaker'] == 'Speaker 1'


def test_summary_parses_custom_bold_speaker_name():
    assert parse_markdown_transcript('[00:01 - 00:03] **Alice Doe:** Hello\n')[0]['speaker'] == 'Alice Doe'


def test_summary_fallback_keeps_mixed_untimed_speakers_and_empty_boundaries(tmp_path):
    from backend.summaries.summary_runner import load_summary_segments

    transcript = tmp_path / 'meeting.md'
    transcript.write_text("""## Transcript
**Speaker 1:**
**Speaker 2:** First line
continued line

[00:04 - 00:06] **Speaker 1:** Timed speech
**Speaker 1:** Untimed again
""", encoding='utf-8')
    segments = load_summary_segments(str(transcript), speaker_names={'Speaker 1': 'Alice', 'Speaker 2': 'Bob'})
    assert [(item['speaker'], item['text']) for item in segments] == [
        ('Bob', 'First line continued line'), ('Alice', 'Timed speech'), ('Alice', 'Untimed again')
    ]
    lines = [item['line'] for item in normalize_transcript_segments(segments)]
    assert lines == ['Bob: First line continued line', '[00:04 - 00:06] Alice: Timed speech', 'Alice: Untimed again']


def test_empty_timed_speaker_does_not_consume_untimed_speaker():
    segments = parse_markdown_transcript('[00:01 - 00:03] **Speaker 1:**\n**Speaker 2:** Hello\n')
    assert [(item['speaker'], item['text']) for item in segments] == [('Speaker 2', 'Hello')]


def test_summary_speaker_overlay_normalizes_names_and_preserves_empty_labels(tmp_path):
    import json
    from backend.summaries.summary_runner import hash_transcript_text, load_summary_segments

    text = '[00:01 - 00:03] **Speaker 1:** Hello\n[00:04 - 00:05] **Speaker 2:** Hi\n'
    transcript = tmp_path / 'meeting.md'
    transcript.write_text(text, encoding='utf-8')
    sidecar = tmp_path / 'meeting.speakers.json'
    sidecar.write_text(json.dumps({'sourceTranscriptHash': hash_transcript_text(text), 'segments': [
        {'speaker': 'Speaker 1', 'text': 'Hello'}, {'speaker': 'Speaker 2', 'text': 'Hi'}
    ]}), encoding='utf-8')
    names = {'Speaker 1': ' *Alice*--->-> ', 'Speaker 2': '', 'invalid': 'Ignored'}
    for path in (None, str(sidecar)):
        assert [segment['speaker'] for segment in load_summary_segments(str(transcript), path, names)] == ['Alice', 'Speaker 2']
