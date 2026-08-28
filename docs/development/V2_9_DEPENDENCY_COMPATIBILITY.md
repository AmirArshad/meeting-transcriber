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
| CPython 3.11 (packaged `PYTHON_VERSION = 3.11.9` in `build/prepare-resources.js`) | Windows/Linux/macOS installers | same ABI; packaged macOS dir build used python-build-standalone 3.11.7 on this Mac |
| Homebrew CPython 3.11.16 | Apple Silicon Mac (Task 2 native `pip check`) | `cp311` macosx arm64 |

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
| `av` (PyAV) | faster-whisper path-based decode | Windows/Linux build `==18.1.0` | `transcribe(audio_path)` decode. Bundled ffmpeg does not replace this import. Direct runtime dep; do not prune in Task 3. |
| `ctranslate2` | faster-whisper inference | Windows/Linux build `==4.8.1` | CUDA 12 wheels. Packaged Windows GPU profile remains `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`. This host also has CUDA 13 on PATH; that does not change the packaged CUDA 12 contract. |
| `faster-whisper` | Windows + Linux transcription | `==1.2.1` | Linux Core Beta is **CPU only**. |
| `lightning-whisper-mlx` | Apple Silicon transcription | macOS build `==0.0.10` | Pins `tiktoken==0.3.3`. |
| `torch` | macOS resolver only | macOS build `==2.13.0`, then **pruned** | MLX never imports `torch_whisper.py`. `lightning-whisper-mlx` does not pin Torch. **Accepted** Task 2 on Apple Silicon (2026-08-28). Stays in `MACOS_RUNTIME_REMOVABLE_PACKAGES`. Not Pyannote’s `torch==2.8.0`. |
| `setuptools` | pip / wheel metadata | Windows/Linux/macOS build `==84.0.0` (also pruned from the macOS runtime) | Windows/Linux **accepted** Task 2. macOS **accepted** with Torch 2.13.0. CI no longer ignores `CVE-2025-3000` or `PYSEC-2026-3447`. |
| `numba` / `llvmlite` | MLX stack | macOS build `==0.67.0` / `==0.49.0` | **Accepted** Task 2 on Apple Silicon (2026-08-28). Numba 0.67 requires `llvmlite>=0.49,<0.50`. Matching pair; not Dependabot Numba-alone against llvmlite 0.47. |
| `numpy` | audio + ML | all build files `==2.4.6` | Stay on 2.4.x; 2.5+ needs Python ≥3.12. |
| PyObjC `ScreenCaptureKit` / `CoreAudio` / `AVFoundation` | macOS capture fallback | macOS build `==12.2.2` | **Accepted** coordinated bump (2026-08-28). Runtime files already floated to 12.2.2. |
| PyObjC `Cocoa` / `Quartz` / `core` / `CoreMedia` | ScreenCaptureKit fallback graph | macOS build `==12.2.2` | **Kept** at 12.2.2. Cocoa supplies `Foundation` (`NSObject`, `NSRunLoop`). Quartz is required by `pyobjc-framework-AVFoundation==12.2.2`. |
| `sounddevice` | macOS microphone (`InputStream`, `query_devices`) | macOS build `==0.5.6` | **Accepted** (2026-08-28). Runtime already floated to 0.5.6. Desktop capture stays the Swift helper; this pin is the mic path. |
| `tiktoken` | MLX | macOS `==0.3.3` | Dependabot ignore; do not bump alone. |
| Speakrs ONNX Runtime | add-on, **not** pip requirements | Windows setup-time archive **1.27.1** (`src/ai-addon/speakrs-pack-spec.js`) | Distinct from pip `onnxruntime==1.26.0`. Linux add-ons remain `unsupported`. |

Linux CUDA, Speakrs, Pyannote, and summaries are **v3.0+**. This matrix does not authorize those packages.

## Resolver vs packaged pins

Runtime files (`requirements.txt`, `requirements-windows.txt`, `requirements-linux.txt`, `requirements-macos.txt`, `requirements-common.txt`, `requirements-dev.txt`) use floors. Build files pin the installer. **Do not copy a runtime freeze into a build file.**

Material floats observed 2026-08-28 (runtime) versus current build pins:

| Package | Runtime resolve | Build pin | Action in v2.9 |
|---|---|---|---|
| `filelock` | 3.32.4 | 3.32.3 | Floor raised on Linux; build stays 3.32.3 |
| `av` | 18.1.0 | **18.1.0** | **Accepted** Task 2 (2026-08-28): Windows/Linux build pins; macOS does not pin `av` |
| `onnxruntime` | 1.29.0 | 1.26.0 | Keep 1.26.0 until VAD/decode/Speakrs evidence |
| `huggingface-hub` | 1.29.0 | macOS **1.29.0**; Windows/Linux **1.16.1** | **Accepted** macOS-only (2026-08-28). Windows/Linux stay 1.16.1 until those hosts evidence the bump |
| `pytest` | 9.1.1 | floor `>=9.1.1` | **Accepted** Task 2 (2026-08-28): `requirements-dev.txt` floor raised; not a packaged pin |
| `mlx` | 0.32.2 | **0.32.2** | **Accepted** macOS-only (2026-08-28) after packaged MLX smoke; `lightning-whisper-mlx` stays 0.0.10; `tiktoken` stays 0.3.3 |
| `cffi` | 2.1.1 | macOS/Linux **2.1.1** | **Accepted** macOS-only (2026-08-28). Linux already 2.1.1; Windows does not pin `cffi` |
| `regex` | 2026.7.19 | macOS **2026.7.19** | **Accepted** macOS-only (2026-08-28). macOS-only pin (`tiktoken`) |
| `Pygments` | 2.21.0 | macOS **2.21.0**; Windows/Linux **2.20.0** | **Accepted** macOS-only (2026-08-28) |
| `annotated-doc` | 0.0.5 | macOS **0.0.5**; Windows/Linux **0.0.4** | **Accepted** macOS-only (2026-08-28) |
| `torch` (macOS runtime) | 2.13.0 | **2.13.0** then prune | **Accepted** Task 2 (2026-08-28 Mac): still prune after pip |
| `setuptools` (macOS runtime) | 84.0.0 | Windows/Linux/macOS **84.0.0** | **Accepted** Task 2 on all three packaged platforms |
| PyObjC capture frameworks | 12.2.2 | **12.2.2** | **Accepted** macOS-only (2026-08-28). Coordinated seven-package bump; Cocoa and Quartz retained |
| `sounddevice` | 0.5.6 | **0.5.6** | **Accepted** macOS-only (2026-08-28) after packaged CoreAudio tap + InputStream smoke |

