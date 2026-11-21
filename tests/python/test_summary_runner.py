import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend.summaries.summary_pipeline import SummaryValidationError
from backend.summaries.summary_runner import (
    generate_summary_from_segments,
    hash_transcript_text,
    load_summary_segments,
    read_transcript_text,
    resolve_chunk_token_budget,
    save_summary_outputs,
    sidecar_paths,
    validate_summary_runtime,
)


def test_hash_transcript_text_is_stable_and_prefixed():
    digest = hash_transcript_text('hello')

    assert digest.startswith('sha256:')
    assert digest == hash_transcript_text('hello')
    assert digest != hash_transcript_text('hello!')


def test_json_repair_bounds_invalid_output_in_utf8_bytes():
    from backend.summaries.summary_runner import build_json_repair_prompt

    for raw in ['x' * 13000, '错' * 12000, '🙂' * 12000]:
        prompt = build_json_repair_prompt(raw, 'zh', 'Complete grounded source 讨论项目')
        quoted = prompt.split('Invalid model output (quoted data):\n\n', 1)[1]
        assert len(quoted.encode('utf-8')) <= 12000
        assert quoted == raw[:len(quoted)]
        assert '\ufffd' not in quoted
        assert 'Complete grounded source 讨论项目' in prompt
    assert len(quoted) > 0


def test_load_summary_segments_prefers_speaker_sidecar(tmp_path):
    transcript_path = tmp_path / 'meeting.md'
    speakers_path = tmp_path / 'meeting.speakers.json'
    transcript_path.write_text('**[00:01 - 00:02]**\nPlain transcript', encoding='utf-8')
    speakers_path.write_text(json.dumps({'sourceTranscriptHash': hash_transcript_text(transcript_path.read_text()), 'segments': [{'start': 1, 'end': 2, 'speaker': 'Speaker 1', 'text': 'Labeled'}]}), encoding='utf-8')

    segments = load_summary_segments(str(transcript_path), str(speakers_path))

    assert segments == [{'start': 1, 'end': 2, 'speaker': 'Speaker 1', 'text': 'Labeled'}]


def test_read_transcript_text_replaces_invalid_utf8_bytes(tmp_path):
    transcript_path = tmp_path / 'meeting.md'
    transcript_path.write_bytes(b'# Meeting\n\nValid text \xe2 invalid tail')

    assert read_transcript_text(str(transcript_path)) == '# Meeting\n\nValid text \ufffd invalid tail'


def test_load_summary_segments_tolerates_invalid_utf8_bytes(tmp_path):
    transcript_path = tmp_path / 'meeting.md'
    transcript_path.write_bytes(b'**[00:01 - 00:02]**\nValid text \xe2 invalid tail')

    segments = load_summary_segments(str(transcript_path))

    assert segments[0]['text'] == 'Valid text \ufffd invalid tail'


def test_sidecar_paths_use_transcript_stem():
    paths = sidecar_paths('meeting_20260107_104555.md')

    assert paths == {
        'jsonPath': 'meeting_20260107_104555.summary.json',
        'markdownPath': 'meeting_20260107_104555.summary.md',
    }


def test_generate_summary_from_segments_runs_chunk_and_merge_prompts():
    calls = []

    def run_prompt(_runtime, prompt_path, max_tokens):
        calls.append((prompt_path, max_tokens))
        if 'final-merge' in prompt_path:
            return json.dumps({'summary': 'Final summary', 'topics': [{'title': 'Launch'}]})
        return json.dumps({'summary': 'Chunk summary', 'topics': [{'title': 'Launch'}]})

    summary = generate_summary_from_segments(
        meeting_id='20260107_104555',
        segments=[
            {'start': 0, 'end': 60, 'speaker': 'Speaker 1', 'text': 'Launch approved. ' * 2000},
            {'start': 60, 'end': 120, 'speaker': 'Speaker 2', 'text': 'Rollout planning. ' * 2000},
        ],
        runtime={'runtime': 'llama.cpp', 'contextTokens': 7600},
        profile='concise',
        run_prompt=run_prompt,
    )

    assert summary['summary'] == 'Final summary'
    assert len(calls) == 3
    assert calls[0][1] == 900


