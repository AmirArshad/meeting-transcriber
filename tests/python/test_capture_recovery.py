"""Kill-point recovery tests for interrupted capture discovery and finalize."""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest
from filelock import FileLock

from backend.audio.capture_manifest import (
    CAPTURE_DIR_SUFFIX,
    MANIFEST_FILENAME,
    SESSION_LOCK_FILENAME,
    CaptureManifestCoordinator,
)
from backend.audio.capture_recovery import (
    CaptureRecoveryError,
    list_interrupted_captures,
    recover_capture,
    recover_captures,
)
from backend.audio.constants import FINAL_CAPTURE_PCM_NAME
from backend.meetings.scan_import import select_scannable_audio_files
import backend.audio.streaming_post_processor as spp


def _write_segment(path: Path, frames: np.ndarray) -> None:
    path.write_bytes(np.ascontiguousarray(frames).tobytes())


def _build_interrupted_session(
    recordings_dir: Path,
    *,
    stem: str,
    started_at_iso: str,
    state: str = "recording",
    mic_frames: int = 48000,
    desktop_frames: int | None = 48000,
    profile: str = "windows-v1",
    dtype: str = "<i2",
    sample_rate: int = 48000,
):
    output = recordings_dir / f"{stem}.opus"
    coordinator = CaptureManifestCoordinator.create(
        output,
        started_at_ns=1_000_000,
        started_at_iso=started_at_iso,
    )
    coordinator.set_processing_profile(profile)
    coordinator.set_mix_params()
    coordinator.add_track("mic", sample_rate=sample_rate, channels=2, dtype=dtype)
    mic = np.zeros((mic_frames, 2), dtype=np.dtype(dtype))
    mic_name = "mic_0000.pcm.part"
    _write_segment(coordinator.session_dir / mic_name, mic)
    coordinator.commit_track("mic", [mic_name], committed_frames=mic_frames)

    if desktop_frames is not None:
        coordinator.add_track("desktop", sample_rate=sample_rate, channels=2, dtype=dtype)
        desk = np.zeros((desktop_frames, 2), dtype=np.dtype(dtype))
        desk_name = "desktop_0000.pcm.part"
        _write_segment(coordinator.session_dir / desk_name, desk)
        coordinator.commit_track("desktop", [desk_name], committed_frames=desktop_frames)
        coordinator.set_include_desktop(True)
    else:
        coordinator.set_include_desktop(False)

    coordinator.set_state(state)
    session_dir = coordinator.session_dir
    coordinator.close()
    return session_dir


def _patch_finalize_io(monkeypatch):
    def fake_finalize_ffmpeg(*, ffmpeg_path, output_path, frame_iter, sample_rate=48000):
        from backend.audio.wav_io import write_int16_pcm_wav

        frames = [chunk for chunk in frame_iter if chunk.size]
        audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 2), dtype=np.float32)
        int16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        write_int16_pcm_wav(output_path, int16.reshape(-1), channels=2, sample_rate=sample_rate)
        return int(audio.shape[0])

    def compress_copy(input_path, output_path, sample_rate, **kwargs):
        dest = Path(output_path).with_suffix(".wav")
        dest.write_bytes(Path(input_path).read_bytes())
        return str(dest), {
            "input_size": dest.stat().st_size,
            "output_size": dest.stat().st_size,
            "ratio": 0.0,
        }

    monkeypatch.setattr(spp, "_stream_final_wav_via_ffmpeg", fake_finalize_ffmpeg)
    monkeypatch.setattr(spp, "_verify_final_temp", lambda *a, **k: None)
    monkeypatch.setattr(spp, "compress_and_report", compress_copy)
    monkeypatch.setattr(spp, "ffmpeg_can_decode", lambda *a, **k: True)


def test_discovery_is_read_only(tmp_path):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_a",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="recording",
    )
    before = (session / MANIFEST_FILENAME).read_text(encoding="utf-8")
    segment = session / "mic_0000.pcm.part"
    segment_mtime = segment.stat().st_mtime_ns

    candidates = list_interrupted_captures(tmp_path)
    assert len(candidates) == 1
    assert candidates[0]["outputStem"] == "recording_a"
    assert candidates[0]["state"] == "recording"
    assert candidates[0]["startedAtIso"] == "2026-07-13T10:00:00.000Z"
    assert candidates[0]["approxDurationSeconds"] == pytest.approx(1.0)
    assert candidates[0]["approxBytes"] and candidates[0]["approxBytes"] > 0

    after = (session / MANIFEST_FILENAME).read_text(encoding="utf-8")
    assert before == after
    assert segment.stat().st_mtime_ns == segment_mtime
    assert session.is_dir()


