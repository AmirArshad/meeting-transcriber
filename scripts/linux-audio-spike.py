#!/usr/bin/env python3
"""Disposable Linux audio spike for Phase 1.

Connects with pulsectl, enumerates Pulse sources/sinks, captures a mic source
and a sink monitor concurrently with SoundCard, writes short float32 WAVs, and
records default-sink switch + cadence notes.

Pass ``--omarchy`` on a live PipeWire/Hyprland host to also probe browser
speech, ScreenCast portal absence, HDMI/headphone/Bluetooth inventory, and
late desktop-sink loss.

This is evidence, not the product recorder. Do not promote it to
backend/audio/linux_recorder.py.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pulsectl

# SoundCard 0.4.6's Pulse backend indexes sys.argv[1] at import time.
_argv_before_soundcard = list(sys.argv)
if len(sys.argv) < 2:
    sys.argv = [*sys.argv, "linux-audio-spike"]
import soundcard as sc  # noqa: E402

sys.argv = _argv_before_soundcard


SAMPLE_RATE = 48000
CAPTURE_SECONDS = 3.0
BLOCK_FRAMES = 1024
PULSE_INVALID_SINK_INDEX = 0xFFFFFFFF
NULL_SINK_NAME = "avanevis_spike_alt"
SCREENCAST_MARKERS = (
    "org.freedesktop.portal.ScreenCast",
    "org.freedesktop.impl.portal.ScreenCast",
    "xdg-desktop-portal-screencast",
)


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


def enumerate_cards() -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    with pulsectl.Pulse("avanevis-linux-spike-cards") as pulse:
        for card in pulse.card_list():
            profiles = []
            for profile in getattr(card, "profile_list", []) or []:
                profiles.append(
                    {
                        "name": getattr(profile, "name", None),
                        "description": getattr(profile, "description", None),
                        "available": bool(getattr(profile, "available", True)),
                    }
                )
            ports = []
            for port in getattr(card, "port_list", []) or []:
                ports.append(
                    {
                        "name": getattr(port, "name", None),
                        "description": getattr(port, "description", None),
                        "available": str(getattr(port, "available_state", getattr(port, "available", None))),
                        "type": str(getattr(port, "type", None)),
                    }
                )
            cards.append(
                {
                    "name": card.name,
                    "description": getattr(card, "description", None) or card.name,
                    "active_profile": getattr(getattr(card, "profile_active", None), "name", None),
                    "profiles": profiles,
                    "ports": ports,
                }
            )
    return cards


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


def stereo_channel_stats(samples: np.ndarray) -> dict[str, Any]:
    stereo = mix_to_stereo(samples)
    left = stereo[:, 0]
    right = stereo[:, 1]
    left_rms = rms(left)
    right_rms = rms(right)
    mono = ((left + right) * 0.5).astype(np.float32)
    # ffmpeg/av typical transcription path: average to mono, then 16 kHz.
    correlation = 0.0
    if left.size and float(np.std(left)) > 1e-8 and float(np.std(right)) > 1e-8:
        correlation = float(np.corrcoef(left, right)[0, 1])
    max_rms = max(left_rms, right_rms)
    min_rms = min(left_rms, right_rms)
    one_sided = bool(max_rms >= 1e-5 and min_rms <= max_rms * 0.20)
    return {
        "channels": int(stereo.shape[1]),
        "frames": int(stereo.shape[0]),
        "left_rms": left_rms,
        "right_rms": right_rms,
        "mono_mean_rms": rms(mono),
        "channel_correlation": correlation,
        "one_sided_like_macos_repair_gate": one_sided,
        "speech_survives_mean_mono_downmix": bool(rms(mono) >= max(1e-4, max_rms * 0.25)),
    }


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


def _run(cmd: list[str], timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


def load_null_sink(pulse: pulsectl.Pulse) -> int:
    existing = next((module for module in pulse.module_list() if NULL_SINK_NAME in (getattr(module, "argument", "") or "")), None)
    if existing is not None:
        return int(existing.index)
    return int(pulse.module_load("module-null-sink", f"sink_name={NULL_SINK_NAME} sink_properties=device.description=AvaNevisSpikeAlt"))


def unload_module(pulse: pulsectl.Pulse, index: int) -> None:
    try:
        pulse.module_unload(index)
    except Exception as exc:  # noqa: BLE001
        print(f"warning: module_unload({index}) failed: {exc}", file=sys.stderr)


def probe_sink_switch(default_sink_name: str, sinks: list[dict[str, Any]]) -> dict[str, Any]:
    alt = next((item for item in sinks if item["name"] != default_sink_name), None)
    created_null = False
    module_index: int | None = None
    with pulsectl.Pulse("avanevis-linux-spike-switch") as pulse:
        try:
            if alt is None:
                module_index = load_null_sink(pulse)
                created_null = True
                time.sleep(0.2)
                alt_name = NULL_SINK_NAME
            else:
                alt_name = alt["name"]
            before = pulse.server_info().default_sink_name
            switch_started = time.perf_counter()
            switch_default_sink(pulse, alt_name)
            time.sleep(0.15)
            after = pulse.server_info().default_sink_name
            elapsed_ms = (time.perf_counter() - switch_started) * 1000.0
            return {
                "performed": True,
                "created_null_sink": created_null,
                "before": before,
                "after": after,
                "elapsed_ms": elapsed_ms,
                "note": "Linux v1 will not hot-switch the desktop stream; a sink change is warn + continue on the original monitor.",
            }
        except Exception as exc:  # noqa: BLE001
            return {"performed": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            try:
                switch_default_sink(pulse, default_sink_name)
            except Exception:
                pass
            if module_index is not None:
                unload_module(pulse, module_index)


def probe_late_desktop_loss() -> dict[str, Any]:
    """Unload a Pulse sink while SoundCard is recording its monitor."""
    with pulsectl.Pulse("avanevis-linux-spike-loss") as pulse:
        module_index = load_null_sink(pulse)
        time.sleep(0.25)
        sink = next((item for item in pulse.sink_list() if item.name == NULL_SINK_NAME), None)
        if sink is None:
            unload_module(pulse, module_index)
            return {"performed": False, "error": "null sink did not appear"}
        monitor_name = getattr(sink, "monitor_source_name", None)
        if not monitor_name:
            unload_module(pulse, module_index)
            return {"performed": False, "error": "null sink has no monitor"}

        chunks: list[np.ndarray] = []
        errors: list[str] = []
        block_times: list[float] = []
        stop = threading.Event()
        started = time.perf_counter()

        def worker() -> None:
            try:
                microphone = sc.get_microphone(monitor_name, include_loopback=True)
                channels = int(getattr(microphone, "channels", 1) or 1)
                with microphone.recorder(samplerate=SAMPLE_RATE, channels=channels, blocksize=BLOCK_FRAMES) as recorder:
                    while not stop.is_set() and len(block_times) < 80:
                        block_started = time.perf_counter()
                        chunk = recorder.record(numframes=BLOCK_FRAMES)
                        block_times.append(time.perf_counter() - block_started)
                        chunks.append(np.asarray(chunk, dtype=np.float32))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{type(exc).__name__}: {exc}")

        thread = threading.Thread(target=worker, name="spike-late-loss")
        thread.start()
        time.sleep(0.35)
        blocks_before_unload = len(block_times)
        unload_module(pulse, module_index)
        time.sleep(0.05)
        source_still_listed_after = monitor_name in [source.name for source in pulse.source_list()]
        time.sleep(0.5)
        stop.set()
        thread.join(timeout=8.0)
        hung = thread.is_alive()
        audio = np.concatenate(chunks, axis=0) if chunks else np.zeros((0, 1), dtype=np.float32)
        split = BLOCK_FRAMES * max(1, blocks_before_unload)
        pre = audio[:split] if audio.shape[0] else audio
        post = audio[split:] if audio.shape[0] else audio
        result = {
            "performed": True,
            "monitor_name": f"pulse-monitor:{monitor_name}",
            "hung_after_unload": hung,
            "exception_after_unload": errors,
            "blocks_before_unload": blocks_before_unload,
            "source_still_listed_after_unload": source_still_listed_after,
            "blocks_captured": len(block_times),
            "elapsed_s": time.perf_counter() - started,
            "pre_unload_rms": rms(pre),
            "post_unload_rms": rms(post),
            "median_block_s": float(np.median(block_times)) if block_times else None,
            "note": (
                "SoundCard continued or failed after the sink disappeared. "
                "linux_recorder.py should treat a vanished monitor as late desktop loss "
                "and continue mic-only rather than hanging the stop path."
            ),
        }
        if hung:
            result["note"] = (
                "Capture thread did not return within 8s after sink unload — "
                "product recorder must bound this wait."
            )
        return result


def start_screencast_monitor(log_path: Path) -> subprocess.Popen[bytes]:
    handle = log_path.open("wb")
    proc = subprocess.Popen(
        ["dbus-monitor", "--session"],
        stdout=handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    proc._spike_log_handle = handle  # type: ignore[attr-defined]
    time.sleep(0.2)
    return proc


def stop_screencast_monitor(proc: subprocess.Popen[bytes], log_path: Path) -> dict[str, Any]:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
    handle = getattr(proc, "_spike_log_handle", None)
    if handle is not None:
        handle.close()
    text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    hits = [marker for marker in SCREENCAST_MARKERS if marker in text]
    return {
        "dbus_monitor_ran": True,
        "log_bytes": log_path.stat().st_size if log_path.exists() else 0,
        "screencast_markers_seen": hits,
        "portal_appeared": bool(hits),
    }


def write_synthetic_speech_wav(path: Path, seconds: float = 4.0) -> None:
    """Formant-style voiced bursts in the speech band (not a TTS cloud call)."""
    frames = int(SAMPLE_RATE * seconds)
    t = np.arange(frames, dtype=np.float32) / SAMPLE_RATE
    glottal = 0.0
    for harmonic in range(1, 8):
        glottal += (0.12 / harmonic) * np.sin(2 * np.pi * 110.0 * harmonic * t)
    formants = (
        0.35 * np.sin(2 * np.pi * 700.0 * t)
        + 0.22 * np.sin(2 * np.pi * 1220.0 * t)
        + 0.12 * np.sin(2 * np.pi * 2600.0 * t)
    )
    envelope = np.clip(np.sin(2 * np.pi * 3.5 * t), 0, 1).astype(np.float32)
    voiced = (0.25 * (glottal + formants) * envelope).astype(np.float32)
    stereo = np.stack([voiced, voiced * 0.92], axis=1)
    write_float32_wav(path, stereo, SAMPLE_RATE)


def download_speech_clip(path: Path) -> dict[str, Any]:
    url = "https://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0010_8k.wav"
    try:
        proc = _run(["curl", "-fsSL", "--max-time", "20", "-o", str(path), url], timeout=25)
        if proc.returncode != 0 or not path.exists() or path.stat().st_size < 1000:
            return {"ok": False, "error": proc.stderr.strip() or "download failed"}
        trimmed = path.with_name("speech-browser.wav")
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            convert = _run(
                [ffmpeg, "-y", "-i", str(path), "-t", "4", "-ar", str(SAMPLE_RATE), "-ac", "2", str(trimmed)],
                timeout=15,
            )
            if convert.returncode == 0 and trimmed.exists():
                return {"ok": True, "path": str(trimmed), "source": url, "seconds": 4}
        return {"ok": True, "path": str(path), "source": url}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def probe_browser_speech(out_dir: Path, monitor_name: str, seconds: float) -> dict[str, Any]:
    speech_dir = out_dir / "browser"
    speech_dir.mkdir(parents=True, exist_ok=True)
    downloaded = download_speech_clip(speech_dir / "osr.wav")
    wav_path = speech_dir / "play.wav"
    if downloaded.get("ok"):
        src = Path(str(downloaded["path"]))
        if src != wav_path:
            shutil.copy2(src, wav_path)
    else:
        write_synthetic_speech_wav(wav_path, seconds=max(4.0, seconds))
    html_path = speech_dir / "play.html"
    html_path.write_text(
        """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AvaNevis spike</title></head>