def test_generate_summary_from_segments_skips_merge_for_single_chunk():
    calls = []

    def run_prompt(_runtime, prompt_path, max_tokens):
        calls.append((prompt_path, max_tokens))
        return json.dumps({'summary': 'Single chunk summary', 'topics': [{'title': 'Launch'}]})

    summary = generate_summary_from_segments(
        meeting_id='20260107_104555',
        segments=[{'start': 0, 'end': 1, 'speaker': 'Speaker 1', 'text': 'Launch approved'}],
        runtime={'runtime': 'llama.cpp'},
        profile='balanced',
        run_prompt=run_prompt,
    )

    assert summary['summary'] == 'Single chunk summary'
    assert len(calls) == 1
    assert 'final-merge' not in calls[0][0]


def test_resolve_chunk_token_budget_uses_available_context_without_shrinking_profile():
    assert resolve_chunk_token_budget({'contextTokens': 32768}, {'chunk_tokens': 16000, 'max_output_tokens': 1600}) == 25168
    assert resolve_chunk_token_budget({'contextTokens': 8192}, {'chunk_tokens': 16000, 'max_output_tokens': 1600}) == 16000
    assert resolve_chunk_token_budget({'contextTokens': 7600}, {'chunk_tokens': 16000, 'max_output_tokens': 1600}) == 16000


def test_generate_summary_from_segments_retries_malformed_json_once():
    calls = []

    def run_prompt(_runtime, prompt_path, _max_tokens):
        calls.append(prompt_path)
        if 'repair' in prompt_path:
            return json.dumps({'summary': 'Repaired summary', 'topics': []})
        if 'final-merge' in prompt_path:
            return json.dumps({'summary': 'Final summary', 'topics': []})
        return 'not json'

    summary = generate_summary_from_segments(
        meeting_id='20260107_104555',
        segments=[
            {'start': 0, 'end': 60, 'text': 'Discussed launch. ' * 2000},
            {'start': 60, 'end': 120, 'text': 'Discussed follow-up. ' * 2000},
        ],
        runtime={'runtime': 'llama.cpp'},
        profile='concise',
        run_prompt=run_prompt,
    )

    assert summary['summary'] == 'Final summary'
    assert any('repair' in call for call in calls)


def test_generate_summary_from_segments_regenerates_ungrounded_denial():
    calls = []
    responses = iter([
        json.dumps({
            'summary': 'No meeting content was provided; only system status and exit commands were observed.',
            'topics': [],
        }),
        json.dumps({
            'summary': 'Speakers tested audio and discussed a league win.',
            'topics': [{'title': 'Audio test'}],
        }),
    ])

    def run_prompt(_runtime, prompt_path, _max_tokens):
        calls.append(prompt_path)
        return next(responses)

    summary = generate_summary_from_segments(
        meeting_id='20260710_165125',
        segments=[{
            'start': 3,
            'end': 10,
            'speaker': 'Speaker 1',
            'text': 'Hello, hello, this is another test of the speakers.',
        }],
        runtime={'runtime': 'llama.cpp'},
        profile='balanced',
        run_prompt=run_prompt,
    )

    assert summary['summary'] == 'Speakers tested audio and discussed a league win.'
    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert all('repair' not in call for call in calls)


def test_generate_summary_from_segments_raises_after_second_ungrounded_denial():
    calls = []

    def run_prompt(_runtime, prompt_path, _max_tokens):
        calls.append(prompt_path)
        return json.dumps({
            'summary': 'No meeting content was provided; only system status and exit commands were observed.',
            'topics': [],
        })

    with pytest.raises(SummaryValidationError, match='denied transcript content'):
        generate_summary_from_segments(
            meeting_id='20260710_165125',
            segments=[{
                'start': 3,
                'end': 10,
                'speaker': 'Speaker 1',
                'text': 'Hello, hello, this is another test of the speakers.',
            }],
            runtime={'runtime': 'llama.cpp'},
            profile='balanced',
            run_prompt=run_prompt,
        )

    assert len(calls) == 2
    assert calls[0] == calls[1]


