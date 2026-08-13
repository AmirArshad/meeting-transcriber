"""Spawn the bundled speakrs-cli for local speaker diarization."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from common.sensitive_text import redact_sensitive_text

SPEAKRS_MODEL_ID = "speakrs-community1-vbx"
VALIDATE_WAV_NAME = "speakrs-two-speaker-16k.wav"
ALLOWED_SPEAKRS_MODES = frozenset({"cpu", "coreml", "cuda"})
PRODUCT_ANNOTATION_SOURCE = "exclusive_speaker_diarization"
HF_TOKEN_ENV_KEYS = ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN")
INVALID_CLI_OUTPUT = "speakrs-cli produced invalid output."
PACKAGED_NATIVE_CLI_REQUIRED = "Packaged Speakrs runs require the bundled native CLI."
MAX_SPEAKRS_STDOUT_BYTES = 8 * 1024 * 1024
STREAM_READ_CHUNK_BYTES = 65536


def speakrs_cli_executable_name() -> str:
    return "speakrs-cli.exe" if os.name == "nt" else "speakrs-cli"


def _is_packaged(env: Optional[Mapping[str, str]] = None) -> bool:
    environ = os.environ if env is None else env
    return str(environ.get("AVANEVIS_PACKAGED") or "") == "1"


def _module_dir(module_file: Optional[str] = None) -> Path:
    return Path(module_file or __file__).resolve().parent


def _resources_or_repo_root(module_file: Optional[str] = None) -> Path:
    # backend/diarization/speakrs_runner.py -> repo root (dev) or Resources (packaged)
    return _module_dir(module_file).parent.parent


def _is_python_cli_wrapper(path: Path) -> bool:
    return path.suffix.lower() == ".py"


def _assert_trusted_packaged_cli(path: Path) -> None:
    if _is_python_cli_wrapper(path) or path.name != speakrs_cli_executable_name():
        raise FileNotFoundError(PACKAGED_NATIVE_CLI_REQUIRED)


def resolve_speakrs_mode(
    required_device: Optional[str] = None,
    *,
    env: Optional[Mapping[str, str]] = None,
) -> str:
    environ = os.environ if env is None else env
    raw = "" if required_device is None else str(required_device).strip().lower()
    if raw in {"", "auto"}:
        env_mode = str(environ.get("SPEAKRS_MODE") or "").strip().lower()
        if env_mode in ALLOWED_SPEAKRS_MODES:
            return env_mode
        raise ValueError("Speaker diarization requires either CUDA or Metal/MPS acceleration; CPU fallback is disabled.")
    if raw == "cuda":
        return "cuda"
    if raw in {"mps", "coreml"}:
        return "coreml"
    raise ValueError("Speaker diarization requires either CUDA or Metal/MPS acceleration; CPU fallback is disabled.")


def resolve_speakrs_cli_path(
    *,
    env: Optional[Mapping[str, str]] = None,
    module_file: Optional[str] = None,
) -> Path:
    environ = os.environ if env is None else env
    packaged = _is_packaged(environ)
    explicit = str(environ.get("SPEAKRS_CLI_PATH") or "").strip()
    if explicit:
        path = Path(explicit)
        if path.is_file():
            if packaged:
                _assert_trusted_packaged_cli(path)
            return path
        raise FileNotFoundError(f"SPEAKRS_CLI_PATH does not exist: {explicit}")

    name = speakrs_cli_executable_name()
    resources_or_repo = _resources_or_repo_root(module_file)
    candidates = [
        resources_or_repo / "bin" / name,
        resources_or_repo / "native" / "speakrs-cli" / "target" / "release" / name,
    ]
    for candidate in candidates:
        if candidate.is_file():
            if packaged:
                _assert_trusted_packaged_cli(candidate)
            return candidate

    if packaged:
        raise FileNotFoundError("speakrs-cli not found in packaged app resources (PATH lookup skipped)")

    which_path = shutil.which(name) or shutil.which("speakrs-cli")
    if which_path:
        return Path(which_path)
    raise FileNotFoundError("speakrs-cli not found")


def resolve_speakrs_validate_wav(
    *,
    env: Optional[Mapping[str, str]] = None,
    module_file: Optional[str] = None,
    cli_path: Optional[Path] = None,
) -> Path:
    environ = os.environ if env is None else env
    packaged = _is_packaged(environ)
    explicit = str(environ.get("SPEAKRS_VALIDATE_WAV") or "").strip()
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return path
        raise FileNotFoundError(f"SPEAKRS_VALIDATE_WAV does not exist: {explicit}")

    current_dir = _module_dir(module_file)
    resources_or_repo = _resources_or_repo_root(module_file)
    candidates: List[Path] = []
    if cli_path is not None:
        candidates.append(Path(cli_path).resolve().parent / VALIDATE_WAV_NAME)
    if packaged:
        candidates.append(resources_or_repo / "bin" / VALIDATE_WAV_NAME)
    else:
        candidates.extend([
            current_dir / "fixtures" / VALIDATE_WAV_NAME,
            resources_or_repo / "bin" / VALIDATE_WAV_NAME,
            resources_or_repo / "tests" / "fixtures" / VALIDATE_WAV_NAME,
        ])

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("Speakrs validation fixture WAV was not found.")


def build_speakrs_child_env(
    *,
    mode: str,
    env: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    child = {
        str(key): str(value)
        for key, value in (os.environ if env is None else env).items()
        if value is not None
    }
    for key in HF_TOKEN_ENV_KEYS:
        child.pop(key, None)
    child.pop("SPEAKRS_NUM_SPEAKERS", None)
    child["HF_TOKEN_PATH"] = os.devnull
    child["SPEAKRS_MODE"] = mode
    child["SPEAKRS_EXCLUSIVE"] = "1"
    return child


def build_speakrs_cli_command(
    cli_path: Path,
    wav_path: Path,
    *,
    env: Optional[Mapping[str, str]] = None,
) -> List[str]:
    resolved = Path(cli_path)
    if _is_packaged(env):
        _assert_trusted_packaged_cli(resolved)
        return [str(resolved), str(wav_path)]
    if _is_python_cli_wrapper(resolved):
        return [sys.executable, str(resolved), str(wav_path)]
    return [str(resolved), str(wav_path)]


def spawn_speakrs_cli(
    cli_path: Path,
    wav_path: Path,
    *,
    env: Mapping[str, str],
) -> subprocess.Popen:
    # Same process group as this Python child. Never start_new_session / CREATE_NEW_PROCESS_GROUP.
    return subprocess.Popen(
        build_speakrs_cli_command(cli_path, wav_path, env=env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(env),
    )


def terminate_speakrs_cli(proc: Optional[subprocess.Popen]) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.kill()
    except OSError:
        return
    try:
        proc.wait(timeout=2)
    except Exception:
        pass


def collect_speakrs_cli_output(proc: subprocess.Popen) -> str:
    """Read CLI pipes with a stdout cap. stderr is drained and never used for control.

    There is no internal timeout: Electron's wall-clock tree kill is the primary
    hung-CLI abort. This function must still return or raise so callers can reap.
    """
    stdout_chunks: List[bytes] = []
    stdout_size = 0
    stdout_overflow = False
    reader_errors: List[BaseException] = []

    def read_stdout() -> None:
        nonlocal stdout_size, stdout_overflow
        stream = proc.stdout
        if stream is None:
            return
        try:
            while True:
                chunk = stream.read(STREAM_READ_CHUNK_BYTES)
                if not chunk:
                    break
                if stdout_overflow:
                    continue
                stdout_size += len(chunk)
                if stdout_size > MAX_SPEAKRS_STDOUT_BYTES:
                    stdout_overflow = True
                    stdout_chunks.clear()
                    terminate_speakrs_cli(proc)
                    continue
                stdout_chunks.append(chunk)
        except BaseException as exc:  # noqa: BLE001 — surface into the waiter
            reader_errors.append(exc)

    def read_stderr() -> None:
        stream = proc.stderr
        if stream is None:
            return
        try:
            while stream.read(STREAM_READ_CHUNK_BYTES):
                pass
        except BaseException as exc:  # noqa: BLE001 — drain failures are non-control
            reader_errors.append(exc)

    threads = [
        threading.Thread(target=read_stdout, name="speakrs-cli-stdout", daemon=True),
        threading.Thread(target=read_stderr, name="speakrs-cli-stderr", daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        proc.wait()
    finally:
        for thread in threads:
            thread.join(timeout=2)
        if proc.stdout is not None:
            try:
                proc.stdout.close()
            except OSError:
                pass
        if proc.stderr is not None:
            try:
                proc.stderr.close()
            except OSError:
                pass

    if stdout_overflow:
        raise RuntimeError(INVALID_CLI_OUTPUT)
    if reader_errors:
        raise RuntimeError(INVALID_CLI_OUTPUT) from reader_errors[0]
    return b"".join(stdout_chunks).decode("utf-8", errors="replace")


def parse_speakrs_cli_stdout(stdout: str) -> Dict[str, Any]:
    stripped = str(stdout or "").strip()
    if not stripped or "\n" in stripped or "\r" in stripped:
        raise RuntimeError(INVALID_CLI_OUTPUT)
    try:
        parsed, end = json.JSONDecoder().raw_decode(stripped)
    except json.JSONDecodeError as exc:
        raise RuntimeError(INVALID_CLI_OUTPUT) from exc
    if end != len(stripped) or not isinstance(parsed, dict) or "success" not in parsed:
        raise RuntimeError(INVALID_CLI_OUTPUT)
    return parsed


def speaker_result_from_payload(
    payload: Mapping[str, Any],
    *,
    mode: str,
) -> Tuple[List[Dict[str, Any]], str, str]:
    from .diarization_pipeline import annotation_to_speaker_segments

    if payload.get("success") is not True:
        error = redact_sensitive_text(payload.get("error") or "Speaker diarization failed.")
        raise RuntimeError(error or "Speaker diarization failed.")

    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise RuntimeError("speakrs-cli produced invalid segments.")

    annotation_source = payload.get("annotationSource")
    if annotation_source != PRODUCT_ANNOTATION_SOURCE:
        raise RuntimeError("speakrs-cli produced an unsupported annotation source.")

    device = payload.get("device")
    if not isinstance(device, str) or device != mode:
        raise RuntimeError("speakrs-cli produced an unexpected device.")

    return annotation_to_speaker_segments(segments), annotation_source, device


def run_speakrs_diarization(
    audio_path: Path,
    *,
    required_device: Optional[str] = None,
    model_ref: str = SPEAKRS_MODEL_ID,
) -> Tuple[List[Dict[str, Any]], str, str]:
    from .diarization_pipeline import emit_progress

    del model_ref
    mode = resolve_speakrs_mode(required_device)
    emit_progress(
        "validating-accelerator",
        f"Checking {mode.upper()} speaker identification acceleration.",
        percent=30,
    )

    wav_path = Path(audio_path)
    if not wav_path.is_file():
        raise FileNotFoundError(f"Audio file not found: {wav_path}")

    cli_path = resolve_speakrs_cli_path()
    child_env = build_speakrs_child_env(mode=mode)

    emit_progress("loading-model", "Loading speaker diarization model.", percent=35)
    emit_progress("running-model", "Running speaker diarization locally.", percent=55)

    proc: Optional[subprocess.Popen] = None
    try:
        proc = spawn_speakrs_cli(cli_path, wav_path, env=child_env)
        stdout = collect_speakrs_cli_output(proc)
        payload = parse_speakrs_cli_stdout(stdout)
        if payload.get("success") is not True:
            raise RuntimeError(
                redact_sensitive_text(payload.get("error") or "Speaker diarization failed.")
                or "Speaker diarization failed."
            )
        if proc.returncode != 0:
            raise RuntimeError(f"speakrs-cli exited with code {proc.returncode}.")
        speaker_segments, annotation_source, device = speaker_result_from_payload(payload, mode=mode)
    finally:
        terminate_speakrs_cli(proc)

    emit_progress("merging-speakers", "Merging speaker labels into transcript timestamps.", percent=80)
    return speaker_segments, annotation_source, device


def validate_speakrs_setup(
    *,
    model_ref: str = SPEAKRS_MODEL_ID,
    required_device: Optional[str] = None,
) -> Dict[str, Any]:
    from .diarization_pipeline import emit_progress

    emit_progress("validating-runtime", "Checking speakrs runtime.", percent=10)
    cli_path = resolve_speakrs_cli_path()
    wav_path = resolve_speakrs_validate_wav(cli_path=cli_path)
    speaker_segments, _annotation_source, device = run_speakrs_diarization(
        wav_path,
        required_device=required_device,
        model_ref=model_ref,
    )
    if not speaker_segments:
        raise RuntimeError("Speakrs validation produced no speaker segments.")
    return {
        "status": "ready",
        "model": model_ref or SPEAKRS_MODEL_ID,
        "device": device,
    }
