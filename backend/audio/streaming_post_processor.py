"""Bounded multi-pass capture finalization (Task 9).

Reads committed track spools in ``chunk_frames``-sized windows, normalizes to
48 kHz stereo intermediates, applies the platform processing profile, streams a
recoverable ``final.pcm.tmp`` via an explicit ffmpeg path, then encodes Opus.
Failures before verified completion leave the manifest and committed tracks for
Task 10 recovery.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Union

import numpy as np

from .capture_manifest import (
    CaptureManifestCoordinator,
    CaptureManifestError,
    MANIFEST_FILENAME,
    VALID_PROCESSING_PROFILES,
)
from .compressor import compress_and_report
from .constants import (
    DEFAULT_FINALIZATION_CHUNK_FRAMES,
    DEFAULT_SAMPLE_RATE,
    FINAL_CAPTURE_PCM_NAME,
    MIC_BOOST_LINEAR,
    NORMALIZED_DESKTOP_NAME,
    NORMALIZED_MIC_NAME,
)
from .macos_stereo_repair import repair_one_sided_stereo
from .processor import (
    ChannelEnhancePlan,
    StatefulResampler,
    apply_stereo_enhance_inplace,
    downmix_macos_frames_to_stereo,
    downmix_windows_frames_to_stereo,
    plan_stereo_enhance,
)
from .wav_io import probe_wav_pcm_geometry

PathLike = Union[str, Path]
ProgressCallback = Optional[Callable[[str, str], None]]

TARGET_RATE = DEFAULT_SAMPLE_RATE
TARGET_CHANNELS = 2


class FinalizationError(RuntimeError):
    """Bounded finalization failed before verified completion."""

    def __init__(self, message: str, *, recoverable_path: Optional[str] = None) -> None:
        super().__init__(message)
        self.recoverable_path = recoverable_path


@dataclass
class FinalizationResult:
    final_path: str
    duration: float
    temp_wav_path: Optional[str]
    recovered: bool
    stats: Dict[str, Any] = field(default_factory=dict)


@dataclass
class _OneSidedDecision:
    repair: bool = False
    dominant_left: bool = True


@dataclass
class _TrackStats:
    frames: int = 0
    channels: int = 0
    sum_sq_left: float = 0.0
    sum_sq_right: float = 0.0
    peak_left: float = 0.0
    peak_right: float = 0.0


class TrackFrameReader:
    """Sequential frame reader over capture segment files (bounded reads only).

    When ``committed_frames`` is set, reading stops at that durable manifest
    boundary even if segment files contain a longer uncommitted tail.
    """

    def __init__(
        self,
        session_dir: PathLike,
        segments: List[str],
        *,
        channels: int,
        dtype: str,
        chunk_frames: int = DEFAULT_FINALIZATION_CHUNK_FRAMES,
        max_chunk_frames: Optional[int] = None,
        committed_frames: Optional[int] = None,
    ) -> None:
        if channels <= 0:
            raise ValueError("channels must be positive")
        if chunk_frames <= 0:
            raise ValueError("chunk_frames must be positive")
        if committed_frames is not None and committed_frames < 0:
            raise ValueError("committed_frames must be non-negative")
        self._session_dir = Path(session_dir)
        self._segments = list(segments)
        self._channels = int(channels)
        self._dtype = np.dtype(dtype)
        self._frame_bytes = self._channels * self._dtype.itemsize
        self._chunk_frames = int(chunk_frames)
        self._max_chunk_frames = int(max_chunk_frames or chunk_frames)
        self._committed_frames = (
            None if committed_frames is None else int(committed_frames)
        )
        self._frames_read = 0
        self._seg_index = 0
        self._seg_offset = 0
        self._handle: Optional[Any] = None
        self._opened_path: Optional[Path] = None

    @property
    def chunk_frames(self) -> int:
        return self._chunk_frames

    @property
    def frames_read(self) -> int:
        return self._frames_read

    def close(self) -> None:
        if self._handle is not None:
            try:
                self._handle.close()
            except Exception:
                pass
            self._handle = None
            self._opened_path = None

    def __enter__(self) -> "TrackFrameReader":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def read_frames(self, frame_count: Optional[int] = None) -> np.ndarray:
        requested = self._chunk_frames if frame_count is None else int(frame_count)
        if requested <= 0:
            raise ValueError("frame_count must be positive")
        if requested > self._max_chunk_frames:
            raise ValueError(
                f"Rejecting oversize chunk read: requested {requested} frames "
                f"exceeds max_chunk_frames={self._max_chunk_frames}"
            )
        if self._committed_frames is not None:
            remaining_frames = self._committed_frames - self._frames_read
            if remaining_frames <= 0:
                return np.zeros((0, self._channels), dtype=self._dtype)
            requested = min(requested, remaining_frames)

        remaining = requested * self._frame_bytes
        # Prefer a single preallocated buffer over joining byte fragments.
        buffer = bytearray()
        while remaining > 0:
            handle = self._ensure_handle()
            if handle is None:
                break
            chunk = handle.read(remaining)
            if not chunk:
                handle.close()
                self._handle = None
                self._opened_path = None
                self._seg_index += 1
                self._seg_offset = 0
                continue
            if len(chunk) % self._frame_bytes != 0:
                usable = (len(chunk) // self._frame_bytes) * self._frame_bytes
                chunk = chunk[:usable]
                if not chunk:
                    break
            buffer.extend(chunk)
            remaining -= len(chunk)
            self._seg_offset += len(chunk)

        if not buffer:
            return np.zeros((0, self._channels), dtype=self._dtype)

        samples = np.frombuffer(buffer, dtype=self._dtype)
        frames = samples.reshape(-1, self._channels).copy()
        self._frames_read += int(frames.shape[0])
        return frames

    def iter_chunks(self) -> Iterator[np.ndarray]:
        while True:
            chunk = self.read_frames()
            if chunk.shape[0] == 0:
                break
            yield chunk

    def _ensure_handle(self) -> Optional[Any]:
        if self._handle is not None:
            return self._handle
        while self._seg_index < len(self._segments):
            path = self._session_dir / self._segments[self._seg_index]
            if not path.is_file():
                raise FileNotFoundError(f"Missing capture segment: {path}")
            handle = open(path, "rb")
            if self._seg_offset:
                handle.seek(self._seg_offset)
            self._handle = handle
            self._opened_path = path
            return handle
        return None


def _emit_progress(callback: ProgressCallback, stage: str, message: str) -> None:
    if callback is None:
        return
    try:
        callback(stage, message)
    except Exception:
        pass


def _int16_frames_to_float(frames: np.ndarray) -> np.ndarray:
    return frames.astype(np.float32) / 32768.0


def _float_stereo_to_int16_interleaved(frames: np.ndarray) -> np.ndarray:
    clipped = np.clip(frames, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).reshape(-1)


def _accumulate_stereo_stats(stats: _TrackStats, frames: np.ndarray) -> None:
    if frames.size == 0:
        return
    data = frames if frames.ndim == 2 else frames.reshape(-1, frames.shape[-1] if frames.ndim else 1)
    if data.shape[1] == 1:
        left = data[:, 0]
        right = left
    else:
        left = data[:, 0]
        right = data[:, 1]
    stats.frames += int(data.shape[0])
    stats.channels = 2
    stats.sum_sq_left += float(np.dot(left, left))
    stats.sum_sq_right += float(np.dot(right, right))
    stats.peak_left = max(stats.peak_left, abs(float(left.min())) if left.size else 0.0, abs(float(left.max())) if left.size else 0.0)
    stats.peak_right = max(stats.peak_right, abs(float(right.min())) if right.size else 0.0, abs(float(right.max())) if right.size else 0.0)


def _decide_one_sided(stats: _TrackStats) -> _OneSidedDecision:
    if stats.frames <= 0:
        return _OneSidedDecision(repair=False)
    left_rms = float(np.sqrt(stats.sum_sq_left / stats.frames))
    right_rms = float(np.sqrt(stats.sum_sq_right / stats.frames))
    left_peak = stats.peak_left
    right_peak = stats.peak_right
    max_rms = max(left_rms, right_rms)
    min_rms = min(left_rms, right_rms)
    max_peak = max(left_peak, right_peak)
    min_peak = min(left_peak, right_peak)
    if max_rms < 1e-5 or max_peak < 1e-4:
        return _OneSidedDecision(repair=False)
    if min_rms > max_rms * 0.20 or min_peak > max_peak * 0.35:
        return _OneSidedDecision(repair=False)
    return _OneSidedDecision(repair=True, dominant_left=left_rms >= right_rms)


def _apply_one_sided(frames: np.ndarray, decision: _OneSidedDecision) -> np.ndarray:
    if not decision.repair or frames.size == 0:
        return frames
    dominant = frames[:, 0] if decision.dominant_left else frames[:, 1]
    return np.column_stack([dominant, dominant])


def _write_float32_chunk(path: Path, frames: np.ndarray, *, append: bool) -> None:
    mode = "ab" if append else "wb"
    with open(path, mode) as handle:
        handle.write(np.ascontiguousarray(frames, dtype=np.float32).tobytes())


def _read_float32_stereo_chunk(path: Path, start_frame: int, frame_count: int) -> np.ndarray:
    if frame_count <= 0:
        return np.zeros((0, 2), dtype=np.float32)
    frame_bytes = 2 * 4
    with open(path, "rb") as handle:
        handle.seek(start_frame * frame_bytes)
        payload = handle.read(frame_count * frame_bytes)
    if not payload:
        return np.zeros((0, 2), dtype=np.float32)
    samples = np.frombuffer(payload, dtype=np.float32)
    usable = (samples.size // 2) * 2
    return samples[:usable].reshape(-1, 2).copy()


def _normalize_track_to_stereo_file(
    *,
    session_dir: Path,
    track: Dict[str, Any],
    profile: str,
    output_name: str,
    chunk_frames: int,
    target_rate: int = TARGET_RATE,
) -> int:
    sample_rate = int(track["sampleRate"])
    channels = int(track["channels"])
    dtype = str(track["dtype"])
    if profile == "macos-v1" and sample_rate != target_rate:
        raise FinalizationError(
            f"macOS-v1 capture rate {sample_rate} Hz is unsupported; expected {target_rate} Hz"
        )

    out_path = session_dir / output_name
    if out_path.exists():
        out_path.unlink()

    written = 0
    resampler = StatefulResampler(sample_rate, target_rate, channels, quality="VHQ")
    downmix = (
        downmix_windows_frames_to_stereo
        if profile == "windows-v1"
        else downmix_macos_frames_to_stereo
    )
    committed = int(track.get("committedFrames") or 0)

    with TrackFrameReader(
        session_dir,
        track.get("segments") or [],
        channels=channels,
        dtype=dtype,
        chunk_frames=chunk_frames,
        max_chunk_frames=chunk_frames,
        committed_frames=committed,
    ) as reader:
        first = True
        pending_flush = False
        while True:
            raw = reader.read_frames()
            if raw.shape[0] == 0:
                if written == 0 and not pending_flush:
                    break
                float_in = (
                    np.zeros((0, channels), dtype=np.float32)
                    if channels > 1
                    else np.zeros(0, dtype=np.float32)
                )
                last = True
            else:
                pending_flush = True
                if dtype in ("<i2", "int16"):
                    float_in = _int16_frames_to_float(raw)
                else:
                    float_in = raw.astype(np.float32, copy=False)
                last = False

            resampled = resampler.process(float_in, last=last)
            if resampled.size:
                stereo = downmix(resampled, channels)
                _write_float32_chunk(out_path, stereo, append=not first)
                first = False
                written += int(stereo.shape[0])
            if last:
                break

        if reader.frames_read != committed:
            raise FinalizationError(
                f"Track short of committed frames for {output_name}: "
                f"read {reader.frames_read}, expected {committed}"
            )

    if written == 0:
        _write_float32_chunk(out_path, np.zeros((0, 2), dtype=np.float32), append=False)
    return written


def _scan_normalized_stats(path: Path, chunk_frames: int) -> _TrackStats:
    stats = _TrackStats()
    if not path.is_file():
        return stats
    total_bytes = path.stat().st_size
    frame_bytes = 8
    total_frames = total_bytes // frame_bytes
    offset = 0
    while offset < total_frames:
        chunk = _read_float32_stereo_chunk(path, offset, min(chunk_frames, total_frames - offset))
        if chunk.shape[0] == 0:
            break
        if chunk.shape[0] > chunk_frames:
            raise ValueError("Rejecting oversize normalized chunk read")
        _accumulate_stereo_stats(stats, chunk)
        offset += chunk.shape[0]
    return stats


def _mix_soft_limit_inplace(mixed: np.ndarray, *, apply: bool) -> None:
    if apply and mixed.size:
        mixed *= 0.85
        np.tanh(mixed, out=mixed)


def _iter_aligned_mix_chunks(
    *,
    mic_path: Path,
    desk_path: Optional[Path],
    mic_frames: int,
    desk_frames: int,
    total_frames: int,
    chunk_frames: int,
    mic_pad: int,
    desk_pad: int,
    desk_trim: int,
    include_desktop: bool,
    profile: str,
    mic_volume: float,
    desktop_volume: float,
    mic_boost: float,
    mic_one_sided: _OneSidedDecision,
    desk_one_sided: _OneSidedDecision,
    mic_enhance: Optional[tuple[ChannelEnhancePlan, ChannelEnhancePlan]],
    apply_mix_limit: bool,
    post_mix_enhance: Optional[tuple[ChannelEnhancePlan, ChannelEnhancePlan]] = None,
) -> Iterator[np.ndarray]:
    """Yield aligned mixed float32 stereo chunks (same geometry as final output)."""
    mic_pos = 0
    desk_pos = desk_trim
    out_pos = 0
    desk_kept = max(0, desk_frames - desk_trim) if include_desktop else 0
    while out_pos < total_frames:
        n = min(chunk_frames, total_frames - out_pos)
        if n > chunk_frames:
            raise ValueError("Rejecting oversize aligned mix chunk")
        mic_chunk = np.zeros((n, 2), dtype=np.float32)
        local = 0
        if out_pos < mic_pad:
            local = min(n, mic_pad - out_pos)
        take = n - local
        if take > 0 and mic_pos < mic_frames:
            got = _read_float32_stereo_chunk(
                mic_path, mic_pos, min(take, mic_frames - mic_pos)
            )
            if got.shape[0] > chunk_frames:
                raise ValueError("Rejecting oversize mic chunk read")
            # One-sided + Windows enhance only on real mic samples — never on
            # alignment silence (RAM path enhances before padding).
            got = _apply_one_sided(got, mic_one_sided)
            if mic_enhance is not None:
                apply_stereo_enhance_inplace(got, mic_enhance[0], mic_enhance[1])
            mic_chunk[local : local + got.shape[0]] = got
            mic_pos += got.shape[0]
        elif mic_one_sided.repair:
            # Pad-only chunk: zeros stay zeros under one-sided repair.
            mic_chunk = _apply_one_sided(mic_chunk, mic_one_sided)

        if include_desktop and desk_path is not None:
            desk_chunk = np.zeros((n, 2), dtype=np.float32)
            dlocal = 0
            if out_pos < desk_pad:
                dlocal = min(n, desk_pad - out_pos)
            dtake = n - dlocal
            if dtake > 0 and desk_pos < desk_trim + desk_kept:
                got = _read_float32_stereo_chunk(
                    desk_path,
                    desk_pos,
                    min(dtake, desk_trim + desk_kept - desk_pos),
                )
                if got.shape[0] > chunk_frames:
                    raise ValueError("Rejecting oversize desktop chunk read")
                desk_chunk[dlocal : dlocal + got.shape[0]] = got
                desk_pos += got.shape[0]
            desk_chunk = _apply_one_sided(desk_chunk, desk_one_sided)
            mixed = mic_chunk * (mic_volume * mic_boost) + desk_chunk * desktop_volume
            _mix_soft_limit_inplace(mixed, apply=apply_mix_limit)
        elif profile == "windows-v1":
            # Windows mic-only: enhance already applied; no extra volume multiply.
            mixed = mic_chunk
        else:
            mixed = mic_chunk * mic_volume

        if post_mix_enhance is not None:
            apply_stereo_enhance_inplace(mixed, post_mix_enhance[0], post_mix_enhance[1])
        yield mixed
        out_pos += n


def _compute_mix_peak_aligned(
    *,
    mic_path: Path,
    desk_path: Optional[Path],
    mic_frames: int,
    desk_frames: int,
    total_frames: int,
    chunk_frames: int,
    mic_pad: int,
    desk_pad: int,
    desk_trim: int,
    include_desktop: bool,
    profile: str,
    mic_volume: float,
    desktop_volume: float,
    mic_boost: float,
    mic_one_sided: _OneSidedDecision,
    desk_one_sided: _OneSidedDecision,
    mic_enhance: Optional[tuple[ChannelEnhancePlan, ChannelEnhancePlan]],
) -> float:
    """Peak of the aligned mix *before* soft limiting (to decide whether to limit)."""
    peak = 0.0
    for mixed in _iter_aligned_mix_chunks(
        mic_path=mic_path,
        desk_path=desk_path,
        mic_frames=mic_frames,
        desk_frames=desk_frames,
        total_frames=total_frames,
        chunk_frames=chunk_frames,
        mic_pad=mic_pad,
        desk_pad=desk_pad,
        desk_trim=desk_trim,
        include_desktop=include_desktop,
        profile=profile,
        mic_volume=mic_volume,
        desktop_volume=desktop_volume,
        mic_boost=mic_boost,
        mic_one_sided=mic_one_sided,
        desk_one_sided=desk_one_sided,
        mic_enhance=mic_enhance,
        apply_mix_limit=False,
        post_mix_enhance=None,
    ):
        if mixed.size:
            peak = max(
                peak,
                abs(float(mixed.min())),
                abs(float(mixed.max())),
            )
    return peak


def _aligned_frame_count(
    mic_frames: int,
    desk_frames: int,
    *,
    include_desktop: bool,
    alignment: Dict[str, int],
) -> tuple[int, int, int]:
    """Return (mic_start_pad, desk_start_pad_after_trim, total_frames)."""
    mic_pad = int(alignment.get("micLeadingPadFrames") or 0)
    desk_trim = int(alignment.get("desktopTrimFrames") or 0)
    desk_pad = int(alignment.get("desktopLeadingPadFrames") or 0)
    mic_total = mic_frames + mic_pad
    if not include_desktop:
        return mic_pad, 0, mic_total
    desk_kept = max(0, desk_frames - desk_trim)
    desk_total = desk_kept + desk_pad
    return mic_pad, desk_pad, max(mic_total, desk_total)


def _stream_final_wav_via_ffmpeg(
    *,
    ffmpeg_path: str,
    output_path: Path,
    frame_iter: Iterator[np.ndarray],
    sample_rate: int = TARGET_RATE,
) -> int:
    cmd = [
        ffmpeg_path,
        "-f",
        "f32le",
        "-ar",
        str(sample_rate),
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-c:a",
        "pcm_s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        "2",
        "-rf64",
        "auto",
        "-f",
        "wav",
        "-y",
        "-loglevel",
        "error",
        str(output_path),
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdin is not None
    written = 0
    try:
        for chunk in frame_iter:
            if chunk.size == 0:
                continue
            proc.stdin.write(np.ascontiguousarray(chunk, dtype=np.float32).tobytes())
            written += int(chunk.shape[0])
        proc.stdin.close()
        _stdout, stderr = proc.communicate(timeout=600)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
        raise
    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", errors="replace")
        raise FinalizationError(
            f"ffmpeg failed writing final PCM temp: {detail}",
            recoverable_path=None,
        )
    return written


def ffmpeg_can_decode(path: PathLike, ffmpeg_path: str) -> bool:
    """True when ffmpeg can fully demux/decode ``path`` (ffprobe-free).

    Uses ``-xerror`` so decode errors on truncated/corrupt PCM fail the check
    even when ffmpeg would otherwise exit 0 after printing stderr diagnostics.
    """
    try:
        result = subprocess.run(
            [
                ffmpeg_path,
                "-v",
                "error",
                "-xerror",
                "-i",
                str(path),
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            timeout=600,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0


def _verify_final_temp(
    path: Path,
    *,
    expected_frames: int,
    ffmpeg_path: str,
) -> None:
    geometry = probe_wav_pcm_geometry(path)
    if geometry is None:
        raise FinalizationError(
            f"Could not probe final PCM temp: {path}",
            recoverable_path=None,
        )
    if geometry["channels"] != 2 or geometry["sample_rate"] != TARGET_RATE or geometry["sample_width"] != 2:
        raise FinalizationError(
            f"Unexpected final PCM geometry: {geometry}",
            recoverable_path=None,
        )
    # Allow one-frame codec/header rounding.
    if abs(int(geometry["frames"]) - int(expected_frames)) > 1:
        raise FinalizationError(
            f"Final PCM frame count mismatch: got {geometry['frames']}, expected {expected_frames}",
            recoverable_path=None,
        )
    if not ffmpeg_can_decode(path, ffmpeg_path):
        raise FinalizationError(
            f"ffmpeg could not decode final PCM temp: {path}",
            recoverable_path=None,
        )


def _copy_recoverable_wav(
    final_temp: Path,
    output_path: PathLike,
    *,
    ffmpeg_path: str,
) -> Optional[str]:
    """Copy a decodable capture temp to a stable meeting-dir WAV (leave capture intact)."""
    from .recorder_temp_paths import (
        MIN_RECOVERABLE_PCM_BYTES,
        build_stable_wav_path_for_output,
    )

    try:
        if not final_temp.is_file() or final_temp.stat().st_size <= MIN_RECOVERABLE_PCM_BYTES:
            return None
    except OSError:
        return None
    if probe_wav_pcm_geometry(final_temp) is None:
        return None
    if not ffmpeg_can_decode(final_temp, ffmpeg_path):
        return None
    stable = Path(build_stable_wav_path_for_output(output_path))
    try:
        shutil.copy2(final_temp, stable)
        return str(stable)
    except OSError:
        return None


def cleanup_completed_capture_session(session_dir: PathLike) -> None:
    """Idempotent removal of a completed capture directory and intermediates."""
    root = Path(session_dir)
    if not root.exists():
        return
    for name in (
        NORMALIZED_MIC_NAME,
        NORMALIZED_DESKTOP_NAME,
        FINAL_CAPTURE_PCM_NAME,
        MANIFEST_FILENAME,
        f"{MANIFEST_FILENAME}.tmp",
        "session.lock",
    ):
        path = root / name
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            pass
    try:
        for path in root.glob("*.pcm.part"):
            try:
                path.unlink()
            except OSError:
                pass
    except OSError:
        pass
    try:
        root.rmdir()
    except OSError:
        shutil.rmtree(root, ignore_errors=True)


def reference_windows_v1_process(
    mic: np.ndarray,
    desktop: Optional[np.ndarray],
    *,
    mic_rate: int,
    mic_channels: int,
    desktop_rate: int = TARGET_RATE,
    desktop_channels: int = 2,
    mic_volume: float = 1.0,
    desktop_volume: float = 1.0,
    mic_boost: float = MIC_BOOST_LINEAR,
) -> np.ndarray:
    """Whole-array Windows profile used only for characterization fixtures."""
    from .processor import enhance_microphone, mix_audio, mono_to_stereo, resample, downmix_to_stereo, align_audio_lengths

    mic_i16 = mic
    if mic.dtype != np.int16:
        mic_i16 = np.clip(mic * 32767.0, -32768, 32767).astype(np.int16).reshape(-1)

    if mic_rate != TARGET_RATE:
        mic_i16 = resample(mic_i16, mic_rate, TARGET_RATE, num_channels=mic_channels)
    if mic_channels > 2:
        mic_i16 = downmix_to_stereo(mic_i16, mic_channels)
    elif mic_channels == 1:
        mic_i16 = mono_to_stereo(mic_i16)

    mic_i16 = enhance_microphone(mic_i16, TARGET_RATE, 2)

    if desktop is None or desktop.size == 0:
        return mic_i16

    desk_i16 = desktop
    if desktop.dtype != np.int16:
        desk_i16 = np.clip(desktop * 32767.0, -32768, 32767).astype(np.int16).reshape(-1)
    if desktop_rate != TARGET_RATE:
        desk_i16 = resample(desk_i16, desktop_rate, TARGET_RATE, num_channels=desktop_channels)
    if desktop_channels > 2:
        desk_i16 = downmix_to_stereo(desk_i16, desktop_channels)
    elif desktop_channels == 1:
        desk_i16 = mono_to_stereo(desk_i16)

    mic_i16, desk_i16 = align_audio_lengths(mic_i16, desk_i16)
    return mix_audio(
        mic_i16,
        desk_i16,
        mic_volume=mic_volume,
        desktop_volume=desktop_volume,
        mic_boost=mic_boost,
    )


def reference_macos_v1_process(
    mic: np.ndarray,
    desktop: Optional[np.ndarray],
    *,
    mic_channels: int,
    desktop_channels: int = 2,
    mic_volume: float = 1.0,
    desktop_volume: float = 1.0,
    mic_boost: float = MIC_BOOST_LINEAR,
) -> np.ndarray:
    """Whole-array macOS profile used only for characterization fixtures."""
    mic_f = np.asarray(mic, dtype=np.float32)
    if mic_f.ndim == 1:
        mic_f = mic_f.reshape(-1, mic_channels)
    mic_f = downmix_macos_frames_to_stereo(mic_f, mic_channels)

    if desktop is None or desktop.size == 0:
        final = repair_one_sided_stereo(mic_f, "microphone")
        final = final * mic_volume
    else:
        desk_f = np.asarray(desktop, dtype=np.float32)
        if desk_f.ndim == 1:
            desk_f = desk_f.reshape(-1, desktop_channels)
        desk_f = downmix_macos_frames_to_stereo(desk_f, desktop_channels)
        mic_f = repair_one_sided_stereo(mic_f, "microphone")
        desk_f = repair_one_sided_stereo(desk_f, "desktop")
        target = max(len(mic_f), len(desk_f))
        if len(mic_f) < target:
            mic_f = np.concatenate(
                [mic_f, np.zeros((target - len(mic_f), 2), dtype=np.float32)], axis=0
            )
        if len(desk_f) < target:
            desk_f = np.concatenate(
                [desk_f, np.zeros((target - len(desk_f), 2), dtype=np.float32)], axis=0
            )
        final = mic_f * (mic_volume * mic_boost)
        final = final + desk_f * desktop_volume
        max_val = max(abs(float(final.min())), abs(float(final.max()))) if final.size else 0.0
        if max_val > 1.0:
            final = final * 0.85
            np.tanh(final, out=final)

    left_plan, right_plan = plan_stereo_enhance(final)
    apply_stereo_enhance_inplace(final, left_plan, right_plan)
    return _float_stereo_to_int16_interleaved(final)


def finalize_capture(
    manifest_path: PathLike,
    output_path: PathLike,
    ffmpeg_path: str = "ffmpeg",
    progress_callback: ProgressCallback = None,
    chunk_frames: int = DEFAULT_FINALIZATION_CHUNK_FRAMES,
    *,
    coordinator: Optional[CaptureManifestCoordinator] = None,
    recovered: bool = False,
) -> FinalizationResult:
    """Finalize a capture session with bounded memory.

    When ``coordinator`` is provided (live recorder path), the existing session
    lock is reused. Recovery (Task 10) passes only ``manifest_path``.
    """
    if chunk_frames <= 0:
        raise ValueError("chunk_frames must be positive")

    owns_coordinator = coordinator is None
    manifest_file = Path(manifest_path)
    session_dir = manifest_file.parent if manifest_file.name == MANIFEST_FILENAME else manifest_file
    if owns_coordinator:
        coordinator = CaptureManifestCoordinator.open_existing(session_dir)
    assert coordinator is not None

    recoverable: Optional[str] = None
    try:
        data = coordinator.to_dict()
        profile = data.get("processingProfile")
        if profile not in VALID_PROCESSING_PROFILES:
            raise FinalizationError(
                f"Missing or invalid processingProfile on capture manifest: {profile!r}"
            )
        if "mic" not in data.get("tracks", {}):
            raise FinalizationError("Capture manifest has no mic track")

        if coordinator.state not in ("finalizing", "error", "recording"):
            if coordinator.state == "complete" and data.get("finalRelativePath"):
                # Idempotent complete cleanup path for Task 10.
                final_name = data["finalRelativePath"]
                final_candidate = Path(output_path).with_name(final_name)
                ffmpeg_exe = ffmpeg_path or "ffmpeg"
                if final_candidate.is_file() and ffmpeg_can_decode(final_candidate, ffmpeg_exe):
                    cleanup_completed_capture_session(coordinator.session_dir)
                    return FinalizationResult(
                        final_path=str(final_candidate),
                        duration=0.0,
                        temp_wav_path=None,
                        recovered=recovered,
                        stats={"idempotentComplete": True},
                    )
                raise FinalizationError(
                    f"Complete capture final output is missing or undecodable: {final_candidate}"
                )

        coordinator.set_state("finalizing")
        _emit_progress(progress_callback, "post_processing_started", "Finishing recording...")
        mix = data.get("mix") or {}
        mic_volume = float(mix.get("micVolume", 1.0))
        desktop_volume = float(mix.get("desktopVolume", 1.0))
        mic_boost = float(mix.get("micBoost", MIC_BOOST_LINEAR))
        alignment = data.get("alignment") or {}
        include_desktop = bool(data.get("includeDesktop", False)) and coordinator.has_track("desktop")

        _emit_progress(progress_callback, "audio_normalizing", "Normalizing audio...")

        mic_track = coordinator.get_track("mic")
        if int(mic_track.get("committedFrames") or 0) <= 0:
            raise FinalizationError("No microphone audio was captured")

        mic_frames = _normalize_track_to_stereo_file(
            session_dir=coordinator.session_dir,
            track=mic_track,
            profile=profile,
            output_name=NORMALIZED_MIC_NAME,
            chunk_frames=chunk_frames,
        )
        desk_frames = 0
        desk_path: Optional[Path] = None
        if include_desktop:
            desk_track = coordinator.get_track("desktop")
            desk_frames = _normalize_track_to_stereo_file(
                session_dir=coordinator.session_dir,
                track=desk_track,
                profile=profile,
                output_name=NORMALIZED_DESKTOP_NAME,
                chunk_frames=chunk_frames,
            )
            desk_path = coordinator.session_dir / NORMALIZED_DESKTOP_NAME

        mic_path = coordinator.session_dir / NORMALIZED_MIC_NAME
        mic_stats = _scan_normalized_stats(mic_path, chunk_frames)
        desk_stats = _scan_normalized_stats(desk_path, chunk_frames) if desk_path else _TrackStats()

        mic_one_sided = (
            _decide_one_sided(mic_stats) if profile == "macos-v1" else _OneSidedDecision(False)
        )
        desk_one_sided = (
            _decide_one_sided(desk_stats) if profile == "macos-v1" and include_desktop else _OneSidedDecision(False)
        )

        mic_pad, desk_pad, total_frames = _aligned_frame_count(
            mic_frames,
            desk_frames,
            include_desktop=include_desktop,
            alignment={
                "micLeadingPadFrames": int(alignment.get("micLeadingPadFrames") or 0),
                "desktopTrimFrames": int(alignment.get("desktopTrimFrames") or 0),
                "desktopLeadingPadFrames": int(alignment.get("desktopLeadingPadFrames") or 0),
            },
        )
        desk_trim = int(alignment.get("desktopTrimFrames") or 0)

        # Windows enhances mic before mix; macOS enhances after global mix limiting.
        mic_enhance = None
        if profile == "windows-v1":
            # Plan enhance from normalized mic (optionally after one-sided — Windows has none).
            # Read mic in bounded chunks to build plans without loading whole file.
            left_sums = 0.0
            right_sums = 0.0
            count = 0
            offset = 0
            while offset < mic_frames:
                chunk = _read_float32_stereo_chunk(mic_path, offset, min(chunk_frames, mic_frames - offset))
                if chunk.shape[0] == 0:
                    break
                left_sums += float(chunk[:, 0].sum())
                right_sums += float(chunk[:, 1].sum())
                count += chunk.shape[0]
                offset += chunk.shape[0]
            # Re-scan with means for peak/scale decisions via plan_channel_enhance on
            # a synthetic pass: accumulate min/max after subtracting running means.
            mean_l = left_sums / count if count else 0.0
            mean_r = right_sums / count if count else 0.0
            min_l = min_r = 0.0
            max_l = max_r = 0.0
            offset = 0
            first = True
            while offset < mic_frames:
                chunk = _read_float32_stereo_chunk(mic_path, offset, min(chunk_frames, mic_frames - offset))
                if chunk.shape[0] == 0:
                    break
                left = chunk[:, 0] - mean_l
                right = chunk[:, 1] - mean_r
                if first:
                    min_l = float(left.min())
                    max_l = float(left.max())
                    min_r = float(right.min())
                    max_r = float(right.max())
                    first = False
                else:
                    min_l = min(min_l, float(left.min()))
                    max_l = max(max_l, float(left.max()))
                    min_r = min(min_r, float(right.min()))
                    max_r = max(max_r, float(right.max()))
                offset += chunk.shape[0]
            left_plan = ChannelEnhancePlan(mean=mean_l)
            right_plan = ChannelEnhancePlan(mean=mean_r)
            peak_l = max(abs(min_l), abs(max_l))
            peak_r = max(abs(min_r), abs(max_r))
            from .constants import (
                NORMALIZATION_HIGH_THRESHOLD,
                NORMALIZATION_LOW_THRESHOLD,
                NORMALIZATION_BOOST_TARGET,
                SOFT_LIMIT_THRESHOLD,
            )

            def _scale_and_limit(peak: float) -> tuple[float, bool]:
                scale = 1.0
                if peak > NORMALIZATION_HIGH_THRESHOLD:
                    scale = NORMALIZATION_HIGH_THRESHOLD / peak
                elif 0 < peak < NORMALIZATION_LOW_THRESHOLD:
                    scale = NORMALIZATION_BOOST_TARGET / peak
                abs_max = peak * scale
                return scale, abs_max > SOFT_LIMIT_THRESHOLD

            left_plan.scale, left_plan.soft_limit = _scale_and_limit(peak_l)
            right_plan.scale, right_plan.soft_limit = _scale_and_limit(peak_r)
            mic_enhance = (left_plan, right_plan)

        _emit_progress(progress_callback, "audio_mixing", "Mixing audio...")
        mix_peak = _compute_mix_peak_aligned(
            mic_path=mic_path,
            desk_path=desk_path if include_desktop else None,
            mic_frames=mic_frames,
            desk_frames=desk_frames,
            total_frames=total_frames,
            chunk_frames=chunk_frames,
            mic_pad=mic_pad,
            desk_pad=desk_pad,
            desk_trim=desk_trim,
            include_desktop=include_desktop,
            profile=profile,
            mic_volume=mic_volume,
            desktop_volume=desktop_volume,
            mic_boost=mic_boost if include_desktop else 1.0,
            mic_one_sided=mic_one_sided,
            desk_one_sided=desk_one_sided,
            mic_enhance=mic_enhance,
        )
        apply_mix_limit = include_desktop and mix_peak > 1.0

        post_mix_enhance = None
        if profile == "macos-v1":
            # Bounded stats over the globally limited aligned mixed signal.
            left_sums = right_sums = 0.0
            count = 0
            min_l = max_l = min_r = max_r = 0.0
            first = True

            def _iter_mixed_for_stats() -> Iterator[np.ndarray]:
                return _iter_aligned_mix_chunks(
                    mic_path=mic_path,
                    desk_path=desk_path if include_desktop else None,
                    mic_frames=mic_frames,
                    desk_frames=desk_frames,
                    total_frames=total_frames,
                    chunk_frames=chunk_frames,
                    mic_pad=mic_pad,
                    desk_pad=desk_pad,
                    desk_trim=desk_trim,
                    include_desktop=include_desktop,
                    profile=profile,
                    mic_volume=mic_volume,
                    desktop_volume=desktop_volume,
                    mic_boost=mic_boost if include_desktop else 1.0,
                    mic_one_sided=mic_one_sided,
                    desk_one_sided=desk_one_sided,
                    mic_enhance=None,
                    apply_mix_limit=apply_mix_limit,
                    post_mix_enhance=None,
                )

            for mixed in _iter_mixed_for_stats():
                left_sums += float(mixed[:, 0].sum())
                right_sums += float(mixed[:, 1].sum())
                count += mixed.shape[0]
            mean_l = left_sums / count if count else 0.0
            mean_r = right_sums / count if count else 0.0
            for mixed in _iter_mixed_for_stats():
                left = mixed[:, 0] - mean_l
                right = mixed[:, 1] - mean_r
                if first:
                    min_l, max_l = float(left.min()), float(left.max())
                    min_r, max_r = float(right.min()), float(right.max())
                    first = False
                else:
                    min_l = min(min_l, float(left.min()))
                    max_l = max(max_l, float(left.max()))
                    min_r = min(min_r, float(right.min()))
                    max_r = max(max_r, float(right.max()))
            from .constants import (
                NORMALIZATION_HIGH_THRESHOLD,
                NORMALIZATION_LOW_THRESHOLD,
                NORMALIZATION_BOOST_TARGET,
                SOFT_LIMIT_THRESHOLD,
            )

            def _scale_and_limit(peak: float) -> tuple[float, bool]:
                scale = 1.0
                if peak > NORMALIZATION_HIGH_THRESHOLD:
                    scale = NORMALIZATION_HIGH_THRESHOLD / peak
                elif 0 < peak < NORMALIZATION_LOW_THRESHOLD:
                    scale = NORMALIZATION_BOOST_TARGET / peak
                return scale, (peak * scale) > SOFT_LIMIT_THRESHOLD

            left_plan = ChannelEnhancePlan(mean=mean_l)
            right_plan = ChannelEnhancePlan(mean=mean_r)
            left_plan.scale, left_plan.soft_limit = _scale_and_limit(max(abs(min_l), abs(max_l)))
            right_plan.scale, right_plan.soft_limit = _scale_and_limit(max(abs(min_r), abs(max_r)))
            post_mix_enhance = (left_plan, right_plan)

        final_temp = coordinator.session_dir / FINAL_CAPTURE_PCM_NAME
        if final_temp.exists():
            final_temp.unlink()
        capture_temp_written = False
        recoverable = None

        written_frames = _stream_final_wav_via_ffmpeg(
            ffmpeg_path=ffmpeg_path,
            output_path=final_temp,
            frame_iter=_iter_aligned_mix_chunks(
                mic_path=mic_path,
                desk_path=desk_path if include_desktop else None,
                mic_frames=mic_frames,
                desk_frames=desk_frames,
                total_frames=total_frames,
                chunk_frames=chunk_frames,
                mic_pad=mic_pad,
                desk_pad=desk_pad,
                desk_trim=desk_trim,
                include_desktop=include_desktop,
                profile=profile,
                mic_volume=mic_volume,
                desktop_volume=desktop_volume,
                mic_boost=mic_boost if include_desktop else 1.0,
                mic_one_sided=mic_one_sided,
                desk_one_sided=desk_one_sided,
                mic_enhance=mic_enhance,
                apply_mix_limit=apply_mix_limit,
                post_mix_enhance=post_mix_enhance if profile == "macos-v1" else None,
            ),
        )
        capture_temp_written = True
        try:
            _verify_final_temp(final_temp, expected_frames=written_frames, ffmpeg_path=ffmpeg_path)
        except FinalizationError as verify_exc:
            promoted = _copy_recoverable_wav(
                final_temp, output_path, ffmpeg_path=ffmpeg_path
            )
            raise FinalizationError(str(verify_exc), recoverable_path=promoted) from verify_exc

        geometry = probe_wav_pcm_geometry(final_temp) or {}
        duration = float(geometry.get("frames", written_frames)) / float(TARGET_RATE)

        _emit_progress(progress_callback, "audio_encoding", "Encoding audio...")
        final_path, compress_stats = compress_and_report(
            str(final_temp),
            str(output_path),
            TARGET_RATE,
            ffmpeg_path=ffmpeg_path,
            progress_message="Compressing with ffmpeg (Opus codec)...",
        )
        # Require a real decode of the meeting output before deleting recovery inputs.
        if not ffmpeg_can_decode(final_path, ffmpeg_path):
            promoted = _copy_recoverable_wav(
                final_temp, output_path, ffmpeg_path=ffmpeg_path
            )
            raise FinalizationError(
                f"Final output failed decode verification: {final_path}",
                recoverable_path=promoted or (final_path if Path(final_path).is_file() else None),
            )
        recoverable = final_path

        # Mark complete + store basename only (same directory as output).
        coordinator.set_final_relative_path(Path(final_path).name)
        coordinator.set_state("complete")

        # Transactional cleanup only after verified completion.
        for name in (NORMALIZED_MIC_NAME, NORMALIZED_DESKTOP_NAME, FINAL_CAPTURE_PCM_NAME):
            path = coordinator.session_dir / name
            try:
                if path.is_file():
                    path.unlink()
            except OSError:
                pass
        for track_name in list(data.get("tracks", {})):
            track = coordinator.get_track(track_name)
            for segment in track.get("segments") or []:
                path = coordinator.session_dir / segment
                try:
                    if path.is_file():
                        path.unlink()
                except OSError:
                    pass

        session_dir_path = coordinator.session_dir
        try:
            coordinator.close()
        except Exception:
            pass
        cleanup_completed_capture_session(session_dir_path)

        _emit_progress(progress_callback, "post_processing_complete", "Recording saved.")
        return FinalizationResult(
            final_path=final_path,
            duration=duration,
            temp_wav_path=None,
            recovered=recovered,
            stats={
                "processingProfile": profile,
                "frames": int(geometry.get("frames", written_frames)),
                "includeDesktop": include_desktop,
                "compress": compress_stats,
            },
        )
    except FinalizationError as exc:
        # Never hand Electron a manifest-owned .capture/final.pcm.tmp path.
        if exc.recoverable_path and FINAL_CAPTURE_PCM_NAME in Path(exc.recoverable_path).name:
            promoted = _copy_recoverable_wav(
                Path(exc.recoverable_path), output_path, ffmpeg_path=ffmpeg_path
            )
            if promoted:
                raise FinalizationError(str(exc), recoverable_path=promoted) from exc
            raise FinalizationError(str(exc), recoverable_path=None) from exc
        raise
    except Exception as exc:
        promoted = None
        try:
            final_candidate = Path(session_dir) / FINAL_CAPTURE_PCM_NAME
            if final_candidate.is_file():
                promoted = _copy_recoverable_wav(
                    final_candidate, output_path, ffmpeg_path=ffmpeg_path
                )
        except Exception:
            promoted = None
        raise FinalizationError(str(exc), recoverable_path=promoted or recoverable) from exc
    finally:
        if owns_coordinator and coordinator is not None and not getattr(coordinator, "_closed", False):
            try:
                coordinator.close()
            except Exception:
                pass
