# Linux Parakeet compatibility qualification — v2.10

**Measurements:** 2026-09-21; assessment and managed CUDA recheck: 2026-09-22
**Decision scope:** Linux x86_64 only; CPU and managed CUDA 12 are independent rows. This is qualification evidence, not an implementation or support claim.

Two passes ran on the same host and app revision. Pass 1 recorded a Whisper Small CPU baseline and rejected the default NeMo 2.5.3 resolver (CUDA 13). Pass 2 re-checked live CUDA admission, identified hash-pinned CPU and CUDA 12 closures, and measured one short fixture. Neither row should proceed to implementation.

## Environment and method

| Item | Observed value |
| --- | --- |
| App revision | `06e036577c18ce18b1efe777df5318406f0911b0` (`docs: record shipped v2.10 Slice A and UX work`) |
| Host class | CachyOS x86_64; AMD Ryzen 5 7600 (6 cores / 12 threads); NVIDIA GeForce RTX 4070 (AD104); 30 GiB RAM |
| OS / kernel | CachyOS rolling (`ID=cachyos`), Linux `7.2.6-1-cachyos` |
| NVIDIA driver | Installed and loaded open-kernel-module / userspace package `615.71.09`; host CUDA UMD `13.4`. Pass 1: live `nvidia-smi` communication failed. Pass 2: `nvidia-smi` worked and the project probe returned `ready` |
| App runtime | Electron `44.1.0`; Node `24.21.0`; npm `11.19.0` |
| Python runtime | CPython `3.11.16` |
| Existing Whisper runtime | `faster-whisper 1.2.1`, CTranslate2 `4.8.1` |
| Baseline model | `Systran/faster-whisper-small`, cached revision `536b0662742c02347bc0e980a01041f333bce120`; `model.bin` SHA-256 `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671` |

All inference was local and offline after explicit setup. Scratch caches, copied fixtures, disposable virtualenvs, raw output, and generated transcripts stayed outside the repository and were not retained as evidence artifacts. This document intentionally contains no user-data or machine-local paths.

## Candidate identities

The investigated model family is NVIDIA's English-only Parakeet TDT 0.6B v2. The official artifact remains the NeMo `.nemo` file. The executable Linux closures that actually ran used a community ONNX conversion of that model.

### Official NVIDIA model (not executed)

| Component | Exact identity | Evidence |
| --- | --- | --- |
| Model | `nvidia/parakeet-tdt-0.6b-v2@ae9ad07059c7c739ffaf932226a8fe64ae2620b0` | Hugging Face model metadata; `library_name=nemo`; pipeline `automatic-speech-recognition` |
| Model artifact | `parakeet-tdt-0.6b-v2.nemo`, 2,472,222,720 bytes, SHA-256 `d99e39955c9d3d0350d8fb7c75e40c64a2b2eaeb003883d7c941fd2e8747b28c` | Published LFS SHA-256; **not downloaded** |
| Model terms | CC-BY-4.0 | Model card |
| NeMo wheel | `nemo_toolkit-2.5.3-py3-none-any.whl`, 5,924,546 bytes, SHA-256 `17fb705e002cb38c753c0d0804d66b8cec4d0d86f878ba8a41049bcd9c7ae7d6` | PyPI; Apache-2.0 |

### Runtime closures resolved (pip `--dry-run --ignore-installed`)

| Closure | Resolver result | CUDA major | Packaging notes | Inference |
| --- | --- | --- | --- | --- |
| `nemo_toolkit[asr]==2.5.3` default PyPI | `torch 2.14.0`, `cuda-toolkit 13.0.3.0`, `nvidia-cudnn-cu13 9.24.0.43`, `nvidia-cublas 13.1.1.3` | **13** | Violates managed CUDA 12 / fail-closed policy | Not installed |
| `nemo_toolkit[asr]==2.5.3` + `torch==2.8.0+cpu` | 185 packages; `torch==2.8.0+cpu` SHA-256 `cb06175284673a581dd91fb1965662ae4ecaba6e5c357aa0ea7bb8b84b6b7eeb`; no `nvidia-*-cu12/cu13` | none | Seven sdists (`ctc_segmentation`, `antlr4-python3-runtime`, `sox`, `texterrors`, `kaldi-python-io`, `docopt`, `wget`) plus `bitsandbytes==0.46.0`, Lightning, datasets, wandb | Not installed |
| `nemo_toolkit[asr]==2.5.3` + `torch==2.8.0+cu126` | 200 packages; 14 `nvidia-*-cu12` wheels (cuBLAS `12.6.4.1`, cuDNN `9.10.2.21`); no cu13 | **12.6** | Same seven sdists; separate from the app catalog's cuBLAS `12.9.2.10` / cuDNN `9.22.0.52` | Not installed |
| `onnx-asr[cpu]==0.12.0` | 6 wheels; no NVIDIA CUDA packages | none | All manylinux wheels; MIT runtime | **Ran** on the short fixture |
| `onnx-asr==0.12.0` + `onnxruntime-gpu[cuda,cudnn]==1.23.2` | 17 wheels; CUDA 12 only | **12** | cuBLAS `12.9.2.10` SHA-256 matches the app catalog; cuDNN is `9.26.0.51`, **not** the app's `9.22.0.52`. Must be a separate managed tree | **Ran** on the short fixture |
| `onnx-asr[gpu]==0.12.0` (unpinned ORT) | `onnxruntime-gpu==1.30.0`; extras declare `nvidia-cuda-*-~=13.0` / `nvidia-cudnn-cu13` | **13** | Rejected for this app | Not installed |

