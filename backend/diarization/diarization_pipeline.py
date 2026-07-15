"""Runtime speaker diarization pipeline.

The pyannote runtime is imported lazily so unit tests and normal app startup do
not require model downloads or GPU-specific dependencies. Progress is emitted as
structured JSON on stderr and intentionally excludes transcript text and tokens.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from inspect import Parameter, signature
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .audio_prep import (
    MAX_IN_MEMORY_AUDIO_SECONDS,
    build_audio_conversion_command,
    get_audio_duration_seconds,
    load_prepared_audio_for_pipeline,
    prepare_diarization_audio,
    should_load_audio_in_memory,
)
from .speaker_segments import merge_speaker_labels
from common.hf_runtime import hugging_face_offline_mode
from common.sensitive_text import redact_sensitive_text


DEFAULT_MODEL_REF = "pyannote/speaker-diarization-community-1"
UNKNOWN_PROGRESS_ERROR = "Speaker diarization failed."

os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")


@contextlib.contextmanager
def pyannote_torch_load_compat() -> Any:
    """Allow trusted pyannote checkpoints to load on PyTorch 2.6+.

    PyTorch 2.6 changed torch.load's default to weights_only=True. Current
    pyannote checkpoints can require the historical loader path. Scope the
    override to Pipeline.from_pretrained and restore the user's environment
    immediately afterwards.
    """
    key = "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"
    previous = os.environ.get(key)
    os.environ[key] = "1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = previous


def validate_pyannote_setup(
    *,
    model_ref: str = DEFAULT_MODEL_REF,
    hf_token: Optional[str] = None,
    required_device: Optional[str] = None,
) -> Dict[str, Any]:
    """Validate that local pyannote setup can load the gated model."""
    token = hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or ""
    if not token:
        raise ValueError("Hugging Face token is required for speaker diarization.")

    device_requirement = normalize_required_device(required_device)
    if device_requirement:
        emit_progress("validating-accelerator", f"Checking {device_requirement.upper()} speaker identification acceleration.", percent=8)
        assert_required_device_available(device_requirement)

    emit_progress("validating-runtime", "Checking pyannote.audio runtime.", percent=10)
    pipeline = load_pyannote_pipeline(model_ref, token)
    device = move_pipeline_to_best_device(pipeline, required_device=device_requirement)
    return {
        "status": "ready",
        "model": model_ref,
        "device": device,
    }


def _read_hf_token_from_stdin() -> str:
    """Read a one-line HF token from stdin (preferred over process env)."""
    return sys.stdin.readline().strip()


def _safe_message(message: Any) -> str:
    return redact_sensitive_text(message)


def emit_progress(phase: str, message: str, *, percent: Optional[float] = None) -> None:
    payload: Dict[str, Any] = {
        "type": "progress",
        "feature": "diarization",
        "phase": re.sub(r"[^A-Za-z0-9._-]+", "-", str(phase or "status"))[:80],
        "message": _safe_message(message),
    }

    if percent is not None:
        try:
            payload["percent"] = max(0.0, min(100.0, float(percent)))
        except (TypeError, ValueError):
            pass

    print(json.dumps(payload), file=sys.stderr, flush=True)


def normalize_speaker_count(value: Any) -> Optional[int]:
    if value in (None, "", "auto"):
        return None

    count = int(value)
    if count < 2 or count > 10:
        raise ValueError("speaker count must be between 2 and 10, or 'auto'")
    return count


def normalize_required_device(value: Any) -> Optional[str]:
    if value in (None, "", "auto"):
        return None

    device = str(value).strip().lower()
    if device not in {"cuda", "mps"}:
        raise ValueError("Speaker diarization requires either CUDA or Metal/MPS acceleration; CPU fallback is disabled.")
    return device


def assert_required_device_available(required_device: str) -> Any:
    normalized_device = normalize_required_device(required_device)
    if not normalized_device:
        raise ValueError("Speaker diarization requires either CUDA or Metal/MPS acceleration; CPU fallback is disabled.")

    try:
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("PyTorch is not installed for accelerated speaker diarization.") from exc

    if normalized_device == "cuda":
        if not getattr(torch, "cuda", None) or not torch.cuda.is_available():
            raise RuntimeError("Speaker identification requires CUDA acceleration. CPU fallback is disabled.")
    elif normalized_device == "mps":
        mps_backend = getattr(getattr(torch, "backends", None), "mps", None)
        is_built = bool(mps_backend and mps_backend.is_built())
        is_available = bool(mps_backend and mps_backend.is_available())
        if not is_built:
            raise RuntimeError("Speaker identification on macOS requires a PyTorch build with Metal/MPS support. Reinstall speaker identification setup. CPU fallback is disabled.")
        if not is_available:
            raise RuntimeError("Speaker identification on macOS requires PyTorch Metal/MPS acceleration. CPU fallback is disabled.")

    device = torch.device(normalized_device)
    try:
        probe_tensor = torch.empty(1, device=device)
        if hasattr(probe_tensor, "cpu"):
            probe_tensor.cpu()
    except Exception as exc:
        raise RuntimeError(f"Speaker identification could not initialize {normalized_device.upper()} acceleration. CPU fallback is disabled.") from exc
    return device


def load_transcript_segments(segments_json_path: str) -> List[Dict[str, Any]]:
    with open(segments_json_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    if isinstance(payload, dict):
        segments = payload.get("segments")
    else:
        segments = payload

    if not isinstance(segments, list):
        raise ValueError("Transcript segments JSON must be a list or an object with a segments list.")

    normalized: List[Dict[str, Any]] = []
    for item in segments:
        if isinstance(item, dict):
            normalized.append(dict(item))
    return normalized


def select_annotation(diarization_result: Any) -> Tuple[Any, str]:
    for field in ("exclusive_speaker_diarization", "speaker_diarization"):
        if isinstance(diarization_result, dict):
            candidate = diarization_result.get(field)
        else:
            candidate = getattr(diarization_result, field, None)

        if candidate is not None:
            return candidate, field

    return diarization_result, "diarization"


def _segment_from_mapping(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        start = float(item.get("start", 0) or 0)
        end = float(item.get("end", 0) or 0)
    except (TypeError, ValueError):
        return None

    speaker = str(item.get("speaker", "") or "").strip()
    if not speaker or end <= start:
        return None

    return {"start": start, "end": end, "speaker": speaker}


def annotation_to_speaker_segments(annotation: Any) -> List[Dict[str, Any]]:
    if isinstance(annotation, list):
        segments = [_segment_from_mapping(item) for item in annotation if isinstance(item, dict)]
        return [segment for segment in segments if segment is not None]

    if not hasattr(annotation, "itertracks"):
        raise ValueError("Unsupported diarization annotation format.")

    speaker_segments: List[Dict[str, Any]] = []
    for turn, _track, speaker in annotation.itertracks(yield_label=True):
        start = float(getattr(turn, "start", 0) or 0)
        end = float(getattr(turn, "end", 0) or 0)
        speaker_label = str(speaker or "").strip()
        if speaker_label and end > start:
            speaker_segments.append({"start": start, "end": end, "speaker": speaker_label})

    return speaker_segments


def build_pyannote_from_pretrained_kwargs(from_pretrained: Any, hf_token: str = "", *, local_files_only: bool = False) -> Dict[str, Any]:
    try:
        parameters = signature(from_pretrained).parameters
    except (TypeError, ValueError):
        parameters = {}

    accepts_kwargs = any(parameter.kind == Parameter.VAR_KEYWORD for parameter in parameters.values())
    kwargs: Dict[str, Any] = {}
    supports_token = accepts_kwargs or "token" in parameters
    if supports_token and hf_token:
        kwargs["token"] = hf_token
    elif supports_token and local_files_only and not hf_token:
        # token=False disables huggingface_hub env/file token discovery. Without this,
        # an empty HF_TOKEN_PATH (Path(".")) can raise PermissionError and get misreported
        # as a missing model cache — forcing unnecessary reinstalls of working setups.
        kwargs["token"] = False
    elif "use_auth_token" in parameters:
        if local_files_only:
            raise RuntimeError("Installed pyannote.audio is too old to enforce offline cached execution. Re-run speaker identification setup in Settings.")
        if hf_token:
            kwargs["use_auth_token"] = hf_token

    if accepts_kwargs or "local_files_only" in parameters:
        kwargs["local_files_only"] = local_files_only

    return kwargs


def load_pyannote_pipeline(model_ref: str, hf_token: str = "", *, local_files_only: bool = False) -> Any:
    try:
        from pyannote.audio import Pipeline  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("pyannote.audio is not installed for speaker diarization.") from exc

    try:
        with pyannote_torch_load_compat(), hugging_face_offline_mode(local_files_only):
            kwargs = build_pyannote_from_pretrained_kwargs(Pipeline.from_pretrained, hf_token, local_files_only=local_files_only)
            return Pipeline.from_pretrained(model_ref, **kwargs)
    except Exception as exc:
        if local_files_only:
            # Collapse/redact so guided_transcription's raw `ERROR: {exc}` stderr stays a
            # single line for summarizeAiBackendError (last non-empty line wins).
            cause = redact_sensitive_text(exc) or exc.__class__.__name__
            # Auth/path probe failures are not missing caches — do not tell users to reinstall.
            if isinstance(exc, PermissionError) or "Permission denied" in cause:
                raise RuntimeError(
                    "Speaker diarization failed while reading Hugging Face auth settings "
                    f"({cause}). Existing speaker setup was not removed; update the app and retry."
                ) from exc
            raise RuntimeError(
                "Speaker diarization model cache is missing or incomplete. "
                f"Re-run speaker identification setup in Settings. ({cause})"
            ) from exc
        raise


def move_pipeline_to_best_device(pipeline: Any, *, required_device: Optional[str] = None) -> str:
    """Move pipeline to a required accelerator or best-effort dev fallback."""
    normalized_required_device = normalize_required_device(required_device)

    try:
        import torch  # type: ignore[import-not-found]

        if normalized_required_device:
            device = assert_required_device_available(normalized_required_device)
            try:
                pipeline.to(device)
            except Exception as exc:
                raise RuntimeError(f"Speaker identification could not use {normalized_required_device.upper()} acceleration. CPU fallback is disabled.") from exc
            return normalized_required_device

        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
            return "cuda"
        mps_backend = getattr(getattr(torch, "backends", None), "mps", None)
        if mps_backend and mps_backend.is_built() and mps_backend.is_available():
            pipeline.to(torch.device("mps"))
            return "mps"
    except Exception:
        if normalized_required_device:
            raise
        pass

    return "cpu"


def run_pyannote_diarization(
    audio_path: Path,
    *,
    model_ref: str,
    hf_token: str = "",
    speaker_count: Optional[int] = None,
    required_device: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], str, str]:
    device_requirement = normalize_required_device(required_device)
    if device_requirement:
        emit_progress("validating-accelerator", f"Checking {device_requirement.upper()} speaker identification acceleration.", percent=30)
        assert_required_device_available(device_requirement)

    emit_progress("loading-model", "Loading speaker diarization model.", percent=35)
    pipeline = load_pyannote_pipeline(model_ref, hf_token, local_files_only=True)
    device = move_pipeline_to_best_device(pipeline, required_device=device_requirement)

    emit_progress("running-model", "Running speaker diarization locally.", percent=55)
    kwargs: Dict[str, Any] = {}
    if speaker_count is not None:
        kwargs["num_speakers"] = speaker_count

    # Always pass in-memory waveform dict. pyannote file-path input requires a
    # working torchcodec AudioDecoder, which often fails on macOS even when pip
    # reports torchcodec as installed.
    audio_input = load_prepared_audio_for_pipeline(audio_path)
    result = pipeline(audio_input, **kwargs)
    annotation, annotation_source = select_annotation(result)

    emit_progress("merging-speakers", "Merging speaker labels into transcript timestamps.", percent=80)
    return annotation_to_speaker_segments(annotation), annotation_source, device


def build_diarization_result(
    *,
    audio_path: str,
    transcript_segments: Iterable[Dict[str, Any]],
    speaker_segments: Iterable[Dict[str, Any]],
    model_ref: str,
    annotation_source: str,
    device: str,
) -> Dict[str, Any]:
    speaker_turns = [dict(segment) for segment in speaker_segments]
    merged_segments = merge_speaker_labels(transcript_segments, speaker_turns)
    speaker_count = len({segment.get("speaker") for segment in speaker_turns if segment.get("speaker")})

    return {
        "status": "completed",
        "model": model_ref,
        "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "audioPath": str(audio_path),
        "speakerCount": speaker_count,
        "annotationSource": annotation_source,
        "device": device,
        "speakerSegments": speaker_turns,
        "segments": merged_segments,
    }


def save_diarization_result(output_json: str, result: Dict[str, Any]) -> None:
    output_path = Path(output_json)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(f".{output_path.name}.tmp")
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    temp_path.replace(output_path)


def diarize_transcript(
    *,
    audio_path: str,
    segments_json_path: str,
    output_json: str,
    model_ref: str = DEFAULT_MODEL_REF,
    speaker_count: Optional[int] = None,
    ffmpeg_path: str = "ffmpeg",
    hf_token: Optional[str] = None,
    required_device: Optional[str] = None,
) -> Dict[str, Any]:
    emit_progress("loading-transcript", "Loading transcript segments.", percent=5)
    transcript_segments = load_transcript_segments(segments_json_path)

    with tempfile.TemporaryDirectory(prefix="avanevis-diarization-") as work_dir:
        emit_progress("preparing-audio", "Preparing audio for speaker diarization.", percent=15)
        prepared_audio = prepare_diarization_audio(audio_path, work_dir, ffmpeg_path=ffmpeg_path)
        token = hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or ""
        speaker_segments, annotation_source, device = run_pyannote_diarization(
            prepared_audio,
            model_ref=model_ref,
            hf_token=token,
            speaker_count=speaker_count,
            required_device=required_device,
        )

    result = build_diarization_result(
        audio_path=audio_path,
        transcript_segments=transcript_segments,
        speaker_segments=speaker_segments,
        model_ref=model_ref,
        annotation_source=annotation_source,
        device=device,
    )
    save_diarization_result(output_json, result)
    emit_progress("completed", "Speaker diarization completed.", percent=100)
    return result


def main() -> None:
    from common.process_priority import lower_process_priority
    lower_process_priority()

    parser = argparse.ArgumentParser(description="Run local speaker diarization for an AvaNevis transcript")
    parser.add_argument("--validate-setup", action="store_true", help="Validate pyannote runtime and model access without diarizing audio")
    parser.add_argument(
        "--token-stdin",
        action="store_true",
        help="Read Hugging Face token from stdin (preferred over process env for setup validation)",
    )
    parser.add_argument("--audio", help="Source audio file path")
    parser.add_argument("--segments-json", help="Transcript segments JSON path")
    parser.add_argument("--output-json", help="Output speakers JSON path")
    parser.add_argument("--model-ref", default=DEFAULT_MODEL_REF, help="pyannote model reference")
    parser.add_argument("--speaker-count", default="auto", help="Known speaker count or auto")
    parser.add_argument("--require-device", default=None, help="Require accelerated torch device: cuda or mps")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable path")
    args = parser.parse_args()

    try:
        if args.validate_setup:
            token = _read_hf_token_from_stdin() if args.token_stdin else None
            result = validate_pyannote_setup(
                model_ref=args.model_ref,
                hf_token=token,
                required_device=args.require_device,
            )
            emit_progress("ready", "Speaker diarization setup is ready.", percent=100)
            print(json.dumps(result, ensure_ascii=True))
            return

        if not args.audio or not args.segments_json or not args.output_json:
            raise ValueError("--audio, --segments-json, and --output-json are required unless --validate-setup is used.")

        result = diarize_transcript(
            audio_path=args.audio,
            segments_json_path=args.segments_json,
            output_json=args.output_json,
            model_ref=args.model_ref,
            speaker_count=normalize_speaker_count(args.speaker_count),
            ffmpeg_path=args.ffmpeg,
            required_device=args.require_device,
        )
        print(json.dumps({**result, "segmentsPath": args.output_json}, ensure_ascii=True))
    except Exception as exc:
        emit_progress("error", UNKNOWN_PROGRESS_ERROR)
        print(f"ERROR: {_safe_message(exc)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
