"""Regression checks for macOS packaged-runtime trimming."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PREPARE_RESOURCES = REPO_ROOT / 'build' / 'prepare-resources.js'
MLX_TRANSCRIBER = REPO_ROOT / 'backend' / 'transcription' / 'mlx_whisper_transcriber.py'


def test_macos_runtime_removal_list_includes_torch():
    contents = PREPARE_RESOURCES.read_text(encoding='utf-8')
    assert "'torch'," in contents


def test_mlx_transcriber_does_not_import_torch():
    source = MLX_TRANSCRIBER.read_text(encoding='utf-8')
    assert 'import torch' not in source
    assert 'from torch' not in source
