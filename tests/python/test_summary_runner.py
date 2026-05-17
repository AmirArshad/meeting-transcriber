import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend.summaries.summary_runner import (
    generate_summary_from_segments,
    hash_transcript_text,
    load_summary_segments,
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


def test_load_summary_segments_prefers_speaker_sidecar(tmp_path):
    transcript_path = tmp_path / 'meeting.md'
    speakers_path = tmp_path / 'meeting.speakers.json'
    transcript_path.write_text('**[00:01 - 00:02]**\nPlain transcript', encoding='utf-8')
    speakers_path.write_text(json.dumps({'segments': [{'start': 1, 'end': 2, 'speaker': 'Speaker 1', 'text': 'Labeled'}]}), encoding='utf-8')

    segments = load_summary_segments(str(transcript_path), str(speakers_path))

    assert segments == [{'start': 1, 'end': 2, 'speaker': 'Speaker 1', 'text': 'Labeled'}]


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
    assert '# Meeting Summary' in markdown_path.read_text(encoding='utf-8')


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
