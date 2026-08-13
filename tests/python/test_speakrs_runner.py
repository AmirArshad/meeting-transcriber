import json
import os
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import pytest

from backend.diarization import diarization_pipeline as pipeline
from backend.diarization import speakrs_runner as runner

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests' / 'fixtures'
SUCCESS_FIXTURE = FIXTURES / 'speakrs-cli-success.json'
FAILURE_FIXTURE = FIXTURES / 'speakrs-cli-failure.json'
WAV_FIXTURE = FIXTURES / 'speakrs-two-speaker-16k.wav'


def _pid_alive(pid: int) -> bool:
    if os.name == 'nt':
        result = subprocess.run(
            ['tasklist', '/FI', f'PID eq {pid}', '/NH'],
            capture_output=True,
            text=True,
            check=False,
        )
        return str(pid) in (result.stdout or '')
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _compact_json(payload) -> str:
    if isinstance(payload, Path):
        payload = json.loads(payload.read_text(encoding='utf-8'))
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=True)


def _write_fake_cli(
    directory: Path,
    *,
    hang: bool = False,
    payload: Optional[dict] = None,
    exit_code: int = 0,
    stdout_text: Optional[str] = None,
    stderr_text: Optional[str] = None,
    stdout_bytes: Optional[bytes] = None,
) -> Path:
    script = directory / 'fake_speakrs_cli.py'
    if hang:
        script.write_text(
            'import os, time\n'
            'from pathlib import Path\n'
            "Path(os.environ['SPEAKRS_TEST_PID_FILE']).write_text(str(os.getpid()), encoding='utf-8')\n"
            'time.sleep(120)\n',
            encoding='utf-8',
        )
        return script

    lines = ['import sys']
    if stdout_bytes is not None:
        lines.append(f'sys.stdout.buffer.write({stdout_bytes!r})')
        lines.append('sys.stdout.buffer.flush()')
    elif stdout_text is not None:
        lines.append(f'print({stdout_text!r})')
    else:
        body = _compact_json(payload if payload is not None else {'success': False, 'error': 'unset'})
        lines.append(f'print({body!r})')
    if stderr_text is not None:
        lines.append(f'print({stderr_text!r}, file=sys.stderr)')
    lines.append(f'sys.exit({int(exit_code)})')
    script.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return script


def _native_cli_name() -> str:
    return runner.speakrs_cli_executable_name()


def _write_native_cli_stub(directory: Path) -> Path:
    cli = directory / _native_cli_name()
    cli.write_bytes(b'native-stub')
    return cli


def _success_payload(*, device: str = 'cuda', segments=None, annotation_source: str = 'exclusive_speaker_diarization') -> dict:
    if segments is None:
        segments = [{'start': 0, 'end': 1, 'speaker': 'SPEAKER_00'}]
    return {
        'success': True,
        'device': device,
        'annotationSource': annotation_source,
        'segments': segments,
    }


def test_resolve_speakrs_mode_maps_mps_to_coreml():
    assert runner.resolve_speakrs_mode('cuda') == 'cuda'
    assert runner.resolve_speakrs_mode('mps') == 'coreml'
    assert runner.resolve_speakrs_mode('COREML') == 'coreml'
    assert runner.resolve_speakrs_mode(None, env={'SPEAKRS_MODE': 'cpu'}) == 'cpu'
    with pytest.raises(ValueError, match='CPU fallback is disabled'):
        runner.resolve_speakrs_mode('cpu')
    with pytest.raises(ValueError, match='CPU fallback is disabled'):
        runner.resolve_speakrs_mode(None, env={})


def test_resolve_speakrs_cli_path_prefers_env_and_skips_which_when_packaged(tmp_path, monkeypatch):
    cli = _write_native_cli_stub(tmp_path)
    which_calls = []
    monkeypatch.setattr(shutil, 'which', lambda name: which_calls.append(name) or str(tmp_path / 'from-path'))

    resolved = runner.resolve_speakrs_cli_path(env={'SPEAKRS_CLI_PATH': str(cli), 'AVANEVIS_PACKAGED': '1'})
    assert resolved == cli
    assert which_calls == []

    missing_env = {'SPEAKRS_CLI_PATH': str(tmp_path / 'missing'), 'AVANEVIS_PACKAGED': '1'}
    with pytest.raises(FileNotFoundError, match='SPEAKRS_CLI_PATH'):
        runner.resolve_speakrs_cli_path(env=missing_env)

    packaged_module = tmp_path / 'resources' / 'backend' / 'diarization' / 'speakrs_runner.py'
    packaged_module.parent.mkdir(parents=True)
    packaged_module.write_text('#', encoding='utf-8')
    with pytest.raises(FileNotFoundError, match='PATH lookup skipped'):
        runner.resolve_speakrs_cli_path(
            env={'AVANEVIS_PACKAGED': '1'},
            module_file=str(packaged_module),
        )
    assert which_calls == []