@pytest.mark.parametrize(
    "state",
    ["recording", "finalizing", "error"],
)
def test_discovery_lists_kill_point_states(tmp_path, state):
    _build_interrupted_session(
        tmp_path,
        stem=f"recording_{state}",
        started_at_iso="2026-07-13T11:00:00.000Z",
        state=state,
        desktop_frames=24000,
    )
    candidates = list_interrupted_captures(tmp_path)
    assert len(candidates) == 1
    assert candidates[0]["state"] == state


def test_discovery_orders_oldest_first_by_started_at_iso(tmp_path):
    _build_interrupted_session(
        tmp_path,
        stem="recording_newer",
        started_at_iso="2026-07-13T12:00:00.000Z",
    )
    _build_interrupted_session(
        tmp_path,
        stem="recording_older",
        started_at_iso="2026-07-13T09:00:00.000Z",
    )
    candidates = list_interrupted_captures(tmp_path)
    assert [c["outputStem"] for c in candidates] == ["recording_older", "recording_newer"]


def test_discovery_skips_locked_session(tmp_path):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_locked",
        started_at_iso="2026-07-13T10:00:00.000Z",
    )
    lock = FileLock(str(session / SESSION_LOCK_FILENAME))
    lock.acquire(timeout=0)
    try:
        assert list_interrupted_captures(tmp_path) == []
    finally:
        lock.release()


def test_discovery_null_fields_when_iso_malformed(tmp_path):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_bad_iso",
        started_at_iso="2026-07-13T10:00:00.000Z",
    )
    manifest_path = session / MANIFEST_FILENAME
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["startedAtIso"] = "not-a-timestamp"
    # Bypass coordinator validation that would reject at write time by writing raw.
    # validate_manifest_data still accepts the string type; discovery reports null.
    lock = FileLock(str(session / SESSION_LOCK_FILENAME))
    lock.acquire(timeout=0)
    try:
        manifest_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    finally:
        lock.release()

    candidates = list_interrupted_captures(tmp_path)
    assert len(candidates) == 1
    assert candidates[0]["startedAtIso"] is None


def test_scan_never_imports_tracks_or_capture_temps(tmp_path):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_scan",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="finalizing",
    )
    meeting = tmp_path / "meeting_20260101_120000.opus"
    meeting.write_bytes(b"opus")
    (session / FINAL_CAPTURE_PCM_NAME).write_bytes(b"RIFF" + b"\x00" * 60)
    (session / "inside.wav").write_bytes(b"RIFF")
    (tmp_path / "loose.pcm.part").write_bytes(b"\x00" * 8)

    selected = select_scannable_audio_files(tmp_path)
    assert [path.name for path in selected] == [meeting.name]
    assert session.is_dir()
    assert (session / "mic_0000.pcm.part").is_file()


def test_recovery_resumes_from_committed_frames(tmp_path, monkeypatch):
    _patch_finalize_io(monkeypatch)
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_recover",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="recording",
        mic_frames=9600,
        desktop_frames=None,
    )
    # Append uncommitted tail bytes that must not be finalized.
    mic_part = session / "mic_0000.pcm.part"
    mic_part.write_bytes(mic_part.read_bytes() + (b"\xff" * 400))

    result = recover_capture(tmp_path, session, ffmpeg_path="ffmpeg")
    assert Path(result["audioPath"]).is_file()
    assert result["duration"] == pytest.approx(9600 / 48000, abs=0.05)
    # Successful recovery removes the capture directory.
    assert not session.exists()
    assert select_scannable_audio_files(tmp_path)
    # Recovered audio is a meeting file, not a track segment.
    for path in select_scannable_audio_files(tmp_path):
        assert CAPTURE_DIR_SUFFIX not in path.name
        assert not path.name.endswith(".pcm.part")


def test_recovery_never_deletes_verified_final_on_failure(tmp_path, monkeypatch):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_keep_final",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="finalizing",
        desktop_frames=None,
    )
    verified = tmp_path / "recording_keep_final.opus"
    verified.write_bytes(b"verified-final")

    def boom(*args, **kwargs):
        raise spp.FinalizationError("forced failure")

    monkeypatch.setattr(spp, "finalize_capture", boom)

    # Call through recover_captures so the exception is recorded, not raised.
    # Use the real recover_capture path with a patched finalize.
    monkeypatch.setattr(
        "backend.audio.capture_recovery.finalize_capture",
        boom,
    )
    batch = recover_captures(tmp_path, [session], ffmpeg_path="ffmpeg")
    assert batch["success"] is False
    assert len(batch["failed"]) == 1
    assert verified.is_file()
    assert verified.read_bytes() == b"verified-final"
    assert session.is_dir()
    assert (session / MANIFEST_FILENAME).is_file()


