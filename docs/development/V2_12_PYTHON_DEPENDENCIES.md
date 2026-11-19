# v2.12 Python dependency evidence — 2026-11-18

This is qualification evidence, not a packaged-platform acceptance claim. Authenticated
`gh pr list` returned the four open PRs #146, #147, #150 and #152. PyPI JSON was
queried for all packages in the three exact build requirements and all three
Parakeet locks. The inventory below records the version(s) before this change
and the newest non-yanked stable release offering some wheel whose declared
`Requires-Python` permits 3.11. It is a discovery screen, not proof that a wheel
exists for every target or that a candidate is compatible with its dependants.
Re-query at release cut; a target-host build and audit are still required.

| Decision | Evidence and remaining gate |
|---|---|
| #146 filelock 4.2.7 → **4.2.12** | Supersedes proposed 4.2.10 in common, dev, platform and build requirements. The independent macOS Parakeet filelock wheel was generated from PyPI bytes with `scripts/update-parakeet-lock-wheel.js`; Windows/Linux Parakeet locks contain no filelock. Linux Python 3.11 meeting-manager tests including interrupted import and concurrent metadata locking passed with 4.2.12 in an isolated `/tmp` target. Run concurrent lock and metadata checks in both packaged Windows and macOS runtimes. |
| #147 numba 0.68.0 → **0.68.1**, llvmlite remains 0.50.0 | The macOS build wheel closure resolves together on CPython 3.11 arm64. Run import plus recording/transcription on native Apple Silicon before release. The independent macOS Parakeet runtime remains on 0.67.0/0.49.0: changing that isolated accelerator closure needs separate generation, native inference and repair/offline checks. |
| #150 torch 2.14.1 → **2.15.0** | macOS CPython 3.11 arm64 build closure resolves. Torch is build-only and `MACOS_RUNTIME_REMOVABLE_PACKAGES` prunes it; inspect the actual packaged artifact/import path and run native transcription to verify. This does not modify the separately installed Pyannote runtime. |
| #152 click 8.5.0 → **8.5.1** | All three build closures resolve. The macOS Parakeet lock is independently regenerated from actual wheel bytes; the Windows/Linux Parakeet locks contain no click. Run packaged CLI startup and transcription on each target. |
| Other build dependencies | Updated annotated-doc 0.0.5 → 0.0.7, markdown-it-py 4.2.0 → 4.3.0, typer 0.27.3 → 0.29.2, and macOS regex 2026.9.29 → 2026.11.18. Typer's new resolved `annotated-types`, `pydantic`, `pydantic-core` and `typing-inspection` dependencies are pinned in each build closure. The target-host installer gates below apply. |
| ONNX Runtime 1.31.1 → 1.32.0 | Hold: the Windows wheel's internal telemetry suppression is a qualified implementation detail; upgrade only with the native ETW positive-control and guarded real VAD test. Linux GPU and managed Speakrs qualification also remain separate. |
| CTranslate2 4.8.5 → 4.9.0 | Hold pending CPU and managed CUDA transcript/packaged inference comparison on supported hardware, including Windows CUDA 12. |
| PyObjC 12.2.2 → 13.0 coordinated set | Hold pending native macOS audio, permissions and capture qualification for the major upgrade, plus target closure and packaged artifact checks. |
| HF Hub 1.33.0 → 2.4.0 | Hold pending API/offline cache and explicit download migration qualification; keep Xet disabled. hf-xet 1.8.0 is current in the base closure. |
| Independent Parakeet and GPU wheels | Other newer versions in the inventory remain held pending reverse-closure resolution, regenerated wheel inventories and native accelerator inference/setup/offline/repair qualification. Locks are independent identities; do not mechanically synchronize them with base requirements. |
| Pyannote managed runtime | Direct Windows pins are pyannote.audio 4.0.7, torch 2.13.0+cu126, torchvision 0.28.0+cu126, torchaudio 2.11.0+cu126, torchcodec 0.16.0, julius 0.2.7, certifi 2026.10.19; macOS omits torchvision and uses torch 2.13.0/torchaudio 2.11.0. PyPI discovery shows pyannote.audio 4.1.0, torchvision 0.29.2, torchaudio 2.11.1, torchcodec 0.17.0 and julius 0.2.8. Hold the coupled set pending native CUDA/MPS resolution, explicit setup, inference, offline and repair qualification and inventory/audit of actual installed transitive dependencies. It is not the macOS build-only Torch. |

## Resolution and audit evidence

- `check-build-requirements-closure.py windows linux` passed on Linux for Python
  3.11 target wheels; Windows host-only markers are explicitly accounted for by
  the checker. macOS passed with an explicit temporary override of pip's marker
  environment to Darwin/arm64; unmodified cross-resolution on Linux incorrectly
  applies Linux Torch CUDA markers and fails. This override is evidence of wheel
  resolution, not a native macOS build or import.
- `pip-audit -r requirements-linux-build.txt` on Linux: no known vulnerabilities.
  The same command for Windows on Linux fails because PyAudioWPatch has no Linux
  wheel; macOS fails because a PyObjC source build needs `/usr/bin/sw_vers`.
  Run these audits on their actual Windows and macOS hosts; neither is a pass.
- `node --test tests/js/parakeet-locks.test.js tests/js/update-parakeet-lock-wheel.test.js`:
  11 passed. Regenerated macOS Parakeet lock digest changed, so existing managed
  installs require repair and must be qualified through that path.
- Linux `test_meeting_manager.py` with `/tmp`-installed filelock 4.2.12: 45 passed.
  This does not exercise a packaged runtime or establish platform hardware success.
