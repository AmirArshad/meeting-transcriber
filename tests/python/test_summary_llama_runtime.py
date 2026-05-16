from pathlib import Path

import pytest

from backend.summaries.llama_runtime import (
    SummaryRuntimeError,
    build_llama_cli_args,
    build_summary_progress_event,
    default_llama_executable_name,
    get_platform_acceleration,
    normalize_platform,
    resolve_llama_runtime,
    smoke_test_llama_runtime,
)


def test_normalize_platform_matches_electron_style_names():
    assert normalize_platform('Windows', 'AMD64') == {'platform': 'win32', 'arch': 'x64'}
    assert normalize_platform('Darwin', 'arm64') == {'platform': 'darwin', 'arch': 'arm64'}


def test_platform_acceleration_targets_cuda_and_metal_only():
    assert get_platform_acceleration('win32', 'x64') == 'cuda'
    assert get_platform_acceleration('darwin', 'arm64') == 'metal'
    assert get_platform_acceleration('linux', 'x64') == 'unsupported'


def test_default_llama_executable_name_is_platform_specific():
    assert default_llama_executable_name('win32') == 'llama-cli.exe'
    assert default_llama_executable_name('darwin') == 'llama-cli'


def test_resolve_llama_runtime_requires_executable_and_model(tmp_path):
    runtime_dir = tmp_path / 'runtime'
    runtime_dir.mkdir()
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    with pytest.raises(SummaryRuntimeError, match='runtime not found'):
        resolve_llama_runtime(
            runtime_dir=str(runtime_dir),
            model_path=str(model_path),
            platform='darwin',
            arch='arm64',
        )

    executable = runtime_dir / 'llama-cli'
    executable.write_text('bin', encoding='utf-8')
    runtime = resolve_llama_runtime(
        runtime_dir=str(runtime_dir),
        model_path=str(model_path),
        platform='darwin',
        arch='arm64',
    )

    assert runtime['runtime'] == 'llama.cpp'
    assert runtime['acceleration'] == 'metal'
    assert runtime['executable'] == str(executable)
    assert runtime['modelPath'] == str(model_path)


def test_build_llama_cli_args_uses_json_prompt_file(tmp_path):
    runtime = {
        'executable': str(tmp_path / 'llama-cli'),
        'modelPath': str(tmp_path / 'model.gguf'),
        'contextTokens': 4096,
        'gpuLayers': -1,
    }
    args = build_llama_cli_args(runtime, prompt_path=str(tmp_path / 'prompt.txt'), max_tokens=512)

    assert args[:2] == [runtime['executable'], '--model']
    assert '--file' in args
    assert '--ctx-size' in args
    assert '4096' in args
    assert '--no-display-prompt' in args


def test_smoke_test_llama_runtime_loads_model_with_tiny_prompt(monkeypatch, tmp_path):
    calls = []

    class Result:
        returncode = 0
        stdout = 'llama.cpp help'
        stderr = ''

    def fake_run(args, capture_output, text, check, timeout, **kwargs):
        calls.append((args, capture_output, text, check, timeout, kwargs))
        return Result()

    executable = tmp_path / 'llama-cli'
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')
    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', fake_run)

    smoke_test_llama_runtime({'executable': str(executable), 'modelPath': str(model_path)}, timeout_seconds=5)

    args, capture_output, text, check, timeout, kwargs = calls[0]
    assert args[0] == str(executable)
    assert '--model' in args
    assert str(model_path) in args
    assert '--file' in args
    assert capture_output is True
    assert text is True
    assert check is False
    assert timeout == 5
    assert kwargs['cwd'] == str(tmp_path)


def test_smoke_test_llama_runtime_rejects_failed_help(monkeypatch, tmp_path):
    class Result:
        returncode = 1
        stdout = ''
        stderr = 'missing dll'

    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', lambda *args, **kwargs: Result())

    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    with pytest.raises(SummaryRuntimeError, match='smoke validation failed'):
        smoke_test_llama_runtime({'executable': str(tmp_path / 'llama-cli'), 'modelPath': str(model_path)})


def test_build_summary_progress_event_never_includes_prompt_text():
    event = build_summary_progress_event(
        meeting_id='20260107_104555',
        phase='chunk-summary',
        message='Summarizing chunk',
        chunk_index=1,
        chunk_total=3,
    )

    assert event == {
        'meetingId': '20260107_104555',
        'phase': 'chunk-summary',
        'message': 'Summarizing chunk',
        'chunkIndex': 1,
        'chunkTotal': 3,
    }