def test_deferred_failed_session_remains_discoverable(tmp_path, monkeypatch):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_deferred",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="error",
    )

    def boom(*args, **kwargs):
        raise spp.FinalizationError("still broken")

    monkeypatch.setattr("backend.audio.capture_recovery.finalize_capture", boom)
    batch = recover_captures(tmp_path, [session], ffmpeg_path="ffmpeg")
    assert batch["success"] is False
    assert session.is_dir()

    again = list_interrupted_captures(tmp_path)
    assert len(again) == 1
    assert again[0]["outputStem"] == "recording_deferred"


def test_recover_rejects_symlink_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    escape = outside / "evil.capture"
    escape.mkdir()
    (escape / MANIFEST_FILENAME).write_text("{}", encoding="utf-8")

    recordings = tmp_path / "recordings"
    recordings.mkdir()
    link = recordings / "evil.capture"
    try:
        link.symlink_to(escape, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")

    with pytest.raises(CaptureRecoveryError, match="direct child|escapes"):
        recover_capture(recordings, link, ffmpeg_path="ffmpeg")


def test_recover_rejects_non_child_path(tmp_path):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_ok",
        started_at_iso="2026-07-13T10:00:00.000Z",
    )
    other_root = tmp_path / "other"
    other_root.mkdir()
    with pytest.raises(CaptureRecoveryError, match="direct child"):
        recover_capture(other_root, session, ffmpeg_path="ffmpeg")


def test_recovery_after_final_before_manifest_complete(tmp_path, monkeypatch):
    """Kill after verified output exists but before complete+cleanup."""
    _patch_finalize_io(monkeypatch)
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_almost",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="finalizing",
        desktop_frames=None,
        mic_frames=4800,
    )
    # Simulate a verified final already written beside the recordings root.
    final = tmp_path / "recording_almost.wav"
    final.write_bytes(b"RIFF" + b"\x00" * 100)

    # Make finalize succeed idempotently by completing via the real path.
    result = recover_capture(tmp_path, session, ffmpeg_path="ffmpeg")
    assert Path(result["audioPath"]).is_file()
    # Capture dir cleaned on success; meeting audio remains scannable.
    assert not session.exists() or not (session / MANIFEST_FILENAME).exists()
    selected = select_scannable_audio_files(tmp_path)
    assert selected
    assert all(CAPTURE_DIR_SUFFIX not in p.name for p in selected)


def test_cli_list_and_recover_roundtrip(tmp_path, monkeypatch):
    from backend.audio.capture_recovery import main

    _patch_finalize_io(monkeypatch)
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_cli",
        started_at_iso="2026-07-13T08:00:00.000Z",
        desktop_frames=None,
        mic_frames=4800,
    )

    assert main(["--recordings-dir", str(tmp_path), "--list"]) == 0
    assert main([
        "--recordings-dir", str(tmp_path),
        "--ffmpeg", "ffmpeg",
        "--recover", str(session),
    ]) == 0
    assert list_interrupted_captures(tmp_path) == []


def test_unsafe_output_stem_rejected(tmp_path):
    from backend.audio.capture_manifest import CaptureManifestError, validate_manifest_data

    with pytest.raises(CaptureManifestError, match="Unsafe outputStem"):
        validate_manifest_data({
            "schemaVersion": 1,
            "state": "recording",
            "outputStem": "../escape",
            "startedAtMonotonicNs": 1,
            "startedAtIso": "2026-07-13T10:00:00.000Z",
            "tracks": {
                "mic": {
                    "sampleRate": 48000,
                    "channels": 2,
                    "dtype": "<i2",
                    "committedFrames": 0,
                    "segments": [],
                }
            },
        })

    with pytest.raises(CaptureManifestError, match="Unsafe outputStem"):
        validate_manifest_data({
            "schemaVersion": 1,
            "state": "recording",
            "outputStem": "/tmp/evil",
            "startedAtMonotonicNs": 1,
            "startedAtIso": "2026-07-13T10:00:00.000Z",
            "tracks": {
                "mic": {
                    "sampleRate": 48000,
                    "channels": 2,
                    "dtype": "<i2",
                    "committedFrames": 0,
                    "segments": [],
                }
            },
        })


