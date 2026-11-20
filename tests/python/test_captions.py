import json
from types import SimpleNamespace

import pytest

from backend.transcription.captions import (
    CAPTIONS_SCHEMA_VERSION,
    MAX_CUE_CHARS,
    MAX_CUE_DURATION_MS,
    MIN_CUE_DURATION_MS,
    attempt_captions_sidecar_path,
    build_caption_cues,
    build_captions_payload,
    captions_sidecar_path_for_audio,
    hash_transcript_text,
    normalize_caption_engine,
    validate_captions_payload,
    write_captions_sidecar_atomic,
)


def test_hash_transcript_text_normalizes_line_endings():
    lf = "# Transcript\n\nHello world.\nLine two.\n"
    crlf = "# Transcript\r\n\r\nHello world.\r\nLine two.\r\n"
    cr = "# Transcript\r\rHello world.\rLine two.\r"

    digest = hash_transcript_text(lf)
    assert digest.startswith("sha256:")
    assert len(digest) == len("sha256:") + 64
    assert hash_transcript_text(crlf) == digest
    assert hash_transcript_text(cr) == digest
    assert hash_transcript_text(None) == hash_transcript_text("")


def test_normalize_caption_engine_maps_aliases_and_rejects_unknown():
    assert normalize_caption_engine("lightning-whisper-mlx") == "mlx-whisper"
    assert normalize_caption_engine("MLX") == "mlx-whisper"
    assert normalize_caption_engine(" mlx-whisper ") == "mlx-whisper"
    assert normalize_caption_engine("faster") == "faster-whisper"
    assert normalize_caption_engine("faster-whisper") == "faster-whisper"
    assert normalize_caption_engine("parakeet") == "parakeet"

    for bad in ("", "whisper", "cloud", None):
        with pytest.raises(ValueError, match="Unsupported caption engine"):
            normalize_caption_engine(bad)


def test_sidecar_path_helpers(tmp_path):
    audio = tmp_path / "meeting_20260101_120000.opus"
    assert captions_sidecar_path_for_audio(audio) == tmp_path / "meeting_20260101_120000.captions.json"
    assert (
        attempt_captions_sidecar_path(audio, "11111111-1111-4111-8111-111111111111")
        == tmp_path / "meeting_20260101_120000.captions-11111111-1111-4111-8111-111111111111.json"
    )


def test_build_caption_cues_word_timed_leading_space_objects_attach_punctuation():
    words = [
        SimpleNamespace(word=" Hello", start=0.10, end=0.45),
        SimpleNamespace(word=" world", start=0.45, end=0.90),
        SimpleNamespace(word=",", start=0.90, end=0.95),
        SimpleNamespace(word=" next", start=1.00, end=1.40),
    ]
    cues, precision = build_caption_cues([{"start": 0.1, "end": 1.4, "text": "Hello world, next", "words": words}])

    assert precision == "word"
    assert cues == [
        {
            "startMs": 100,
            "endMs": 1400,
            "text": "Hello world, next",
        }
    ]


def test_build_caption_cues_word_timed_without_leading_spaces_never_glues_words():
    words = [
        SimpleNamespace(word="Hello", start=0.0, end=0.4),
        SimpleNamespace(word="world", start=0.4, end=0.8),
        SimpleNamespace(word="again", start=0.8, end=1.2),
    ]
    cues, precision = build_caption_cues([{"start": 0.0, "end": 1.2, "text": "Hello world again", "words": words}])

    assert precision == "word"
    assert cues == [
        {
            "startMs": 0,
            "endMs": 1200,
            "text": "Hello world again",
        }
    ]


def test_build_caption_cues_dict_words_flush_on_speaker_duration_and_char_limits():
    words = [
        {"text": "Speaker", "startMs": 0, "endMs": 400, "speaker": "Speaker 1"},
        {"text": "one", "startMs": 400, "endMs": 800, "speaker": "Speaker 1"},
        {"text": ".", "startMs": 800, "endMs": 850, "joinNoSpace": True, "speaker": "Speaker 1"},
        {"text": "Speaker", "startMs": 900, "endMs": 1300, "speaker": "Speaker 2"},
        {"text": "two", "startMs": 1300, "endMs": 1700, "speaker": "Speaker 2"},
        # Pushes duration past MAX_CUE_DURATION_MS (900 -> 8500 = 7600ms > 7000ms)
        {"text": "continues", "startMs": 8100, "endMs": 8500, "speaker": "Speaker 2"},
        # Pushes char count past MAX_CUE_CHARS
        {"text": "x" * 78, "startMs": 8600, "endMs": 9200, "speaker": "Speaker 2"},
    ]
    cues, precision = build_caption_cues([{"start": 0.0, "end": 9.2, "text": "ignored", "words": words}])

    assert precision == "word"
    assert len(cues) == 4
    assert cues[0] == {"startMs": 0, "endMs": 850, "text": "Speaker one.", "speaker": "Speaker 1"}
    assert cues[1] == {"startMs": 900, "endMs": 1700, "text": "Speaker two", "speaker": "Speaker 2"}
    assert cues[2] == {"startMs": 8100, "endMs": 8500, "text": "continues", "speaker": "Speaker 2"}
    assert cues[3] == {"startMs": 8600, "endMs": 9200, "text": "x" * 78, "speaker": "Speaker 2"}