def test_resolve_speakrs_cli_path_dev_native_release_layout(tmp_path, monkeypatch):
    module = tmp_path / 'backend' / 'diarization' / 'speakrs_runner.py'
    module.parent.mkdir(parents=True)
    module.write_text('#', encoding='utf-8')
    cli = tmp_path / 'native' / 'speakrs-cli' / 'target' / 'release' / _native_cli_name()
    cli.parent.mkdir(parents=True)
    cli.write_bytes(b'native')
    which_calls = []
    monkeypatch.setattr(shutil, 'which', lambda name: which_calls.append(name) or str(tmp_path / 'from-path'))

    resolved = runner.resolve_speakrs_cli_path(env={}, module_file=str(module))
    assert resolved == cli
    assert which_calls == []


def test_resolve_speakrs_cli_path_packaged_resources_bin(tmp_path, monkeypatch):
    module = tmp_path / 'resources' / 'backend' / 'diarization' / 'speakrs_runner.py'
    module.parent.mkdir(parents=True)
    module.write_text('#', encoding='utf-8')
    cli = tmp_path / 'resources' / 'bin' / _native_cli_name()
    cli.parent.mkdir(parents=True)
    cli.write_bytes(b'native')
    decoy = tmp_path / 'resources' / 'native' / 'speakrs-cli' / 'target' / 'release' / _native_cli_name()
    decoy.parent.mkdir(parents=True)
    decoy.write_bytes(b'dev-decoy')
    which_calls = []
    monkeypatch.setattr(shutil, 'which', lambda name: which_calls.append(name) or str(tmp_path / 'from-path'))

    resolved = runner.resolve_speakrs_cli_path(
        env={'AVANEVIS_PACKAGED': '1'},
        module_file=str(module),
    )
    assert resolved == cli
    assert which_calls == []


def test_resolve_speakrs_cli_path_rejects_packaged_python_wrapper(tmp_path):
    script = tmp_path / 'fake_speakrs_cli.py'
    script.write_text('print("nope")\n', encoding='utf-8')
    with pytest.raises(FileNotFoundError, match='bundled native CLI'):
        runner.resolve_speakrs_cli_path(env={
            'SPEAKRS_CLI_PATH': str(script),
            'AVANEVIS_PACKAGED': '1',
        })


def test_resolve_speakrs_cli_path_accepts_unpackaged_python_wrapper(tmp_path):
    script = tmp_path / 'fake_speakrs_cli.py'
    script.write_text('print("ok")\n', encoding='utf-8')
    resolved = runner.resolve_speakrs_cli_path(env={'SPEAKRS_CLI_PATH': str(script)})
    assert resolved == script


def test_build_speakrs_cli_command_packaged_native_vs_python(tmp_path):
    wav = tmp_path / 'audio.wav'
    wav.write_bytes(b'RIFF')
    native = _write_native_cli_stub(tmp_path)
    script = tmp_path / 'fake_speakrs_cli.py'
    script.write_text('print("nope")\n', encoding='utf-8')

    assert runner.build_speakrs_cli_command(
        native,
        wav,
        env={'AVANEVIS_PACKAGED': '1'},
    ) == [str(native), str(wav)]

    with pytest.raises(FileNotFoundError, match='bundled native CLI'):
        runner.build_speakrs_cli_command(script, wav, env={'AVANEVIS_PACKAGED': '1'})

    command = runner.build_speakrs_cli_command(script, wav, env={})
    assert command == [sys.executable, str(script), str(wav)]


def test_resolve_speakrs_validate_wav_dev_repo_fixtures():
    resolved = runner.resolve_speakrs_validate_wav(env={})
    assert resolved.resolve() == WAV_FIXTURE.resolve()


