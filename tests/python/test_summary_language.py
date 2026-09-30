import json
from pathlib import Path

import pytest

from summaries.summary_language import (
    LANGUAGE_NAMES, SummaryLanguageError, build_language_check_prompt,
    check_summary_language, language_instruction, summary_prose,
)
from summaries.summary_pipeline import build_chunk_summary_prompt, build_final_merge_prompt, render_summary_markdown
from summaries.summary_runner import generate_summary_from_segments, build_json_repair_prompt, generate_summary

SPANISH = 'El equipo aprobó una prueba piloto para el lunes. Mira preparará la lista de verificación antes del viernes. El presupuesto no cambia.'


def test_language_policy_parity_and_prompt_stages():
    # Exact retained IDs; no Persian, implicit default or renderer instructions.
    assert list(LANGUAGE_NAMES) == ['en', 'es', 'fr', 'de', 'zh', 'ja', 'it', 'pa', 'hi', 'ko', 'pt']
    for language, name in LANGUAGE_NAMES.items():
        for prompt in (
            build_chunk_summary_prompt({'text': 'quoted speech'}, language=language),
            build_final_merge_prompt([{'summary': 'quoted overview'}], language=language),
            build_json_repair_prompt('invalid', language),
        ):
            assert f'{name} ({language})' in prompt
            assert 'quoted' in prompt
            assert '"action_items"' in prompt
    with pytest.raises(SummaryLanguageError):
        language_instruction('fa')


def test_checker_excludes_keys_names_timestamps_and_fixed_labels():
    summary = {'summary': SPANISH, 'action_items': [{'task': 'Preparar la lista de verificación.', 'owner': 'English Person', 'due': 'Friday', 'timestamp': '01:02'}]}
    prose = summary_prose(summary)
    assert 'English Person' not in prose
    assert 'Friday' not in prose
    assert '01:02' not in prose
    assert 'action_items' not in prose
    prompt = build_language_check_prompt(prose)
    assert 'confirmed transcript language' not in prompt
    assert 'requested language' not in prompt


def test_detector_bounds_long_meetings_and_samples_across_them():
    prompt = build_language_check_prompt('HEAD ' + 'a' * 10000 + ' MIDDLE ' + 'b' * 10000 + ' TAIL')
    assert len(prompt) < 7200
    assert all(marker in prompt for marker in ('HEAD', 'MIDDLE', 'TAIL'))


@pytest.mark.parametrize('result', [
    {'language': 'en', 'certain': True}, {'language': 'es', 'certain': False},
    {'language': 'unknown', 'certain': False}, {'language': 'es', 'certain': 'true'},
])
def test_wrong_or_indeterminate_prose_rejects(tmp_path, result):
    with pytest.raises(SummaryLanguageError, match='mismatch or indeterminate'):
        check_summary_language({'summary': SPANISH}, 'es', {}, lambda *_: json.dumps(result), tmp_path, 'test')


def test_short_names_and_dates_are_indeterminate_without_inference(tmp_path):
    with pytest.raises(SummaryLanguageError, match='too little substantive prose'):
        check_summary_language({'summary': 'Mira Friday', 'topics': []}, 'en', {}, lambda *_: pytest.fail('must not infer'), tmp_path, 'short')


def test_language_check_malformed_result_fails_closed(tmp_path):
    with pytest.raises(SummaryLanguageError, match='indeterminate'):
        check_summary_language({'summary': SPANISH}, 'es', {}, lambda *_: 'not JSON', tmp_path, 'malformed')


def test_chunk_merge_and_json_repair_use_one_language_and_original_source(monkeypatch):
    import summaries.summary_runner as runner
    monkeypatch.setattr(runner, 'resolve_chunk_token_budget', lambda *_: 50)
    calls = []
    malformed = False

    def run_prompt(_runtime, path, _max_tokens):
        nonlocal malformed
        prompt = Path(path).read_text(encoding='utf-8')
        calls.append((Path(path).name, prompt))
        if 'language.prompt' in path:
            return '{"language":"es","certain":true}'
        assert 'Spanish (es)' in prompt
        if not malformed:
            malformed = True
            return '{invalid json'
        if '-repair-' in path:
            assert 'Original grounded instructions and source' in prompt
            assert SPANISH in prompt
        return json.dumps({'summary': SPANISH, 'topics': []})

    result = generate_summary_from_segments(
        meeting_id='synthetic', segments=[{'text': SPANISH}, {'text': SPANISH}],
        runtime={}, profile='concise', language='es', run_prompt=run_prompt,
    )
    assert result['summary'] == SPANISH
    assert any('final-merge.prompt.txt' == name for name, _ in calls)
    assert sum('-repair-' in name for name, _ in calls) == 1
    assert sum('language.prompt' in name for name, _ in calls) == 4


def test_wrong_language_regenerates_grounded_prompt_once_then_rejects():
    calls = []

    def run_prompt(_runtime, path, _max_tokens):
        calls.append(Path(path).name)
        if 'transcript-language' in path:
            return '{"language":"es","certain":true}'
        if 'language.prompt' in path:
            return '{"language":"en","certain":true}'
        assert 'Spanish (es)' in Path(path).read_text(encoding='utf-8')
        return json.dumps({'summary': 'The team approved the pilot for Monday and Mira will prepare a checklist by Friday.'})

    with pytest.raises(SummaryLanguageError):
        generate_summary_from_segments(meeting_id='synthetic', segments=[{'text': SPANISH}], runtime={}, language='es', run_prompt=run_prompt)
    assert calls.count('chunk-1.prompt.txt') == 2
    assert not any('-repair-' in name for name in calls)


def test_balanced_multilingual_or_incorrect_confirmation_rejects_before_summary():
    calls = []
    def run_prompt(_runtime, path, _max_tokens):
        calls.append(Path(path).name)
        return '{"language":"unknown","certain":false}'
    with pytest.raises(SummaryLanguageError):
        generate_summary_from_segments(meeting_id='synthetic', segments=[{'text': SPANISH}], runtime={}, language='es', run_prompt=run_prompt)
    assert calls == ['transcript-language.prompt.txt']


def test_stale_confirmation_fails_before_runtime_or_output(tmp_path):
    transcript = tmp_path / 'meeting.md'
    transcript.write_text(SPANISH, encoding='utf-8')
    with pytest.raises(SummaryLanguageError, match='Transcript changed'):
        generate_summary(meeting_id='synthetic', transcript_path=str(transcript), runtime_dir='missing', model_path='missing', language='es', source_transcript_hash='sha256:' + '0' * 64)
    assert list(tmp_path.iterdir()) == [transcript]


def test_localized_markdown_preserves_schema_keys_and_legacy_output():
    for language in LANGUAGE_NAMES:
        markdown = render_summary_markdown({'summary': SPANISH, 'action_items': [{'task': 'Preparar la lista.', 'owner': 'Mira', 'timestamp': '01:02'}]}, {'language': language, 'profile': 'balanced'})
        assert 'Mira' in markdown and '01:02' in markdown
        if language != 'en':
            assert '# Meeting Summary' not in markdown
            assert 'None captured.' not in markdown
            assert '**Profile:**' not in markdown
            assert '(owner:' not in markdown
    assert '# Meeting Summary' in render_summary_markdown({'summary': 'Legacy overview'})
