import json
import os
import re
import signal
import subprocess
import time
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests' / 'fixtures'
SUCCESS_FIXTURE = FIXTURES / 'speakrs-cli-success.json'
FAILURE_FIXTURE = FIXTURES / 'speakrs-cli-failure.json'
WAV_FIXTURE = FIXTURES / 'speakrs-two-speaker-16k.wav'
CLI_DIR = ROOT / 'native' / 'speakrs-cli'
CARGO_TOML = CLI_DIR / 'Cargo.toml'
FIXTURE_PROVENANCE = FIXTURES / 'README.md'
FIXTURE_GENERATOR = FIXTURES / 'generate_speakrs_fixture.ps1'
REAL_MODELS_DIR = os.environ.get('SPEAKRS_TEST_MODELS_DIR')

SUCCESS_FIELDS = frozenset({'success', 'device', 'annotationSource', 'segments'})
SEGMENT_FIELDS = frozenset({'start', 'end', 'speaker'})
ANNOTATION_SOURCES = frozenset({
    'exclusive_speaker_diarization',
    'speaker_diarization',
})
ALLOWED_DEVICES = frozenset({'cpu', 'coreml', 'cuda'})
SPEAKER_LABEL = re.compile(r'^SPEAKER_\d{2}$')


def _cli_path():
    name = 'speakrs-cli.exe' if os.name == 'nt' else 'speakrs-cli'
    source_mtime = (CLI_DIR / 'src' / 'main.rs').stat().st_mtime
    candidates = [
        CLI_DIR / 'target' / 'debug' / name,
        CLI_DIR / 'target' / 'release' / name,
    ]
    existing = [
        path
        for path in candidates
        if path.is_file() and path.stat().st_mtime >= source_mtime
    ]
    if existing:
        return max(existing, key=lambda path: path.stat().st_mtime)
    return None


def _cli_env(env):
    merged = os.environ.copy()
    for key in ('SPEAKRS_MODELS_DIR', 'SPEAKRS_MODE', 'SPEAKRS_EXCLUSIVE', 'SPEAKRS_NUM_SPEAKERS'):
        merged.pop(key, None)
    merged.update(env)
    return merged


def _run_cli(args, env):
    return subprocess.run(
        [_cli_path(), *args],
        capture_output=True,
        text=True,
        env=_cli_env(env),
        check=False,
    )


def _single_stdout_payload(result):
    lines = result.stdout.splitlines()
    assert len(lines) == 1, f'expected one stdout JSON object, got: {result.stdout!r}'
    return json.loads(lines[0])


def test_success_fixture_json_matches_frozen_contract():
    payload = json.loads(SUCCESS_FIXTURE.read_text(encoding='utf-8'))
    assert set(payload) == SUCCESS_FIELDS
    assert payload['success'] is True
    assert payload['device'] in ALLOWED_DEVICES
    assert payload['annotationSource'] in ANNOTATION_SOURCES
    assert payload['annotationSource'] == 'exclusive_speaker_diarization'
    assert payload['segments']
    for segment in payload['segments']:
        assert set(segment) == SEGMENT_FIELDS
        assert isinstance(segment['start'], (int, float))
        assert isinstance(segment['end'], (int, float))
        assert SPEAKER_LABEL.match(segment['speaker'])


def test_failure_fixture_json_is_single_line_success_false():
    raw = FAILURE_FIXTURE.read_text(encoding='utf-8').strip()
    payload = json.loads(raw)
    assert payload == {'success': False, 'error': payload['error']}
    assert payload['success'] is False
    assert isinstance(payload['error'], str)
    assert payload['error']
    assert '\n' not in payload['error']
    assert '\r' not in payload['error']


def test_fixture_wav_is_licensed_local_mono_16k():
    assert WAV_FIXTURE.is_file()
    assert FIXTURE_GENERATOR.is_file()
    provenance = FIXTURE_PROVENANCE.read_text(encoding='utf-8')
    assert 'original test dialogue' in provenance
    assert 'AvaNevis' in provenance
    assert 'does not contain or sample third-party recordings' in provenance
    with wave.open(str(WAV_FIXTURE), 'rb') as handle:
        assert handle.getnchannels() == 1
        assert handle.getframerate() == 16000
        assert handle.getsampwidth() == 2
        duration = handle.getnframes() / float(handle.getframerate())
    assert 14.0 <= duration <= 16.0


