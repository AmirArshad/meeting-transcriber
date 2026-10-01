import json
import subprocess
from pathlib import Path

import pytest

from summaries.summary_language import (
    LANGUAGE_NAMES, LANGUAGE_POLICY_VERSION, SummaryLanguageError, build_language_check_prompt,
    check_summary_language, detected_language_code, language_instruction, summary_prose,
)
from summaries.summary_pipeline import build_chunk_summary_prompt, build_final_merge_prompt, render_summary_markdown
from summaries.summary_runner import generate_summary_from_segments, build_json_repair_prompt, generate_summary
from summaries.summary_pipeline import SummaryValidationError, assert_summary_grounded_in_transcript, transcript_chunk_has_speech
from summaries.summary_runner import run_summary_prompt_with_repair

SPANISH = 'El equipo aprobó una prueba piloto para el lunes. Mira preparará la lista de verificación antes del viernes. El presupuesto no cambia.'
REVIEW_FIXTURES = json.loads((Path(__file__).parents[1] / 'manual/summary-language-review-fixtures.json').read_text(encoding='utf-8'))


def test_combining_vowel_signs_do_not_disable_localized_grounding_guard():
    speech = 'मीरा सूची तैयार करेगी। मीरा सूची की समीक्षा करेगी।'
    assert transcript_chunk_has_speech(speech)
    with pytest.raises(SummaryValidationError, match='denied transcript'):
        assert_summary_grounded_in_transcript({'summary': REVIEW_FIXTURES['denials']['hi']}, speech, language='hi')


@pytest.mark.parametrize('fixture_id,denial', REVIEW_FIXTURES['denials'].items())
def test_localized_denial_rejects_with_one_grounded_retry_before_language_check(tmp_path, fixture_id, denial):
    language = fixture_id.split('-')[0]
    calls = []
    prompt = tmp_path / 'chunk.prompt.txt'
    prompt.write_text(build_chunk_summary_prompt({'text': SPANISH}, language=language), encoding='utf-8')
    def run_prompt(_runtime, path, _tokens):
        calls.append(Path(path).name)
        if 'language.prompt' in path:
            return json.dumps({'language': language, 'certain': True, 'share': 1})
        return json.dumps({'summary': denial}, ensure_ascii=False)
    with pytest.raises(SummaryValidationError, match='denied transcript content'):
        run_summary_prompt_with_repair(meeting_id='synthetic', runtime={}, prompt_path=prompt, max_tokens=900,
            run_prompt=run_prompt, work_path=tmp_path, repair_name='chunk', chunk_text=SPANISH, language=language)
    assert calls == ['chunk.prompt.txt', 'chunk.prompt.txt']


@pytest.mark.parametrize('fixture_id,overview', REVIEW_FIXTURES['affirmative'].items())
def test_localized_affirmative_transcript_mentions_are_not_denials(fixture_id, overview):
    assert assert_summary_grounded_in_transcript({'summary': overview}, SPANISH, language=fixture_id.split('-')[0])['summary'] == overview


@pytest.mark.parametrize('fixture_id,denial', REVIEW_FIXTURES['denials'].items())
def test_localized_denial_failure_keeps_existing_sidecars(tmp_path, monkeypatch, fixture_id, denial):
    import summaries.summary_runner as runner
    transcript = tmp_path / 'meeting.md'
    transcript.write_text(SPANISH, encoding='utf-8')
    json_path = tmp_path / 'meeting.summary.json'
    markdown_path = tmp_path / 'meeting.summary.md'
    json_path.write_text('{"prior":"good"}', encoding='utf-8')
    markdown_path.write_text('Prior good summary', encoding='utf-8')
    monkeypatch.setattr(runner, 'resolve_llama_runtime', lambda **_: {})
    language = fixture_id.split('-')[0]
    def run_prompt(_runtime, path, _tokens):
        if 'transcript-language' in path:
            return json.dumps({'language': language, 'certain': True, 'share': 1})
        if 'language.prompt' in path:
            pytest.fail('Localized denial must be rejected before output-language classification')
        return json.dumps({'summary': denial}, ensure_ascii=False)
    with pytest.raises(SummaryValidationError, match='denied transcript content'):
        generate_summary(meeting_id='synthetic', transcript_path=str(transcript), runtime_dir='installed', model_path='installed',
            language=language, run_prompt=run_prompt)
    assert json_path.read_text(encoding='utf-8') == '{"prior":"good"}'
    assert markdown_path.read_text(encoding='utf-8') == 'Prior good summary'


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