def test_resolve_speakrs_validate_wav_dev_and_packaged_layouts(tmp_path, monkeypatch):
    module = tmp_path / 'backend' / 'diarization' / 'speakrs_runner.py'
    module.parent.mkdir(parents=True)
    module.write_text('#', encoding='utf-8')
    repo_wav = tmp_path / 'tests' / 'fixtures' / runner.VALIDATE_WAV_NAME
    repo_wav.parent.mkdir(parents=True)
    repo_wav.write_bytes(b'RIFF')
    local_wav = module.parent / 'fixtures' / runner.VALIDATE_WAV_NAME
    local_wav.parent.mkdir(parents=True)
    local_wav.write_bytes(b'RIFF-local')

    assert runner.resolve_speakrs_validate_wav(env={}, module_file=str(module)) == local_wav

    local_wav.unlink()
    assert runner.resolve_speakrs_validate_wav(env={}, module_file=str(module)) == repo_wav

    packaged_module = tmp_path / 'resources' / 'backend' / 'diarization' / 'speakrs_runner.py'
    packaged_module.parent.mkdir(parents=True)
    packaged_module.write_text('#', encoding='utf-8')
    packaged_decoy = tmp_path / 'resources' / 'tests' / 'fixtures' / runner.VALIDATE_WAV_NAME
    packaged_decoy.parent.mkdir(parents=True)
    packaged_decoy.write_bytes(b'decoy')
    with pytest.raises(FileNotFoundError, match='validation fixture WAV'):
        runner.resolve_speakrs_validate_wav(
            env={'AVANEVIS_PACKAGED': '1'},
            module_file=str(packaged_module),
        )

    cli = tmp_path / 'resources' / 'bin' / _native_cli_name()
    cli.parent.mkdir(parents=True)
    cli.write_bytes(b'native')
    beside = cli.parent / runner.VALIDATE_WAV_NAME
    beside.write_bytes(b'beside')
    resolved = runner.resolve_speakrs_validate_wav(
        env={'AVANEVIS_PACKAGED': '1'},
        module_file=str(packaged_module),
        cli_path=cli,
    )
    assert resolved == beside


def test_resolve_speakrs_validate_wav_skips_tests_fixtures_when_packaged(tmp_path):
    packaged_module = tmp_path / 'resources' / 'backend' / 'diarization' / 'speakrs_runner.py'
    packaged_module.parent.mkdir(parents=True)
    packaged_module.write_text('#', encoding='utf-8')
    with pytest.raises(FileNotFoundError, match='validation fixture WAV'):
        runner.resolve_speakrs_validate_wav(
            env={'AVANEVIS_PACKAGED': '1'},
            module_file=str(packaged_module),
        )

    assert runner.resolve_speakrs_validate_wav(
        env={'SPEAKRS_VALIDATE_WAV': str(WAV_FIXTURE)},
    ) == WAV_FIXTURE


def test_build_speakrs_child_env_clears_tokens_and_forces_exclusive():
    env = runner.build_speakrs_child_env(
        mode='coreml',
        env={
            'HF_TOKEN': 'hf_secret_token_value',
            'HUGGINGFACE_HUB_TOKEN': 'hf_other',
            'HUGGING_FACE_HUB_TOKEN': 'legacy',
            'HF_TOKEN_PATH': '',
            'SPEAKRS_NUM_SPEAKERS': '2',
            'SPEAKRS_MODELS_DIR': '/models',
            'SPEAKRS_EXCLUSIVE': '0',
            'PATH': '/bin',
        },
    )
    assert 'HF_TOKEN' not in env
    assert 'HUGGINGFACE_HUB_TOKEN' not in env
    assert 'HUGGING_FACE_HUB_TOKEN' not in env
    assert 'SPEAKRS_NUM_SPEAKERS' not in env
    assert env['HF_TOKEN_PATH'] == os.devnull
    assert env['HF_TOKEN_PATH'] not in {'', '.'}
    assert env['SPEAKRS_MODE'] == 'coreml'
    assert env['SPEAKRS_EXCLUSIVE'] == '1'
    assert env['SPEAKRS_MODELS_DIR'] == '/models'