def test_save_summary_outputs_writes_json_and_markdown(tmp_path):
    json_path = tmp_path / 'meeting.summary.json'
    markdown_path = tmp_path / 'meeting.summary.md'
    save_summary_outputs(
        summary={'summary': 'Saved summary', 'topics': []},
        metadata={'profile': 'balanced', 'model': 'Qwen3.5-9B'},
        json_path=str(json_path),
        markdown_path=str(markdown_path),
    )

    payload = json.loads(json_path.read_text(encoding='utf-8'))
    assert payload['summary']['summary'] == 'Saved summary'
    assert payload['metadata']['profile'] == 'balanced'
    assert '# Summary' in markdown_path.read_text(encoding='utf-8')


def test_save_summary_outputs_uses_unique_temp_names(monkeypatch, tmp_path):
    json_path = tmp_path / 'meeting.summary.json'
    markdown_path = tmp_path / 'meeting.summary.md'
    observed = []
    original_write_text = type(json_path).write_text

    def capture_write_text(self, *args, **kwargs):
        observed.append(self.name)
        return original_write_text(self, *args, **kwargs)

    monkeypatch.setattr(type(json_path), 'write_text', capture_write_text)

    save_summary_outputs(
        summary={'summary': 'Saved summary', 'topics': []},
        metadata={'profile': 'balanced', 'model': 'Qwen3.5-9B'},
        json_path=str(json_path),
        markdown_path=str(markdown_path),
    )

    temp_names = [name for name in observed if name.startswith('.meeting.summary')]
    assert len(temp_names) == 2
    assert all(name.endswith('.tmp') for name in temp_names)
    assert all(name.count('.') >= 5 for name in temp_names)


def test_validate_summary_runtime_smoke_tests_resolved_runtime(monkeypatch, tmp_path):
    runtime_dir = tmp_path / 'runtime'
    runtime_dir.mkdir()
    executable = runtime_dir / 'llama-cli.exe'
    executable.write_text('bin', encoding='utf-8')
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')
    calls = []

    monkeypatch.setattr('backend.summaries.summary_runner.smoke_test_llama_runtime', lambda runtime: calls.append(runtime))

    result = validate_summary_runtime(
        runtime_dir=str(runtime_dir),
        model_path=str(model_path),
        platform='win32',
        arch='x64',
    )

    assert result['status'] == 'ready'
    assert result['acceleration'] == 'cuda'
    assert result['executable'] == str(executable)
    assert calls[0]['modelPath'] == str(model_path)


def test_summary_runner_module_execution_has_no_preimport_warning(tmp_path):
    runtime_dir = tmp_path / 'runtime'
    runtime_dir.mkdir()
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    result = subprocess.run(
        [
            sys.executable,
            '-m',
            'summaries.summary_runner',
            '--validate-runtime',
            '--runtime-dir',
            str(runtime_dir),
            '--model-path',
            str(model_path),
            '--platform',
            'win32',
            '--arch',
            'x64',
        ],
        capture_output=True,
        text=True,
        check=False,
        env={
            **os.environ,
            'PYTHONPATH': str(Path(__file__).resolve().parents[2] / 'backend'),
        },
    )

    assert 'RuntimeWarning' not in result.stderr


def test_summary_runner_help_exits_successfully():
    result = subprocess.run(
        [sys.executable, '-m', 'summaries.summary_runner', '--help'],
        capture_output=True,
        text=True,
        check=False,
        env={
            **os.environ,
            'PYTHONPATH': str(Path(__file__).resolve().parents[2] / 'backend'),
        },
    )

    assert result.returncode == 0, result.stderr
    assert 'Generate a local AvaNevis meeting summary' in result.stdout


@pytest.mark.parametrize('binding', [None, hash_transcript_text('Superseded facts')])
def test_summary_ignores_unbound_or_superseded_speaker_text(tmp_path, binding):
    transcript = tmp_path / 'new.md'
    transcript.write_text('**[00:01 - 00:02]**\nCurrent facts', encoding='utf-8')
    speakers = tmp_path / 'old.speakers.json'
    speakers.write_text(json.dumps({'sourceTranscriptHash': binding, 'segments': [
        {'start': 1, 'end': 2, 'speaker': 'Speaker 1', 'text': 'Superseded facts'},
    ]}))
    segments = load_summary_segments(str(transcript), str(speakers))
    assert 'Current facts' in str(segments)
    assert 'Superseded facts' not in str(segments)


