# AvaNevis v2.9.0 dependency compatibility matrix

Decision record for `feature/v2.9-dependency-hygiene` Task 1. Later version changes on this lane must cite this file; do not copy a freeze or lockfile from one platform onto another.

**Recorded:** 2026-08-28  
**Python target:** 3.11 (`cp311`)  
**Electron baseline:** 42.9.0 (Electron 44 is a separate lane; not evaluated here)  
**Privacy:** no cloud transcription, telemetry, or extra network use beyond explicit model/update checks and these resolver downloads.

| Interpreter | Where | ABI |
|---|---|---|
| CPython 3.11.9 (`MSC v.1938`, 64-bit) | Windows host clean venvs | `cp311` win_amd64 |
| CPython 3.11.15 (uv `cpython-3.11.15-linux-x86_64-gnu`) | WSL2 Ubuntu | `cp311` manylinux |
| CPython 3.11 (packaged `PYTHON_VERSION = 3.11.9` in `build/prepare-resources.js`) | Windows/macOS/Linux installers | same ABI; not re-resolved in this task |
| macOS arm64 3.11 | not present on this host | `pip install --dry-run --report` with `--python-version 3.11 --abi cp311` and `macosx_14_0_arm64` / `13_0` / `12_0` / `11_0` tags |

Linux WSL2 is **not** Omarchy hardware. It is a Python 3.11 Linux resolver/`pip check` stand-in. Packaged Linux still uses python-build-standalone 3.11.9.

## FileLock correction (this change)

Linux was the only remaining 3.32.0 holdout. Common, Windows, macOS, and development already required 3.32.3 for CVE-2025-68146 and CVE-2026-22701.

| File | Before | After |
|---|---|---|
| `requirements-linux.txt` | `filelock>=3.32.0` | `filelock>=3.32.3` |
| `requirements-linux-build.txt` | `filelock==3.32.0` | `filelock==3.32.3` |

Unconstrained runtime files still resolve **filelock 3.32.4** today. Packaged builds stay on **3.32.3** until a later task accepts a newer pin with its own evidence. That float is expected; do not copy 3.32.4 into the Linux build file from a Windows or Linux runtime freeze.

`pip check` after the correction: no broken requirements on Windows `requirements-windows-build.txt` (already 3.32.3) and on Linux WSL `requirements-linux.txt` / `requirements-linux-build.txt`.

SBOM: `legal/PYTHON-BUNDLED-PACKAGES.md` regenerated 2026-08-28T15:31:52.342Z. Direct pin `filelock` is **3.32.3** on all three `requirements-*-build.txt` files (the previous SBOM listed 3.32.0 for all three and was stale relative to the Windows/macOS pins).

## Package and runtime ownership

Treat these as **direct runtime dependencies** even when a resolver also reaches them through `faster-whisper`. Never prune them in Task 3 without a failed experiment.

| Package | Owner | Packaged pin today | Why it stays explicit |
|---|---|---|---|
| `onnxruntime` | faster-whisper Silero VAD (`vad_filter=True` in `faster_whisper_transcriber.py`) | Windows/Linux build `==1.26.0` | Import/VAD failure if missing. macOS `prepare-resources.js` **removes** `onnxruntime` after pip because MLX does not use it. |
| `tokenizers` | faster-whisper tokenization | Windows/Linux build `==0.23.1` | Tokenize/model load failure if missing. |
| `av` (PyAV) | faster-whisper path-based decode | Windows/Linux build `==17.0.1` | `transcribe(audio_path)` decode. Bundled ffmpeg does not replace this import. Runtime files currently float to **18.1.0** — Task 2 candidate only after packaged decode smoke. |
| `ctranslate2` | faster-whisper inference | Windows/Linux build `==4.8.1` | CUDA 12 wheels. Packaged Windows GPU profile remains `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`. This host also has CUDA 13 on PATH; that does not change the packaged CUDA 12 contract. |
| `faster-whisper` | Windows + Linux transcription | `==1.2.1` | Linux Core Beta is **CPU only**. |
| `lightning-whisper-mlx` | Apple Silicon transcription | macOS build `==0.0.10` | Pins `tiktoken==0.3.3`. |
| `torch` | macOS resolver only | macOS build `==2.12.0`, then **pruned** | MLX inference never imports `torch_whisper.py`. `torch==2.12.0` requires `setuptools<82`. |
| `setuptools` | pip / wheel metadata | Windows/Linux build `==83.0.0`; macOS build `==81.0.0` (also pruned from the macOS runtime) | **Global setuptools 84 is blocked** while macOS still resolves Torch 2.12.0. CI ignores `PYSEC-2026-3447` on macOS for that reason. An unconstrained macOS *runtime* resolve already floats to setuptools **84.0.0** with torch **2.13.0** — do not treat that as an accepted packaged graph. |
| `numba` / `llvmlite` | MLX stack | macOS build `==0.65.1` / `==0.47.0` | Unconstrained macOS runtime floats to **0.67.0 / 0.49.0**. Accept 0.67 only with matching llvmlite 0.49 **and** MLX/Whisper plus ScreenCaptureKit-fallback smoke. |
| `numpy` | audio + ML | all build files `==2.4.6` | Stay on 2.4.x; 2.5+ needs Python ≥3.12. |
| PyObjC `ScreenCaptureKit` / `CoreAudio` / `AVFoundation` | macOS capture fallback | build `==10.0` | Runtime files float to **12.2.2**. Coordinated bump only. |
| PyObjC `Cocoa` / `Quartz` / `core` / `CoreMedia` | ScreenCaptureKit fallback graph | build `==12.1` | Task 3: do not remove without imports, `pip check`, packaged macOS dir build, and hardware capture smoke. |
| `tiktoken` | MLX | macOS `==0.3.3` | Dependabot ignore; do not bump alone. |
| Speakrs ONNX Runtime | add-on, **not** pip requirements | Windows setup-time archive **1.27.1** (`src/ai-addon/speakrs-pack-spec.js`) | Distinct from pip `onnxruntime==1.26.0`. Linux add-ons remain `unsupported`. |