`onnxruntime-gpu==1.27.1` is not published on PyPI. Speakrs' CUDA 12 ORT 1.27.1 identity is the GitHub archive, not this pip extra.

### Executable ONNX candidate (community conversion)

Source: `istupakov/parakeet-tdt-0.6b-v2-onnx@0bbb45a3365852604aef28b538a8f066f4ccaa85`. License CC-BY-4.0; `base_model` is the NVIDIA checkpoint above. Runtime `onnx-asr==0.12.0` is MIT. This is not NVIDIA's published `.nemo` inference path.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `config.json` | 97 | `666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466` |
| `vocab.txt` | 9,384 | `ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d` |
| `nemo128.onnx` | 139,764 | `a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f` |
| `decoder_joint-model.onnx` | 35,792,059 | `cbb52a07bd70ab5b67f8439d4b3cd8704b18467b4430bcacb5adabe154b8d191` |
| `encoder-model.onnx` | 41,770,866 | `3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3` |
| `encoder-model.onnx.data` | 2,435,420,160 | `4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41` |
| **fp32 model total** | **2,512,624,330** | hash-verified after download |

CPU runtime pins (`onnx-asr[cpu]==0.12.0`):

| Package | SHA-256 | Wheel |
| --- | --- | --- |
| `onnx-asr==0.12.0` | `5e7ceca454609819ea7833f61e2302e0c8f6ece4f8a78b66c5daba53cb51de4a` | `onnx_asr-0.12.0-py3-none-any.whl` |
| `onnxruntime==1.30.0` | `fd54b314ea385bcecac69ab431f020ba503e3878dad4ebb645fec5a24b041242` | `onnxruntime-1.30.0-cp311-cp311-manylinux_2_28_x86_64.whl` (23,561,046 bytes) |
| `numpy==2.4.6` | `89cd468399cfd2504718f0ba50e410dca55a170b61a02ad92bb18c8a65186e93` | `numpy-2.4.6-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl` |
| `protobuf==7.36.2` | `89f23aa53c24553a2416fd4fd1ec06f74fa42b14b546d8883128813f775bbfd2` | `protobuf-7.36.2-cp310-abi3-manylinux2014_x86_64.whl` |
| `flatbuffers==25.12.19` | `7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4` | `flatbuffers-25.12.19-py2.py3-none-any.whl` |
| `packaging==26.3` | `d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c` | `packaging-26.3-py3-none-any.whl` |

CUDA 12 runtime pins (`onnxruntime-gpu[cuda,cudnn]==1.23.2`), in addition to `onnx-asr` / `numpy` / `protobuf` / `flatbuffers` / `packaging` above:

| Package | SHA-256 |
| --- | --- |
| `onnxruntime-gpu==1.23.2` | `d76d1ac7a479ecc3ac54482eea4ba3b10d68e888a0f8b5f420f0bdf82c5eec59` (300,525,715 bytes) |
| `nvidia-cublas-cu12==12.9.2.10` | `e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702` (matches app catalog) |
| `nvidia-cudnn-cu12==9.26.0.51` | `ce8603d4ea88d134be5a92c5e0833d513bea1ce0ee4bbc5d649fcb8718d51cbf` (does **not** match app catalog `9.22.0.52`) |
| `nvidia-cuda-runtime-cu12==12.9.79` | `25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3` |
| `nvidia-cuda-nvrtc-cu12==12.9.86` | `210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4` |
| `nvidia-cufft-cu12==11.4.1.4` | `c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28` |
| `nvidia-curand-cu12==10.3.10.19` | `49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e` |
| `nvidia-nvjitlink-cu12==12.9.86` | `e3f1171dbdc83c5932a45f0f4c99180a70de9bd2718c1ab77d14104f6d7147f9` |
| `coloredlogs==15.0.1` | `612ee75c546f53e92e70049c9dbfcc18c935a2b9a53b66085ce9ef6a6e5c0934` |
| `humanfriendly==10.0` | `1697e1a8a8f550fd43c2865cd84542fc175a61dcb779b6fee18cf6b6ccba1477` |
| `sympy==1.14.0` | `e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5` |
| `mpmath==1.3.0` | `a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c` |

## Managed CUDA 12 admission

The pre-existing managed CUDA 12 artifact tree was present in both passes. Checked wheel and library SHA-256 values matched the code-owned catalog, including the two wheels and `libcublas.so.12`, `libcublasLt.so.12`, and `libcudnn.so.9`. Integrity is not admission.

**Pass 1:** `nvidia-smi` could not talk to the driver. `transcription.cuda_probe` returned fail-closed `probeError`. CTranslate2 reported zero CUDA devices. No CUDA-to-CPU substitution was attempted.

**Pass 2:** The same probe path, using managed library directories, `--device-check nvidia-smi`, and `--validate-ctranslate2-cuda`, returned `statusCode=ready`, `deviceAvailable=true`, `runtimeLoadable=true`, `matchedProfile=cuda12`, empty `missingLibraries`, empty `unsupportedDetectedProfiles`. The host still matches the accepted CachyOS / RTX 4070 profile. `resolveLinuxCudaDriverLibraryDirs` rejected `/usr/lib64` as a symbolic link and contributed no driver directories; the probe still admitted. A later Parakeet CUDA child loaded the driver API from `/usr/lib/libcuda.so.615.71.09` plus venv CUDA 12 runtime libraries. No `libcublas.so.13` / `libcudart.so.13` appeared in that child's `/proc/<pid>/maps`.

The host CUDA toolkit remains 13.4. Children must keep using an isolated CUDA 12 loader path. Ambient `find_library("cublas")` still reports `libcublas.so.13` via ldconfig; that is not evidence of a loaded CUDA 13 runtime.

## Fixtures and baselines

| Fixture | Source and coverage | Duration | SHA-256 |
| --- | --- | ---: | --- |
| `speakrs-two-speaker-16k.wav` | Repository fixture generated from original synthetic dialogue using bundled Windows voices; mono 16 kHz PCM. Short English, two-speaker coverage. Not a validated overlapping-speaker or meeting-length corpus. | 14.2245 s | `1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998` |

No approved local fixture was available for a long meeting, silence/noise, accent, or true overlapping speech. A repeated synthetic clip is not a representative long meeting.

Whisper Small ran in a fresh Python process per run, with a complete copied cache and explicit offline flags. “Cold start” means fresh-process cached-model end-to-end time. Pass 1 CPU RSS is a 25 ms sampled process-tree sum. Pass 2 CUDA Whisper RSS is 25 ms sampled `VmRSS` of the CLI process. Parakeet RSS is Linux `ru_maxrss` of the disposable interpreter (no child workers observed).

| Baseline row | Cold wall time | Repeated wall time | Audio RTF | Peak RSS | Output observation |
| --- | ---: | ---: | ---: | ---: | --- |
| Whisper Small, Linux CPU, `int8` | 1.987 s | 1.931 s median of 1.931 s, 1.863 s, and 2.018 s | 0.140 cold; 0.136 median repeat | 623,240 KiB (sampled) | Exit 0; non-empty English; 1 segment with complete ordered start/end timestamps |
| Whisper Small, Linux managed CUDA 12, `float16` | 1.509 s | 0.981 s median of 0.981 s, 1.016 s, and 0.977 s | 0.106 cold; 0.069 median repeat | 946,156 KiB (sampled) | Exit 0; `device=cuda`, `computeType=float16`; non-empty English; 1 segment with timestamps |

Pass 1 could not run a CUDA Whisper baseline because admission had failed. Pass 2 ran it only after `ready`. Renderer/IPC/queue overhead was not measured. No guided baseline was run.

## Parakeet measurements (same 14.2245 s fixture)