def test_summary_runner_persists_tag_template_metadata_and_defaults_untagged_to_other(tmp_path, monkeypatch):
    from backend.summaries.summary_runner import build_json_repair_prompt, generate_summary
    from backend.summaries.templates import TEMPLATE_VERSION

    # 1. Tagged segment generation uses matching template schema & validates fields
    seen_prompts = []

    def run_tagged(_runtime, prompt_path, _max_tokens):
        text = Path(prompt_path).read_text(encoding='utf-8')
        seen_prompts.append(text)
        return json.dumps({
            'summary': 'Product brainstorm session.',
            'problem_or_goal': [{'goal': 'Improve onboarding', 'timestamp': '00:05'}],
            'ideas_explored': [{'idea': 'Guided checklist', 'notes': 'Reduces drop-off', 'timestamp': '00:12'}],
        })

    res_tagged = generate_summary_from_segments(
        meeting_id='m_tag_1',
        segments=[{'start': 0, 'end': 10, 'speaker': 'Speaker 1', 'text': 'Let us brainstorm onboarding ideas.'}],
        runtime={'modelName': 'Qwen-Test'},
        profile='balanced',
        tag='brainstorm',
        run_prompt=run_tagged,
    )
    assert 'ideas_explored' in seen_prompts[0]
    assert res_tagged['summary'] == 'Product brainstorm session.'
    assert res_tagged['problem_or_goal'][0]['goal'] == 'Improve onboarding'
    assert res_tagged['ideas_explored'][0]['idea'] == 'Guided checklist'

    # 2. Untagged new generation resolves template schema to 'other'
    def run_untagged(_runtime, prompt_path, _max_tokens):
        text = Path(prompt_path).read_text(encoding='utf-8')
        assert '"outcomes_and_takeaways"' in text
        return json.dumps({'summary': 'General recording overview.', 'key_points': []})

    res_untagged = generate_summary_from_segments(
        meeting_id='m_untagged_1',
        segments=[{'start': 0, 'end': 8, 'speaker': 'Speaker 1', 'text': 'General note taking.'}],
        runtime={'modelName': 'Qwen-Test'},
        profile='balanced',
        tag=None,
        run_prompt=run_untagged,
    )
    assert res_untagged['summary'] == 'General recording overview.'
    assert res_untagged['key_points'] == []

    # 3. build_json_repair_prompt preserves --tag schema
    repair_prompt = build_json_repair_prompt('{bad json', 'en', 'Musical rehearsal notes.', tag='music')
    assert 'mix_and_arrangement' in repair_prompt
    assert 'lyrics_and_themes' in repair_prompt

    # 4. generate_summary untagged metadata defaults template='other' & tag=None
    untagged_md = tmp_path / 'untagged.md'
    untagged_md.write_text(
        '**[00:01 - 00:08]** **Speaker 1:**\nGeneral recording discussion covering architecture and release timeline milestones.\n',
        encoding='utf-8',
    )
    untagged_hash = hash_transcript_text(untagged_md.read_text(encoding='utf-8'))
    untagged_json = tmp_path / 'untagged.summary.json'
    untagged_out_md = tmp_path / 'untagged.summary.md'

    import backend.summaries.summary_runner as sr

    monkeypatch.setattr(sr, 'resolve_llama_runtime', lambda *_a, **_kw: {'modelName': 'MockModel', 'runtime': 'llama.cpp'})
    monkeypatch.setattr(
        sr,
        'run_llama_prompt',
        lambda _runtime, prompt_path, *_args, **_kwargs: (
            json.dumps({'language': 'en', 'certain': True, 'share': 1})
            if 'language.prompt' in str(prompt_path)
            else json.dumps({'summary': 'General recording overview covering architecture and release timeline milestones.', 'key_points': []})
        ),
    )

    gen_untagged = generate_summary(
        meeting_id='m_untagged_2',
        transcript_path=str(untagged_md),
        runtime_dir=str(tmp_path),
        model_path=str(tmp_path / 'model.gguf'),
        output_json=str(untagged_json),
        output_markdown=str(untagged_out_md),
        language='en',
        source_transcript_hash=untagged_hash,
        model_id='qwen-test',
        tag=None,
    )
    assert gen_untagged['metadata']['tag'] is None
    assert '**Tag:**' not in untagged_out_md.read_text(encoding='utf-8')
    assert gen_untagged['metadata']['template'] == 'other'
    assert gen_untagged['metadata']['templateVersion'] == TEMPLATE_VERSION

    # 5. --tag CLI end-to-end persistence to JSON and Markdown files
    transcript = tmp_path / 'clip.md'
    transcript.write_text(
        '**[00:01 - 00:09]** **Speaker 1:**\nAppointment follow-up scheduled for Tuesday morning with updated lab results.\n',
        encoding='utf-8',
    )
    tx_hash = hash_transcript_text(transcript.read_text(encoding='utf-8'))
    out_json = tmp_path / 'clip.summary.json'
    out_md = tmp_path / 'clip.summary.md'

    monkeypatch.setattr(
        sr,
        'run_llama_prompt',
        lambda _runtime, prompt_path, *_args, **_kwargs: (
            json.dumps({'language': 'en', 'certain': True, 'share': 1})
            if 'language.prompt' in str(prompt_path)
            else json.dumps({
                'summary': 'Routine follow-up appointment scheduled for Tuesday morning with updated lab results.',
                'key_findings': [{'finding': 'Metrics look stable across recent checkups', 'timestamp': '00:05'}],
            })
        ),
    )
    monkeypatch.setattr(
        sys,
        'argv',
        [
            'summary_runner.py',
            '--transcript', str(transcript),
            '--output-json', str(out_json),
            '--output-markdown', str(out_md),
            '--runtime-dir', str(tmp_path),
            '--model-path', str(tmp_path / 'model.gguf'),
            '--language', 'en',
            '--source-transcript-hash', tx_hash,
            '--model-id', 'qwen3.5-9b-q4-k-m',
            '--tag', 'appointment',
        ],
    )
    sr.main()
    saved = json.loads(out_json.read_text(encoding='utf-8'))
    assert saved['metadata']['tag'] == 'appointment'
    assert saved['metadata']['template'] == 'appointment'
    assert saved['metadata']['templateVersion'] == TEMPLATE_VERSION
    md_text = out_md.read_text(encoding='utf-8')
    assert '## Key Findings' in md_text
    assert '**Tag:** Appointment' in md_text


