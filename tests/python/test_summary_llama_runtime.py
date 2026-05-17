from pathlib import Path

import pytest

from backend.summaries.llama_runtime import (
    SummaryRuntimeError,
    build_llama_cli_args,
    build_llama_smoke_test_args,
    build_summary_progress_event,
    default_llama_executable_name,
    get_platform_acceleration,
    normalize_platform,
    resolve_llama_runtime,
    run_llama_prompt,
    smoke_test_llama_runtime,
    strip_llama_prompt_echo,
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


def test_resolve_llama_runtime_prefers_extracted_windows_executable(tmp_path):
    runtime_dir = tmp_path / 'runtime'
    nested_dir = runtime_dir / 'extract' / 'llama-b9173-bin-win-cuda-12.4-x64'
    nested_dir.mkdir(parents=True)
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')
    top_level_executable = runtime_dir / 'llama-cli.exe'
    nested_executable = nested_dir / 'llama-cli.exe'
    top_level_executable.write_text('orphaned exe', encoding='utf-8')
    nested_executable.write_text('exe with adjacent dlls', encoding='utf-8')

    runtime = resolve_llama_runtime(
        runtime_dir=str(runtime_dir),
        model_path=str(model_path),
        platform='win32',
        arch='x64',
    )

    assert runtime['acceleration'] == 'cuda'
    assert runtime['executable'] == str(nested_executable)


def test_build_llama_cli_args_uses_json_prompt_file(tmp_path):
    runtime = {
        'executable': str(tmp_path / 'llama-cli'),
        'modelPath': str(tmp_path / 'model.gguf'),
        'contextTokens': 4096,
        'gpuLayers': -1,
    }
    args = build_llama_cli_args(runtime, prompt_path=str(tmp_path / 'prompt.txt'), max_tokens=512)

    assert args[0] == runtime['executable']
    assert '--file' in args
    assert '--ctx-size' in args
    assert '4096' in args
    assert '--no-display-prompt' in args
    assert '--no-warmup' in args
    assert '--single-turn' in args
    assert '--simple-io' in args
    assert args[args.index('--reasoning') + 1] == 'off'


def test_smoke_args_use_pinned_runtime_compatible_flags(tmp_path):
    runtime = {
        'executable': str(tmp_path / 'llama-cli'),
        'modelPath': str(tmp_path / 'model.gguf'),
    }
    args = build_llama_smoke_test_args(runtime, prompt_path=str(tmp_path / 'prompt.txt'))

    assert '--seed' in args
    assert args[args.index('--ctx-size') + 1] == '512'
    assert args[args.index('--predict') + 1] == '1'
    assert '--no-mmap' not in args


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


def test_smoke_test_llama_runtime_allows_empty_success_output(monkeypatch, tmp_path):
    class Result:
        returncode = 0
        stdout = ''
        stderr = ''

    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', lambda *args, **kwargs: Result())

    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    smoke_test_llama_runtime({'executable': str(tmp_path / 'llama-cli'), 'modelPath': str(model_path)})


def test_run_llama_prompt_uses_executable_directory(monkeypatch, tmp_path):
    calls = []

    class Result:
        returncode = 0
        stdout = '{"summary":"ok"}'
        stderr = ''

    def fake_run(args, capture_output, text, check, timeout, cwd):
        calls.append((args, capture_output, text, check, timeout, cwd))
        return Result()

    executable = tmp_path / 'runtime' / 'extract' / 'llama-cli.exe'
    executable.parent.mkdir(parents=True)
    prompt_path = tmp_path / 'prompt.txt'
    prompt_path.write_text('prompt', encoding='utf-8')
    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', fake_run)

    output = run_llama_prompt(
        {'executable': str(executable), 'modelPath': str(tmp_path / 'model.gguf')},
        prompt_path=str(prompt_path),
        max_tokens=64,
        timeout_seconds=5,
    )

    assert output == '{"summary":"ok"}'
    assert calls[0][5] == str(executable.parent)


def test_run_llama_prompt_strips_echoed_prompt(monkeypatch, tmp_path):
    prompt_text = 'Return JSON like {"summary":"schema","topics":[]}.'
    generated = '{"summary":"generated","topics":[]}'

    class Result:
        returncode = 0
        stdout = f'Loading model...\n> {prompt_text}\n\n{generated}\n\nExiting...'
        stderr = ''

    executable = tmp_path / 'runtime' / 'llama-cli'
    executable.parent.mkdir(parents=True)
    prompt_path = tmp_path / 'prompt.txt'
    prompt_path.write_text(prompt_text, encoding='utf-8')
    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', lambda *args, **kwargs: Result())

    output = run_llama_prompt(
        {'executable': str(executable), 'modelPath': str(tmp_path / 'model.gguf')},
        prompt_path=str(prompt_path),
        max_tokens=64,
        timeout_seconds=5,
    )

    assert output == f'{generated}\n\nExiting...'
    assert 'schema' not in output


def test_strip_llama_prompt_echo_leaves_plain_generation_output():
    assert strip_llama_prompt_echo('{"summary":"ok"}', 'prompt') == '{"summary":"ok"}'


def test_strip_llama_prompt_echo_does_not_strip_generated_prompt_text():
    prompt_text = 'Return JSON like {"summary":"schema","topics":[]}.'
    raw_output = f'{prompt_text}\n{{"summary":"generated","topics":[]}}'

    assert strip_llama_prompt_echo(raw_output, prompt_text) == raw_output


def test_strip_llama_prompt_echo_handles_crlf_echo():
    prompt_text = 'Line one\nLine two'
    raw_output = 'Loading model...\n> Line one\r\nLine two\n\n{"summary":"ok"}'

    assert strip_llama_prompt_echo(raw_output, prompt_text) == '{"summary":"ok"}'


def test_smoke_test_llama_runtime_rejects_failed_help(monkeypatch, tmp_path):
    class Result:
        returncode = 1
        stdout = ''
        stderr = 'missing dll'

    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', lambda *args, **kwargs: Result())

    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    with pytest.raises(SummaryRuntimeError, match='Local summary runtime validation failed: missing dll'):
        smoke_test_llama_runtime({'executable': str(tmp_path / 'llama-cli'), 'modelPath': str(model_path)})


def test_smoke_test_llama_runtime_reports_timeout_without_command(monkeypatch, tmp_path):
    def fake_timeout(args, **kwargs):
        import subprocess

        raise subprocess.TimeoutExpired(cmd=args[0] if args else ['llama-cli'], timeout=kwargs['timeout'])

    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', fake_timeout)
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    with pytest.raises(SummaryRuntimeError) as excinfo:
        smoke_test_llama_runtime({'executable': str(tmp_path / 'runtime' / 'llama-cli'), 'modelPath': str(model_path)}, timeout_seconds=3)

    message = str(excinfo.value)
    assert 'timed out after 3 seconds' in message
    assert '--model' not in message
    assert str(tmp_path) not in message


def test_smoke_test_llama_runtime_redacts_paths(monkeypatch, tmp_path):
    class Result:
        returncode = 1
        stdout = ''
        stderr = f"error: failed to open {tmp_path / 'model.gguf'}"

    monkeypatch.setattr('backend.summaries.llama_runtime.subprocess.run', lambda *args, **kwargs: Result())
    model_path = tmp_path / 'model.gguf'
    model_path.write_text('model', encoding='utf-8')

    with pytest.raises(SummaryRuntimeError) as excinfo:
        smoke_test_llama_runtime({'executable': str(tmp_path / 'runtime' / 'llama-cli'), 'modelPath': str(model_path)})

    assert str(tmp_path) not in str(excinfo.value)
    assert '<model>' in str(excinfo.value) or '<path>' in str(excinfo.value)


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