def test_spawn_speakrs_cli_stays_in_same_process_group(monkeypatch, tmp_path):
    captured = {}

    def fake_popen(command, **kwargs):
        captured['command'] = command
        captured['kwargs'] = kwargs
        return SimpleNamespace(pid=1)

    monkeypatch.setattr(runner.subprocess, 'Popen', fake_popen)
    cli = _write_native_cli_stub(tmp_path)
    wav = tmp_path / 'audio.wav'
    wav.write_bytes(b'RIFF')

    runner.spawn_speakrs_cli(cli, wav, env={'SPEAKRS_MODE': 'cuda'})

    assert 'start_new_session' not in captured['kwargs']
    assert 'creationflags' not in captured['kwargs']
    flags = int(captured['kwargs'].get('creationflags') or 0)
    create_new_group = int(getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) or 0)
    assert flags & create_new_group == 0


def test_parse_speakrs_cli_stdout_reads_compact_success_and_failure_fixtures():
    success = runner.parse_speakrs_cli_stdout(_compact_json(SUCCESS_FIXTURE))
    segments, source, device = runner.speaker_result_from_payload(success, mode='cuda')
    assert source == 'exclusive_speaker_diarization'
    assert device == 'cuda'
    assert segments == [
        {'start': 0.0, 'end': 2.5, 'speaker': 'SPEAKER_00'},
        {'start': 2.5, 'end': 5.0, 'speaker': 'SPEAKER_01'},
    ]

    failure = runner.parse_speakrs_cli_stdout(_compact_json(FAILURE_FIXTURE))
    with pytest.raises(RuntimeError, match='re-run speaker setup'):
        runner.speaker_result_from_payload(failure, mode='cuda')


@pytest.mark.parametrize('stdout', [
    '',
    '   ',
    '{',
    '[]',
    'true',
    'diagnostic\n{"success":true,"device":"cuda","annotationSource":"exclusive_speaker_diarization","segments":[]}',
    '{"success":true,"device":"cuda","annotationSource":"exclusive_speaker_diarization","segments":[]}\ntrailing',
    '{"success":false,"error":"first"}{"success":true,"device":"cuda","annotationSource":"exclusive_speaker_diarization","segments":[]}',
    '{"success":true,"device":"cuda","annotationSource":"exclusive_speaker_diarization","segments":[]}\n{"success":false,"error":"second"}',
])
def test_parse_speakrs_cli_stdout_rejects_noisy_or_non_single_object(stdout):
    with pytest.raises(RuntimeError, match='invalid output'):
        runner.parse_speakrs_cli_stdout(stdout)


def test_parse_speakrs_cli_stdout_rejects_pretty_printed_fixture():
    with pytest.raises(RuntimeError, match='invalid output'):
        runner.parse_speakrs_cli_stdout(SUCCESS_FIXTURE.read_text(encoding='utf-8'))


def test_speaker_result_from_payload_rejects_mismatched_and_noncanonical_devices():
    payload = _success_payload(device='cpu')
    with pytest.raises(RuntimeError, match='unexpected device'):
        runner.speaker_result_from_payload(payload, mode='cuda')

    payload = _success_payload(device='CUDA')
    with pytest.raises(RuntimeError, match='unexpected device'):
        runner.speaker_result_from_payload(payload, mode='cuda')

    payload = _success_payload(device='cuda ')
    with pytest.raises(RuntimeError, match='unexpected device'):
        runner.speaker_result_from_payload(payload, mode='cuda')

    payload = _success_payload(device='unknown')
    with pytest.raises(RuntimeError, match='unexpected device'):
        runner.speaker_result_from_payload(payload, mode='cuda')

    payload = _success_payload(device='coreml')
    segments, source, device = runner.speaker_result_from_payload(payload, mode='coreml')
    assert (source, device, segments[0]['speaker']) == ('exclusive_speaker_diarization', 'coreml', 'SPEAKER_00')

    payload = _success_payload(device='cpu')
    _, _, device = runner.speaker_result_from_payload(payload, mode='cpu')
    assert device == 'cpu'


def test_speaker_result_from_payload_requires_exclusive_annotation_source():
    payload = _success_payload(annotation_source='speaker_diarization')
    with pytest.raises(RuntimeError, match='unsupported annotation source'):
        runner.speaker_result_from_payload(payload, mode='cuda')