def test_javascript_and_python_policy_versions_and_languages_match():
    root = Path(__file__).parents[2]
    result = subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(require('./src/summary-language-policy')))"],
                            cwd=root, check=True, capture_output=True, text=True)
    policy = json.loads(result.stdout)
    assert policy['SUMMARY_LANGUAGE_POLICY_VERSION'] == LANGUAGE_POLICY_VERSION
    assert policy['SUMMARY_LANGUAGE_NAMES'] == LANGUAGE_NAMES


def test_classifier_reports_actual_language_without_a_supported_code_menu():
    prompt = build_language_check_prompt(SPANISH)
    assert 'actual ISO 639-1 code of any language' in prompt
    assert 'en/es/fr/de/zh/ja/it/pa/hi/ko/pt' not in prompt
    assert 'substantially mixed' in prompt
    input_prompt = build_language_check_prompt(SPANISH, transcript=True)
    assert 'share as a number from 0 to 1' in input_prompt
    assert '70/30' in input_prompt


@pytest.mark.parametrize('tag,code', [('zh-HK', 'zh'), ('zh-Hant-TW', 'zh'), ('pt-BR', 'pt'), ('pa-Arab', 'pa'),
    ('mr', 'mr'), ('ur', 'ur'), ('hi-mr', None), ('Hindi', None), (None, None)])
def test_detector_region_and_script_tags_preserve_primary_language(tag, code):
    assert detected_language_code(tag) == code


@pytest.mark.parametrize('share', [None, True, '0.7', -1, .5, .59, 1.1, float('nan')])
def test_input_share_fails_closed_for_missing_invalid_or_balanced_evidence(tmp_path, share):
    with pytest.raises(SummaryLanguageError, match='indeterminate'):
        check_summary_language({'summary': SPANISH}, 'es', {},
            lambda *_: json.dumps({'language': 'es', 'certain': True, 'share': share}), tmp_path, 'input', transcript=True)


def test_input_predominance_threshold_does_not_relax_output_classifier(tmp_path):
    def classifier(_, path, _tokens):
        prompt = Path(path).read_text(encoding='utf-8')
        if 'share as a number' in prompt:
            return '{"language":"es","certain":true,"share":0.6}'
        return '{"language":"unknown","certain":false}'
    check_summary_language({'summary': SPANISH}, 'es', {}, classifier, tmp_path, 'input', transcript=True)
    with pytest.raises(SummaryLanguageError, match='indeterminate'):
        check_summary_language({'summary': SPANISH}, 'es', {}, classifier, tmp_path, 'output')


@pytest.mark.parametrize('neighbor', REVIEW_FIXTURES['neighbors'])
def test_out_of_list_neighbor_code_rejects_even_when_certain(tmp_path, neighbor):
    closest = {'mr': 'hi', 'ne': 'hi', 'ur': 'pa', 'ca': 'es', 'gl': 'pt'}[neighbor]
    with pytest.raises(SummaryLanguageError, match='mismatch'):
        check_summary_language({'summary': REVIEW_FIXTURES['neighbors'][neighbor]}, closest, {},
            lambda *_: json.dumps({'language': neighbor, 'certain': True}), tmp_path, 'neighbor')


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


def test_names_above_floor_reach_classifier_and_still_fail_closed(tmp_path):
    prose = REVIEW_FIXTURES['shortAboveFloor']
    assert sum(c.isalpha() for c in prose) > 40
    calls = []
    def run_prompt(*args):
        calls.append(args)
        return '{"language":"unknown","certain":false}'
    with pytest.raises(SummaryLanguageError, match='indeterminate'):
        check_summary_language({'summary': prose}, 'en', {}, run_prompt, tmp_path, 'short')
    assert len(calls) == 1


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
            return '{"language":"es","certain":true,"share":1}'
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
            return '{"language":"es","certain":true,"share":1}'
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