def test_build_caption_cues_segment_only_splits_long_text_and_duration_monotonically():
    long_text = (
        "We reviewed the Q3 roadmap in detail, covering onboarding delays and API limits. "
        "Then we agreed on concrete next steps for every engineering team before Friday."
    )
    cues, precision = build_caption_cues(
        [
            {
                "start": 0.0,
                "end": 18.0,
                "text": long_text,
                "speaker": "Speaker 1",
            }
        ],
        audio_duration=18.0,
    )

    assert precision == "segment"
    assert len(cues) >= 3
    prev_end = 0
    for cue in cues:
        assert len(cue["text"]) <= MAX_CUE_CHARS
        assert cue["speaker"] == "Speaker 1"
        assert cue["startMs"] >= prev_end
        assert cue["endMs"] > cue["startMs"]
        assert cue["endMs"] - cue["startMs"] <= MAX_CUE_DURATION_MS + 1500
        prev_end = cue["endMs"]
    assert cues[-1]["endMs"] == 18000
    assert " ".join(cue["text"] for cue in cues) == long_text


def test_build_caption_cues_cjk_no_space_text_and_clamps_overlapping_negative_inputs():
    cjk_text = "今天下午我们一起讨论了产品发布计划并且确认了测试时间节点和交付标准" * 4
    cues, precision = build_caption_cues(
        [
            {"start": 5.0, "end": 5.5, "text": "Second overlapping item"},
            {"start": -1.5, "end": 5.1, "text": "First clamped item"},
            {"start": 5.5, "end": 20.0, "text": cjk_text},
        ],
        audio_duration=20.0,
    )

    assert precision == "segment"
    assert cues[0]["startMs"] == 0
    assert cues[0]["text"] == "First clamped item"
    prev_end = 0
    for cue in cues:
        assert len(cue["text"]) <= MAX_CUE_CHARS
        assert cue["startMs"] >= prev_end
        assert cue["endMs"] - cue["startMs"] >= MIN_CUE_DURATION_MS
        prev_end = cue["endMs"]
    assert "".join(c["text"] for c in cues[2:]) == cjk_text


def test_validate_captions_payload_enforces_schema_and_invariants():
    valid_hash = hash_transcript_text("hello")
    valid_payload = build_captions_payload(
        source_transcript_hash=valid_hash,
        engine="faster",
        cues=[{"startMs": 0, "endMs": 500, "text": "hello", "speaker": "Speaker 1"}],
        timing_precision="word",
    )
    assert valid_payload["schemaVersion"] == CAPTIONS_SCHEMA_VERSION
    assert valid_payload["engine"] == "faster-whisper"
    assert validate_captions_payload(valid_payload, expected_transcript_hash=valid_hash, require_non_empty=True) == (True, None)

    invalid_cases = [
        (["not-a-dict"], {}),
        ({**valid_payload, "schemaVersion": 2}, {}),
        ({**valid_payload, "schemaVersion": True}, {}),
        ({**valid_payload, "sourceTranscriptHash": "sha256:not-hex"}, {}),
        ({**valid_payload, "sourceTranscriptHash": valid_hash.upper()}, {}),
        (valid_payload, {"expected_transcript_hash": hash_transcript_text("different")}),
        ({**valid_payload, "engine": "unknown"}, {}),
        ({**valid_payload, "timingPrecision": "char"}, {}),
        ({**valid_payload, "cues": "not-a-list"}, {}),
        ({**valid_payload, "cues": []}, {"require_non_empty": True}),
        ({**valid_payload, "cues": [{"startMs": 100, "endMs": 100, "text": "zero"}]}, {}),
        ({**valid_payload, "cues": [{"startMs": 500, "endMs": 600, "text": "a"}, {"startMs": 550, "endMs": 700, "text": "b"}]}, {}),
        ({**valid_payload, "cues": [{"startMs": -1, "endMs": 200, "text": "neg"}]}, {}),
        ({**valid_payload, "cues": [{"startMs": 0, "endMs": 200, "text": "   "}]}, {}),
        ({**valid_payload, "cues": [{"startMs": 0, "endMs": 200, "text": "ok", "speaker": ""}]}, {}),
        ({**valid_payload, "cues": [{"startMs": 0, "endMs": 200, "text": "ok", "speaker": "   "}]}, {}),
    ]

    for payload, kwargs in invalid_cases:
        ok, reason = validate_captions_payload(payload, **kwargs)
        assert ok is False
        assert isinstance(reason, str) and reason


def test_validate_captions_payload_allows_empty_cues_when_not_required():
    valid_hash = hash_transcript_text("silent")
    payload = build_captions_payload(
        source_transcript_hash=valid_hash,
        engine="parakeet",
        cues=[],
        timing_precision="segment",
    )
    assert validate_captions_payload(payload, expected_transcript_hash=valid_hash, require_non_empty=False) == (True, None)


def test_write_captions_sidecar_atomic_writes_valid_json_without_tmp_files(tmp_path):
    target = tmp_path / "nested" / "meeting.captions.json"
    payload = build_captions_payload(
        source_transcript_hash=hash_transcript_text("sample"),
        engine="mlx",
        cues=[{"startMs": 0, "endMs": 1000, "text": "Sample cue"}],
        timing_precision="segment",
    )

    written = write_captions_sidecar_atomic(target, payload)
    assert written == target
    assert json.loads(target.read_text(encoding="utf-8")) == payload
    assert list(target.parent.glob("*.tmp")) == []