def test_run_speakrs_diarization_maps_mocked_cli_and_redacts_errors(monkeypatch, tmp_path, capsys):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    cli = _write_fake_cli(tmp_path, payload=_success_payload(device='coreml'))
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)
    phases = []
    original = pipeline.emit_progress

    def wrapped(phase, message, *, percent=None):
        phases.append(str(phase))
        return original(phase, message, percent=percent)

    monkeypatch.setattr(pipeline, 'emit_progress', wrapped)

    segments, source, device = runner.run_speakrs_diarization(wav, required_device='mps')
    assert segments == [{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}]
    assert source == 'exclusive_speaker_diarization'
    assert device == 'coreml'
    assert phases == ['validating-accelerator', 'loading-model', 'running-model', 'merging-speakers']

    fail_cli = _write_fake_cli(
        tmp_path,
        payload={'success': False, 'error': 'failed hf_secret_token_value'},
        exit_code=1,
    )
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(fail_cli))
    with pytest.raises(RuntimeError) as exc_info:
        runner.run_speakrs_diarization(wav, required_device='cuda')
    assert 'hf_secret_token_value' not in str(exc_info.value)
    assert '[redacted-token]' in str(exc_info.value)
    assert '\n' not in str(exc_info.value)
    captured = capsys.readouterr()
    assert 'hf_secret_token_value' not in captured.err


def test_run_speakrs_diarization_allows_empty_segments_for_silent_audio(monkeypatch, tmp_path):
    wav = tmp_path / 'silent.wav'
    wav.write_bytes(b'RIFF')
    cli = _write_fake_cli(tmp_path, payload=_success_payload(device='cuda', segments=[]))
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)

    segments, source, device = runner.run_speakrs_diarization(wav, required_device='cuda')

    assert segments == []
    assert source == 'exclusive_speaker_diarization'
    assert device == 'cuda'


def test_run_speakrs_diarization_does_not_import_torch(monkeypatch, tmp_path):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    cli = _write_fake_cli(tmp_path, payload=_success_payload(device='cuda'))
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)
    sys.modules.pop('torch', None)

    runner.run_speakrs_diarization(wav, required_device='cuda')

    assert 'torch' not in sys.modules


def test_run_speakrs_diarization_ignores_stderr_even_when_it_contains_json(monkeypatch, tmp_path):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    success = _compact_json(_success_payload(device='cuda'))
    cli = _write_fake_cli(tmp_path, stdout_bytes=b'', stderr_text=success)
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)

    with pytest.raises(RuntimeError, match='invalid output'):
        runner.run_speakrs_diarization(wav, required_device='cuda')


def test_run_speakrs_diarization_bounds_stdout(monkeypatch, tmp_path):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    monkeypatch.setattr(runner, 'MAX_SPEAKRS_STDOUT_BYTES', 64)
    overflow_cli = _write_fake_cli(tmp_path, stdout_bytes=b'x' * 200)
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(overflow_cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)
    with pytest.raises(RuntimeError, match='invalid output'):
        runner.run_speakrs_diarization(wav, required_device='cuda')


def test_run_speakrs_diarization_drains_verbose_stderr_without_using_it(monkeypatch, tmp_path):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    noisy = _write_fake_cli(
        tmp_path,
        payload=_success_payload(device='cuda'),
        stderr_text='diag ' * 20000,
    )
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(noisy))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)
    segments, source, device = runner.run_speakrs_diarization(wav, required_device='cuda')
    assert segments
    assert source == 'exclusive_speaker_diarization'
    assert device == 'cuda'


def test_run_speakrs_diarization_kills_cli_when_output_collection_raises(monkeypatch, tmp_path):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    cli = _write_fake_cli(tmp_path, hang=True)
    pid_file = tmp_path / 'cli.pid'
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.setenv('SPEAKRS_TEST_PID_FILE', str(pid_file))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)

    def boom(proc):
        deadline = time.time() + 5
        while time.time() < deadline and not pid_file.exists():
            time.sleep(0.05)
        raise RuntimeError('pipe broke')

    monkeypatch.setattr(runner, 'collect_speakrs_cli_output', boom)
    with pytest.raises(RuntimeError, match='pipe broke'):
        runner.run_speakrs_diarization(wav, required_device='cuda')

    assert pid_file.exists()
    cli_pid = int(pid_file.read_text(encoding='utf-8').strip())
    deadline = time.time() + 5
    while time.time() < deadline and _pid_alive(cli_pid):
        time.sleep(0.05)
    assert not _pid_alive(cli_pid)