## Per-file evidence

`pip check` text in every executed install: **No broken requirements found.**

### `requirements-common.txt` — Windows 3.11.9 install

`filelock==3.32.4`, `numpy==2.4.6`. `pip check` passed.

### `requirements-dev.txt` — Windows 3.11.9 install

Task 1 (floor `>=9.0.3`) already resolved `pytest==9.1.1`. Task 2 raised the floor to `>=9.1.1`; a fresh clean venv still resolves the same graph. `pip check` passed.

`pytest==9.1.1`, `numpy==2.4.6`, `soxr==1.1.0`, `filelock==3.32.4`, plus pytest transitives (`iniconfig==2.3.0`, `pluggy==1.6.0`, `Pygments==2.21.0`, `packaging==26.3`).

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

`pip check` passed. Matches the file’s pins, including `filelock==3.32.3`, `av==17.0.1` at Task 1 / `av==18.1.0` after Task 2, `onnxruntime==1.26.0`, `tokenizers==0.23.1`, `faster-whisper==1.2.1`, `ctranslate2==4.8.1`, `setuptools==83.0.0` at Task 1 / `setuptools==84.0.0` after Task 2, `numpy==2.4.6`, `huggingface-hub==1.16.1`.

### `requirements-linux.txt` — WSL2 CPython 3.11.15 install

`pip check` passed. Capture: `pulsectl==24.12.0`, `SoundCard==0.4.6`, `cffi==2.1.1`. Transcription stack floated like Windows runtime (`faster-whisper==1.2.1`, `filelock==3.32.4`, `av==18.1.0`, `onnxruntime==1.29.0`, `tokenizers==0.23.1`, `ctranslate2==4.8.1`, `numpy==2.4.6`). uv seeded `setuptools==84.0.0` in the empty venv; it is **not** a Linux packaged pin.

### `requirements-linux-build.txt` — WSL2 CPython 3.11.15 install

`pip check` passed after the FileLock correction. Pins installed as written: `filelock==3.32.3`, `av==17.0.1` at Task 1 / `av==18.1.0` after Task 2, `onnxruntime==1.26.0`, `tokenizers==0.23.1`, `faster-whisper==1.2.1`, `ctranslate2==4.8.1`, `setuptools==83.0.0` at Task 1 / `setuptools==84.0.0` after Task 2, `pulsectl==24.12.0`, `SoundCard==0.4.6`, `cffi==2.1.1`, `numpy==2.4.6`.

### `requirements-macos.txt` — Homebrew CPython 3.11.16 native install (Apple Silicon)

`pip check` passed (`No broken requirements found.`). Clean venv `/tmp/avanevis-v2.9-macos-runtime`. Resolved graph includes `torch==2.13.0`, `setuptools==84.0.0`, `numba==0.67.0`, `llvmlite==0.49.0`, `mlx==0.32.2`, `lightning-whisper-mlx==0.0.10`, `filelock==3.32.4`, `sounddevice==0.5.6`, PyObjC 12.2.2, `tiktoken==0.3.3`. 45 frozen packages. This is the unconstrained runtime float, not the packaged pin set. Packaged PyObjC **12.2.2** and `sounddevice==0.5.6` were accepted later in this file.

### `requirements-macos-build.txt` — Homebrew CPython 3.11.16 native install (Apple Silicon)

**Baseline (pre-trial):** `pip install --only-binary=:all:` then `pip check` passed at `torch==2.12.0`, `setuptools==81.0.0`, `numba==0.65.1`, `llvmlite==0.47.0`, `mlx==0.31.2`.

**After torch 2.13.0 + setuptools 84.0.0:** clean venv `/tmp/avanevis-v2.9-macos-build-torch213`. `pip check` passed. `pip_audit -r requirements-macos-build.txt` with **no ignores**: `No known vulnerabilities found` (CVE-2025-3000 is patched in 2.13.0; PYSEC-2026-3447 is past setuptools 83). Torch remains in `MACOS_RUNTIME_REMOVABLE_PACKAGES`. Pyannote `torch==2.8.0` in `src/ai-addon-state.js` was not changed.

**After Numba 0.67.0 + llvmlite 0.49.0:** clean venv `/tmp/avanevis-v2.9-macos-build-numba067`. `pip check` passed at `numba==0.67.0`, `llvmlite==0.49.0`, `torch==2.13.0`, `setuptools==84.0.0`, `mlx==0.31.2`.

**After huggingface-hub 1.29.0 (cluster 1):** clean venv `/tmp/avanevis-v2.9-macos-build-hfhub129`. `pip check` passed at `huggingface-hub==1.29.0`, `hf-xet==1.6.0`, `filelock==3.32.3`, `click==8.5.0`. Packaged python-build-standalone 3.11.7 matched. Windows/Linux build files still pin `huggingface-hub==1.16.1`.

## SBOM

Command: `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` (63 direct pins). Regenerated 2026-08-28T17:07:40.260Z after accepting macOS `numba==0.67.0` / `llvmlite==0.49.0` (torch remains 2.13.0; setuptools 84.0.0 on all three build files).

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

macOS equivalent: Homebrew CPython 3.11.16 clean venvs for `requirements-macos.txt` and `requirements-macos-build.txt`, both `pip check` passed (2026-08-28 Apple Silicon).

## Task 2 accepted (Windows/Linux)

Stay on `feature/v2.9-dependency-hygiene`. Each row is its own commit. macOS pins are unchanged until the Mac session.

### pytest 9.1.1 — accepted 2026-08-28 (this PC)