<body>
<audio id="a" src="play.wav" autoplay controls></audio>
<script>
  const a = document.getElementById('a');
  a.volume = 0.5;
  a.play().catch((err) => { document.title = 'autoplay-failed:' + err; });
</script>
</body></html>
""",
        encoding="utf-8",
    )
    chromium = shutil.which("chromium") or shutil.which("brave")
    if chromium is None:
        return {"performed": False, "error": "no chromium/brave in PATH", "speech_wav": str(wav_path)}
    user_dir = speech_dir / "chromium-profile"
    user_dir.mkdir(exist_ok=True)
    cmd = [
        chromium,
        "--ozone-platform=wayland",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        f"--user-data-dir={user_dir}",
        "--window-size=480,240",
        f"file://{html_path}",
    ]
    proc: subprocess.Popen[bytes] | None = None
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        time.sleep(1.2)
        capture = capture_source(monitor_name, max(seconds, 4.0), include_loopback=True)
        stereo = mix_to_stereo(capture["audio"])
        browser_wav = out_dir / "browser-desktop.wav"
        write_float32_wav(browser_wav, stereo, SAMPLE_RATE)
        stats = stereo_channel_stats(stereo)
        return {
            "performed": True,
            "chromium": chromium,
            "pid": proc.pid,
            "speech_source": downloaded if downloaded.get("ok") else {"ok": False, "synthetic": True, "error": downloaded.get("error")},
            "wav": str(browser_wav),
            "capture": summarize_capture(capture),
            "downmix": stats,
            "note": "Capture used the default-sink Pulse monitor while Chromium played a local WAV. No ScreenCast API is invoked by this path.",
        }
    except Exception as exc:  # noqa: BLE001
        return {"performed": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


def probe_hdmi() -> dict[str, Any]:
    cards = enumerate_cards()
    hdmi = next((card for card in cards if "hdmi" in card["name"].lower() or any("hdmi" in (p["name"] or "") for p in card["profiles"])), None)
    analog = next((card for card in cards if card is not hdmi), None)
    probe: dict[str, Any] = {
        "hdmi_card": None if hdmi is None else {
            "name": hdmi["name"],
            "active_profile": hdmi["active_profile"],
            "hdmi_ports": [port for port in hdmi["ports"] if "hdmi" in (port["name"] or "").lower()],
            "available_hdmi_profiles": [
                profile for profile in hdmi["profiles"]
                if "hdmi" in (profile["name"] or "") and profile["available"]
            ],
        },
        "headphone_ports": [],
        "profile_switch": {"performed": False},
    }
    for card in cards:
        probe["headphone_ports"].extend(
            {
                "card": card["name"],
                **port,
                "note": "Headphone jack typically retargets the analog-stereo sink; the monitor Pulse name stays the same.",
            }
            for port in card["ports"]
            if "headphone" in (port["name"] or "").lower() or "headphones" in str(port.get("type") or "").lower()
        )
    if hdmi is None:
        probe["profile_switch"] = {"performed": False, "error": "no HDMI card"}
        return probe
    original = hdmi["active_profile"]
    candidate = next(
        (profile["name"] for profile in hdmi["profiles"] if profile["name"] and profile["name"].startswith("output:hdmi-stereo")),
        None,
    )
    if not candidate:
        return probe
    with pulsectl.Pulse("avanevis-linux-spike-hdmi") as pulse:
        card_obj = next((item for item in pulse.card_list() if item.name == hdmi["name"]), None)
        if card_obj is None:
            return probe
        try:
            pulse.card_profile_set(card_obj, candidate)
            time.sleep(0.3)
            sinks_after = [sink.name for sink in pulse.sink_list()]
            card_after = next((item for item in pulse.card_list() if item.name == hdmi["name"]), card_obj)
            probe["profile_switch"] = {
                "performed": True,
                "requested": candidate,
                "active_after": getattr(getattr(card_after, "profile_active", None), "name", None),
                "sinks_after": sinks_after,
                "hdmi_sink_appeared": any("hdmi" in name.lower() for name in sinks_after),
                "note": "HDMI monitor selection is a different Pulse sink (.monitor of that sink). Unavailable ports do not become capture devices.",
            }
        except Exception as exc:  # noqa: BLE001
            probe["profile_switch"] = {"performed": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            try:
                if original:
                    pulse.card_profile_set(card_obj, original)
            except Exception:
                pass
    _ = analog
    return probe


def probe_bluetooth() -> dict[str, Any]:
    rfkill_before = _run(["rfkill", "list", "bluetooth"])
    btctl = _run(["bluetoothctl", "show"])
    devices = _run(["bluetoothctl", "devices"])
    blocked = "Soft blocked: yes" in (rfkill_before.stdout or "")
    unblocked = False
    after_cards: list[str] = []
    try:
        if blocked:
            unblock = _run(["rfkill", "unblock", "bluetooth"])
            unblocked = unblock.returncode == 0
            time.sleep(1.5)
        after_cards = [card["name"] for card in enumerate_cards() if "blue" in card["name"].lower()]
        sinks = [sink["name"] for sink in enumerate_pulse()["sinks"] if "blue" in sink["name"].lower()]
        return {
            "adapter_present": "Controller" in (btctl.stdout or ""),
            "rfkill_before": rfkill_before.stdout.strip(),
            "soft_blocked_before": blocked,
            "temporarily_unblocked": unblocked,
            "paired_devices": devices.stdout.strip() or "",
            "bluez_cards_after_unblock": after_cards,
            "bluez_sinks_after_unblock": sinks,
            "note": (
                "A Bluetooth headset becomes its own Pulse sink with a .monitor source. "
                "No paired A2DP device was required for this inventory. "
                "linux_recorder.py should treat that monitor like HDMI: select by opaque pulse-monitor id, no hot-switch."
            ),
        }
    finally:
        if unblocked:
            _run(["rfkill", "block", "bluetooth"])


def host_facts() -> dict[str, Any]:
    return {
        "nodename": os.uname().nodename if hasattr(os, "uname") else "unknown",
        "xdg_current_desktop": os.environ.get("XDG_CURRENT_DESKTOP"),
        "xdg_session_type": os.environ.get("XDG_SESSION_TYPE"),
        "wayland_display": os.environ.get("WAYLAND_DISPLAY"),
        "os_release_pretty": _pretty_os_name(),
    }


def _pretty_os_name() -> str | None:
    path = Path("/etc/os-release")
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Disposable Linux Pulse/SoundCard spike")
    parser.add_argument("--out-dir", default="/tmp/avanevis-linux-spike")
    parser.add_argument("--seconds", type=float, default=CAPTURE_SECONDS)
    parser.add_argument(
        "--omarchy",
        action="store_true",
        help="Run live PipeWire/Hyprland probes (browser, portal, HDMI/BT, late loss).",
    )
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

    dbus_proc = None
    dbus_log = out_dir / "dbus-monitor.log"
    omarchy: dict[str, Any] = {}
    try:
        if args.omarchy:
            dbus_proc = start_screencast_monitor(dbus_log)

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

        sink_switch = probe_sink_switch(desktop_sink["name"], sinks) if args.omarchy else {"performed": False}
        if not args.omarchy:
            alt_sink = next((item for item in sinks if item["name"] != desktop_sink["name"]), None)
            if alt_sink is not None:
                with pulsectl.Pulse("avanevis-linux-spike-switch") as pulse:
                    before = pulse.server_info().default_sink_name
                    switch_started = time.perf_counter()
                    try:
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
                    finally:
                        switch_default_sink(pulse, before)

        if args.omarchy:
            omarchy["cards"] = enumerate_cards()
            omarchy["hdmi_headphones"] = probe_hdmi()
            omarchy["bluetooth"] = probe_bluetooth()
            omarchy["late_desktop_loss"] = probe_late_desktop_loss()
            omarchy["browser_speech"] = probe_browser_speech(out_dir, monitor_name, args.seconds)
            omarchy["desktop_tone_downmix"] = stereo_channel_stats(desktop_only)
            if dbus_proc is not None:
                omarchy["screencast_portal"] = stop_screencast_monitor(dbus_proc, dbus_log)
                dbus_proc = None

        if args.omarchy:
            limitations = []
            browser = omarchy.get("browser_speech") or {}
            portal = omarchy.get("screencast_portal") or {}
            hdmi = omarchy.get("hdmi_headphones") or {}
            bluetooth = omarchy.get("bluetooth") or {}
            late = omarchy.get("late_desktop_loss") or {}
            if not browser.get("performed"):
                limitations.append(f"Browser speech capture did not complete: {browser.get('error')}")
            elif not (browser.get("downmix") or {}).get("speech_survives_mean_mono_downmix"):
                limitations.append("Browser desktop capture did not keep usable energy after mean-mono downmix.")
            if portal.get("portal_appeared"):
                limitations.append(f"ScreenCast portal markers appeared: {portal.get('screencast_markers_seen')}")
            if late.get("hung_after_unload"):
                limitations.append("Late desktop-loss capture hung after sink unload.")
            if not (hdmi.get("hdmi_card") or {}).get("name"):
                limitations.append("No HDMI card was found.")
            if not bluetooth.get("adapter_present"):
                limitations.append("No Bluetooth adapter was found.")
            if not limitations:
                limitations = ["Omarchy live probes completed; see omarchy.* in this report."]
        else:
            limitations = [
                "Dummy Pulse server, not Omarchy/PipeWire hardware.",
                "No browser speech, Bluetooth, HDMI, or ScreenCast-portal observation.",
                "Do not treat this as Phase 1 exit-criteria complete.",
            ]

        report = {
            "host": os.uname().nodename if hasattr(os, "uname") else "unknown",
            "host_facts": host_facts() if args.omarchy else None,
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
            "omarchy": omarchy,
            "limitations": limitations,
        }
        report_path = out_dir / "spike-report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        print(f"wrote {report_path}", file=sys.stderr)
        return 0
    finally:
        if dbus_proc is not None:
            try:
                stop_screencast_monitor(dbus_proc, dbus_log)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