def test_run_speakrs_diarization_rejects_packaged_python_wrapper(monkeypatch, tmp_path):
    wav = tmp_path / 'meeting.wav'
    wav.write_bytes(b'RIFF')
    cli = _write_fake_cli(tmp_path, payload=_success_payload(device='cuda'))
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.setenv('AVANEVIS_PACKAGED', '1')

    with pytest.raises(FileNotFoundError, match='bundled native CLI'):
        runner.run_speakrs_diarization(wav, required_device='cuda')


def test_validate_speakrs_setup_smokes_fixture_without_token(monkeypatch, tmp_path):
    cli = _write_fake_cli(tmp_path, payload=_success_payload(device='cuda'))
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.setenv('SPEAKRS_VALIDATE_WAV', str(WAV_FIXTURE))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)
    monkeypatch.delenv('HF_TOKEN', raising=False)
    monkeypatch.delenv('HUGGINGFACE_HUB_TOKEN', raising=False)
    monkeypatch.setattr(pipeline, 'assert_required_device_available', lambda _device: (_ for _ in ()).throw(AssertionError('torch')))

    result = runner.validate_speakrs_setup(required_device='cuda')

    assert result == {
        'status': 'ready',
        'model': runner.SPEAKRS_MODEL_ID,
        'device': 'cuda',
    }


def test_validate_speakrs_setup_rejects_empty_segments(monkeypatch, tmp_path):
    cli = _write_fake_cli(tmp_path, payload=_success_payload(device='cuda', segments=[]))
    monkeypatch.setenv('SPEAKRS_CLI_PATH', str(cli))
    monkeypatch.setenv('SPEAKRS_MODELS_DIR', str(tmp_path))
    monkeypatch.setenv('SPEAKRS_VALIDATE_WAV', str(WAV_FIXTURE))
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)

    with pytest.raises(RuntimeError, match='no speaker segments'):
        runner.validate_speakrs_setup(required_device='cuda')


def test_group_kill_reaps_speakrs_cli(tmp_path):
    fake_cli = _write_fake_cli(tmp_path, hang=True)
    pid_file = tmp_path / 'cli.pid'
    wav = tmp_path / 'audio.wav'
    wav.write_bytes(b'RIFF')
    models = tmp_path / 'models'
    models.mkdir()
    (models / 'placeholder').write_text('x', encoding='utf-8')

    env = os.environ.copy()
    env.update({
        'SPEAKRS_CLI_PATH': str(fake_cli),
        'SPEAKRS_MODELS_DIR': str(models),
        'SPEAKRS_MODE': 'cuda',
        'SPEAKRS_TEST_PID_FILE': str(pid_file),
        'PYTHONPATH': os.pathsep.join([str(ROOT), str(ROOT / 'backend'), env.get('PYTHONPATH', '')]),
    })
    env.pop('AVANEVIS_PACKAGED', None)
    parent_script = tmp_path / 'parent.py'
    parent_script.write_text(
        'from pathlib import Path\n'
        'from backend.diarization.speakrs_runner import run_speakrs_diarization\n'
        f'run_speakrs_diarization(Path({str(wav)!r}), required_device="cuda")\n',
        encoding='utf-8',
    )
    popen_kwargs = {'start_new_session': True} if os.name != 'nt' else {}
    parent = subprocess.Popen(
        [sys.executable, str(parent_script)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **popen_kwargs,
    )
    try:
        deadline = time.time() + 15
        while time.time() < deadline and not pid_file.exists():
            if parent.poll() is not None:
                stdout, stderr = parent.communicate()
                raise AssertionError(f'parent exited before spawn: {stdout!r} {stderr!r}')
            time.sleep(0.05)
        assert pid_file.exists(), 'fake CLI did not write its pid'
        cli_pid = int(pid_file.read_text(encoding='utf-8').strip())
        assert _pid_alive(cli_pid)

        if os.name == 'nt':
            subprocess.run(
                ['taskkill', '/PID', str(parent.pid), '/T', '/F'],
                check=False,
                capture_output=True,
                text=True,
            )
        else:
            os.killpg(parent.pid, signal.SIGKILL)
        try:
            parent.wait(timeout=10)
        except subprocess.TimeoutExpired:
            parent.kill()
            parent.wait(timeout=5)

        deadline = time.time() + 10
        while time.time() < deadline and _pid_alive(cli_pid):
            time.sleep(0.05)
        assert not _pid_alive(cli_pid), f'speakrs CLI pid {cli_pid} survived parent kill'
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
