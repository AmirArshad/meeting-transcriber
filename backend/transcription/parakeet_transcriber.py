"""Offline, bounded Parakeet transcription entry point."""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path

from .base_transcriber import BaseTranscriber
from .formatting import build_transcript_markdown
from .parakeet_segments import (SAMPLE_RATE, InvalidParakeetOutput, assemble,
                                repair_seam, retain_owned, windows)


class ParakeetTranscriber(BaseTranscriber):
    def __init__(self, *, model_dir: str, adapter_id: str, ffmpeg: str,
                 ffprobe: str = '', runtime_lock_id: str = '', artifact_revision: str = '',
                 vad_dir: str = ''):
        self.model_dir = model_dir
        self.adapter_id = adapter_id
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe or str(Path(ffmpeg).with_name('ffprobe'))
        self.runtime_lock_id = runtime_lock_id
        self.artifact_revision = artifact_revision
        self.vad_dir = vad_dir
        self.adapter = None

    def load_model(self):
        if self.adapter_id != 'parakeet-mlx-metal-v1':
            from .parakeet_onnx import CudaParakeet
            self.adapter = CudaParakeet(self.model_dir, self.vad_dir)
        else:
            from .parakeet_mlx import MetalParakeet
            self.adapter = MetalParakeet(self.model_dir)
        self.adapter.load_model()

    def _duration(self, audio_path: str) -> float:
        # Installers contain FFmpeg but do not promise an FFprobe binary.
        probe = self.ffprobe if Path(self.ffprobe).is_file() else shutil.which(self.ffprobe)
        if probe:
            proc = subprocess.run([probe, '-v', 'error', '-show_entries',
                                   'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
                                   audio_path], capture_output=True, text=True, timeout=60)
            if proc.returncode == 0:
                try:
                    duration = float(proc.stdout.strip())
                except ValueError:
                    duration = math.nan
                if math.isfinite(duration) and duration >= 0:
                    return duration
        proc = subprocess.run([self.ffmpeg, '-hide_banner', '-nostdin', '-i', audio_path],
                              capture_output=True, text=True, timeout=60)
        match = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', proc.stderr)
        if not match:
            raise InvalidParakeetOutput('Audio duration is unavailable.')
        duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
        if not math.isfinite(duration) or duration < 0:
            raise InvalidParakeetOutput('Audio duration is invalid.')
        return duration

    def _decode(self, audio_path: str, start: float, end: float) -> bytes:
        length = end - start
        if length > 18.701 or length <= 0:
            raise InvalidParakeetOutput('Audio window exceeds the bounded input.')
        proc = subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-ss', f'{start:.6f}',
                               '-i', audio_path, '-t', f'{length:.6f}', '-ac', '1',
                               '-ar', str(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-'],
                              capture_output=True, check=True, timeout=120)
        pcm = proc.stdout
        if len(pcm) > math.ceil(length * SAMPLE_RATE + 2) * 2:
            raise InvalidParakeetOutput('Decoded window exceeds its sample bound.')
        return pcm

    def transcribe_file(self, audio_path: str, output_path: str | None = None,
                        save_markdown: bool = True):
        if self.adapter is None:
            self.load_model()
        duration = self._duration(audio_path)
        retained = []
        for window in windows(duration):
            pcm = self._decode(audio_path, window.input_start, window.input_end)
            words = self.adapter.transcribe_window(pcm, input_start=window.input_start,
                                                   input_end=window.input_end)
            owned = retain_owned(words, window)
            if retained:
                owned = repair_seam(retained, owned, window.ownership_start)
            retained.extend(owned)
        segments = assemble(retained, duration)
        text = ' '.join(segment['text'] for segment in segments)
        if save_markdown and output_path:
            markdown = build_transcript_markdown(audio_path=audio_path, language_label='English',
                                                 duration=duration, segments=segments,
                                                 engine_label='Parakeet v2')
            if not segments:
                markdown += '\nNo speech transcribed.\n'
            Path(output_path).write_text(markdown, encoding='utf-8')
        return {
            'text': text, 'segments': segments, 'language': 'en', 'duration': duration,
            'output_file': output_path if save_markdown else None,
            'device': self.adapter.device, 'computeType': 'float32',
            'engine': 'parakeet', 'modelId': 'parakeet-tdt-0.6b-v2',
            'artifactRevision': self.artifact_revision, 'adapterId': self.adapter_id,
            'runtimeLockId': self.runtime_lock_id,
            'boundaryPolicy': 'parakeet-boundaries-v1',
        }

    def get_model_info(self):
        return {'engine': 'parakeet', 'modelId': 'parakeet-tdt-0.6b-v2',
                'adapterId': self.adapter_id, 'device': self.adapter.device if self.adapter else None,
                'computeType': 'float32'}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--vad-dir', default='')
    parser.add_argument('--adapter-id', required=True)
    parser.add_argument('--artifact-revision', required=True)
    parser.add_argument('--runtime-lock-id', required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', default='')
    args = parser.parse_args(argv)
    transcriber = ParakeetTranscriber(model_dir=args.model_dir, adapter_id=args.adapter_id,
                                     ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
                                     runtime_lock_id=args.runtime_lock_id,
                                     artifact_revision=args.artifact_revision, vad_dir=args.vad_dir)
    result = transcriber.transcribe_file(args.file, args.output)
    sys.stdout.write(json.dumps(result, allow_nan=False) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