Both Parakeet rows used `onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", local_dir).with_timestamps()`, offline after hash-verified download, one fresh process per run, `LD_LIBRARY_PATH` cleared of ambient CUDA for CPU and replaced with the disposable CUDA 12 venv `nvidia/*/lib` directories for GPU.

| Candidate row | Cold wall | Repeat median | Decode-only median | Audio RTF (total / decode) | Peak RSS | Output observation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| ONNX Parakeet, Linux CPU, ORT 1.30.0 `CPUExecutionProvider` | 2.289 s | 2.202 s (2.202, 2.230, 2.201) | 0.891 s | 0.155 / 0.063 | 2,648,176 KiB | Non-empty English (278 chars); 110 token-start timestamps from 0.16 s to 13.84 s; `TimestampedResult` |
| ONNX Parakeet, Linux CUDA 12, ORT 1.23.2 `CUDAExecutionProvider` | 1.180 s | 1.012 s (1.012, 1.008, 1.033) | 0.245 s | 0.071 / 0.017 | 1,117,556 KiB | Same text length and 110 timestamps; ORT memcpy warning confirms CUDA EP; process maps showed `libcublas.so.12` / `libcudart.so.12` / `libcudnn.so.9` from the pinned venv plus driver `libcuda.so.615.71.09` |

Token timestamps are a list of floats (token start times), not Whisper-style segment `{start, end}` intervals. Isolated Parakeet VRAM was not measured: `nvidia-smi memory.used` stayed in the 1.8–1.9 GiB host-wide range already occupied by the desktop session.

onnx-asr documents a 20–30 s maximum without VAD. This fixture is 14.2 s, so long-form meeting behavior was not exercised.

## Separate qualification decisions

| Runtime/device row | What ran | Requested metrics status | Decision |
| --- | --- | --- | --- |
| Linux x86_64 CPU | Default NeMo 2.5.3 resolver still **rejected** (CUDA 13). Pinning `torch==2.8.0+cpu` removes CUDA packages but leaves a 185-package tree with source builds; not a desktop closure. `onnx-asr[cpu]==0.12.0` is a 6-wheel CUDA-free closure; the community ONNX model ran on the short fixture. | Short-clip time/RAM/RTF/timestamps measured. Long meeting, silence/noise, accent, overlap, guided, cancel, timeout, malformed-output: **not measured**. | **Needs more evidence; current short-clip result misses the feature goal.** Slower than Whisper Small CPU (2.202 s vs 1.931 s) and ~4.2× RAM (2,648,176 vs 623,240 KiB). Do not implement. |
| Linux x86_64 managed CUDA 12 | Live admission is `ready`. Unpinned ORT GPU 1.30 is CUDA 13 and remains rejected. Pinned ORT GPU 1.23.2 + CUDA 12 extras ran in an isolated venv. NeMo + `torch==2.8.0+cu126` is a hash-pinnable CUDA 12.6 alternative but was not installed (200 packages, sdists, different cuBLAS/cuDNN than the app catalog). | Short-clip Parakeet vs Whisper Small CUDA measured. Isolated VRAM, long-form, guided, cancel, timeout: **not measured**. | **Needs more evidence; current short-clip result is not a speed or RAM win.** Repeat 1.012 s vs Whisper CUDA 0.981 s; RAM 1,117,556 vs 946,156 KiB. Sharing the Whisper managed cuDNN `9.22.0.52` tree is unqualified; preserve the isolated tested closure. Do not implement. |

## Failure behavior and limitations

- Cancellation, timeout, malformed-output handling, and meeting-length completeness were not exercised. No absence of errors is claimed.
- The official `.nemo` artifact was still not downloaded. Executable evidence is the community ONNX conversion only.
- onnx-asr long-form requires a separate VAD path (`silero` or similar). That closure, its hashes, and its effect on timestamps were not measured.
- The existing project benchmark harness is for finalization and MLX characterization. Disposable measurement scripts stayed outside the repository. No production harness, packaging, or engine-selector behavior was changed.
- This qualification is not packaged-app acceptance. It does not authorize an engine selector, automatic selection/fallback, a Whisper-default change, or any cloud path.

## Conclusion and next step

Neither Linux row should proceed to implementation. CUDA 13 closures remain rejected. CUDA-free CPU and isolated CUDA 12 candidates executed, but the only measured audio is a 14.2 s synthetic clip. CPU results are unfavorable; the GPU repeat medians differ by only about 3%, while the first recorded GPU run favored Parakeet. Three short repeats establish no meaningful GPU winner. RAM measurements used different methods, and isolated VRAM and reference-based quality were not measured. This supports further bounded screening, not a general rejection or acceptance of Parakeet.

