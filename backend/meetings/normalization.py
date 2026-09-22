"""Pure meeting metadata normalization helpers."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from common.sensitive_text import redact_sensitive_text

MAX_AI_METADATA_STRING_LENGTH = 300
VALID_TRANSCRIPTION_STATUSES = {"pending", "failed", "completed"}
VALID_TRANSCRIPTION_DEVICES = {"cpu", "cuda", "mps"}
# MLX reports "metal"; meeting metadata stores the Apple GPU as "mps".
TRANSCRIPTION_DEVICE_ALIASES = {"metal": "mps"}
# CLI argparse accepts aliases, then normalize_transcription_device maps to canonical.
TRANSCRIPTION_DEVICE_CLI_CHOICES = sorted(
    VALID_TRANSCRIPTION_DEVICES | set(TRANSCRIPTION_DEVICE_ALIASES.keys())
)


def read_text_file(file_path: Optional[Path], label: str) -> str:
    if file_path is None or not file_path.exists():
        return ""

    try:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"Warning: Could not read {label}: {exc}", file=sys.stderr)
        return ""


def read_transcript_text(transcript_path: Optional[Path]) -> str:
    return read_text_file(transcript_path, "transcript")


def hash_text(text: str) -> str:
    return f"sha256:{hashlib.sha256(str(text or '').encode('utf-8')).hexdigest()}"


def normalize_transcription_status(value: object, default: str = "completed") -> str:
    candidate = str(value or "").strip().lower()
    if candidate in VALID_TRANSCRIPTION_STATUSES:
        return candidate
    return default


def normalize_transcription_error(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    text = redact_sensitive_text(value)
    text = re.sub(r"\s+", " ", str(text)).strip()
    return text[:MAX_AI_METADATA_STRING_LENGTH] if text else None


def normalize_transcription_device(value: object) -> Optional[str]:
    candidate = str(value or "").strip().lower()
    candidate = TRANSCRIPTION_DEVICE_ALIASES.get(candidate, candidate)
    return candidate if candidate in VALID_TRANSCRIPTION_DEVICES else None


def normalize_transcription_compute_type(value: object) -> Optional[str]:
    candidate = re.sub(r"[^a-z0-9_.-]+", "", str(value or "").strip().lower())
    return candidate[:40] if candidate else None


def build_pending_transcript_placeholder(audio_file_name: str) -> str:
    return "\n".join([
        "# Recording Awaiting Transcription",
        "",
        f"**File:** {audio_file_name}",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "**Status:** Transcription pending",
        "",
        "The recording was saved successfully, but a transcript is not available yet.",
        "Use Retry transcription in AvaNevis to generate a transcript.",
        "",
    ])


def strip_inline_transcript(meeting: Dict) -> Dict:
    stripped = dict(meeting)
    stripped.pop("transcript", None)
    return stripped


def normalize_text(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:MAX_AI_METADATA_STRING_LENGTH]


class TranscriptionMetadataError(ValueError):
    """Bounded transcription provenance was rejected."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_HEX40_RE = re.compile(r"^[a-f0-9]{40}$")
