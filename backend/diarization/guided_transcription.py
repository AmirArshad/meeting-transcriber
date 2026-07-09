"""Diarization-guided transcription pipeline.

This module runs speaker diarization before transcription, then uses the speaker
turns to choose short padded transcription windows. It keeps Whisper context near
turn boundaries without assigning whole 30 second chunks to whichever speaker had
the largest overlap.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .diarization_pipeline import (
    DEFAULT_MODEL_REF,
    build_diarization_result,
    emit_progress,
    get_audio_duration_seconds,
    normalize_speaker_count,
    prepare_diarization_audio,
    run_pyannote_diarization,
    save_diarization_result,
)
from transcription.formatting import save_transcript_markdown


DEFAULT_TURN_PADDING_SECONDS = 0.35
DEFAULT_MAX_WINDOW_SECONDS = 18.0
DEFAULT_MERGE_GAP_SECONDS = 0.6
DEFAULT_MIN_TURN_SECONDS = 0.5


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_whitespace(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def decode_process_output(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", errors="replace")
    return str(value or "")


def normalize_speaker_turns(
    speaker_segments: Iterable[Dict[str, Any]],
    *,
    min_turn_seconds: float = DEFAULT_MIN_TURN_SECONDS,
) -> List[Dict[str, Any]]:
    turns: List[Dict[str, Any]] = []
    for segment in speaker_segments:
        if not isinstance(segment, dict):
            continue
        speaker = str(segment.get("speaker", "") or "").strip()
        start = max(0.0, _to_float(segment.get("start")))
        end = max(0.0, _to_float(segment.get("end")))
        if not speaker or end - start < min_turn_seconds:
            continue
        turns.append({"start": start, "end": end, "speaker": speaker})

    return sorted(turns, key=lambda item: (item["start"], item["end"], item["speaker"]))


def _split_long_turn(turn: Dict[str, Any], *, max_window_seconds: float) -> List[Dict[str, Any]]:
    if max_window_seconds <= 0 or turn["end"] - turn["start"] <= max_window_seconds:
        return [turn]

    pieces: List[Dict[str, Any]] = []
    cursor = turn["start"]
    while cursor < turn["end"]:
        end = min(turn["end"], cursor + max_window_seconds)
        pieces.append({**turn, "start": cursor, "end": end})
        cursor = end
    return pieces


def build_diarization_guided_windows(
    speaker_segments: Iterable[Dict[str, Any]],
    *,
    audio_duration: float = 0.0,
    padding_seconds: float = DEFAULT_TURN_PADDING_SECONDS,
    max_window_seconds: float = DEFAULT_MAX_WINDOW_SECONDS,
    merge_gap_seconds: float = DEFAULT_MERGE_GAP_SECONDS,
    min_turn_seconds: float = DEFAULT_MIN_TURN_SECONDS,
) -> List[Dict[str, Any]]:
    """Build padded transcription windows that never intentionally cross speakers."""
    turns = normalize_speaker_turns(speaker_segments, min_turn_seconds=min_turn_seconds)
    if not turns:
        return []

    merged: List[Dict[str, Any]] = []
    for turn in turns:
        previous = merged[-1] if merged else None
        gap = turn["start"] - previous["end"] if previous else None
        combined_duration = turn["end"] - previous["start"] if previous else 0.0
        if (
            previous
            and previous["speaker"] == turn["speaker"]
            and gap is not None
            and gap <= merge_gap_seconds
            and combined_duration <= max_window_seconds
        ):
            previous["end"] = max(previous["end"], turn["end"])
            continue

        merged.append(dict(turn))

    windows: List[Dict[str, Any]] = []
    duration_limit = audio_duration if audio_duration > 0 else 0.0
    for turn in merged:
        for piece in _split_long_turn(turn, max_window_seconds=max_window_seconds):
            padded_start = max(0.0, piece["start"] - padding_seconds)
            padded_end = piece["end"] + padding_seconds
            if duration_limit > 0:
                padded_end = min(duration_limit, padded_end)
            if padded_end <= padded_start:
                padded_start = piece["start"]
                padded_end = piece["end"]
            if padded_end <= padded_start:
                continue
            windows.append({
                **piece,
                "audioStart": padded_start,
                "audioEnd": padded_end,
            })

    return windows


def build_audio_window_extract_command(
    ffmpeg_path: str,
    source_audio: Path,
    target_audio: Path,
    *,
    start: float,
    end: float,
) -> List[str]:
    duration = max(0.0, end - start)
    return [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(0.0, start):.3f}",
        "-i",
        str(source_audio),
        "-t",
        f"{duration:.3f}",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        str(target_audio),
    ]


def extract_audio_window(
    source_audio: Path,
    target_audio: Path,
    *,
    start: float,
    end: float,
    ffmpeg_path: str = "ffmpeg",
) -> None:
    if end <= start:
        raise ValueError("Audio window end must be greater than start.")

    result = subprocess.run(
        build_audio_window_extract_command(ffmpeg_path, source_audio, target_audio, start=start, end=end),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = normalize_whitespace(decode_process_output(result.stderr))
        suffix = f": {detail[:200]}" if detail else ""
        raise RuntimeError(f"Could not extract diarization-guided audio window (exit code {result.returncode}){suffix}.")
    if not target_audio.exists():
        raise RuntimeError("ffmpeg did not create the diarization-guided audio window.")


def resolve_transcriber_backend(value: Optional[str] = None) -> str:
    backend = str(value or "auto").strip().lower()
    if backend in {"mlx", "faster"}:
        return backend
    if backend not in {"", "auto"}:
        raise ValueError("transcriber backend must be auto, mlx, or faster")

    machine = platform.machine().lower()
    if sys.platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "mlx"
    return "faster"


def create_transcriber(*, backend: str, model_size: str, language: str) -> Any:
    resolved_backend = resolve_transcriber_backend(backend)
    if resolved_backend == "mlx":
        from transcription.mlx_whisper_transcriber import MLXWhisperTranscriber

        return MLXWhisperTranscriber(model_size=model_size, language=language)

    from transcription.faster_whisper_transcriber import TranscriberService

    return TranscriberService(model_size=model_size, language=language)


def _extract_result_text(result: Dict[str, Any]) -> str:
    text = normalize_whitespace(result.get("text"))
    if text:
        return text

    segments = result.get("segments")
    if isinstance(segments, list):
        return normalize_whitespace(" ".join(str(segment.get("text", "")) for segment in segments if isinstance(segment, dict)))
    return ""


def temporal_overlap(first: Dict[str, Any], second: Dict[str, Any]) -> float:
    start = max(_to_float(first.get("start")), _to_float(second.get("start")))
    end = min(_to_float(first.get("end")), _to_float(second.get("end")))
    return max(0.0, end - start)


def extract_window_text_for_turn(result: Dict[str, Any], window: Dict[str, Any]) -> str:
    """Use Whisper sub-segment timestamps to drop padded context when possible."""
    segments = result.get("segments")
    if not isinstance(segments, list) or not segments:
        return _extract_result_text(result)

    turn = {"start": _to_float(window.get("start")), "end": _to_float(window.get("end"))}
    audio_start = _to_float(window.get("audioStart"))
    selected_text: List[str] = []
    fallback_text: List[str] = []
    all_text: List[str] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        text = normalize_whitespace(segment.get("text"))
        if not text:
            continue
        all_text.append(text)
        absolute = {
            "start": audio_start + _to_float(segment.get("start")),
            "end": audio_start + _to_float(segment.get("end")),
        }
        if absolute["end"] <= absolute["start"]:
            fallback_text.append(text)
            continue
        if temporal_overlap(absolute, turn) > 0:
            selected_text.append(text)

    return normalize_whitespace(" ".join(selected_text or fallback_text or all_text))


def transcribe_speaker_windows(
    *,
    source_audio: Path,
    windows: List[Dict[str, Any]],
    transcriber: Any,
    work_dir: Path,
    ffmpeg_path: str = "ffmpeg",
) -> List[Dict[str, Any]]:
    transcript_segments: List[Dict[str, Any]] = []
    total = len(windows)
    for index, window in enumerate(windows, start=1):
        emit_progress(
            "transcribing-speaker-window",
            f"Transcribing speaker window {index} of {total}.",
            percent=82 + (index / max(total, 1)) * 16,
        )
        chunk_path = work_dir / f"speaker-window-{index:04d}.wav"
        extract_audio_window(
            source_audio,
            chunk_path,
            start=_to_float(window.get("audioStart")),
            end=_to_float(window.get("audioEnd")),
            ffmpeg_path=ffmpeg_path,
        )
        result = transcriber.transcribe_file(str(chunk_path), save_markdown=False)
        text = extract_window_text_for_turn(result, window)
        if not text:
            continue
        transcript_segments.append({
            "start": _to_float(window.get("start")),
            "end": _to_float(window.get("end")),
            "text": text,
            "speaker": str(window.get("speaker", "") or ""),
        })

    return transcript_segments


def transcribe_full_audio(transcriber: Any, audio_path: Path) -> List[Dict[str, Any]]:
    result = transcriber.transcribe_file(str(audio_path), save_markdown=False)
    segments = result.get("segments")
    if isinstance(segments, list) and segments:
        return [dict(segment) for segment in segments if isinstance(segment, dict)]

    text = _extract_result_text(result)
    if not text:
        return []
    duration = _to_float(result.get("duration"), get_audio_duration_seconds(audio_path))
    return [{"start": 0.0, "end": duration, "text": text}]


def save_guided_markdown(
    *,
    output_path: str,
    audio_path: str,
    language: str,
    duration: float,
    segments: List[Dict[str, Any]],
) -> None:
    save_transcript_markdown(
        output_path,
        audio_path=audio_path,
        language_label=language,
        duration=duration,
        segments=[
            {
                **segment,
                "start": _to_float(segment.get("start")),
                "end": _to_float(segment.get("end")),
                "text": str(segment.get("text", "") or ""),
            }
            for segment in segments
        ],
        engine_label="Diarization-guided Whisper",
        include_speakers=True,
        log=False,
    )


def transcribe_with_diarization_guidance(
    *,
    audio_path: str,
    output_transcript: Optional[str] = None,
    output_json: Optional[str] = None,
    language: str = "en",
    model_size: str = "small",
    transcriber_backend: str = "auto",
    model_ref: str = DEFAULT_MODEL_REF,
    speaker_count: Optional[int] = None,
    ffmpeg_path: str = "ffmpeg",
    hf_token: Optional[str] = None,
    required_device: Optional[str] = None,
) -> Dict[str, Any]:
    source_audio = Path(audio_path)
    if not source_audio.exists():
        raise FileNotFoundError(f"Audio file not found: {source_audio}")

    transcript_path = output_transcript or str(source_audio.with_suffix(".md"))
    with tempfile.TemporaryDirectory(prefix="avanevis-guided-transcription-") as work_dir_name:
        work_dir = Path(work_dir_name)

        emit_progress("preparing-audio", "Preparing audio for speaker-guided transcription.", percent=8)
        prepared_audio = prepare_diarization_audio(str(source_audio), work_dir_name, ffmpeg_path=ffmpeg_path)
        audio_duration = get_audio_duration_seconds(prepared_audio)

        token = hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or ""
        speaker_segments, annotation_source, device = run_pyannote_diarization(
            prepared_audio,
            model_ref=model_ref,
            hf_token=token,
            speaker_count=speaker_count,
            required_device=required_device,
        )

        emit_progress("building-speaker-windows", "Building speaker-guided transcription windows.", percent=81)
        windows = build_diarization_guided_windows(speaker_segments, audio_duration=audio_duration)

        emit_progress("loading-transcriber", "Loading local transcription model.", percent=82)
        transcriber = create_transcriber(
            backend=transcriber_backend,
            model_size=model_size,
            language=language,
        )
        transcriber.load_model()
        try:
            if windows:
                transcript_segments = transcribe_speaker_windows(
                    source_audio=prepared_audio,
                    windows=windows,
                    transcriber=transcriber,
                    work_dir=work_dir,
                    ffmpeg_path=ffmpeg_path,
                )
            else:
                transcript_segments = []

            if not transcript_segments:
                emit_progress("fallback-transcription", "No usable speaker windows were transcribed; transcribing the full audio.", percent=94)
                transcript_segments = transcribe_full_audio(transcriber, prepared_audio)
        finally:
            try:
                transcriber.cleanup()
            except Exception:
                pass

    diarization_result = build_diarization_result(
        audio_path=str(source_audio),
        transcript_segments=transcript_segments,
        speaker_segments=speaker_segments,
        model_ref=model_ref,
        annotation_source=annotation_source,
        device=device,
    )
    if output_json:
        save_diarization_result(output_json, diarization_result)
        diarization_result["segmentsPath"] = output_json

    final_segments = diarization_result.get("segments") if isinstance(diarization_result.get("segments"), list) else transcript_segments
    text = normalize_whitespace(" ".join(str(segment.get("text", "")) for segment in final_segments if isinstance(segment, dict)))
    result = {
        "text": text,
        "segments": final_segments,
        "language": language,
        "duration": audio_duration,
        "output_file": transcript_path,
        "audioPath": str(source_audio),
        "diarization": diarization_result,
    }

    emit_progress("saving-transcript", "Saving speaker-labeled transcript.", percent=99)
    save_guided_markdown(
        output_path=transcript_path,
        audio_path=str(source_audio),
        language=language,
        duration=audio_duration,
        segments=final_segments,
    )
    emit_progress("completed", "Speaker-guided transcription completed.", percent=100)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Run speaker-guided local transcription")
    parser.add_argument("--audio", required=True, help="Source audio file path")
    parser.add_argument("--output-transcript", help="Output transcript Markdown path")
    parser.add_argument("--output-json", help="Optional output speaker JSON sidecar path")
    parser.add_argument("--language", default="en", help="Whisper language code")
    parser.add_argument("--model", default="small", help="Whisper model size")
    parser.add_argument("--transcriber-backend", default="auto", help="auto, mlx, or faster")
    parser.add_argument("--model-ref", default=DEFAULT_MODEL_REF, help="pyannote model reference")
    parser.add_argument("--speaker-count", default="auto", help="Known speaker count or auto")
    parser.add_argument("--require-device", default=None, help="Require accelerated torch device: cuda or mps")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable path")
    args = parser.parse_args()

    try:
        result = transcribe_with_diarization_guidance(
            audio_path=args.audio,
            output_transcript=args.output_transcript,
            output_json=args.output_json,
            language=args.language,
            model_size=args.model,
            transcriber_backend=args.transcriber_backend,
            model_ref=args.model_ref,
            speaker_count=normalize_speaker_count(args.speaker_count),
            ffmpeg_path=args.ffmpeg,
            required_device=args.require_device,
        )
        print(json.dumps(result, ensure_ascii=True))
    except Exception as exc:
        emit_progress("error", "Speaker-guided transcription failed.")
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