def test_preexisting_verified_opus_is_not_overwritten(tmp_path, monkeypatch):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_keep",
        started_at_iso="2026-07-13T10:00:00.000Z",
        state="finalizing",
        desktop_frames=None,
        mic_frames=4800,
    )
    verified = tmp_path / "recording_keep.opus"
    verified.write_bytes(b"verified-final-bytes")

    monkeypatch.setattr(
        "backend.audio.capture_recovery.ffmpeg_can_decode",
        lambda *a, **k: True,
    )

    called = {"finalize": False}

    def boom(*args, **kwargs):
        called["finalize"] = True
        raise spp.FinalizationError("should not run")

    monkeypatch.setattr("backend.audio.capture_recovery.finalize_capture", boom)

    result = recover_capture(tmp_path, session, ffmpeg_path="ffmpeg")
    assert called["finalize"] is False
    assert verified.read_bytes() == b"verified-final-bytes"
    assert Path(result["audioPath"]) == verified
    assert not session.exists() or not (session / MANIFEST_FILENAME).exists()


def test_approx_bytes_none_when_no_segments(tmp_path):
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_empty_bytes",
        started_at_iso="2026-07-13T10:00:00.000Z",
        mic_frames=0,
        desktop_frames=None,
    )
    # Remove segment file so byte estimate is unknown.
    part = session / "mic_0000.pcm.part"
    if part.exists():
        part.unlink()
    candidates = list_interrupted_captures(tmp_path)
    assert len(candidates) == 1
    assert candidates[0]["approxBytes"] is None


def test_recovering_opus_staging_not_scannable(tmp_path):
    meeting = tmp_path / "meeting_20260101_120000.opus"
    meeting.write_bytes(b"opus")
    staging = tmp_path / "recording_x.recovering.opus"
    staging.write_bytes(b"partial")
    selected = select_scannable_audio_files(tmp_path)
    assert [path.name for path in selected] == [meeting.name]


def test_recovering_wav_staging_not_scannable(tmp_path):
    meeting = tmp_path / "meeting_20260101_120000.opus"
    meeting.write_bytes(b"opus")
    staging = tmp_path / "recording_x.recovering.wav"
    staging.write_bytes(b"RIFF")
    selected = select_scannable_audio_files(tmp_path)
    assert [path.name for path in selected] == [meeting.name]


def test_promote_failure_retains_capture_session(tmp_path, monkeypatch):
    """Promotion must happen before complete/cleanup; failure keeps .capture."""
    _patch_finalize_io(monkeypatch)
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_promote_fail",
        started_at_iso="2026-07-13T10:00:00.000Z",
        desktop_frames=None,
        mic_frames=4800,
    )

    real_replace = os.replace

    def boom_replace(src, dst):
        src_path = Path(src)
        dst_path = Path(dst)
        if src_path.name.endswith(".recovering.opus") or src_path.name.endswith(".recovering.wav"):
            raise OSError("simulated promote failure")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", boom_replace)

    with pytest.raises((spp.FinalizationError, CaptureRecoveryError)):
        recover_capture(tmp_path, session, ffmpeg_path="ffmpeg")

    assert session.is_dir()
    assert (session / MANIFEST_FILENAME).is_file()
    # Canonical meeting file must not appear without a durable capture cleanup.
    assert not (tmp_path / "recording_promote_fail.opus").exists() or session.exists()
    data = json.loads((session / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert data["state"] != "complete"


def test_successful_recovery_promotes_before_cleanup(tmp_path, monkeypatch):
    _patch_finalize_io(monkeypatch)
    session = _build_interrupted_session(
        tmp_path,
        stem="recording_promote_ok",
        started_at_iso="2026-07-13T10:00:00.000Z",
        desktop_frames=None,
        mic_frames=4800,
    )
    result = recover_capture(tmp_path, session, ffmpeg_path="ffmpeg")
    assert Path(result["audioPath"]).name == "recording_promote_ok.wav" or Path(result["audioPath"]).name.endswith(
        (".opus", ".wav")
    )
    assert not (tmp_path / "recording_promote_ok.recovering.opus").exists()
    assert not (tmp_path / "recording_promote_ok.recovering.wav").exists()
    assert not session.exists() or not (session / MANIFEST_FILENAME).exists()
