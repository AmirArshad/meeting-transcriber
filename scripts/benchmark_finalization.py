"""Synthetic benchmark for the real bounded capture finalization pipeline."""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import math
import os
import platform
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.audio.capture_manifest import CaptureManifestCoordinator, MANIFEST_FILENAME
from backend.audio.constants import DEFAULT_FINALIZATION_CHUNK_FRAMES
from backend.audio.streaming_post_processor import finalize_capture


def _windows_rss_bytes() -> int:
    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCounters),
        wintypes.DWORD,
    )
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    handle = kernel32.GetCurrentProcess()
    if not psapi.GetProcessMemoryInfo(
        handle, ctypes.byref(counters), counters.cb
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(counters.WorkingSetSize)


def _macos_rss_bytes() -> int:
    class ProcTaskInfo(ctypes.Structure):
        _fields_ = [
            ("virtual_size", ctypes.c_uint64),
            ("resident_size", ctypes.c_uint64),
            ("total_user", ctypes.c_uint64),
            ("total_system", ctypes.c_uint64),
            ("threads_user", ctypes.c_uint64),
            ("threads_system", ctypes.c_uint64),
            ("policy", ctypes.c_int32),
            ("faults", ctypes.c_int32),
            ("pageins", ctypes.c_int32),
            ("cow_faults", ctypes.c_int32),
            ("messages_sent", ctypes.c_int32),
            ("messages_received", ctypes.c_int32),
            ("syscalls_mach", ctypes.c_int32),
            ("syscalls_unix", ctypes.c_int32),
            ("context_switches", ctypes.c_int32),
            ("threadnum", ctypes.c_int32),
            ("numrunning", ctypes.c_int32),
            ("priority", ctypes.c_int32),
        ]

    info = ProcTaskInfo()
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    libproc.proc_pidinfo.argtypes = (
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    )
    libproc.proc_pidinfo.restype = ctypes.c_int
    result = libproc.proc_pidinfo(
        os.getpid(), 4, 0, ctypes.byref(info), ctypes.sizeof(info)
    )
    if result != ctypes.sizeof(info):
        raise OSError("proc_pidinfo(PROC_PIDTASKINFO) failed")
    return int(info.resident_size)


def current_rss_bytes() -> int:
    if sys.platform == "win32":
        return _windows_rss_bytes()
    if sys.platform == "darwin":
        return _macos_rss_bytes()
    status = Path("/proc/self/status").read_text(encoding="utf-8")
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) * 1024
    raise OSError("Current RSS is unavailable on this platform")


class PeakRssSampler:
    def __init__(self, interval_s: float = 0.01) -> None:
        self._interval_s = interval_s
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.peak_bytes = 0

    def start(self) -> None:
        self.peak_bytes = current_rss_bytes()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> int:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self.peak_bytes = max(self.peak_bytes, current_rss_bytes())
        return self.peak_bytes

    def _run(self) -> None:
        while not self._stop.wait(self._interval_s):
            self.peak_bytes = max(self.peak_bytes, current_rss_bytes())


def _write_synthetic_track(
    path: Path,
    *,
    frames: int,
    dtype: str,
    sample_rate: int,
    frequency: float,
) -> None:
    block_frames = min(DEFAULT_FINALIZATION_CHUNK_FRAMES, frames)
    frame_offset = 0
    with open(path, "wb") as handle:
        while frame_offset < frames:
            count = min(block_frames, frames - frame_offset)
            phase = (
                np.arange(frame_offset, frame_offset + count, dtype=np.float32)
                * np.float32(2.0 * math.pi * frequency / sample_rate)
            )
            left = np.sin(phase) * np.float32(0.12)
            right = np.cos(phase) * np.float32(0.09)
            stereo = np.column_stack([left, right])
            if dtype == "<i2":
                payload = (stereo * 32767.0).astype(np.int16)
            else:
                payload = stereo.astype(np.float32, copy=False)
            handle.write(np.ascontiguousarray(payload).tobytes())
            frame_offset += count


