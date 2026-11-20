"""Caption-scale timing cues and schema-v1 ``.captions.json`` helpers."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


CAPTIONS_SCHEMA_VERSION = 1
VALID_CAPTION_ENGINES = frozenset({"faster-whisper", "mlx-whisper", "parakeet"})
VALID_TIMING_PRECISIONS = frozenset({"segment", "word"})
MAX_CUE_DURATION_MS = 7000
MAX_CUE_CHARS = 84
MIN_CUE_DURATION_MS = 100

_SHA256_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
_SENTENCE_END_RE = re.compile(r"[.!?。！？]$")
_ATTACH_PUNCT_RE = re.compile(r"^[,.;:!?%)\]}…，。！？、；：]+$")
_CJK_CHAR_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]")


def hash_transcript_text(text: Any) -> str:
    """Return canonical ``sha256:<hex>`` over LF-normalized transcript Markdown."""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return f"sha256:{hashlib.sha256(normalized.encode('utf-8')).hexdigest()}"


def normalize_caption_engine(engine: Any) -> str:
    value = str(engine or "").strip().lower()
    aliases = {
        "lightning-whisper-mlx": "mlx-whisper",
        "mlx": "mlx-whisper",
        "faster": "faster-whisper",
    }
    value = aliases.get(value, value)
    if value not in VALID_CAPTION_ENGINES:
        raise ValueError(f"Unsupported caption engine: {engine!r}")
    return value


def captions_sidecar_path_for_audio(audio_path: Path | str) -> Path:
    return Path(audio_path).with_suffix(".captions.json")


def attempt_captions_sidecar_path(audio_path: Path | str, attempt_id: str) -> Path:
    audio = Path(audio_path)
    return audio.parent / f"{audio.stem}.captions-{attempt_id}.json"


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _to_ms(segment: Dict[str, Any], ms_key: str, sec_key: str, default_ms: int = 0) -> int:
    if segment.get(ms_key) is not None:
        try:
            val = float(segment[ms_key])
            if math.isfinite(val):
                return max(0, int(round(val)))
        except (TypeError, ValueError):
            pass
    if segment.get(sec_key) is not None:
        try:
            val = float(segment[sec_key])
            if math.isfinite(val):
                return max(0, int(round(val * 1000.0)))
        except (TypeError, ValueError):
            pass
    return max(0, default_ms)


def _join_word_tokens(words: List[Dict[str, Any]]) -> str:
    out: List[str] = []
    for idx, word in enumerate(words):
        token = str(word["text"])
        if idx > 0 and (word.get("joinNoSpace") or _ATTACH_PUNCT_RE.fullmatch(token)):
            out[-1] = f"{out[-1]}{token}"
        else:
            out.append(token)
    return " ".join(out).strip()


def _extract_valid_words(segment: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    raw_words = segment.get("words")
    if not isinstance(raw_words, (list, tuple)) or not raw_words:
        return None

    seg_speaker = _clean_text(segment.get("speaker"))
    raw_word_texts: List[str] = []
    for item in raw_words:
        if isinstance(item, dict):
            raw_t = item.get("word") if item.get("word") is not None else item.get("text")
        else:
            raw_t = getattr(item, "word", None)
            if raw_t is None:
                raw_t = getattr(item, "text", None)
        raw_word_texts.append(str(raw_t or ""))
    uses_leading_space_tokens = any(t[:1].isspace() for t in raw_word_texts[1:])

    parsed: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw_words):
        if isinstance(item, dict):
            raw_text = item.get("word") if item.get("word") is not None else item.get("text")
            w_start_raw = item.get("startMs") if item.get("startMs") is not None else item.get("start")
            w_end_raw = item.get("endMs") if item.get("endMs") is not None else item.get("end")
            uses_ms = item.get("startMs") is not None or item.get("endMs") is not None
            w_speaker = _clean_text(item.get("speaker")) or seg_speaker
            explicit_join_no_space = bool(item.get("joinNoSpace"))
        else:
            raw_text = getattr(item, "word", None)
            if raw_text is None:
                raw_text = getattr(item, "text", None)
            w_start_raw = getattr(item, "start", None)
            w_end_raw = getattr(item, "end", None)
            uses_ms = False
            w_speaker = _clean_text(getattr(item, "speaker", "")) or seg_speaker
            explicit_join_no_space = False

        raw_str = str(raw_text or "")
        cleaned = _clean_text(raw_str)
        if not cleaned:
            continue
        try:
            start_f = float(w_start_raw)
            end_f = float(w_end_raw)
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(start_f) and math.isfinite(end_f)):
            return None
        scale = 1.0 if uses_ms else 1000.0
        start_ms = max(0, int(round(start_f * scale)))
        end_ms = max(start_ms, int(round(end_f * scale)))
        join_no_space = explicit_join_no_space or (
            idx > 0
            and isinstance(item, dict) is False
            and uses_leading_space_tokens
            and raw_str == raw_str.lstrip()
        )
        entry: Dict[str, Any] = {
            "startMs": start_ms,
            "endMs": end_ms,
            "text": cleaned,
            "joinNoSpace": join_no_space,
        }
        if w_speaker:
            entry["speaker"] = w_speaker
        parsed.append(entry)

    return parsed or None


def _cues_from_words(
    words: List[Dict[str, Any]],
    *,
    max_cue_duration_ms: int,
    max_cue_chars: int,
) -> List[Dict[str, Any]]:
    cues: List[Dict[str, Any]] = []
    bucket: List[Dict[str, Any]] = []

    def flush():
        if not bucket:
            return
        text = _join_word_tokens(bucket)
        if text:
            cue: Dict[str, Any] = {
                "startMs": bucket[0]["startMs"],
                "endMs": max(bucket[0]["startMs"], bucket[-1]["endMs"]),
                "text": text,
            }
            speaker = bucket[0].get("speaker")
            if speaker:
                cue["speaker"] = speaker
            cues.append(cue)
        bucket.clear()

    for word in words:
        if bucket:
            current_speaker = bucket[0].get("speaker") or ""
            next_speaker = word.get("speaker") or ""
            if next_speaker != current_speaker:
                flush()
            else:
                prospective_duration = max(word["endMs"], bucket[-1]["endMs"]) - bucket[0]["startMs"]
                prospective_text = _join_word_tokens([*bucket, word])
                if prospective_duration > max_cue_duration_ms or len(prospective_text) > max_cue_chars:
                    flush()

        bucket.append(word)

        # Break cleanly on sentence end once the cue has natural readability length.
        if _SENTENCE_END_RE.search(word["text"]):
            cue_duration = bucket[-1]["endMs"] - bucket[0]["startMs"]
            cue_text = _join_word_tokens(bucket)
            if cue_duration >= 1200 or len(cue_text) >= 25:
                flush()

    flush()
    return cues


def _break_oversized_piece(piece: str, *, max_chars: int) -> List[str]:
    if len(piece) <= max_chars:
        return [piece]

    clauses = [part.strip() for part in re.split(r"(?<=[,;:\u3001\uff0c\uff1b])\s+", piece) if part.strip()]
    if len(clauses) > 1:
        expanded: List[str] = []
        for clause in clauses:
            expanded.extend(_break_oversized_piece(clause, max_chars=max_chars))
        return expanded

    tokens = [tok for tok in piece.split(" ") if tok]
    if len(tokens) > 1:
        expanded = []
        for tok in tokens:
            if len(tok) <= max_chars:
                expanded.append(tok)
            else:
                expanded.extend(tok[i:i + max_chars] for i in range(0, len(tok), max_chars))
        return expanded

    return [piece[i:i + max_chars] for i in range(0, len(piece), max_chars)]


def _split_segment_text(
    text: str,
    *,
    duration_ms: int,
    max_cue_duration_ms: int,
    max_cue_chars: int,
) -> List[str]:
    cleaned = _clean_text(text)
    if not cleaned:
        return []

    target_parts = max(
        1,
        math.ceil(duration_ms / max(1, max_cue_duration_ms)),
        math.ceil(len(cleaned) / max(1, max_cue_chars)),
    )
    if target_parts == 1 and len(cleaned) <= max_cue_chars:
        return [cleaned]

    # Split into sentence-first units, then break long units cleanly.
    sentences = [part.strip() for part in re.split(r"(?<=[.!?。！？])\s+", cleaned) if part.strip()]
    units: List[str] = []
    # When we need multiple parts due to long duration, prefer clause/word granularity
    # so we have natural breakpoints.
    unit_limit = max_cue_chars if target_parts == 1 else min(max_cue_chars, max(16, math.ceil(len(cleaned) / target_parts)))

    if len(sentences) >= target_parts and all(len(s) <= max_cue_chars for s in sentences):
        units = sentences
    else:
        for sentence in sentences:
            if len(sentence) <= unit_limit:
                units.append(sentence)
                continue
            clauses = [part.strip() for part in re.split(r"(?<=[,;:\u3001\uff0c\uff1b])\s+", sentence) if part.strip()]
            for clause in clauses:
                if len(clause) <= unit_limit:
                    units.append(clause)
                    continue
                words = [word for word in clause.split(" ") if word]
                if len(words) > 1:
                    for word in words:
                        units.extend(_break_oversized_piece(word, max_chars=max_cue_chars))
                elif len(clause) > max_cue_chars or (_CJK_CHAR_RE.search(clause) and len(clause) >= target_parts * 8):
                    slice_size = min(max_cue_chars, max(8, math.ceil(len(clause) / target_parts)))
                    units.extend(clause[i:i + slice_size] for i in range(0, len(clause), slice_size))
                else:
                    units.append(clause)

    if len(units) <= 1:
        return units or [cleaned]

    # Pack units into chunks <= max_cue_chars while respecting target_parts.
    ideal_chars = max_cue_chars if target_parts <= 1 else min(max_cue_chars, max(1, math.ceil(len(cleaned) / target_parts)))
    chunks: List[str] = []
    current_parts: List[str] = []
    current_len = 0
    joiner_is_space = " " in cleaned

    for idx, unit in enumerate(units):
        sep_len = 1 if (current_parts and joiner_is_space) else 0
        next_len = current_len + sep_len + len(unit)
        remaining_units = len(units) - idx
        remaining_needed_chunks = max(0, target_parts - len(chunks) - 1)
        exceeds_hard_limit = next_len > max_cue_chars
        exceeds_ideal_with_room = (
            target_parts > 1
            and next_len > ideal_chars
            and remaining_units >= remaining_needed_chunks
            and current_len > 0
        )
        if current_parts and (exceeds_hard_limit or exceeds_ideal_with_room):
            chunks.append((" " if joiner_is_space else "").join(current_parts).strip())
            current_parts = [unit]
            current_len = len(unit)
        else:
            current_parts.append(unit)
            current_len = next_len

    if current_parts:
        chunks.append((" " if joiner_is_space else "").join(current_parts).strip())

    return [chunk for chunk in chunks if chunk]


def _cues_from_text_segment(
    segment: Dict[str, Any],
    *,
    start_ms: int,
    end_ms: int,
    text: str,
    speaker: str,
    max_cue_duration_ms: int,
    max_cue_chars: int,
) -> List[Dict[str, Any]]:
    duration_ms = max(0, end_ms - start_ms)
    chunks = _split_segment_text(
        text,
        duration_ms=duration_ms,
        max_cue_duration_ms=max_cue_duration_ms,
        max_cue_chars=max_cue_chars,
    )
    if not chunks:
        return []
    if len(chunks) == 1:
        cue: Dict[str, Any] = {"startMs": start_ms, "endMs": end_ms, "text": chunks[0]}
        if speaker:
            cue["speaker"] = speaker
        return [cue]

    weights = [max(1, len(re.sub(r"\s+", "", chunk))) for chunk in chunks]
    total_weight = sum(weights)
    cues: List[Dict[str, Any]] = []
    cursor_ms = start_ms
    accumulated_weight = 0
    for idx, (chunk, weight) in enumerate(zip(chunks, weights)):
        accumulated_weight += weight
        if idx == len(chunks) - 1:
            chunk_end_ms = end_ms
        else:
            chunk_end_ms = start_ms + int(round((duration_ms * accumulated_weight) / total_weight))
        chunk_end_ms = max(cursor_ms, chunk_end_ms)
        cue = {"startMs": cursor_ms, "endMs": chunk_end_ms, "text": chunk}
        if speaker:
            cue["speaker"] = speaker
        cues.append(cue)
        cursor_ms = chunk_end_ms
    return cues


def build_caption_cues(
    raw_segments: Iterable[Dict[str, Any]],
    *,
    audio_duration: Optional[float] = None,
    max_cue_duration_ms: int = MAX_CUE_DURATION_MS,
    max_cue_chars: int = MAX_CUE_CHARS,
    min_cue_duration_ms: int = MIN_CUE_DURATION_MS,
) -> Tuple[List[Dict[str, Any]], str]:
    """Build monotonic, caption-scale cues from raw pre-merge segments or word timings."""
    max_audio_ms: Optional[int] = None
    if audio_duration is not None:
        try:
            dur = float(audio_duration)
            if math.isfinite(dur) and dur > 0:
                max_audio_ms = int(round(dur * 1000.0))
        except (TypeError, ValueError):
            max_audio_ms = None

    raw_cues: List[Dict[str, Any]] = []
    saw_non_empty_segment = False
    all_word_timed = True

    for segment in raw_segments or ():
        if not isinstance(segment, dict):
            continue
        words = _extract_valid_words(segment)
        if words is not None:
            saw_non_empty_segment = True
            raw_cues.extend(
                _cues_from_words(
                    words,
                    max_cue_duration_ms=max_cue_duration_ms,
                    max_cue_chars=max_cue_chars,
                )
            )
            continue

        text = _clean_text(segment.get("text"))
        if not text:
            continue

        saw_non_empty_segment = True
        all_word_timed = False
        start_ms = _to_ms(segment, "startMs", "start", 0)
        end_ms = _to_ms(segment, "endMs", "end", start_ms)
        if max_audio_ms is not None:
            start_ms = min(start_ms, max_audio_ms)
            end_ms = min(end_ms, max_audio_ms)
        if end_ms < start_ms:
            end_ms = start_ms
        speaker = _clean_text(segment.get("speaker"))
        raw_cues.extend(
            _cues_from_text_segment(
                segment,
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                speaker=speaker,
                max_cue_duration_ms=max_cue_duration_ms,
                max_cue_chars=max_cue_chars,
            )
        )

    raw_cues.sort(key=lambda item: (item["startMs"], item["endMs"]))

    normalized: List[Dict[str, Any]] = []
    prev_end_ms = 0
    for cue in raw_cues:
        text = _clean_text(cue.get("text"))
        if not text:
            continue
        start_ms = max(0, int(cue["startMs"]))
        end_ms = max(start_ms, int(cue["endMs"]))
        if max_audio_ms is not None and start_ms > max_audio_ms:
            start_ms = max_audio_ms
            end_ms = max(start_ms, end_ms)

        if normalized and start_ms < prev_end_ms:
            prev = normalized[-1]
            if start_ms - prev["startMs"] >= min_cue_duration_ms:
                prev["endMs"] = start_ms
                prev_end_ms = start_ms
            else:
                start_ms = prev_end_ms

        if end_ms < start_ms + min_cue_duration_ms:
            end_ms = start_ms + min_cue_duration_ms

        out_cue: Dict[str, Any] = {
            "startMs": start_ms,
            "endMs": end_ms,
            "text": text,
        }
        speaker = _clean_text(cue.get("speaker"))
        if speaker:
            out_cue["speaker"] = speaker
        normalized.append(out_cue)
        prev_end_ms = end_ms

    precision = "word" if (saw_non_empty_segment and all_word_timed and normalized) else "segment"
    return normalized, precision


def build_captions_payload(
    *,
    source_transcript_hash: str,
    engine: str,
    cues: List[Dict[str, Any]],
    timing_precision: str = "segment",
) -> Dict[str, Any]:
    normalized_engine = normalize_caption_engine(engine)
    precision = str(timing_precision or "segment").strip().lower()
    if precision not in VALID_TIMING_PRECISIONS:
        raise ValueError(f"Unsupported timing precision: {timing_precision!r}")
    if not _SHA256_RE.fullmatch(str(source_transcript_hash or "")):
        raise ValueError("source_transcript_hash must be formatted as sha256:<64 hex>")

    payload = {
        "schemaVersion": CAPTIONS_SCHEMA_VERSION,
        "sourceTranscriptHash": source_transcript_hash,
        "engine": normalized_engine,
        "timingPrecision": precision,
        "cues": list(cues),
    }
    valid, reason = validate_captions_payload(payload, expected_transcript_hash=source_transcript_hash)
    if not valid:
        raise ValueError(reason or "Invalid caption sidecar payload")
    return payload


def validate_captions_payload(
    payload: Any,
    *,
    expected_transcript_hash: Optional[str] = None,
    require_non_empty: bool = False,
) -> Tuple[bool, Optional[str]]:
    if not isinstance(payload, dict):
        return False, "Captions sidecar must be a JSON object."
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != CAPTIONS_SCHEMA_VERSION:
        return False, "Unsupported captions schemaVersion."

    source_hash = payload.get("sourceTranscriptHash")
    if not isinstance(source_hash, str) or not _SHA256_RE.fullmatch(source_hash):
        return False, "Captions sidecar is missing a valid sourceTranscriptHash."
    if expected_transcript_hash is not None and source_hash != expected_transcript_hash:
        return False, "Transcript changed after caption timings were generated."

    engine = payload.get("engine")
    if not isinstance(engine, str) or engine not in VALID_CAPTION_ENGINES:
        return False, "Captions sidecar has an invalid engine."

    precision = payload.get("timingPrecision")
    if not isinstance(precision, str) or precision not in VALID_TIMING_PRECISIONS:
        return False, "Captions sidecar has an invalid timingPrecision."

    cues = payload.get("cues")
    if not isinstance(cues, list):
        return False, "Captions sidecar cues must be a list."
    if require_non_empty and not cues:
        return False, "Captions sidecar has no caption cues."

    prev_end_ms = 0
    for index, cue in enumerate(cues):
        if not isinstance(cue, dict):
            return False, f"Cue {index} must be an object."
        start_ms = cue.get("startMs")
        end_ms = cue.get("endMs")
        if type(start_ms) is not int or type(end_ms) is not int:
            return False, f"Cue {index} timestamps must be integers."
        if start_ms < 0 or end_ms <= start_ms or start_ms < prev_end_ms:
            return False, f"Cue {index} timestamps must be monotonic and non-negative."
        text = cue.get("text")
        if not isinstance(text, str) or not text.strip():
            return False, f"Cue {index} text must be a non-empty string."
        if "speaker" in cue and cue["speaker"] is not None:
            if not isinstance(cue["speaker"], str) or not cue["speaker"].strip():
                return False, f"Cue {index} speaker must be a non-empty string."
        prev_end_ms = end_ms

    return True, None


def write_captions_sidecar_atomic(output_path: Path | str, payload: Dict[str, Any]) -> Path:
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=str(target.parent),
    )
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return target