Linux CUDA, Speakrs, Pyannote, and summaries are **v3.0+**. This matrix does not authorize those packages.

## Resolver vs packaged pins

Runtime files (`requirements.txt`, `requirements-windows.txt`, `requirements-linux.txt`, `requirements-macos.txt`, `requirements-common.txt`, `requirements-dev.txt`) use floors. Build files pin the installer. **Do not copy a runtime freeze into a build file.**

Material floats observed 2026-08-28 (runtime) versus current build pins:

| Package | Runtime resolve | Build pin | Action in v2.9 |
|---|---|---|---|
| `filelock` | 3.32.4 | 3.32.3 | Floor raised on Linux; build stays 3.32.3 |
| `av` | 18.1.0 | 17.0.1 | Task 2 after packaged decode smoke |
| `onnxruntime` | 1.29.0 | 1.26.0 | Keep 1.26.0 until VAD/decode/Speakrs evidence |
| `huggingface-hub` | 1.29.0 | 1.16.1 | Hold packaged pin |
| `pytest` | 9.1.1 | floor `>=9.0.3` | Task 2 may record 9.1.1; suite already passed on it |
| `mlx` | 0.32.2 | 0.31.2 | macOS only; needs native smoke |
| `torch` (macOS runtime) | 2.13.0 | 2.12.0 then prune | Do not follow the runtime float |
| `setuptools` (macOS runtime) | 84.0.0 | 81.0.0 | Blocker for a global 84 bump |
| PyObjC capture frameworks | 12.2.2 | 10.0 / 12.1 mix | Coordinated macOS change only |
| `sounddevice` | 0.5.6 | 0.4.6 | Hold until macOS capture smoke |

## Per-file evidence

`pip check` text in every executed install: **No broken requirements found.**

### `requirements-common.txt` — Windows 3.11.9 install

`filelock==3.32.4`, `numpy==2.4.6`. `pip check` passed.

### `requirements-dev.txt` — Windows 3.11.9 install

`pytest==9.1.1`, `numpy==2.4.6`, `soxr==1.1.0`, `filelock==3.32.4`, plus pytest transitives (`iniconfig==2.3.0`, `pluggy==1.6.0`, `Pygments==2.21.0`, `packaging==26.3`). `pip check` passed.

### `requirements.txt` and `requirements-windows.txt` — Windows 3.11.9 install

Same resolved graph (windows.txt matches requirements.txt for package floors). `pip check` passed.

```
anyio==4.14.2 av==18.1.0 certifi==2026.7.22 click==8.5.0 colorama==0.4.6
ctranslate2==4.8.1 faster-whisper==1.2.1 filelock==3.32.4 flatbuffers==25.12.19
fsspec==2026.7.0 h11==0.16.0 hf-xet==1.6.0 httpcore==1.0.9 httpx==0.28.1
huggingface_hub==1.29.0 idna==3.19 numpy==2.4.6 onnxruntime==1.29.0 packaging==26.3
protobuf==7.36.0 PyAudioWPatch==0.2.12.8 PyYAML==6.0.3 soxr==1.1.0
tokenizers==0.23.1 tqdm==4.70.0 typing_extensions==4.16.0
```

### `requirements-windows-build.txt` — Windows 3.11.9 install

`pip check` passed. Matches the file’s pins, including `filelock==3.32.3`, `av==17.0.1`, `onnxruntime==1.26.0`, `tokenizers==0.23.1`, `faster-whisper==1.2.1`, `ctranslate2==4.8.1`, `setuptools==83.0.0`, `numpy==2.4.6`, `huggingface-hub==1.16.1`.

### `requirements-linux.txt` — WSL2 CPython 3.11.15 install

`pip check` passed. Capture: `pulsectl==24.12.0`, `SoundCard==0.4.6`, `cffi==2.1.1`. Transcription stack floated like Windows runtime (`faster-whisper==1.2.1`, `filelock==3.32.4`, `av==18.1.0`, `onnxruntime==1.29.0`, `tokenizers==0.23.1`, `ctranslate2==4.8.1`, `numpy==2.4.6`). uv seeded `setuptools==84.0.0` in the empty venv; it is **not** a Linux packaged pin.