def run_benchmark(args: argparse.Namespace) -> dict:
    ffmpeg = args.ffmpeg or shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found; pass --ffmpeg with an explicit path")

    sample_rate = 48000 if args.profile == "macos-v1" else args.windows_sample_rate
    dtype = "<f4" if args.profile == "macos-v1" else "<i2"
    total_frames = int(round(args.duration * sample_rate))
    chunk_frames = int(round(args.chunk_seconds * 48000))
    if total_frames <= 0 or chunk_frames <= 0:
        raise ValueError("duration and chunk-seconds must be positive")

    with tempfile.TemporaryDirectory(prefix="avanevis-finalize-benchmark-") as temp:
        root = Path(temp)
        output = root / "benchmark.opus"
        coordinator = CaptureManifestCoordinator.create(
            output,
            started_at_ns=1,
            started_at_iso="2026-07-14T00:00:00.000Z",
        )
        sampler: Optional[PeakRssSampler] = None
        try:
            coordinator.set_processing_profile(args.profile)
            coordinator.set_mix_params()

            mic_name = "mic_0000.pcm.part"
            _write_synthetic_track(
                coordinator.session_dir / mic_name,
                frames=total_frames,
                dtype=dtype,
                sample_rate=sample_rate,
                frequency=220.0,
            )
            coordinator.add_track(
                "mic", sample_rate=sample_rate, channels=2, dtype=dtype
            )
            coordinator.commit_track("mic", [mic_name], committed_frames=total_frames)

            raw_bytes = (coordinator.session_dir / mic_name).stat().st_size
            if args.desktop:
                desk_name = "desktop_0000.pcm.part"
                _write_synthetic_track(
                    coordinator.session_dir / desk_name,
                    frames=total_frames,
                    dtype=dtype,
                    sample_rate=sample_rate,
                    frequency=440.0,
                )
                coordinator.add_track(
                    "desktop", sample_rate=sample_rate, channels=2, dtype=dtype
                )
                coordinator.commit_track(
                    "desktop", [desk_name], committed_frames=total_frames
                )
                coordinator.set_include_desktop(True)
                raw_bytes += (coordinator.session_dir / desk_name).stat().st_size
            else:
                coordinator.set_include_desktop(False)
            coordinator.set_state("finalizing")

            baseline_rss = current_rss_bytes()
            sampler = PeakRssSampler()
            sampler.start()
            started = time.perf_counter()
            result = finalize_capture(
                coordinator.session_dir / MANIFEST_FILENAME,
                output,
                ffmpeg_path=str(ffmpeg),
                chunk_frames=chunk_frames,
                coordinator=coordinator,
            )
            elapsed = time.perf_counter() - started
            peak_rss = sampler.stop()
            sampler = None
            final_path = Path(result.final_path)

            return {
                "schemaVersion": 1,
                "platform": platform.platform(),
                "python": platform.python_version(),
                "profile": args.profile,
                "desktop": bool(args.desktop),
                "audioDurationSeconds": result.duration,
                "chunkFrames": chunk_frames,
                "chunkSeconds": args.chunk_seconds,
                "elapsedSeconds": elapsed,
                "audioSecondsPerWallSecond": result.duration / elapsed,
                "realTimeFactor": elapsed / result.duration,
                "baselineRssBytes": baseline_rss,
                "peakFinalizationRssBytes": peak_rss,
                "peakRssIncreaseBytes": max(0, peak_rss - baseline_rss),
                "rawTrackBytes": raw_bytes,
                "finalOutputBytes": final_path.stat().st_size,
                "finalSuffix": final_path.suffix,
            }
        finally:
            if sampler is not None:
                sampler.stop()
            coordinator.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=60.0)
    parser.add_argument(
        "--profile", choices=("windows-v1", "macos-v1"), default="windows-v1"
    )
    parser.add_argument("--desktop", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--chunk-seconds", type=float, default=1.0)
    parser.add_argument("--windows-sample-rate", type=int, default=44100)
    parser.add_argument("--ffmpeg")
    return parser.parse_args()


def main() -> int:
    try:
        result = run_benchmark(parse_args())
    except Exception as exc:
        print(f"Finalization benchmark failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
