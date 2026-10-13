#!/usr/bin/env python3
"""Compare CPU Silero VAD on the bundled model; no model/network downloads.

Install ONNX Runtime 1.30.0 with --no-deps --target <baseline>, then run:
  python scripts/qualify-onnx-vad.py --baseline-site-packages <baseline>
The active interpreter must contain candidate ONNX Runtime 1.31.0 and the
faster-whisper build dependencies. Workers use separate native processes.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

# Set before optional native imports, including when invoked outside Electron.
os.environ['ORT_DISABLE_TELEMETRY'] = '1'
ROOT = Path(__file__).resolve().parents[1]


def worker(site_packages, windows_telemetry_guard=False):
    # Exercise the app's opt-out instead of ORT's automatic CI suppression.
    for key in ('CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI',
                'TRAVIS', 'JENKINS_URL', 'CODEBUILD_BUILD_ID', 'BUILDKITE',
                'TEAMCITY_VERSION', 'APPVEYOR', 'BITBUCKET_BUILD_NUMBER',
                'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI', 'ORT_RUNNING_UNIT_TESTS'):
        os.environ[key] = '0'
    if windows_telemetry_guard:
        assert sys.platform == 'win32', 'Windows telemetry qualification requires Windows'
        # Exercise the actual standalone application boundary after hostile
        # environment values, rather than duplicating its guard in this probe.
        sys.path.insert(0, str(ROOT / 'backend'))
        import transcription  # noqa: F401
        assert os.environ['ORT_RUNNING_UNIT_TESTS'] == '1'
    if site_packages:
        sys.path.insert(0, str(Path(site_packages).resolve()))
    import numpy as np
    import onnxruntime as ort
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, get_vad_model

    audio = decode_audio(str(ROOT / 'tests/fixtures/speakrs-two-speaker-16k.wav'),
                         sampling_rate=16000)
    model = get_vad_model()
    assert model.session.get_providers() == ['CPUExecutionProvider']
    cases = {}
    for name, samples in [('speech', audio), ('silence', np.zeros(16000, dtype=np.float32))]:
        padded = np.pad(samples, (0, 512 - len(samples) % 512))
        probabilities = model(padded)
        assert np.isfinite(probabilities).all()
        segments = get_speech_timestamps(samples)
        if name == 'speech':
            assert segments, 'Fixture speech must be detected'
        else:
            assert segments == [], 'Silence must remain empty'
        cases[name] = {'probabilities': probabilities.tolist(), 'segments': segments}
    return {'version': ort.__version__, 'pid': os.getpid(),
            'telemetry_opt_out': os.environ['ORT_DISABLE_TELEMETRY'],
            'fixture_sha256': hashlib.sha256(audio.tobytes()).hexdigest(), 'cases': cases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-site-packages')
    parser.add_argument('--check-network', action='store_true',
                        help='Require Linux strace and reject native network syscalls')
    parser.add_argument('--windows-telemetry-guard', action='store_true',
                        help='Exercise the pinned Windows pre-import ETW suppression')
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--site-packages')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.worker:
        result = worker(args.site_packages, args.windows_telemetry_guard)
        if args.output:
            args.output.write_text(json.dumps(result), encoding='utf-8')
        else:
            print(json.dumps(result))
        return
    if not args.baseline_site_packages:
        parser.error('--baseline-site-packages is required for comparison')
    if args.check_network and (not sys.platform.startswith('linux') or not shutil.which('strace')):
        parser.error('--check-network requires Linux with strace installed')
    import numpy as np

    results = []
    with tempfile.TemporaryDirectory(prefix='avanevis-vad-') as temp:
        for index, packages in enumerate([args.baseline_site_packages, None]):
            output = Path(temp) / f'{index}.json'
            command = [sys.executable, str(Path(__file__).resolve()), '--worker', '--output', str(output)]
            if packages:
                command += ['--site-packages', packages]
            if args.windows_telemetry_guard:
                command += ['--windows-telemetry-guard']
            trace = Path(temp) / f'{index}.network'
            if args.check_network:
                command = ['strace', '-f', '-e', 'trace=network', '-o', str(trace), *command]
            subprocess.run(command, check=True, timeout=120, env=dict(os.environ, ORT_DISABLE_TELEMETRY='1'))
            if args.check_network:
                trace_text = trace.read_text(encoding='utf-8')
                assert not any(marker in trace_text for marker in
                               ('AF_INET', 'AF_INET6', 'connect(', 'sendto(', 'sendmsg(')), trace_text
            results.append(json.loads(output.read_text(encoding='utf-8')))
    baseline, candidate = results
    assert baseline['version'] == '1.30.0', baseline['version']
    assert candidate['version'] == '1.31.0', candidate['version']
    assert baseline['fixture_sha256'] == candidate['fixture_sha256']
    for name in baseline['cases']:
        before, after = baseline['cases'][name], candidate['cases'][name]
        np.testing.assert_allclose(after['probabilities'], before['probabilities'], rtol=1e-5, atol=1e-6)
        assert after['segments'] == before['segments'], f'{name}: speech boundaries changed'
    print(json.dumps({'baseline': baseline['version'], 'candidate': candidate['version'],
                      'telemetry_opt_out': candidate['telemetry_opt_out'],
                      'speech_segments': len(candidate['cases']['speech']['segments']),
                      'network_checked': args.check_network,
                      'probabilities_match': True, 'boundaries_match': True, 'silence_empty': True}))


if __name__ == '__main__':
    main()