def test_plain_and_mixed_transcripts_chunk_without_losing_text(tmp_path):
    from backend.summaries.summary_pipeline import chunk_transcript, estimate_token_count

    transcript = tmp_path / "meeting.md"
    sentences = ["Approved calibration today.", "The group agreed to test it tomorrow."]
    oversized_word = "驗證" * 45
    transcript.write_text(
        "# Audio Transcript\n\n" + "\n\n".join([" ".join(sentences * 8), oversized_word]),
        encoding="utf-8",
    )
    segments = load_summary_segments(str(transcript))
    assert len(segments) == 2
    assert all(segment["start"] is None and segment["end"] is None for segment in segments)
    chunks = chunk_transcript(segments, max_tokens=22, prefer_topic_boundaries=False)
    assert len(chunks) > 2
    assert all(estimate_token_count(chunk["text"]) == chunk["estimatedTokens"] <= 22 for chunk in chunks)
    parts = [segment["text"] for chunk in chunks for segment in chunk["segments"]]
    assert all(part.endswith(".") for part in parts if part.isascii())
    assert " ".join(part for part in parts if part.isascii()) == " ".join(sentences * 8)
    assert "".join(part for part in parts if not part.isascii()) == oversized_word

    transcript.write_text(
        "# Audio Transcript\n\nOpening remarks.\n\n**Dr. Lee:** Discussed quotas.\n"
        "Followed up on training.\n\nUnattributed next steps.\n\n**Morgan:**",
        encoding="utf-8",
    )
    segments = load_summary_segments(str(transcript))
    assert [(segment["speaker"], segment["text"]) for segment in segments] == [
        ("Unknown", "Opening remarks."),
        ("Dr. Lee", "Discussed quotas. Followed up on training."),
        ("Unknown", "Unattributed next steps."),
    ]
