#!/usr/bin/env python3
"""Disposable Linux audio spike for Phase 1.

Connects with pulsectl, enumerates Pulse sources/sinks, captures a mic source
and a sink monitor concurrently with SoundCard, writes short float32 WAVs, and
records default-sink switch + cadence notes.

This is evidence, not the product recorder. Do not promote it to
backend/audio/linux_recorder.py.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import struct
import sys
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pulsectl
import soundcard as sc


SAMPLE_RATE = 48000
CAPTURE_SECONDS = 3.0
BLOCK_FRAMES = 1024
PULSE_INVALID_SINK_INDEX = 0xFFFFFFFF


@dataclass
class DeviceSnapshot:
    name: str
    description: str
    kind: str
    channels: int
    sample_rate: int
    monitor_of_sink_name: str | None


def _sample_rate(info: Any) -> int:
    spec = getattr(info, "sample_spec", None)
    return int(getattr(spec, "rate", 0) or 0)


def _channels(info: Any) -> int:
    return int(getattr(info, "channel_count", 0) or 0)


def is_monitor_source(source: Any) -> bool:
    monitor_of = getattr(source, "monitor_of_sink", None)
    if monitor_of is None:
        return bool(getattr(source, "monitor_of_sink_name", None))
    try:
        return int(monitor_of) != PULSE_INVALID_SINK_INDEX
    except (TypeError, ValueError):
        return bool(getattr(source, "monitor_of_sink_name", None))


def enumerate_pulse() -> dict[str, Any]:
    with pulsectl.Pulse("avanevis-linux-spike") as pulse:
        server = pulse.server_info()
        sources = []
        sinks = []
        for source in pulse.source_list():
            sources.append(
                DeviceSnapshot(
                    name=source.name,
                    description=source.description,
                    kind="monitor" if is_monitor_source(source) else "source",
                    channels=_channels(source),
                    sample_rate=_sample_rate(source),
                    monitor_of_sink_name=getattr(source, "monitor_of_sink_name", None),
                )
            )
        for sink in pulse.sink_list():
            sinks.append(
                DeviceSnapshot(
                    name=sink.name,
                    description=sink.description,
                    kind="sink",
                    channels=_channels(sink),
                    sample_rate=_sample_rate(sink),
                    monitor_of_sink_name=getattr(sink, "monitor_source_name", None),
                )
            )
        return {
            "server_name": getattr(server, "server_name", None),
            "server_version": getattr(server, "server_version", None),
            "default_source": getattr(server, "default_source_name", None),
            "default_sink": getattr(server, "default_sink_name", None),
            "sources": [asdict(item) for item in sources],
            "sinks": [asdict(item) for item in sinks],
        }


def write_float32_wav(path: Path, samples: np.ndarray, samplerate: int) -> None:
    data = np.asarray(samples, dtype=np.float32)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    nch = int(data.shape[1])
    payload = data.tobytes()
    with path.open("wb") as handle:
        handle.write(b"RIFF")
        handle.write(struct.pack("<I", 36 + len(payload)))
        handle.write(b"WAVEfmt ")
        handle.write(struct.pack("<IHHIIHH", 16, 3, nch, samplerate, samplerate * nch * 4, nch * 4, 32))
        handle.write(b"data")
        handle.write(struct.pack("<I", len(payload)))
        handle.write(payload)


def mix_to_stereo(samples: np.ndarray) -> np.ndarray:
    data = np.asarray(samples, dtype=np.float32)
    if data.ndim == 1:
        data = np.stack([data, data], axis=1)
    elif data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    return data


def rms(samples: np.ndarray) -> float:
    data = np.asarray(samples, dtype=np.float32)
    if data.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(data))))


def capture_source(source_name: str, seconds: float, include_loopback: bool) -> dict[str, Any]:
    microphone = sc.get_microphone(source_name, include_loopback=include_loopback)
    channels = int(getattr(microphone, "channels", 1) or 1)
    expected_blocks = int(round(seconds * SAMPLE_RATE / BLOCK_FRAMES))
    chunks: list[np.ndarray] = []
    block_times: list[float] = []
    started = time.perf_counter()
    with microphone.recorder(samplerate=SAMPLE_RATE, channels=channels, blocksize=BLOCK_FRAMES) as recorder:
        for _ in range(max(1, expected_blocks)):
            block_started = time.perf_counter()
            chunk = recorder.record(numframes=BLOCK_FRAMES)
            block_times.append(time.perf_counter() - block_started)
            chunks.append(np.asarray(chunk, dtype=np.float32))
    elapsed = time.perf_counter() - started
    audio = np.concatenate(chunks, axis=0) if chunks else np.zeros((0, channels), dtype=np.float32)
    expected_s = BLOCK_FRAMES / SAMPLE_RATE
    return {
        "source_name": source_name,
        "soundcard_name": getattr(microphone, "name", source_name),
        "channels": channels,
        "frames": int(audio.shape[0]),
        "dtype": str(audio.dtype),
        "elapsed_s": elapsed,
        "rms": rms(audio),
        "median_block_s": float(np.median(block_times)) if block_times else None,
        "max_block_s": float(np.max(block_times)) if block_times else None,
        "expected_block_s": expected_s,
        "block_count": len(block_times),
        "audio": audio,
    }


def capture_concurrent(mic_name: str, monitor_name: str, seconds: float) -> tuple[dict[str, Any], dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    errors: dict[str, str] = {}

    def worker(key: str, source_name: str, include_loopback: bool) -> None:
        try:
            results[key] = capture_source(source_name, seconds, include_loopback)
        except Exception as exc:  # noqa: BLE001 - spike records the failure
            errors[key] = f"{type(exc).__name__}: {exc}"

    mic_thread = threading.Thread(target=worker, args=("mic", mic_name, False), name="spike-mic")
    desktop_thread = threading.Thread(target=worker, args=("desktop", monitor_name, True), name="spike-desktop")
    mic_thread.start()
    desktop_thread.start()
    mic_thread.join()
    desktop_thread.join()
    if errors:
        raise RuntimeError(f"Concurrent capture failed: {errors}")
    return results["mic"], results["desktop"]


def switch_default_sink(pulse: pulsectl.Pulse, sink_name: str) -> None:
    for sink in pulse.sink_list():
        if sink.name == sink_name:
            pulse.sink_default_set(sink)
            return
    raise RuntimeError(f"Sink not found: {sink_name}")


def play_tone_into_sink(sink_name: str, seconds: float, frequency: float) -> threading.Thread:
    speaker = sc.get_speaker(sink_name)
    frames = int(SAMPLE_RATE * seconds)
    t = np.arange(frames, dtype=np.float32) / SAMPLE_RATE
    tone = (0.2 * np.sin(2 * np.pi * frequency * t)).astype(np.float32)
    stereo = np.stack([tone, tone], axis=1)

    def worker() -> None:
        try:
            speaker.play(stereo, samplerate=SAMPLE_RATE)
        except Exception as exc:  # noqa: BLE001 - playback is best-effort evidence
            print(f"warning: playback into {sink_name} failed: {exc}", file=sys.stderr)

    thread = threading.Thread(target=worker, name=f"play-{sink_name}", daemon=True)
    thread.start()
    return thread


def cpu_percent(elapsed_s: float, usage_before: resource.struct_rusage, usage_after: resource.struct_rusage) -> float:
    cpu_s = (usage_after.ru_utime - usage_before.ru_utime) + (usage_after.ru_stime - usage_before.ru_stime)
    if elapsed_s <= 0:
        return 0.0
    return 100.0 * cpu_s / elapsed_s


def summarize_capture(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "audio"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Disposable Linux Pulse/SoundCard spike")
    parser.add_argument("--out-dir", default="/tmp/avanevis-linux-spike")
    parser.add_argument("--seconds", type=float, default=CAPTURE_SECONDS)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    inventory = enumerate_pulse()
    sources = inventory["sources"]
    sinks = inventory["sinks"]
    mic = next((item for item in sources if item["kind"] == "source"), None)
    if mic is None:
        raise SystemExit("No non-monitor Pulse source found")
    default_sink_name = inventory["default_sink"]
    desktop_sink = next((item for item in sinks if item["name"] == default_sink_name), sinks[0])
    monitor_name = desktop_sink.get("monitor_of_sink_name")
    if not monitor_name:
        raise SystemExit(f"Default sink {desktop_sink['name']} has no monitor source")
    alt_sink = next((item for item in sinks if item["name"] != desktop_sink["name"]), None)

    playback = play_tone_into_sink(desktop_sink["name"], args.seconds + 0.5, 880.0)
    time.sleep(0.15)

    usage_before = resource.getrusage(resource.RUSAGE_SELF)
    started = time.perf_counter()
    mic_capture, desktop_capture = capture_concurrent(mic["name"], monitor_name, args.seconds)
    elapsed = time.perf_counter() - started
    usage_after = resource.getrusage(resource.RUSAGE_SELF)
    playback.join(timeout=2.0)

    mic_only = mix_to_stereo(mic_capture["audio"])
    desktop_only = mix_to_stereo(desktop_capture["audio"])
    frames = min(len(mic_only), len(desktop_only))
    mixed = np.clip(0.5 * mic_only[:frames] + 0.5 * desktop_only[:frames], -1.0, 1.0)

    write_float32_wav(out_dir / "mic.wav", mic_only, SAMPLE_RATE)
    write_float32_wav(out_dir / "desktop.wav", desktop_only, SAMPLE_RATE)
    write_float32_wav(out_dir / "mixed.wav", mixed, SAMPLE_RATE)

    sink_switch: dict[str, Any] = {"performed": False}
    if alt_sink is not None:
        with pulsectl.Pulse("avanevis-linux-spike-switch") as pulse:
            before = pulse.server_info().default_sink_name
            switch_started = time.perf_counter()
            switch_default_sink(pulse, alt_sink["name"])
            after = pulse.server_info().default_sink_name
            switch_elapsed_ms = (time.perf_counter() - switch_started) * 1000.0
            sink_switch = {
                "performed": True,
                "before": before,
                "after": after,
                "elapsed_ms": switch_elapsed_ms,
                "note": "Linux v1 will not hot-switch the desktop stream; a sink change is warn + continue on the original monitor.",
            }
            switch_default_sink(pulse, before)

    report = {
        "host": os.uname().nodename if hasattr(os, "uname") else "unknown",
        "python": sys.version.split()[0],
        "pulsectl": getattr(pulsectl, "__version__", None),
        "soundcard": getattr(sc, "__version__", None),
        "inventory": inventory,
        "selected": {
            "mic": f"pulse-source:{mic['name']}",
            "desktop": f"pulse-monitor:{monitor_name}",
        },
        "concurrent_ok": True,
        "cpu_percent": cpu_percent(elapsed, usage_before, usage_after),
        "wall_s": elapsed,
        "mic": summarize_capture(mic_capture),
        "desktop": summarize_capture(desktop_capture),
        "mixed_rms": rms(mixed),
        "wavs": {
            "mic": str(out_dir / "mic.wav"),
            "desktop": str(out_dir / "desktop.wav"),
            "mixed": str(out_dir / "mixed.wav"),
        },
        "default_sink_switch": sink_switch,
        "limitations": [
            "Dummy Pulse server, not Omarchy/PipeWire hardware.",
            "No browser speech, Bluetooth, HDMI, or ScreenCast-portal observation.",
            "Do not treat this as Phase 1 exit-criteria complete.",
        ],
    }
    report_path = out_dir / "spike-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"wrote {report_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