def test_cargo_toml_keeps_online_compiled_out():
    manifest = CARGO_TOML.read_text(encoding='utf-8')
    assert 'default-features = false' in manifest
    assert 'default-linalg' in manifest
    assert 'coreml' in manifest
    assert 'cuda' in manifest
    assert 'load-dynamic' in manifest
    assert '"online"' not in manifest
    assert 'from_pretrained' not in (CLI_DIR / 'src' / 'main.rs').read_text(encoding='utf-8')


@pytest.mark.skipif(_cli_path() is None, reason='speakrs-cli binary not built')
def test_cli_missing_models_emits_structured_failure(tmp_path):
    result = _run_cli(
        [str(WAV_FIXTURE)],
        {
            'SPEAKRS_MODELS_DIR': str(tmp_path / 'missing-models'),
            'SPEAKRS_MODE': 'cpu',
        },
    )
    assert result.returncode != 0
    payload = _single_stdout_payload(result)
    assert payload['success'] is False
    assert 're-run speaker setup' in payload['error']
    assert '\n' not in payload['error']
    assert result.stderr.strip()
    with pytest.raises(json.JSONDecodeError):
        json.loads(result.stderr)

    missing_env = _run_cli(
        [str(WAV_FIXTURE)],
        {'SPEAKRS_MODE': 'cpu'},
    )
    assert missing_env.returncode != 0
    missing_env_payload = _single_stdout_payload(missing_env)
    assert missing_env_payload['success'] is False
    assert 're-run speaker setup' in missing_env_payload['error']


@pytest.mark.skipif(_cli_path() is None, reason='speakrs-cli binary not built')
def test_cli_rejects_num_speakers_and_fast_modes(tmp_path):
    models = tmp_path / 'models'
    models.mkdir()
    (models / 'placeholder').write_text('x', encoding='utf-8')

    num_speakers = _run_cli(
        [str(WAV_FIXTURE)],
        {
            'SPEAKRS_MODELS_DIR': str(models),
            'SPEAKRS_MODE': 'cpu',
            'SPEAKRS_NUM_SPEAKERS': '2',
        },
    )
    assert num_speakers.returncode != 0
    payload = _single_stdout_payload(num_speakers)
    assert payload['success'] is False
    assert 'auto-only' in payload['error']

    fast_mode = _run_cli(
        [str(WAV_FIXTURE)],
        {
            'SPEAKRS_MODELS_DIR': str(models),
            'SPEAKRS_MODE': 'cuda-fast',
        },
    )
    assert fast_mode.returncode != 0
    fast_payload = _single_stdout_payload(fast_mode)
    assert fast_payload['success'] is False
    assert 'expected cpu, coreml, or cuda' in fast_payload['error']


@pytest.mark.skipif(
    _cli_path() is None or not REAL_MODELS_DIR or not Path(REAL_MODELS_DIR).is_dir(),
    reason='speakrs-cli binary or real model directory not available',
)
def test_cli_real_fixture_inference_smoke():
    result = _run_cli(
        [str(WAV_FIXTURE)],
        {
            'SPEAKRS_MODELS_DIR': REAL_MODELS_DIR,
            'SPEAKRS_MODE': 'cpu',
        },
    )
    assert result.returncode == 0, result.stderr
    payload = _single_stdout_payload(result)
    assert set(payload) == SUCCESS_FIELDS
    assert payload['success'] is True
    assert payload['device'] == 'cpu'
    assert payload['annotationSource'] == 'exclusive_speaker_diarization'
    assert payload['segments']


@pytest.mark.skipif(
    _cli_path() is None or not REAL_MODELS_DIR or not Path(REAL_MODELS_DIR).is_dir(),
    reason='speakrs-cli binary or real model directory not available',
)
def test_cli_termination_signal_exits_promptly():
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
    process = subprocess.Popen(
        [_cli_path(), str(WAV_FIXTURE)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_cli_env({
            'SPEAKRS_MODELS_DIR': REAL_MODELS_DIR,
            'SPEAKRS_MODE': 'cpu',
        }),
        creationflags=creationflags,
    )
    time.sleep(0.5)
    assert process.poll() is None, 'CLI exited before its termination handler could be exercised'

    started = time.monotonic()
    if os.name == 'nt':
        process.send_signal(signal.CTRL_BREAK_EVENT)
    else:
        process.terminate()
    process.communicate(timeout=2)

    assert process.returncode != 0
    assert time.monotonic() - started < 2


@pytest.mark.skipif(_cli_path() is None, reason='speakrs-cli binary not built')
def test_cli_binary_has_no_hf_host_strings():
    data = Path(_cli_path()).read_bytes().lower()
    assert b'huggingface' not in data
    assert b'avencera/speakrs-models' not in data
