"""Check the standalone import boundary before optional native modules load."""

import os
from pathlib import Path
import subprocess
import sys


def test_transcription_disables_onnx_telemetry_before_native_import():
    backend = Path(__file__).resolve().parents[2] / 'backend'
    env = dict(os.environ, PYTHONPATH=str(backend), ORT_DISABLE_TELEMETRY='0',
               ORT_RUNNING_UNIT_TESTS='0')
    code = '''
import os, sys
import transcription
assert os.environ['ORT_DISABLE_TELEMETRY'] == '1'
assert os.environ['ORT_RUNNING_UNIT_TESTS'] == '1'
assert 'onnxruntime' not in sys.modules
assert 'faster_whisper' not in sys.modules
'''
    result = subprocess.run([sys.executable, '-c', code], env=env,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