_HEX64_RE = re.compile(r"^[a-f0-9]{64}$")
_LANGUAGE_RE = re.compile(r"^[a-z]{2,8}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_ATTEMPT_FILE_RE = re.compile(r"^.+\.transcript-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$")

WHISPER_MODEL_SIZES = {"tiny", "base", "small", "medium", "large", "large-v3"}
PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v2"
PARAKEET_BOUNDARY_POLICY = "parakeet-boundaries-v1"
ONNX_ARTIFACT_REVISION = "0bbb45a3365852604aef28b538a8f066f4ccaa85"
MLX_ARTIFACT_REVISION = "8ae155301e23d820d82aa60d24817c900e69e487"
PARAKEET_ADAPTERS = {
    "parakeet-onnx-win-cuda-v1": ONNX_ARTIFACT_REVISION,
    "parakeet-onnx-linux-cuda-v1": ONNX_ARTIFACT_REVISION,
    "parakeet-mlx-metal-v1": MLX_ARTIFACT_REVISION,
}
REQUEST_ENGINES = {"whisper", "parakeet"}
RESULT_ENGINES = {"whisper", "parakeet", "unknown"}
RESULT_DEVICES = {"cpu", "cuda", "mps"}


def _reject(code: str):
    raise TranscriptionMetadataError(code)


def _bounded_token(value: object, *, pattern: re.Pattern[str], code: str) -> str:
    text = str(value or "").strip()
    if any(marker in text for marker in ("/", "\\", "..", "\n", "\r")):
        _reject(code)
    if not pattern.fullmatch(text):
        _reject(code)
    return text


def _require_schema_version(value: object, code: str) -> None:
    if type(value) is not int or value != 1:
        _reject(code)


def _optional_revision(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    return _bounded_token(str(value).strip().lower(), pattern=_HEX40_RE, code="INVALID_TRANSCRIPTION_REQUEST")


def normalize_transcription_request(value: object, *, require_explicit: bool = False) -> Optional[Dict]:
    """Return a bounded request, or None when the legacy Whisper shape is absent.

    An explicit unknown engine is an error. Missing request metadata keeps
    legacy Whisper semantics and does not invent an artifact revision.
    """
    if value is None:
        if require_explicit:
            _reject("INVALID_TRANSCRIPTION_REQUEST")
        return None
    if not isinstance(value, dict):
        _reject("INVALID_TRANSCRIPTION_REQUEST")
    engine = str(value.get("engine") or "").strip().lower()
    if not engine:
        if require_explicit:
            _reject("INVALID_TRANSCRIPTION_REQUEST")
        return None
    if engine not in REQUEST_ENGINES:
        _reject("UNKNOWN_ENGINE")
    _require_schema_version(value.get("schemaVersion"), "INVALID_TRANSCRIPTION_REQUEST")
    attempt_id = _bounded_token(str(value.get("attemptId") or "").lower(), pattern=_UUID_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    language = _bounded_token(str(value.get("language") or "").lower(), pattern=_LANGUAGE_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    request = {
        "schemaVersion": 1,
        "attemptId": attempt_id,
        "engine": engine,
        "language": language,
        "artifactRevision": None,
    }
    if engine == "whisper":
        model_size = _bounded_token(str(value.get("modelSize") or value.get("model") or "").lower(), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_REQUEST")
        if model_size not in WHISPER_MODEL_SIZES:
            _reject("INVALID_TRANSCRIPTION_REQUEST")
        if value.get("artifactRevision") not in (None, ""):
            _reject("INVALID_TRANSCRIPTION_REQUEST")
        request["modelSize"] = model_size
        return request

    model_id = _bounded_token(value.get("modelId"), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    adapter_id = _bounded_token(value.get("adapterId"), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    revision = _bounded_token(str(value.get("artifactRevision") or "").lower(), pattern=_HEX40_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    runtime_lock_id = _bounded_token(str(value.get("runtimeLockId") or "").lower(), pattern=_HEX64_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    boundary = _bounded_token(value.get("boundaryPolicy"), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_REQUEST")
    if (
        language != "en"
        or model_id != PARAKEET_MODEL_ID
        or adapter_id not in PARAKEET_ADAPTERS
        or PARAKEET_ADAPTERS[adapter_id] != revision
        or boundary != PARAKEET_BOUNDARY_POLICY
    ):
        _reject("INVALID_TRANSCRIPTION_REQUEST")
    request.update({
        "modelId": model_id,
        "artifactRevision": revision,
        "adapterId": adapter_id,
        "runtimeLockId": runtime_lock_id,
        "boundaryPolicy": boundary,
    })
    return request


def normalize_transcription_result(value: object, *, attempt_id: Optional[str] = None) -> Optional[Dict]:
    """Return bounded execution provenance. Imported unknown output stays unknown."""
    if value is None:
        return None
    if not isinstance(value, dict):
        _reject("INVALID_TRANSCRIPTION_RESULT")
    engine = str(value.get("engine") or "").strip().lower()
    if engine not in RESULT_ENGINES:
        _reject("UNKNOWN_ENGINE" if engine else "INVALID_TRANSCRIPTION_RESULT")
    _require_schema_version(value.get("schemaVersion"), "INVALID_TRANSCRIPTION_RESULT")
    if engine == "unknown":
        return {
            "schemaVersion": 1,
            "engine": "unknown",
            "artifactRevision": None,
        }
    result_attempt = _bounded_token(str(value.get("attemptId") or "").lower(), pattern=_UUID_RE, code="INVALID_TRANSCRIPTION_RESULT")
    if attempt_id and result_attempt != attempt_id:
        _reject("STALE_TRANSCRIPTION_ATTEMPT")
    language = _bounded_token(str(value.get("language") or "").lower(), pattern=_LANGUAGE_RE, code="INVALID_TRANSCRIPTION_RESULT")
    device = normalize_transcription_device(value.get("device"))
    compute_type = normalize_transcription_compute_type(value.get("computeType") or value.get("compute_type"))
    if device not in RESULT_DEVICES or not compute_type:
        _reject("INVALID_TRANSCRIPTION_RESULT")
    transcript_hash = value.get("transcriptHash")
    if transcript_hash not in (None, ""):
        hash_text_value = str(transcript_hash).strip().lower()
        if not hash_text_value.startswith("sha256:") or not _HEX64_RE.fullmatch(hash_text_value.split(":", 1)[1]):
            _reject("INVALID_TRANSCRIPTION_RESULT")
        transcript_hash = hash_text_value
    else:
        transcript_hash = None
    result = {
        "schemaVersion": 1,
        "attemptId": result_attempt,
        "engine": engine,
        "language": language,
        "device": device,
        "computeType": compute_type,
        "artifactRevision": None,
        "transcriptHash": transcript_hash,
    }
    if engine == "whisper":
        model_size = _bounded_token(str(value.get("modelSize") or value.get("modelId") or "").lower(), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_RESULT")
        if model_size not in WHISPER_MODEL_SIZES:
            _reject("INVALID_TRANSCRIPTION_RESULT")
        if value.get("artifactRevision") not in (None, ""):
            _reject("INVALID_TRANSCRIPTION_RESULT")
        result["modelSize"] = model_size
        return result

    model_id = _bounded_token(value.get("modelId"), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_RESULT")
    adapter_id = _bounded_token(value.get("adapterId"), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_RESULT")
    revision = _bounded_token(str(value.get("artifactRevision") or "").lower(), pattern=_HEX40_RE, code="INVALID_TRANSCRIPTION_RESULT")
    runtime_lock_id = _bounded_token(str(value.get("runtimeLockId") or "").lower(), pattern=_HEX64_RE, code="INVALID_TRANSCRIPTION_RESULT")
    boundary = _bounded_token(value.get("boundaryPolicy"), pattern=_TOKEN_RE, code="INVALID_TRANSCRIPTION_RESULT")
    if (
        language != "en"
        or model_id != PARAKEET_MODEL_ID
        or adapter_id not in PARAKEET_ADAPTERS
        or PARAKEET_ADAPTERS[adapter_id] != revision
        or boundary != PARAKEET_BOUNDARY_POLICY
    ):
        _reject("INVALID_TRANSCRIPTION_RESULT")
    result.update({
        "modelId": model_id,
        "artifactRevision": revision,
        "adapterId": adapter_id,
        "runtimeLockId": runtime_lock_id,
        "boundaryPolicy": boundary,
    })
    return result


def public_transcription_provenance(meeting: Dict) -> Dict:
    """Copy display provenance, dropping malformed values instead of raising."""
    cleaned = dict(meeting)
    try:
        cleaned["transcriptionRequest"] = normalize_transcription_request(meeting.get("transcriptionRequest"))
    except (TranscriptionMetadataError, ValueError, TypeError):
        cleaned["transcriptionRequest"] = None
    try:
        cleaned["transcriptionResult"] = normalize_transcription_result(meeting.get("transcriptionResult"))
    except (TranscriptionMetadataError, ValueError, TypeError):
        cleaned["transcriptionResult"] = None
    if cleaned["transcriptionRequest"] is None:
        cleaned.pop("transcriptionRequest", None)
    if cleaned["transcriptionResult"] is None:
        cleaned.pop("transcriptionResult", None)
    return cleaned


def is_unreferenced_attempt_transcript(file_name: str) -> bool:
    return _ATTEMPT_FILE_RE.fullmatch(str(file_name or "")) is not None


def expected_attempt_transcript_name(audio_path: object, attempt_id: str) -> str:
    stem = Path(str(audio_path)).stem
    if not stem or not _UUID_RE.fullmatch(attempt_id):
        _reject("INVALID_TRANSCRIPTION_RESULT")
    return f"{stem}.transcript-{attempt_id}.md"


def parse_metadata(raw_value: Optional[str], label: str, *, unset):
    """Parse CLI AI metadata JSON. Returns `unset` when raw_value is None."""
    if raw_value is None:
        return unset
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid {label} metadata JSON: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit(f"Invalid {label} metadata JSON: expected object")
    return parsed