- Before release run all three target-host closure checks and audits, inspect the
  prepared/installed and removed package inventories, and execute packaged CLI,
  recording/transcription and explicit AI setup/repair/offline checks on the
  affected native Windows, macOS and Linux hosts. No native Windows/macOS or
  packaged runtime execution was available in this investigation.

## PyPI 3.11 wheel discovery

`Package | existing pinned version(s) | newest discovered compatible release`:

- annotated-doc | 0.0.5 | 0.0.7
- anyio | 4.14.2,4.16.0 | 4.16.0
- audioread | 3.1.0 | 3.1.0
- av | 18.1.0 | 18.1.0
- certifi | 2026.10.19,2026.10.23 | 2026.10.23
- cffi | 2.1.1 | 2.1.1
- charset-normalizer | 3.5.1,3.5.2 | 3.5.2
- click | 8.5.0,8.5.1 | 8.5.1
- colorama | 0.4.6 | 0.4.6
- coloredlogs | 15.0.1 | 15.0.1
- ctranslate2 | 4.8.5 | 4.9.0
- dacite | 1.9.2 | 1.9.2
- decorator | 5.2.1 | 5.3.1
- faster-whisper | 1.2.1 | 1.2.1
- filelock | 4.2.10,4.2.7 | 4.2.12
- flatbuffers | 25.12.19 | 25.12.19
- fsspec | 2026.7.0,2026.9.0 | 2026.9.0
- h11 | 0.16.0 | 0.16.0
- hf-xet | 1.8.0 | 1.8.0
- httpcore | 1.0.9 | 1.0.9
- httpx | 0.28.1 | 0.28.1
- huggingface-hub | 1.29.0,1.33.0 | 2.4.0
- humanfriendly | 10.0 | 10.0
- idna | 3.19,3.20 | 3.20
- jinja2 | 3.1.6 | 3.1.6
- joblib | 1.5.2 | 1.6.0
- lazy-loader | 0.4 | 0.6
- librosa | 0.11.0 | 0.11.0
- lightning-whisper-mlx | 0.0.10 | 0.0.10
- llvmlite | 0.49.0,0.50.0 | 0.50.0
- markdown-it-py | 4.2.0 | 4.3.0
- markupsafe | 3.0.4 | 3.0.4
- mdurl | 0.1.2 | 0.1.2
- mlx | 0.32.2,0.32.4 | 0.32.4
- mlx-metal | 0.32.2,0.32.4 | 0.32.4
- more-itertools | 11.2.1 | 11.2.1
- mpmath | 1.3.0 | 1.4.1
- msgpack | 1.2.3 | 1.2.4
- networkx | 3.6.1 | 3.6.1
- numba | 0.67.0,0.68.0 | 0.68.1
- numpy | 2.4.6 | 2.4.6
- nvidia-cublas-cu12 | 12.9.2.10 | 12.9.3.13
- nvidia-cuda-nvrtc-cu12 | 12.9.86 | 12.9.86
- nvidia-cuda-runtime-cu12 | 12.9.79 | 12.9.79
- nvidia-cudnn-cu12 | 9.26.0.51 | 9.28.1.4
- nvidia-cufft-cu12 | 11.4.1.4 | 11.4.1.4
- nvidia-curand-cu12 | 10.3.10.19 | 10.3.10.19
- nvidia-nvjitlink-cu12 | 12.9.86 | 12.9.86
- onnx-asr | 0.12.0 | 0.12.0
- onnxruntime | 1.31.1 | 1.32.0
- onnxruntime-gpu | 1.23.2 | 1.32.0
- packaging | 26.3 | 26.3
- parakeet-mlx | 0.5.2 | 0.7.0
- platformdirs | 4.4.0 | 4.14.7
- pooch | 1.8.2 | 1.9.0
- protobuf | 7.36.2 | 7.36.2
- pulsectl | 24.12.0 | 24.12.0
- pyaudiowpatch | 0.2.12.9 | 0.2.12.9
- pycparser | 3.0,3.12 | 3.12
- pygments | 2.21.0 | 2.21.0
- pyobjc-core | 12.2.2 | 13.0
- pyobjc-framework-avfoundation | 12.2.2 | 13.0
- pyobjc-framework-cocoa | 12.2.2 | 13.0
- pyobjc-framework-coreaudio | 12.2.2 | 13.0
- pyobjc-framework-coremedia | 12.2.2 | 13.0
- pyobjc-framework-quartz | 12.2.2 | 13.0
- pyobjc-framework-screencapturekit | 12.2.2 | 13.0
- pyreadline3 | 3.5.4 | 3.5.6
- pyyaml | 6.0.3 | 6.0.3
- regex | 2026.9.29 | 2026.11.18
- requests | 2.34.2 | 2.34.2
- rich | 15.0.0 | 15.0.0
- scikit-learn | 1.7.2 | 1.9.1
- scipy | 1.17.1 | 1.17.1
- setuptools | 84.2.1 | 84.2.1
- shellingham | 1.5.4 | 1.5.4
- soundcard | 0.4.6 | 0.4.6
- sounddevice | 0.5.6 | 0.5.6
- soundfile | 0.13.1 | 0.14.0
- soxr | 1.1.0 | 1.1.0
- sympy | 1.14.0 | 1.14.0
- threadpoolctl | 3.6.0 | 3.8.0
- tiktoken | 0.3.3 | 0.14.0
- tokenizers | 0.23.3 | 0.23.3
- torch | 2.14.1 | 2.15.0
- tqdm | 4.70.0,4.70.1 | 4.70.1
- typer | 0.27.2,0.27.3 | 0.29.2
- typing-extensions | 4.16.0 | 4.16.0
- urllib3 | 2.8.0 | 2.8.0