### `requirements-linux-build.txt` — WSL2 CPython 3.11.15 install

`pip check` passed after the FileLock correction. Pins installed as written: `filelock==3.32.3`, `av==17.0.1`, `onnxruntime==1.26.0`, `tokenizers==0.23.1`, `faster-whisper==1.2.1`, `ctranslate2==4.8.1`, `setuptools==83.0.0`, `pulsectl==24.12.0`, `SoundCard==0.4.6`, `cffi==2.1.1`, `numpy==2.4.6`.

### `requirements-macos.txt` — dry-run only (no macOS `pip check`)

`pip install --dry-run --report` with macOS arm64 tags succeeded (`Would install` 46 packages). Notable floats: `filelock==3.32.4`, `lightning-whisper-mlx==0.0.10`, `mlx==0.32.2`, `numba==0.67.0`, `llvmlite==0.49.0`, `torch==2.13.0`, `setuptools==84.0.0`, PyObjC 12.2.2, `sounddevice==0.5.6`, `scipy==1.17.1`, `tiktoken==0.3.3`. **Native `pip check` was not run** (no macOS 3.11 on this machine). CI `test-backend-macos` installs this file plus `requirements-dev.txt` but does not run `pip check`.

### `requirements-macos-build.txt` — dry-run only (no macOS `pip check`)

Dry-run succeeded (`Would install` 53 packages) at the pinned graph: `filelock==3.32.3`, `torch==2.12.0`, `setuptools==81.0.0`, `mlx==0.31.2`, `numba==0.65.1`, `llvmlite==0.47.0`, `lightning-whisper-mlx==0.0.10`, mixed PyObjC 10.0/12.1, `tiktoken==0.3.3`, `scipy==1.17.1`. Same native `pip check` gap as the runtime file.

## SBOM

Command: `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` (63 direct pins).

The generator lists **direct `==` pins** from the three build requirement files, not a full transitive lock. Transitive packages still install during `npm run prepare-build`.

Task 3 pin-trim diffs should compare this SBOM plus `pip freeze` from a clean packaged-requirements venv, not a runtime freeze.

## Offline transcription

Automations (no network required):

- `tests/python/test_transcriber_helpers.py` local-files / cache tests: **10 passed**
- `tests/js/main-process-helpers.test.js` cache completeness + `buildHuggingFaceOfflineEnv` / `buildTranscriptionRuntimeEnv`: included in **143 passed, 1 skipped**

Host smoke (Windows, 2026-08-28): complete Hugging Face snapshots `models--Systran--faster-whisper-small` and `...-medium`. Clean runtime venv (`faster-whisper` 1.2.1, `av` 18.1.0, `onnxruntime` 1.29.0) with `HF_HUB_OFFLINE=1` and `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1`:

```
python -m transcription.faster_whisper_transcriber --file fixture.wav --model small --device cpu --language en --json
```

Log: `Using cached Whisper model files only.` Result: `device: cpu`, `computeType: int8`, duration 14.22s, English transcript from `tests/fixtures/speakrs-two-speaker-16k.wav`, exit 0. Temporary files only under `%TEMP%\avanevis-v2.9-offline-transcribe`.

Not claimed: packaged-app transcription, CUDA 12 transcription, MLX, Speakrs, or Linux CPU packaged smoke. Those remain later native gates.

## Task 1 validation commands

Windows:

```powershell
python -m pip install -r requirements.txt
python -m pip check
python -m pytest tests/python -q
rg -n "filelock" --glob "requirements*.txt"
```

Executed here in a clean 3.11.9 venv (plus `requirements-dev.txt` for pytest): `pip check` passed; `pytest tests/python -q` exit 0 (7 skipped). The same pytest run in the repo `.venv` also exit 0. Project `.venv` `pip check` passed. FileLock scan shows 3.32.3 on every `requirements*.txt` (floors or pins).

Linux equivalent: WSL2 Python 3.11.15 clean venvs for `requirements-linux.txt` and `requirements-linux-build.txt`, both `pip check` passed.

macOS equivalent: dry-run resolver only; native install/`pip check` still needed on macos-14 before Task 2 macOS pin changes.

## Blockers and non-goals (before Task 2)

- **Do not** merge or land Dependabot PRs from this evidence. Use this matrix to accept or reject each candidate in its own commit.
- **Do not** upgrade Electron.
- **Do not** start Linux AI add-on phases 6–9.
- **Do not** add Apple signing or notarization.
- **setuptools 84** is acceptable to *evaluate* on Windows/Linux build files only. It is **not** acceptable as a global bump while macOS packaged Torch remains 2.12.0 / setuptools 81.0.0.
- **macOS native `pip check`** and packaged MLX / ScreenCaptureKit smoke are still required before accepting macOS-only floats (PyObjC 12.2, Numba 0.67, MLX 0.32, Torch 2.13, sounddevice 0.5.6).
- **PyAV 18.1.0** is a Windows/Linux Task 2 candidate; packaged pin remains 17.0.1 until import + fixture decode + installer smoke pass on those platforms.
- Host CUDA 13 toolkits must not be mistaken for packaged CUDA 12 support.