**Upstream:** [pytest 9.1.1](https://github.com/pytest-dev/pytest/releases/tag/9.1.1) (2026-06-19) is a bug-fix release over 9.1.0 (`RaisesGroup` message, indirect parametrize regression, `conftest.py` load regression, mypy `argvalues` typing). No security advisory. Dev-only; not bundled.

**Pin:** `requirements-dev.txt` floor `pytest>=9.0.3` → `pytest>=9.1.1`. Build files do not list pytest.

**Resolver (clean Windows 3.11.9 venv, `%TEMP%\avanevis-v2.9-pytest-911`):** `pip install -r requirements-dev.txt` installed `pytest==9.1.1` with `iniconfig==2.3.0`, `pluggy==1.6.0`, `Pygments==2.21.0`, `packaging==26.3`, `colorama==0.4.6`, `numpy==2.4.6`, `soxr==1.1.0`, `filelock==3.32.4`.

**`pip check`:** No broken requirements found (clean venv and repo `.venv` after `pip install -U pytest>=9.1.1`).

**SBOM:** unchanged. `npm run legal:sbom` reads only `requirements-*-build.txt`; pytest is not a packaged pin.

**Suite:** `npm run test:python` → **576 passed, 7 skipped** in 57.45s (`pytest 9.1.1` in repo `.venv`). `npm test` → **754 passed, 1 failed, 1 skipped**. The failure is `assertAppImageUsesStaticRuntime rejects malformed ELF...` (`spawnSync file ENOENT`) — Windows host has no `file(1)` for ELF inspection. Unrelated to pytest; not a Python-suite gate.

Held: packaged Python pins; Electron 42.9.0; macOS `torch` / `setuptools` / Numba.

### PyAV 18.1.0 — accepted 2026-08-28 (this PC)

**Upstream:** [PyAV v18.1.0](https://github.com/PyAV-Org/PyAV/releases/tag/v18.1.0) (2026-08-12). Feature release over 17.0.1 (via 18.0.0): `AVRational`, packet/frame helpers, CUDA-context interop. AvaNevis does not call those APIs directly; faster-whisper uses `av` to decode `transcribe(audio_path)`. No security advisory on this bump. cp311 wheels exist for `win_amd64` and `manylinux_2_28_x86_64` (`--only-binary=:all:`).

**Pin:** `requirements-windows-build.txt` and `requirements-linux-build.txt` `av==17.0.1` → `av==18.1.0`. macOS build files unchanged (no `av` pin). `onnxruntime==1.26.0` and `tokenizers==0.23.1` stay explicit direct runtime deps.

**Resolver / `pip check`:**
- Windows 3.11.9 clean venv `%TEMP%\avanevis-v2.9-pyav-1810`: `pip install --only-binary=:all: -r requirements-windows-build.txt` → `av==18.1.0`. `pip check`: No broken requirements found.
- WSL2 CPython 3.11.15 `/tmp/avanevis-v2.9-pyav-1810`: same for `requirements-linux-build.txt` (`av-18.1.0-cp311-abi3-manylinux_2_28_x86_64.whl`). `pip check`: No broken requirements found.

**Import + fixture decode** (`tests/fixtures/speakrs-two-speaker-16k.wav`): both venvs and the Windows bundled embed printed `av 18.1.0`, `rate 16000 channels 1 frames 223 samples 227592`, plus `faster_whisper 1.2.1` / `onnxruntime 1.26.0` / `tokenizers 0.23.1`.

**`prepare-build`:** `npm run prepare-build` exit 0 (manifest invalidated for the av pin; reinstalled embedded 3.11.9, pip installed `av==18.1.0`, ffmpeg, speakrs-cli). Bundled `build/resources/python/python.exe -m pip check`: No broken requirements found. Bundled decode matched the venv counts.

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-28T16:12:43.484Z; direct pin `av` is **18.1.0** (was 17.0.1). 63 direct pins.

Held: macOS pins; Electron; Linux AI add-ons; `onnxruntime` 1.26.0; `tokenizers` 0.23.1.

### setuptools 84.0.0 — accepted 2026-08-28 (this PC, Windows/Linux only)

**Upstream:** [setuptools v84.0.0](https://setuptools.pypa.io/en/stable/history.html) (2026-08-08). Distutils/compiler decoupling (`Compiler.call`, `Extension` dataclass, newline `keywords`/`platforms` deprecation). PYSEC-2026-3447 / CVE-2026-59890 was already fixed in **83.0.0**; PyPI lists no vulnerabilities on 84.0.0. Wheel `setuptools-84.0.0-py3-none-any.whl` (`requires-python >=3.10`).

**Pin:** `requirements-windows-build.txt` and `requirements-linux-build.txt` `setuptools==83.0.0` → `setuptools==84.0.0`. macOS pin remains `setuptools==81.0.0` with `torch==2.12.0`. Comment in `requirements-macos-build.txt` updated to name the Windows/Linux 84.0.0 pin; the macOS pin itself is unchanged.

**Resolver / `pip check`:**
- Windows 3.11.9 clean venv `%TEMP%\avanevis-v2.9-setuptools-84`: `pip install --only-binary=:all: -r requirements-windows-build.txt` → `setuptools==84.0.0`, `av==18.1.0`, `onnxruntime==1.26.0`, `tokenizers==0.23.1`. `pip check`: No broken requirements found.
- WSL2 CPython 3.11.15 `/tmp/avanevis-v2.9-setuptools-84`: same for `requirements-linux-build.txt`. `pip check`: No broken requirements found.

**`prepare-build`:** `npm run prepare-build` exit 0. Bundled `build/resources/python/python.exe`: `setuptools 84.0.0`, `av 18.1.0`, `onnxruntime 1.26.0`, `tokenizers 0.23.1`; `pip check`: No broken requirements found.

**pip-audit:** `python -m pip_audit -r requirements-windows-build.txt` → **No known vulnerabilities found**.

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-28T16:20:48.832Z; `setuptools` is **platform-specific (84.0.0 vs 81.0.0)**. 63 direct pins.

Held: macOS `torch==2.12.0` / `setuptools==81.0.0` / Numba 0.65.1; Electron 42.9.0; Linux AI add-ons; `onnxruntime` 1.26.0; `tokenizers` 0.23.1.

**This Windows PC:** the three Windows/Linux Task 2 commits are done. Next step is the Mac.

## Task 2 accepted (macOS Apple Silicon)

Stay on `feature/v2.9-dependency-hygiene`. Host: macOS 26.6.2 arm64, Homebrew CPython 3.11.16. Packaged dir build used python-build-standalone 3.11.7. Electron stayed 42.9.0. Pyannote `torch==2.8.0` was not changed. `onnxruntime`, `tokenizers`, and `av` were not changed. PyObjC and `sounddevice` were not bumped.

### torch 2.13.0 + setuptools 84.0.0 — accepted 2026-08-28 (this Mac)

**Upstream:** [torch 2.13.0](https://pypi.org/project/torch/2.13.0/) requires `setuptools>=77.0.3` (no `<82` cap). [setuptools 84.0.0](https://setuptools.pypa.io/en/stable/history.html) is past PYSEC-2026-3447. GitHub advisory GHSA-rrmf-rvhw-rf47 lists CVE-2025-3000 patched in **2.13.0** (affected `<=2.12.1`).

**Pin:** `requirements-macos-build.txt` `torch==2.12.0` / `setuptools==81.0.0` → `torch==2.13.0` / `setuptools==84.0.0`. Torch stays in `MACOS_RUNTIME_REMOVABLE_PACKAGES` (`build/prepare-resources.js`). CI `pip-macos` no longer ignores CVE-2025-3000 or PYSEC-2026-3447.

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-torch213`, `pip install --only-binary=:all: -r requirements-macos-build.txt` → `torch==2.13.0`, `setuptools==84.0.0`. `pip check`: No broken requirements found.

**pip-audit:** `python -m pip_audit -r requirements-macos-build.txt` with no `--ignore-vuln` → **No known vulnerabilities found**.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. prepare-resources installed `torch==2.13.0` then **Removed torch (533 MB)** and **Removed setuptools (7 MB)**. `npm run verify:mac:packaged` passed (ad-hoc deep/strict, no `site-packages/torch` directory). Packaged `import torch` raises `ModuleNotFoundError` (leftover `torch-2.13.0.dist-info` / `setuptools-84.0.0.dist-info` metadata only — existing prune-directory behavior).

**Hardware smokes (same Mac session; packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX transcription: bundled python `-m transcription.mlx_whisper_transcriber --file tests/fixtures/speakrs-two-speaker-16k.wav --model base --language en --json` → exit 0, `device: metal`, `computeType: float16`, duration 14.22s, English two-speaker fixture text, cache `~/Library/Caches/avanevis`.
- Desktop capture: packaged `audiocapture-helper` via `SwiftAudioCapture`, CoreAudio tap, 8.51s, peak 0.693, `helperCaptureBackend=coreaudio_tap`.
- ScreenCaptureKit fallback: helper started with `--screencapturekit` (`preferCoreAudioTap: false`), requested shareable content, then fail-closed `PERMISSION_DENIED: Screen Recording permission not granted`. The same deny occurred when launched from Terminal.app. Cursor/Terminal/this agent do not hold Screen Recording TCC; the SCK **path** ran and failed closed. PCM capture via SCK was not possible in this session. That is a TCC limitation, not a Torch/setuptools resolver failure.

Held: Numba 0.65.1 / llvmlite 0.47.0 until the following same-session commit; Electron 42.9.0; Linux AI add-ons; PyObjC; sounddevice 0.4.6; `onnxruntime` 1.26.0; `tokenizers` 0.23.1.

### Numba 0.67.0 + llvmlite 0.49.0 — accepted 2026-08-28 (this Mac)

**Upstream:** [numba 0.67.0](https://pypi.org/project/numba/0.67.0/) requires `llvmlite>=0.49.0dev0,<0.50` and `numpy>=1.22,<2.6`. Packaged numpy stays 2.4.6. Do not accept Dependabot Numba alone against llvmlite 0.47.

**Pin:** `requirements-macos-build.txt` `numba==0.65.1` / `llvmlite==0.47.0` → `numba==0.67.0` / `llvmlite==0.49.0`. mlx remains `==0.31.2`.

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-numba067` with the torch 2.13 / setuptools 84 pins already in the file. `pip install --only-binary=:all:` → `numba==0.67.0`, `llvmlite==0.49.0`. Import ok. `pip check`: No broken requirements found. `pip_audit -r requirements-macos-build.txt` with no ignores: **No known vulnerabilities found**.

**Packaged dir build + smokes:** the `npm run build:mac:dir` / MLX / helper session above installed this Numba pair into `dist/mac-arm64/AvaNevis.app` (`numba==0.67.0`, `llvmlite==0.49.0` in bundled site-packages). Packaged MLX `base` transcription of the two-speaker fixture succeeded on Metal. ScreenCaptureKit `--screencapturekit` startup fail-closed on Screen Recording TCC as recorded in the torch section.

Held: Electron 42.9.0; Linux AI add-ons; PyObjC 10.0/12.1 mix; sounddevice 0.4.6; `onnxruntime` 1.26.0; `tokenizers` 0.23.1; mlx 0.31.2.

## After Mac Task 2

Stay on `feature/v2.9-dependency-hygiene`. Native `pip check`, torch 2.13.0 + setuptools 84.0.0, Numba 0.67.0 + llvmlite 0.49.0, packaged dir build, MLX smoke, and CoreAudio tap capture are recorded above. CI pip-audit ignores for CVE-2025-3000 / PYSEC-2026-3447 are removed.

Packaged PyObjC **12.2.2** and `sounddevice==0.5.6` were accepted later in this file.

## Task 3 macOS pin trim — rejected 2026-08-28 (this Mac)

Host: macOS 26.6.2 arm64, Homebrew CPython 3.11.16. Clean venvs under `/tmp/avanevis-v2.9-task3`. Resolver: `pip install --dry-run --ignore-installed --only-binary=:all:` plus a real trial-2 install. `pip check` text in every executed install: **No broken requirements found.**

No pins were deleted. `requirements-macos.txt` and `requirements-macos-build.txt` are unchanged. Windows/Linux pins were not touched. Electron stayed 42.9.0. PyObjC `Cocoa` / `Quartz` were not evaluated. `sounddevice` stayed `==0.4.6`. `onnxruntime`, `tokenizers`, and `av` are not in the macOS files and remain direct runtime deps on Windows/Linux.

A packaged macOS dir rebuild was **not** run: the plan requires that gate before *accepting* a deletion, and no deletion was accepted. Task 2’s `dist/mac-arm64/AvaNevis.app` remains the last packaged artifact.

### Method

Kept as first-party or documented holds: `sounddevice==0.4.6`, `numpy==2.4.6`, `soxr==1.1.0`, every PyObjC pin (including Cocoa/Quartz/CoreMedia), `lightning-whisper-mlx==0.0.10`, `filelock==3.32.3`, `tiktoken==0.3.3`, `huggingface-hub==1.16.1`, `mlx==0.31.2`, `numba==0.67.0`, `llvmlite==0.49.0`, `torch==2.13.0`, `setuptools==84.0.0`.

**Trial 1** omitted every other `requirements-macos-build.txt` pin. Unconstrained resolve vs the lock:

| Package | Lock | Unpinned resolve | Verdict |
|---|---|---|---|
| `annotated-doc` | 0.0.4 | 0.0.5 | **Reject** — version hold |
| `anyio` | 4.13.0 | 4.14.2 | **Reject** — version hold |
| `cffi` | 2.0.0 | 2.1.1 | **Reject** — version hold (sounddevice native) |
| `charset-normalizer` | 3.4.7 | 3.5.1 | **Reject** — version hold |
| `click` | 8.4.1 | **not installed** | **Reject** — graph change. `typer==0.27.2` no longer requires `click` |
| `colorama` | 0.4.6 | **not installed** | **Reject** — graph change. `typer==0.27.2` marks `colorama` Windows-only |
| `fsspec` | 2026.4.0 | 2026.7.0 | **Reject** — version hold |
| `hf-xet` | 1.5.0 | 1.6.0 | **Reject** — version hold |
| `idna` | 3.16 | 3.19 | **Reject** — version hold |
| `packaging` | 26.2 | 26.3 | **Reject** — version hold |
| `Pygments` | 2.20.0 | 2.21.0 | **Reject** — version hold |
| `regex` | 2026.7.10 | 2026.7.19 | **Reject** — version hold |
| `tqdm` | 4.67.3 | 4.70.0 | **Reject** — version hold |
| `typer` | 0.25.1 | 0.27.2 | **Reject** — version + drops `click`; `colorama` becomes Windows-only |

**Trial 2** restored those 14 pins and omitted only the 20 packages that still resolved to the lock version. Real venv `/tmp/avanevis-v2.9-task3/trim2-venv`: `pip check` passed. Freeze matched the fully pinned baseline for every requirements package (`setuptools==84.0.0` present; `scipy==1.17.1` still installed transitively). Hypothetical SBOM would drop those 20 names from the macOS build file while pip still installed them.

Those 20 are **not parent exact-pins**. They match today because they are the current latest that satisfies a range. Removing them would let a later resolve change the packaged artifact without a requirements diff, and the SBOM generator would stop listing real runtime pieces (`scipy` ~20 MB for `lightning-whisper-mlx.timing`, plus the torch resolver/prune set). **Reject** the trim; retain the lock.

| Package | Lock | Why retain even though trial 2 matched |
|---|---|---|
| `certifi` | 2026.7.22 | requests CA bundle; security-sensitive |
| `h11` | 0.16.0 | `httpcore` range |
| `httpcore` | 1.0.9 | `httpx` range |
| `httpx` | 0.28.1 | `huggingface-hub`: `httpx<1,>=0.23.0` |
| `Jinja2` | 3.1.6 | torch resolver then prune; a newer Jinja2 extra would not be pruned |
| `markdown-it-py` | 4.2.0 | `rich` range |
| `MarkupSafe` | 3.0.3 | Jinja2 / torch prune set |
| `mdurl` | 0.1.2 | `markdown-it-py` range |
| `more-itertools` | 11.1.0 | `lightning-whisper-mlx` unpinned dep |
| `mpmath` | 1.3.0 | `sympy==1.14.0` requires `mpmath<1.4` (range, not exact) |
| `networkx` | 3.6.1 | torch resolver then prune |
| `pycparser` | 3.0 | `cffi` range |
| `PyYAML` | 6.0.3 | `huggingface-hub` range |
| `requests` | 2.34.2 | `tiktoken` range |
| `rich` | 15.0.0 | `typer` range |
| `scipy` | 1.17.1 | MLX runtime `scipy.signal`; SBOM would hide it |
| `shellingham` | 1.5.4 | `typer` range |
| `sympy` | 1.14.0 | torch resolver then prune |
| `typing-extensions` | 4.16.0 | torch / `huggingface-hub` range |
| `urllib3` | 2.7.0 | `requests` range |

Held first-party / Task 2 pins (not trim candidates here): `huggingface-hub==1.16.1` vs runtime **1.29.0**; `mlx==0.31.2` vs runtime **0.32.2**; `filelock==3.32.3` vs runtime **3.32.4**; `tiktoken==0.3.3` (exact from `lightning-whisper-mlx`, kept like the Windows `tokenizers` pin). Extra `mlx-metal==0.31.2` is pulled by `mlx` and is not a requirements pin.

### `requirements-macos.txt` scipy floor

Trial: dropped `scipy>=1.17.0`. Clean venv still resolved **scipy 1.17.1** via `lightning-whisper-mlx`. `pip check` passed. `import scipy` succeeded (`1.17.1`). The floor is not constraining today.

**Rejected** anyway: the line documents that MLX needs scipy even though `backend/` does not import it. Removing it would not shrink anything and would hide that runtime requirement from the runtime file.

Unconstrained runtime already floated `sounddevice==0.5.6` and PyObjC **12.2.2**. Those were **not** accepted in the trim session; both were accepted later in this file after their own capture-gated clusters.

### SBOM

Current `legal/PYTHON-BUNDLED-PACKAGES.md` is unchanged (63 direct pins, generated 2026-08-28T17:07:40.260Z). A trial-2 file would drop 20 macOS direct names; scipy / Jinja2 / networkx / sympy / mpmath / MarkupSafe / more-itertools would disappear from the legal table while still being installed (or installed-then-pruned). That SBOM diff is evidence **against** accepting the trim.

## Task 3 macOS pin upgrades (keep the lock)

Stay on `feature/v2.9-dependency-hygiene`. Host: macOS 26.6.2 arm64, Homebrew CPython 3.11.16. Packaged dir build used python-build-standalone 3.11.7. Electron stayed 42.9.0. Windows/Linux pins unchanged except where a macOS-only bump makes the SBOM `platform-specific`. `filelock` stays **3.32.3**. `onnxruntime`, `tokenizers`, and `av` were not changed. PyObjC and `sounddevice` were not bumped.

### Cluster 1: huggingface-hub 1.29.0 + pulled transitives — accepted 2026-08-28 (this Mac)

**Upstream:** [huggingface-hub 1.29.0](https://github.com/huggingface/huggingface_hub/releases/tag/v1.29.0) (2026-08-27). Security/path hardening for `local_dir` filenames (CVE-2026-15717 follow-up in 1.26.0); Xet download rate-limit fix. 1.16.1 required `typer>=0.20.0` and `hf-xet>=1.4.3`. 1.29.0 **drops typer** and requires `click>=8.4.2,<9` plus `hf-xet>=1.5.2`. PyPI lists no vulnerabilities on 1.29.0. App usage is `hf_hub_download(..., local_dir=..., token=False)` in `mlx_whisper_transcriber.py` and `hf_model_downloader.py`. Distil `./mlx_models/...` filenames still pass `_validate_relative_filename`. `token=False` still omits `Authorization`. No application-code change.

**Pin (macOS build only):**

| Package | Before | After |
|---|---|---|
| `huggingface-hub` | 1.16.1 | **1.29.0** |
| `hf-xet` | 1.5.0 | **1.6.0** (hub 1.29 requires `>=1.5.2`) |
| `click` | 8.4.1 | **8.5.0** (hub 1.29 requires `>=8.4.2`; current resolve) |
| `fsspec` | 2026.4.0 | **2026.7.0** |
| `anyio` | 4.13.0 | **4.14.2** |
| `charset-normalizer` | 3.4.7 | **3.5.1** |
| `idna` | 3.16 | **3.19** |
| `packaging` | 26.2 | **26.3** |
| `tqdm` | 4.67.3 | **4.70.0** |

`filelock==3.32.3` unchanged (`huggingface-hub` requires `>=3.10.0`). `typer==0.25.1` and `mlx==0.31.2` unchanged in this commit. `httpx==0.28.1` / `httpcore==1.0.9` / `h11==0.16.0` already matched current resolve.

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-hfhub129`, `pip install --only-binary=:all: -r requirements-macos-build.txt` → versions in the table above. `pip check`: No broken requirements found.

**pip-audit:** `python -m pip_audit -r requirements-macos-build.txt` with no `--ignore-vuln` → **No known vulnerabilities found**.

**Tests:** trial venv `pytest tests/python/test_hf_model_downloader.py tests/python/test_transcriber_helpers.py -q` exit 0 (1 skipped).

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-28T17:41:00.992Z; 63 direct pins. `huggingface-hub`, `hf-xet`, `click`, `fsspec`, `anyio`, `idna`, `packaging`, and `tqdm` are now **platform-specific** vs Windows/Linux 1.16.1-era pins. `charset-normalizer` is macOS-only at **3.5.1**.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. prepare-resources installed `huggingface-hub==1.29.0` then **Removed torch (533 MB)** and **Removed setuptools (7 MB)**. `npm run verify:mac:packaged` passed. Bundled `python -m pip check`: No broken requirements found. Bundled inventory: `huggingface-hub==1.29.0`, `hf-xet==1.6.0`, `filelock==3.32.3`, `click==8.5.0`, `mlx==0.31.2`, `lightning-whisper-mlx==0.0.10`, `tiktoken==0.3.3`.

**Hardware smokes (same Mac session; packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX transcription: bundled python `-m transcription.mlx_whisper_transcriber --file tests/fixtures/speakrs-two-speaker-16k.wav --model base --language en --json` → exit 0, `device: metal`, `computeType: float16`, duration 14.22s, English two-speaker fixture text, cache `~/Library/Caches/avanevis`.
- Desktop capture: packaged `audiocapture-helper` via `SwiftAudioCapture`, CoreAudio tap, 15.04s, peak 0.7325, `helperCaptureBackend=coreaudio_tap`.
- ScreenCaptureKit fallback: helper `--screencapturekit` fail-closed `PERMISSION_DENIED: Screen Recording permission not granted` (same TCC limit as Task 2).

Held: Windows/Linux `huggingface-hub==1.16.1`; Electron 42.9.0; Linux AI add-ons; PyObjC; sounddevice 0.4.6; `onnxruntime` 1.26.0; `tokenizers` 0.23.1; mlx 0.31.2; typer 0.25.1. `click` stays on macOS because hub 1.29 requires it — cluster 2 must not drop it.

### Cluster 2: typer 0.27.2 — accepted 2026-08-28 (this Mac)

**Upstream:** [typer 0.27.2](https://pypi.org/project/typer/0.27.2/) (2026-08-28). 0.26.0 vendored Click and dropped the third-party `click` dependency. 0.27.2 requires `shellingham`, `rich`, `annotated-doc`, and `colorama` **only on Windows**. AvaNevis does not import `typer`, `click`, or `colorama` in application code. huggingface-hub 1.29.0 still requires `click>=8.4.2,<9`, so the macOS `click==8.5.0` pin **stays**. No application-code change.

**Pin (macOS build only):** `typer==0.25.1` → **`typer==0.27.2`**. Removed unused macOS `colorama==0.4.6` (not installed after the bump; Windows/Linux keep `colorama==0.4.6`). `click==8.5.0` retained. `annotated-doc==0.0.4` unchanged (cluster 4).

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-typer027`. `typer==0.27.2`, `click==8.5.0`, colorama **not installed**. `pip check`: No broken requirements found.

**pip-audit:** `python -m pip_audit -r requirements-macos-build.txt` with no ignores → **No known vulnerabilities found**.

**Tests:** same hf/transcriber helper files exit 0 (1 skipped).

**SBOM:** `npm run legal:sbom` → generated 2026-08-28T17:49:26.902Z; 63 direct pins. `typer` is **platform-specific (0.25.1 vs 0.27.2)**. `colorama` is now Windows/Linux only.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. Torch/setuptools pruned. `npm run verify:mac:packaged` passed. Bundled `pip check` passed. Bundled `typer==0.27.2`, `click==8.5.0`, colorama absent.

**Hardware smokes (packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX `base` two-speaker fixture: exit 0, `device: metal`, `computeType: float16`, duration 14.22s.
- CoreAudio tap: 15.07s, peak 0.7328, `helperCaptureBackend=coreaudio_tap`.
- ScreenCaptureKit `--screencapturekit` fail-closed on Screen Recording TCC.

Held: Windows/Linux `typer==0.25.1` / `click==8.4.1` / `colorama==0.4.6`; mlx 0.31.2; Electron 42.9.0; PyObjC; sounddevice 0.4.6.

### Cluster 3: mlx 0.32.2 — accepted 2026-08-28 (this Mac)

**Upstream:** [mlx 0.32.2](https://github.com/ml-explore/mlx/releases/tag/v0.32.2). Maintenance/bug-fix release over 0.31.2. Pulls `mlx-metal==0.32.2` (not a requirements pin). `lightning-whisper-mlx==0.0.10` requires unpinned `mlx` and exact `tiktoken==0.3.3`. No application-code change.

**Pin:** `requirements-macos-build.txt` `mlx==0.31.2` → **`mlx==0.32.2`**. `lightning-whisper-mlx==0.0.10` and `tiktoken==0.3.3` unchanged.

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-mlx032`. `mlx==0.32.2`, `mlx-metal==0.32.2`, `lightning-whisper-mlx==0.0.10`, `tiktoken==0.3.3`. `import mlx.core` → `Device(gpu, 0)`. `pip check`: No broken requirements found.

**pip-audit:** no ignores → **No known vulnerabilities found**.

**SBOM:** `npm run legal:sbom` → generated 2026-08-28T17:58:52.595Z; 63 direct pins. Direct pin `mlx` is **0.32.2**.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. Torch/setuptools pruned. `npm run verify:mac:packaged` passed. Bundled `pip check` passed. Bundled `mlx==0.32.2` / `mlx-metal==0.32.2` / `lightning-whisper-mlx==0.0.10` / `tiktoken==0.3.3`.

**Hardware smokes (packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX `base` two-speaker fixture: exit 0, `device: metal`, `computeType: float16`, duration 14.22s, same English fixture text as clusters 1–2.
- CoreAudio tap: 15.22s, peak 0.7328, `helperCaptureBackend=coreaudio_tap`.
- ScreenCaptureKit `--screencapturekit` fail-closed on Screen Recording TCC.

Held: Electron 42.9.0; PyObjC; sounddevice 0.4.6; Windows/Linux pins.

### Cluster 4: remaining macOS-only floats — accepted 2026-08-28 (this Mac)

**Upstream:** leftover Task 3 version-holds that clusters 1–3 did not pull. `cffi` 2.1.1 is the current binary wheel for `sounddevice` native glue (Linux already pins 2.1.1 for Pulse/SoundCard). `regex` 2026.7.19 is the current `tiktoken` native dep. `Pygments` 2.21.0 and `annotated-doc` 0.0.5 are current `rich`/`typer` deps. AvaNevis does not import these packages. `pycparser==3.0` already matched current resolve. No application-code change. `sounddevice` stays **0.4.6**; PyObjC is unchanged.

**Pin (macOS build only):**

| Package | Before | After |
|---|---|---|
| `cffi` | 2.0.0 | **2.1.1** (Linux already 2.1.1; Windows does not pin `cffi`) |
| `regex` | 2026.7.10 | **2026.7.19** (macOS-only pin) |
| `Pygments` | 2.20.0 | **2.21.0** (Windows/Linux stay 2.20.0) |
| `annotated-doc` | 0.0.4 | **0.0.5** (Windows/Linux stay 0.0.4) |

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-c4floats`, `pip install --only-binary=:all: -r requirements-macos-build.txt` → versions in the table above, `pycparser==3.0`, `sounddevice==0.4.6`, `filelock==3.32.3`. `pip check`: No broken requirements found.

**pip-audit:** `python -m pip_audit -r requirements-macos-build.txt` with no `--ignore-vuln` → **No known vulnerabilities found**.

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-28T18:05:48.860Z; 63 direct pins. `cffi` is now **2.1.1** on both macOS and Linux. `regex` is macOS-only at **2026.7.19**. `Pygments` and `annotated-doc` are **platform-specific**.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. prepare-resources installed `cffi==2.1.1`, `regex==2026.7.19`, `Pygments==2.21.0`, `annotated-doc==0.0.5`, then **Removed torch** and **Removed setuptools**. `npm run verify:mac:packaged` passed. Bundled `python -m pip check`: No broken requirements found. Bundled inventory: `cffi==2.1.1`, `regex==2026.7.19`, `Pygments==2.21.0`, `annotated-doc==0.0.5`, `sounddevice==0.4.6`, `mlx==0.32.2`.

**Hardware smokes (same Mac session; packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX transcription: bundled python `-m transcription.mlx_whisper_transcriber --file tests/fixtures/speakrs-two-speaker-16k.wav --model base --language en --json` → exit 0, `device: metal`, `computeType: float16`, duration 14.22s, same English two-speaker fixture text as clusters 1–3, cache `~/Library/Caches/avanevis`.
- Desktop capture: packaged `audiocapture-helper` via `SwiftAudioCapture`, CoreAudio tap, 14.98s, peak 0.7327, `helperCaptureBackend=coreaudio_tap`.
- ScreenCaptureKit fallback: helper `--screencapturekit` fail-closed `PERMISSION_DENIED: Screen Recording permission not granted` (same TCC limit as Task 2).

Held: Electron 42.9.0; PyObjC 10.0/12.1 mix; sounddevice 0.4.6; Windows/Linux `Pygments==2.20.0` / `annotated-doc==0.0.4`; `filelock==3.32.3`. All 14 Task 3 version-hold rows are now either upgraded (clusters 1–4) or graph-changed (macOS `colorama` removed; `click` kept for hub 1.29). The 20 matching range-locks stay pinned.

### Coordinated PyObjC 12.2.2 — accepted 2026-08-28 (this Mac)

**Upstream:** [PyObjC 12.2.2](https://pyobjc.readthedocs.io/en/latest/changelog.html) (2026-08-11). Current PyPI for all seven packages. 12.2.3 is mentioned in docs (AVFoundation retain-count metadata) but is **not** on PyPI. 12.2 updates framework bindings for the macOS 26.5 SDK; 12.2.2 is an Xcode 27 build fix. `pyobjc-framework-ScreenCaptureKit==12.2.2` requires `pyobjc-core`, `Cocoa`, and `CoreMedia` `>=12.2.2`. `pyobjc-framework-AVFoundation==12.2.2` requires those plus `CoreAudio` and **`Quartz`**. Application code imports `Foundation` (`NSObject`, `NSRunLoop`, `NSDate`), `ScreenCaptureKit`, `AVFoundation.AVAudioFormat`, `CoreAudio` (availability), `CoreMedia` sample-buffer helpers, and `objc`. No `import Quartz`. **Cocoa and Quartz were not removed:** Cocoa owns `Foundation`; Quartz is a declared AVFoundation dependency. No application-code change. CoreAudio aggregate-device key constants still type as `bytes` in 12.2.2; AvaNevis does not use them.

**Pin (macOS build only, coordinated):**

| Package | Before | After |
|---|---|---|
| `pyobjc-framework-ScreenCaptureKit` | 10.0 | **12.2.2** |
| `pyobjc-framework-CoreAudio` | 10.0 | **12.2.2** |
| `pyobjc-framework-AVFoundation` | 10.0 | **12.2.2** |
| `pyobjc-core` | 12.1 | **12.2.2** |
| `pyobjc-framework-Cocoa` | 12.1 | **12.2.2** |
| `pyobjc-framework-CoreMedia` | 12.1 | **12.2.2** |
| `pyobjc-framework-Quartz` | 12.1 | **12.2.2** |

`requirements-macos.txt` floors stay `>=10.0` (runtime already resolved 12.2.2). Windows/Linux files have no PyObjC pins.

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-pyobjc1222`, `pip install --only-binary=:all: -r requirements-macos-build.txt` → all seven at **12.2.2**. `pip check`: No broken requirements found. `ScreenCaptureAudioRecorder` constructed. PyObjC ScreenCaptureKit permission probe fail-closed (`pyobjc_sck_permission_granted False`, SCStreamError -3801 TCC). `StreamDelegate.alloc().init()` succeeded inside `_create_stream_delegate`.

**pip-audit:** `python -m pip_audit -r requirements-macos-build.txt` with no `--ignore-vuln` → **No known vulnerabilities found**.

**Tests:** repo `.venv` `pytest tests/python/test_screencapture_helper.py tests/python/test_macos_capture_sink_parity.py tests/python/test_macos_capture_helpers.py -q` → **57 passed**.

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-28T20:54:41.677Z; 63 direct pins. All seven `pyobjc-*` names are **12.2.2**.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. prepare-resources installed PyObjC 12.2.2 then **Removed torch** and **Removed setuptools**. `npm run verify:mac:packaged` passed. Bundled `python -m pip check`: No broken requirements found. Bundled inventory: all seven `pyobjc-*==12.2.2`, `filelock==3.32.3`, `sounddevice==0.4.6`, `mlx==0.32.2`.

**Hardware smokes (same Mac session; packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX transcription: bundled python `-m transcription.mlx_whisper_transcriber --file tests/fixtures/speakrs-two-speaker-16k.wav --model base --language en --json` → exit 0, `device: metal`, `computeType: float16`, duration 14.22s, same English two-speaker fixture text as clusters 1–4, cache `~/Library/Caches/avanevis`.
- Desktop capture: packaged `audiocapture-helper` via `SwiftAudioCapture`, CoreAudio tap, 15.15s, peak 0.7328, `helperCaptureBackend=coreaudio_tap`.
- ScreenCaptureKit fallback: helper `--screencapturekit` fail-closed `PERMISSION_DENIED: Screen Recording permission not granted` (same TCC limit as Task 2 / clusters 1–4). PyObjC `ScreenCaptureAudioRecorder` remains importable in the bundle.

Held: Electron 42.9.0; sounddevice 0.4.6; Windows/Linux pins; `filelock==3.32.3`; `onnxruntime` 1.26.0; `tokenizers` 0.23.1; `av` 18.1.0. `sounddevice` was **not** attempted in this session.

### sounddevice 0.5.6 — accepted 2026-08-28 (this Mac)

**Upstream:** [sounddevice 0.5.6](https://python-sounddevice.readthedocs.io/en/latest/version-history.html) (2026-08-17). Current PyPI. 0.4.6 → 0.5.6 is Windows-heavy (WASAPI `auto_convert`, optional ASIO via `SD_ENABLE_ASIO`, Windows ARM64 wheels/arch detection). macOS still ships PortAudio **19.7.0** in the universal2 wheel. DeviceList `#548` only changed **repr** to use each dict’s `index`; unfiltered `query_devices()` still matches `enumerate`. AvaNevis uses `query_devices`, `query_hostapis`, and `InputStream(device=, channels=, samplerate=, blocksize=, callback=)` for the microphone path. Desktop capture is the Swift helper, not sounddevice. No application-code change. `cffi==2.1.1` unchanged. Runtime floor stays `sounddevice>=0.4.6`.

**Pin (macOS build only):** `sounddevice==0.4.6` → **`sounddevice==0.5.6`**. Windows/Linux files have no `sounddevice` pin.

**Resolver / `pip check`:** clean venv `/tmp/avanevis-v2.9-macos-build-sd056`, `pip install --only-binary=:all: -r requirements-macos-build.txt` → `sounddevice==0.5.6`, `cffi==2.1.1`, `filelock==3.32.3`, all seven `pyobjc-*==12.2.2`, `mlx==0.32.2`. `pip check`: No broken requirements found. Host trial: PortAudio V19.7.0, 3 devices, `enumerate` vs `index` mismatches `[]`, default input MacBook Pro Microphone index 1, `InputStream` 1.5 s / 17 callbacks / peak 0.003052.

**pip-audit:** `python -m pip_audit -r requirements-macos-build.txt` with no `--ignore-vuln` → **No known vulnerabilities found**.

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-28T22:02:58.900Z; 63 direct pins. Direct pin `sounddevice` is **0.5.6**.

**Packaged macOS dir build:** `npm run build:mac:dir` exit 0. prepare-resources installed `sounddevice==0.5.6` then **Removed torch** and **Removed setuptools**. `npm run verify:mac:packaged` passed. Bundled `python -m pip check`: No broken requirements found. Bundled inventory: `sounddevice==0.5.6`, `cffi==2.1.1`, all seven `pyobjc-*==12.2.2`, `filelock==3.32.3`, `mlx==0.32.2`. Bundled PortAudio V19.7.0; `enumerate` vs `index` mismatches `[]`.

**Hardware smokes (same Mac session; packaged `dist/mac-arm64/AvaNevis.app`):**
- MLX transcription: bundled python `-m transcription.mlx_whisper_transcriber --file tests/fixtures/speakrs-two-speaker-16k.wav --model base --language en --json` → exit 0, `device: metal`, `computeType: float16`, duration 14.22s, same English two-speaker fixture text as clusters 1–4 / PyObjC, cache `~/Library/Caches/avanevis`.
- Desktop capture: packaged `audiocapture-helper` via `SwiftAudioCapture`, CoreAudio tap, 15.05s, peak **0.7328**, `helperCaptureBackend=coreaudio_tap`.
- Packaged `sounddevice.InputStream` on default mic (index 1): 1.5 s, 17 callbacks, peak 0.003466.
- ScreenCaptureKit fallback: helper `--screencapturekit` fail-closed `PERMISSION_DENIED: Screen Recording permission not granted` (same TCC limit as Task 2 / clusters 1–4 / PyObjC). That is a TCC limitation, not a resolver pass.

Held: Electron 42.9.0; Windows/Linux pins; `filelock==3.32.3`; `onnxruntime` 1.26.0; `tokenizers` 0.23.1; `av` 18.1.0; all seven PyObjC pins at 12.2.2. Windows/Linux Task 3 trim remains on those hosts.

## Blockers and non-goals

- **Do not** merge or land Dependabot PRs from this evidence. Use this matrix to accept or reject each candidate in its own commit.
- **Do not** upgrade Electron.
- **Do not** start Linux AI add-on phases 6–9.
- **Do not** add Apple signing or notarization.
- Host CUDA 13 toolkits must not be mistaken for packaged CUDA 12 support.
