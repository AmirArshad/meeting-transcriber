"""Characterization tests for Phase 5 low-risk Python helpers."""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from device_helpers import (
    MACOS_SCREENCAPTURE_LOOPBACK_DEVICE,
    build_device_record,
    dedupe_device_by_name,
    is_blocked_windows_device_name,
    macos_virtual_loopback_devices,
    sort_devices_by_name,
)
from summaries.sidecar_io import save_summary_outputs, sidecar_paths
from transcription.formatting import (
    build_transcript_markdown,
    format_timestamp,
    merge_segments,
    save_transcript_markdown,
)


class TranscriptionFormattingTests(unittest.TestCase):
    def test_format_timestamp_mm_ss_and_hh_mm_ss(self):
        self.assertEqual(format_timestamp(65), "01:05")
        self.assertEqual(format_timestamp(3661), "01:01:01")
        self.assertEqual(format_timestamp(-3), "00:00")

    def test_merge_segments_respects_target_duration(self):
        segments = [
            {"start": 0.0, "end": 12.0, "text": "one"},
            {"start": 12.0, "end": 22.0, "text": "two"},
            {"start": 22.0, "end": 30.0, "text": "three"},
        ]
        merged = merge_segments(segments, target_duration=20.0, log=False)
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["text"], "one two")
        self.assertEqual(merged[1]["text"], "three")

    def test_merge_segments_can_skip_empty_text(self):
        segments = [
            {"start": 0.0, "end": 5.0, "text": "keep"},
            {"start": 5.0, "end": 6.0, "text": "   "},
            {"start": 6.0, "end": 12.0, "text": "also"},
        ]
        merged = merge_segments(segments, target_duration=20.0, skip_empty_text=True, log=False)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["text"], "keep also")

    def test_build_transcript_markdown_includes_optional_engine_and_speakers(self):
        markdown = build_transcript_markdown(
            audio_path=r"C:\meetings\demo.opus",
            language_label="English",
            duration=65,
            segments=[{"start": 0, "end": 5, "speaker": "Speaker 1", "text": "Hello"}],
            engine_label="Diarization-guided Whisper",
            include_speakers=True,
            dated_at=datetime(2026, 7, 9, 12, 0, 0),
        )
        self.assertIn("**Transcribed with:** Diarization-guided Whisper", markdown)
        self.assertIn("**[00:00 - 00:05]** **Speaker 1:**", markdown)
        self.assertIn("Hello", markdown)


class SidecarIoTests(unittest.TestCase):
    def test_sidecar_paths_use_transcript_stem(self):
        paths = sidecar_paths(r"C:\recordings\meeting_20260101_120000.md")
        self.assertTrue(paths["jsonPath"].endswith("meeting_20260101_120000.summary.json"))
        self.assertTrue(paths["markdownPath"].endswith("meeting_20260101_120000.summary.md"))

    def test_save_summary_outputs_writes_json_and_markdown(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            json_path = root / "meeting.summary.json"
            markdown_path = root / "meeting.summary.md"
            summary = {
                "summary": "Quick sync",
                "topics": [{"title": "Ship Phase 5"}],
                "decisions": [],
                "action_items": [],
                "risks": [],
                "open_questions": [],
            }
            metadata = {"profile": "balanced", "model": "test"}
            saved = save_summary_outputs(
                summary=summary,
                metadata=metadata,
                json_path=str(json_path),
                markdown_path=str(markdown_path),
            )
            self.assertTrue(Path(saved["jsonPath"]).exists())
            self.assertTrue(Path(saved["markdownPath"]).exists())
            self.assertIn("Quick sync", Path(saved["markdownPath"]).read_text(encoding="utf-8"))


class DeviceHelpersTests(unittest.TestCase):
    def test_windows_blocklist_and_dedupe(self):
        self.assertTrue(is_blocked_windows_device_name("Microsoft Sound Mapper - Input"))
        self.assertFalse(is_blocked_windows_device_name("Headset Microphone"))

        seen = {}
        low = build_device_record(device_id=1, name="Mic", channels=1, sample_rate=44100, host_api="MME")
        high = build_device_record(device_id=2, name="Mic", channels=1, sample_rate=48000, host_api="WASAPI")
        dedupe_device_by_name(seen, low)
        dedupe_device_by_name(seen, high)
        self.assertEqual(seen["Mic"]["id"], 2)
        self.assertEqual(seen["Mic"]["sample_rate"], 48000)

    def test_macos_virtual_loopback_and_sort(self):
        loopbacks = macos_virtual_loopback_devices()
        self.assertEqual(loopbacks[0]["id"], MACOS_SCREENCAPTURE_LOOPBACK_DEVICE["id"])
        self.assertEqual(loopbacks[0]["name"], "System Audio (ScreenCaptureKit)")

        devices = [
            build_device_record(device_id=2, name="Zebra", channels=2, sample_rate=48000, host_api="Core Audio"),
            build_device_record(device_id=1, name="Alpha", channels=1, sample_rate=44100, host_api="Core Audio"),
        ]
        sorted_devices = sort_devices_by_name(devices)
        self.assertEqual([item["name"] for item in sorted_devices], ["Alpha", "Zebra"])


if __name__ == "__main__":
    unittest.main()