**Active next step:** [CachyOS-only GPU screening](../superpowers/plans/2026-09-22-cachyos-parakeet-qualification.md). Freeze the current candidate and compare complete meeting processing with Whisper Small using a common measurement harness. CPU repeats and Windows/macOS/Omarchy work are deferred. The full coverage listed below remains necessary for eventual qualification, but is not the next task’s scope.

1. **CPU:** keep `onnx-asr[cpu]==0.12.0` as the only packaging-sized CUDA-free candidate. Do not treat NeMo 2.5.3 + CPU torch as installable until the sdist/`bitsandbytes` tree is replaced by a fully pinned wheel set. Re-run only after long-form audio exists.
2. **Managed CUDA 12:** keep the ORT 1.23.2 + CUDA 12 extra pins as the current GPU candidate, in a **separate** managed tree from Whisper (cuDNN 9.26 vs 9.22). Do not use ORT GPU 1.30. Re-run only with isolated VRAM sampling and long-form audio. NeMo `torch==2.8.0+cu126` remains a larger official-API backup, not a measured candidate.
3. Before reconsidering either row, provide safe fixed fixtures for clean short English, meeting-like English, silence/noise, accented speech, real overlap, and a long meeting (or an honestly labeled reproducible proxy). Include an engine-neutral harness for process-tree memory, device telemetry, output schema, cancellation, and timeout without retaining transcript content. Product review is required if long-form speed improves while RAM stays higher than Whisper.

### Reproduction prerequisites

- CachyOS x86_64; Python 3.11; the repo's pinned Python environment; `ffmpeg`; and a complete local Whisper Small cache for the baseline.
- Reject `nemo_toolkit[asr]==2.5.3` if a dry run selects CUDA 13. A CPU torch pin (`torch==2.8.0+cpu`) is CUDA-free in the resolver output but is not a complete packaged closure.
- For the measured CPU candidate, install only the six `onnx-asr[cpu]==0.12.0` wheels above in a disposable venv; hash-verify the six ONNX model files; run offline with ambient `LD_LIBRARY_PATH` unset.
- For CUDA, require project `transcription.cuda_probe` `ready` first. Install the ORT 1.23.2 CUDA 12 extra pins in a disposable venv; set `LD_LIBRARY_PATH` to that venv's `nvidia/*/lib` directories only; confirm `/proc/<pid>/maps` contains `libcublas.so.12` and not `libcublas.so.13`. Do not point a child process at host CUDA 13 toolkit directories. Do not substitute Whisper's managed cuDNN `9.22.0.52` tree for the tested candidate closure without separate qualification. The pin difference alone is not evidence of ABI incompatibility.
- Run candidate and Whisper in fresh processes on identical immutable fixture copies, force offline mode after explicit setup, and retain only sanitized aggregates and hashes.

## 2026-09-22 assessment and live recheck

At app revision `42ae13f9d7579d840328bd6265ad67996a31033b`, the existing
RTX 4070 / driver 615.71.09 was visible to `nvidia-smi`. Full managed-library
integrity verification returned `ok=true`; the project Python CUDA probe with
validated managed loader directories, `--device-check nvidia-smi`, and
`--validate-ctranslate2-cuda` exited 0 with `statusCode=ready`,
`deviceAvailable=true`, `runtimeLoadable=true`, `matchedProfile=cuda12`, and
empty missing-library/unsupported-profile lists. The driver-directory helper
rejected `/usr/lib64` as a symlink; the probe succeeded with no extra driver
directories. This recheck did not run candidate inference or packaged acceptance,
and does not establish the cause of the first pass's driver failure.

The focused Linux CUDA/runtime and transcription-admission JS suites passed
41 tests. These tests verify software behavior, not Parakeet performance.

Two interpretation corrections guide the next experiment:

- Different cuDNN 9.x pins justify preserving separately qualified environments;
  they do not alone prove incompatibility. [ORT's compatibility documentation](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements)
  distinguishes CUDA/cuDNN major requirements and confirms default GPU packages
  moved to CUDA 13 from ORT 1.27. No shared-tree change is proposed.
- [onnx-asr's long-form guidance](https://github.com/istupakov/onnx-asr#quick-start)
  requires VAD for audio beyond typical 20–30 second model limits. The existing
  short-clip trial did not exercise that meeting path. Its VAD artifacts,
  chunk completeness, timestamps, quality, and total cost must be measured.
