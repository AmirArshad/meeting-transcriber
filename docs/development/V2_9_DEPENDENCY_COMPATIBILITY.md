# AvaNevis v2.9.0 dependency compatibility matrix

Decision record for `feature/v2.9-dependency-hygiene` Task 1. Later version changes on this lane must cite this file; do not copy a freeze or lockfile from one platform onto another.

**Recorded:** 2026-08-28  
**Python target:** 3.11 (`cp311`)  
**Electron baseline:** 42.9.0
**Electron 44 lane (2026-08-31):** npm `latest` is **44.1.0** (dist-tag `44-x-y` also 44.1.0; 44.0.0 published 2026-08-25, 44.1.0 published 2026-08-31). Electron 45 is `alpha` only (`45.0.0-alpha.2`) and is out of scope. electron-builder remains **26.15.3** (npm `latest`; not combined with this lane).
**Privacy:** no cloud transcription, telemetry, or extra network use beyond explicit model/update checks and these resolver downloads.

## Linux AI add-ons — Task 1 host and candidate investigation (2026-09-02)

This is **host/candidate investigation only** for `feature/v2.9-linux-ai-addons`.
It is **not** packaged RTX 4070 preflight. CUDA Whisper later passed Task 3
packaged RTX 4070 acceptance (2026-09-02). Task 4 recorded Linux Speakrs CLI
and pack-spec pins (2026-09-02). Task 5 added `linux-x64` Speakrs catalog
entries and CUDA-gated setup/guided admission (2026-09-02) **without** packaged
RTX 4070 Speakrs acceptance. Pyannote is out of Linux product scope. Linux
Qwen summaries are a separate, reactivated Task 6 lane and remain unavailable
until their own gates pass. A component stays unavailable until its later
implementation (Task 2), packaged, and hardware gates (Task 3+) have passed.
No entry below permits a CPU fallback or ambient system-CUDA library discovery;
Linux status may advertise CUDA as ready only after the explicit gates below pass.

**Managed install location:** `{Electron userData}/ai-addons/cuda/python`
(`getManagedLinuxCudaRuntimeTarget`). User-facing only on the accepted
CachyOS x86_64 + RTX 4070 host after Task 3. Driver libraries, if retained, come only
from a code-owned allowlist; inherited `LD_LIBRARY_PATH` is not trusted.

### CachyOS host baseline

| Field | Observed value |
|---|---|
| OS / kernel | CachyOS rolling, `Linux 7.2.2-1-cachyos`, x86_64 |
| desktop / audio | Hyprland on Wayland; PipeWire 1.6.8 |
| GPU | NVIDIA GeForce RTX 4070, compute capability 8.9, 12,282 MiB VRAM |
| driver | NVIDIA open kernel module / userspace 610.57.04; CUDA UMD 13.3 |
| GPU baseline | 10,103 MiB free at 2026-09-02 10:30 BST; normal desktop processes were using the remainder |
| packaged target Python | CPython 3.11.9 (`build/prepare-resources.js`); the host development interpreter is not an acceptance interpreter |
| Electron | 44.1.0 |
| secret store probe | Electron selected `gnome_libsecret` under Hyprland, but `safeStorage.isEncryptionAvailable()` returned `false`; no encrypt/decrypt round trip was possible |

Exact host commands and results (2026-09-02, this CachyOS machine):

```text
nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader
NVIDIA GeForce RTX 4070, 610.57.04, 8.9
```

The development sandbox does not expose `/dev/nvidia*`; host-side `nvidia-smi`
does.  GPU smoke evidence must therefore run on the host/packaged application, not
inside the sandboxed test shell.

### Candidate investigation

All files below were downloaded from the stated official publisher to a disposable
directory and locally hashed.  Sizes are exact bytes, not rounded download UI
values.  Direct URLs are the official PyPI / GitHub release objects, not
search-index metadata.

| Component | Official candidate, license, requirements | Linux x86_64 artifact evidence | Decision |
|---|---|---|---|
| CUDA Whisper / CTranslate2 | [CTranslate2 4.8.1](https://pypi.org/project/ctranslate2/4.8.1/) ([MIT](https://github.com/OpenNMT/CTranslate2/blob/v4.8.1/LICENSE.txt)). Requires packaged CPython 3.11 (`cp311`), manylinux_2_27_x86_64. Direct wheel: `https://files.pythonhosted.org/packages/30/84/f610e90bb419707632b9b668476b9fd4cdb090c9b53c119ce017699b58ca/ctranslate2-4.8.1-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`. Already the packaged Linux pin; **not** reinstalled into userData. | `ctranslate2-4.8.1-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`, 39,351,971 bytes, SHA-256 `c0a584c17f21779eb9035bcbc1ec280998f90b36725b70a5ff911f33e343199a`. | **Accepted (Task 3, 2026-09-02)** on packaged CachyOS x86_64 + NVIDIA RTX 4070. Offered as best-effort opt-in CUDA on other NVIDIA Linux x86_64; default remains CPU until install. |
| NVIDIA cuBLAS CUDA 12 | [nvidia-cublas-cu12 12.9.2.10](https://pypi.org/project/nvidia-cublas-cu12/12.9.2.10/) (`LicenseRef-NVIDIA-Proprietary`; [NVIDIA CUDA EULA](https://docs.nvidia.com/cuda/eula/index.html)). Requires Python ≥3, manylinux_2_27_x86_64, NVIDIA driver able to load CUDA 12 user-mode (host 610.57 / UMD 13.3 is forward-compatible; it does **not** authorize a CUDA 13 app runtime). Direct wheel: `https://files.pythonhosted.org/packages/cb/c0/0a517bfe63ccd3b92eb254d264e28fca3c7cab75d07daea315250fb1bf73/nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl`. | `nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl`, 581,240,110 bytes, SHA-256 `e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702`. Extracted regular files include `nvidia/cublas/lib/libcublas.so.12` (105,140,976 bytes, `5757ab5839fb4f203ca47ecb336110d10f4a5606b1e097f195fbca89774569e2`) and `libcublasLt.so.12` (749,210,000 bytes, `2c9006a75c74b3bea2dc7ae2ec38ab038b0e45ea02cb4b717a915e8a5796acb1`). | **Accepted (Task 3, 2026-09-02)** as the managed CUDA 12 Whisper closure on CachyOS x86_64 + RTX 4070. Not a CUDA 13 app runtime. Not Speakrs/Pyannote. |
| NVIDIA cuDNN CUDA 12 | [nvidia-cudnn-cu12 9.22.0.52](https://pypi.org/project/nvidia-cudnn-cu12/9.22.0.52/) (NVIDIA proprietary; [cuDNN SLA](https://docs.nvidia.com/deeplearning/cudnn/latest/reference/eula.html)). Same Python/manylinux/driver requirements as cuBLAS. Direct wheel: `https://files.pythonhosted.org/packages/a0/8f/2ede6b758b7524608472010f632bdd3370ea271d715d1d66044614b84cdc/nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl`. | `nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl`, 718,382,818 bytes, SHA-256 `391b9a7ee6386daaca7f8dca41e83c2c99f760c9581a0400755e87b4287b8847`. Extracted `nvidia/cudnn/lib/libcudnn.so.9` plus companion `libcudnn_{adv,cnn,ops,graph,...}.so.9` libraries. | **Accepted (Task 3, 2026-09-02)** as the managed CUDA 12 Whisper closure on CachyOS x86_64 + RTX 4070. Not Speakrs/Pyannote. |
| Speakrs | [ONNX Runtime 1.27.1 Linux GPU CUDA 12](https://github.com/microsoft/onnxruntime/releases/download/v1.27.1/onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz) (MIT) plus installer-bundled Linux `speakrs-cli` | GPU archive `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz`, 244,763,765 bytes, `08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf`. Extracted regular files: `libonnxruntime.so.1.27.1` 27,000,912 bytes `67eda041546eb01cf5606add5467d8bb7305b2aedb5cf37fdc6b055c7adfc094`; `libonnxruntime_providers_shared.so` 14,632 bytes `c6a12593396095f5670160e284c35d1700b7708cf3037b7042e2a5200ccae772`; `libonnxruntime_providers_cuda.so` 373,925,672 bytes `cffff5fe3aac14fe50eed1113757ac8318ee12ef307fcb9def35a24398ec0ce3`. NVIDIA wheels: `nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` 3,493,179 bytes `25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3` → `libcudart.so.12` 741,088 bytes `256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7`; `nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` 200,877,592 bytes `c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28` → `libcufft.so.11` 291,507,928 bytes `e1d65ebd08895f9d9883f848f3974f89e0130416252477b18835ba7f15d159bc`; `nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl` 68,295,626 bytes `49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e` → `libcurand.so.10` 166,965,432 bytes `ab8c07338fa663c018b16df5b3f3878c84aaae98bda930e9e8bad340427b0faa`; `nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl` 89,568,129 bytes `210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4` → `libnvrtc.so.12` 106,244,480 bytes `7c67c6b51ea0e0279634cebd676ff7efda1674806444520c84430ad5c35fe625`. Model pack reuses the published CUDA ONNX subset `speakrs-models-5d24ffe-win32-x64-cuda.tar.gz`, 208,765,985 bytes, `a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20` (same 19 files as Windows). Compile-time ORT pin is `linux-x64: null` (`load-dynamic`). CI-only CPU ORT smoke pin: `onnxruntime-linux-x64-1.27.1.tgz` 8,828,892 bytes `25b1ef1fea1acd210d63f8f24dc870ad6e077795ce1f54876252c6d3803c15af`. | **Task 4 pins recorded (2026-09-02).** Linux x86_64 `speakrs-cli` is built/staged with the canonical validation WAV and ELF executable/PIE integrity checks. Setup-time dynamic ORT/CUDA closure is pinned in `src/ai-addon/speakrs-pack-spec.js`, including curand/nvrtc and managed CUDA cublas/cudnn path/hash metadata. Catalog/UI and packaged RTX 4070 Speakrs remain **not accepted** until Task 5. CI CPU fixture smoke is a non-GPU structural check only. Never trust hashes from user-writable `install.json`. |
| Pyannote | `pyannote/speaker-diarization-community-1` requires the user's token; token-based setup has no maintainer artifact to download or pin. | No token was requested, supplied, logged, or downloaded. Linux is now Speakrs-only by product scope. | **Out of scope on Linux.** Do not investigate, pin, package, or surface a Linux Pyannote path. Windows/macOS retain their existing compatibility option. |
| Summaries | [llama.cpp official releases](https://github.com/ggml-org/llama.cpp/releases) (MIT) plus the existing Qwen GGUF catalog artifacts (Apache-2.0 model license) | Windows x64 CUDA and macOS arm64 Metal already use the shared Qwen/llama.cpp summary implementation. Linux now has a separately pinned `ai-dock/llama.cpp-cuda` v0.3.0 CUDA 12.8 amd64 archive plus pinned NVIDIA CUDA runtime/NCCL wheels; exact bytes and extracted closure are recorded below. | **Linux Task 6 reactivated, implementation complete and hardware inference gate passed; final acceptance remains open for quit-during-metadata evidence.** CPU, Vulkan, SYCL, ROCm, cloud, and ambient-library alternatives are rejected. |

### Linux AI add-ons — Task 6 CUDA-only Qwen summaries (reactivated 2026-09-03)

This lane is active again; the previous Linux-summary deferral remains
historical evidence, not the product decision. Windows x64 CUDA and macOS
arm64 Metal retain their existing summary behavior unchanged. Linux must reuse
the shared catalog/setup/service/UI contracts and become available only for
x86_64 NVIDIA systems after managed CUDA admission, artifact integrity,
runtime validation, packaged-path isolation, and the CachyOS RTX 4070 gate.

The current official `b9173` release was previously rejected for Linux because
it has no CUDA x86_64 archive. Its CPU/Vulkan/SYCL/ROCm archives remain
rejected and must not be relabeled or used as fallback. The replacement runtime
decision records:

- exact publisher/source release or commit, license, immutable download URL,
  archive filename, byte size, and SHA-256;
- complete runtime/model compatibility for Qwen3.5 with reasoning disabled;
- every managed/pinned shared library and its source, size, and SHA-256, plus
  allowlisted presence checks for driver/system libraries;
- safe archive layout, managed `userData` cache paths, and the exact rebuilt
  CUDA library environment with ambient `LD_LIBRARY_PATH` excluded; and
- packaged AppImage/unpacked acceptance on CachyOS x86_64 + RTX 4070, including
  setup, Ready status, offline generation, JSON/Markdown sidecars, metadata and
  `sourceTranscriptHash`, cancellation/quit cleanup, queue `busyCount: 0`,
  observed model/runtime/device/version details, timings, and no lingering
  children; the persisted summary metadata contains only the existing profile,
  model, generatedAt, sourceTranscriptHash, and sidecar paths.

Unit tests and CPU-only CI may validate structure and fail-closed policy only;
they cannot establish Linux Qwen support.

### Task 6 catalog decision

The selected Linux runtime is the `ai-dock/llama.cpp-cuda` v0.3.0 CUDA 12.8
amd64 release, built from llama.cpp commit
`c1d0e7a004015f23bc0233470b747b596f29b264`. It is MIT-licensed (the contained
llama.cpp binaries are MIT and the ai-dock build scripts are MIT). Its direct
archive is `llama.cpp-v0.3.0-cuda-12.8-amd64.tar.gz`, 150,794,376 bytes,
SHA-256
`37616f0271e82717eb8ddcd5d2319fd845ddcf93c83fd3943d0a1a539c1d0a99`.
The archive reports CUDA 12.8.1 and is pinned in `src/ai-addon-state.js`.

The binary closure additionally uses the pinned NVIDIA wheels below. They are
NVIDIA Software License Agreement artifacts and are downloaded only during
explicit summary setup. The NCCL wheel ships its applicable notice at
`nvidia/nccl/lib/LICENSE.txt`; the catalog records that path alongside the
immutable wheel URL.

| Artifact | Size | SHA-256 | Extracted library |
|---|---:|---|---|
| `nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` | 3,493,179 | `25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3` | `libcudart.so.12`, 741,088 bytes, `256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7` |
| `nvidia_nccl_cu12-2.31.2-py3-none-manylinux_2_18_x86_64.whl` | 342,105,414 | `f9b1dc3c2a7e20176054144ebb3b32fea83b40402ee5d7ac7045cd11ecc956c0` | `libnccl.so.2`, 473,266,472 bytes, `dba12e429fe11268b895d0531ba96a7f679f35227d5b1ec77c5febbcd02281bd` |

The extracted runtime pins the regular local closure (`llama-cli`,
`libllama-cli-impl.so`, `libllama-server-impl.so`, `libllama-common.so`,
`libllama.so`, `libmtmd.so`, `libggml*.so`, and `VERSION.txt`) by size and
SHA-256 in the catalog; the archive itself is also verified before extraction.
The runtime requires `libcublas.so.12` and `libcublasLt.so.12` from the
already-managed Task 2 CUDA tree, `libcuda.so.1` from the code-owned driver
allowlist, and system
OpenSSL/zlib/brotli/zstd/libstdc++/libgcc/libgomp/pthread/dl/rt libraries.
Admission resolves every declared managed/runtime dependency against those
catalog pins and checks driver/system names in the explicit allowlist. Linux
summary children receive only the runtime directories, managed CUDA
directories, and validated driver directories in `LD_LIBRARY_PATH`; ambient
`LD_LIBRARY_PATH` is discarded.

Packaged CachyOS x86_64 + RTX 4070 evidence was captured on 2026-09-03 using
the rebuilt unpacked app with `app.isPackaged: true`, isolated user data
`/tmp/avanevis-task6-hardware`, and local CDP. Setup was explicit and returned
`summary.status: ready` / `setupComplete: true`; the manifest persisted the
same Ready state. The model was catalog pin
`unsloth/Qwen3.5-9B-GGUF@3885219b6810b007914f3a7950a8d1b469d598a5`,
`Qwen3.5-9B-Q4_K_M.gguf`, 5,680,522,464 bytes, SHA-256
`03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8`.
The host was CachyOS x86_64 on Hyprland/Wayland with an
NVIDIA GeForce RTX 4070 (driver `610.57.04`, 12,282 MiB VRAM). The runtime
reported llama.cpp `v0.3.0`, CUDA `12.8.1`, and build
`c1d0e7a004015f23bc0233470b747b596f29b264`. An offline summary completed in
about 15 seconds, used `/tmp/.../llama-cli`, and GPU sampling observed a peak
of `6,250 MiB`; no CPU/Vulkan fallback was involved. The result used the
existing summary schema, wrote both JSON and Markdown sidecars, persisted
`ai.summary.status: completed`, and recorded
`sourceTranscriptHash: sha256:98cd1f8f3ac99d794535e572dc7d21cc8fc9086b4b68bea3c98a29735ebe92b0`.

A separate long-transcript run accepted
`cancel-summary-generation({meetingId})`; the generator returned the expected
`AI_ADDON_SETUP_CANCELLED` error, produced no summary sidecars, and left no
`llama-cli`, summary-runner, or meeting-manager child. The app remained alive.
After both runs, the shared compute action had settled (`busyCount: 0`
inferred from the queue's settled process and no lingering compute child);
quit-during-metadata-finalization remains a code-path/manual acceptance row,
not claimed by this smoke. This replaces the earlier “hardware inference
evidence pending” note for Task 6, but final Task 6 acceptance remains open
until the quit-during-metadata row is run. It does not accept Task 5 or the
overall branch. Windows/macOS cross-platform acceptance remains explicit.

Local hash commands (disposable directory; 2026-09-02):

```text
sha256sum nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl
e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702

sha256sum nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl
391b9a7ee6386daaca7f8dca41e83c2c99f760c9581a0400755e87b4287b8847
```

The host's CUDA 13 toolkit/UMD does not itself authorize a CUDA 13 app runtime.
NVIDIA's CUDA 12 runtime wheels above remain a separate managed profile and must be
loaded only through the Task 2 controlled library path. **Task 3 packaged RTX 4070
CUDA Whisper is accepted** (2026-09-02). Evidence:
[Linux AI add-ons — Task 3 packaged CUDA Whisper acceptance](#linux-ai-add-ons--task-3-packaged-cuda-whisper-acceptance-2026-09-02).
Speakrs CLI/pack-spec pins are recorded in
[Linux AI add-ons — Task 4 Speakrs CLI packaging pins](#linux-ai-add-ons--task-4-speakrs-cli-packaging-pins-2026-09-02).
Task 5 catalog/admission work is recorded in
[Linux AI add-ons — Task 5 Speakrs catalog and admission](#linux-ai-add-ons--task-5-speakrs-catalog-and-admission-2026-09-02)
and is **not** packaged RTX 4070 Speakrs acceptance. Pyannote is out of Linux
product scope. The separate Linux Qwen summary lane is reactivated as Task 6
and remains unavailable until its own artifact and RTX 4070 gates pass.

## Linux AI add-ons — Task 3 packaged CUDA Whisper acceptance (2026-09-02)

**Decision: accepted** for CUDA Whisper on packaged CachyOS x86_64 + NVIDIA RTX 4070.
CI and unit tests are not this gate. Speakrs and summaries stay unavailable; Pyannote is out of Linux product scope.
Same-day follow-up: offer the same managed CUDA 12 install on other NVIDIA Linux x86_64
as best-effort. Default transcription stays CPU until install; uninstall returns to CPU.
While a managed runtime is installed, a non-ready probe stays fail-closed (no silent CPU).

**Host (this session):** CachyOS rolling, kernel `Linux 7.2.2-1-cachyos`, Hyprland/Wayland,
PipeWire, `ID=cachyos`. GPU identity from both `nvidia-smi` and
`/proc/driver/nvidia/gpus/*/information`: NVIDIA GeForce RTX 4070, driver 610.57.04,
compute capability 8.9, 12282 MiB VRAM. Packaged Python 3.11.7. Electron 44.1.0.
Isolated `--user-data-dir` for the evidence pass (not the interactive home profile).

**Payload:** `npm run build:linux && npm run verify:linux:packaged` (twice this session;
the second rebuild picked up the `/proc/driver/nvidia` host-gate correction). First
evidence pass used `dist/linux-unpacked/avanevis`. The three release artifacts were
produced by the same `build:linux` and passed `verify:linux:packaged`:

| Artifact | Size | SHA-256 |
|---|---|---|
| `AvaNevis-Setup-2.8.0.AppImage` | 319M | `c94935183d3d54f231ace78131b39aa07046e70e0b5b1ad6103d058a278e3821` |
| `AvaNevis-Setup-2.8.0.pkg.tar.zst` | 292M | `15e3e67ff091fd057a69c55e747fbb3782da21619ae2916f8318f70e1c5fa143` |
| `AvaNevis-Setup-2.8.0.deb` | 243M | `e248e5600a717871c5d0883bb4d73ad3e372ebe531092a5cb9a00c9ff7fc633d` |

Launch (isolated userData; not the interactive home profile):

```text
ELECTRON_ENABLE_LOGGING=1 dist/linux-unpacked/avanevis \
  --user-data-dir=/tmp/avanevis-v29-task3 \
  --remote-debugging-port=9222
```

Renderer IPC was exercised through the packaged `window.electronAPI` (trusted sender).

### 1. Managed CUDA 12 install through the packaged app

`checkCUDA` on a fresh userData tree: `statusCode=missingLibraries`,
`pythonSupportedForInstall=true`, Python 3.11.7. Packaged `installGPU` completed
with `finalStatus.statusCode=ready`, `matchedProfile=cuda12`,
`deviceAvailable=true`, `runtimeLoadable=true`.

Exact pip argv from main-process log (no `--find-links`, no `package==version`):

```text
Linux CUDA pip install: {
  "wheelPaths": [
    ".../ai-addons/cuda/wheel-stage-1788349510245-148958/nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl",
    ".../ai-addons/cuda/wheel-stage-1788349510245-148958/nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl"
  ],
  "stagingTarget": ".../ai-addons/cuda/python.staging-1788349510245-148958",
  "activeTarget": ".../ai-addons/cuda/python",
  "pipArgs": ["-m","pip","install","--no-index","--no-deps","--no-compile","--only-binary=:all:","--no-cache-dir","--no-warn-script-location","--target",".../python.staging-1788349510245-148958",".../nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl",".../nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl"]
}

Linux CUDA runtime swapped: {
  "activeTarget": ".../ai-addons/cuda/python",
  "stagingTarget": ".../ai-addons/cuda/python.staging-1788349510245-148958",
  "tombstonePath": ".../ai-addons/cuda/python.tombstone-1788349510245-148958",
  "renamedActive": false
}
```

Device probe after install:

```text
deviceProbe.devices[0]={name:NVIDIA GeForce RTX 4070, driverVersion:610.57.04, computeCapability:8.9}
```

Staged wheel sizes/hashes matched the catalog pins (`e4f53a8c…c1702` 581,240,110 bytes;
`391b9a7e…b8847` 718,382,818 bytes). Extracted managed libraries matched
`src/main-process/linux-cuda-runtime-catalog.js` (`libcublas.so.12`
`5757ab5839fb4f203ca47ecb336110d10f4a5606b1e097f195fbca89774569e2` 105,140,976 bytes;
`libcublasLt.so.12` `2c9006a75c74b3bea2dc7ae2ec38ab038b0e45ea02cb4b717a915e8a5796acb1`
749,210,000 bytes; plus the pinned cuDNN 9 `.so` set).

### 2. Fresh model preload and CUDA transcription

`checkModelDownloaded("tiny")` → `downloaded: false`. Packaged `downloadModel("tiny")`
succeeded. Preload used CPU/int8 (download path, not transcription). Then
`retryTranscription({ meetingId: "20260902_124414", modelSize: "tiny", language: "en" })`
of the 148.47 s JFK desktop-loop fixture
(`meeting_20260902_task3_cuda.opus`, copied from the 2026-08-31 CachyOS Stop pass):

| Field | Result |
|---|---|
| Model | `tiny` (fresh HF cache `models--Systran--faster-whisper-tiny`) |
| Wall time | 7943 ms |
| Result JSON | `device: cuda`, `computeType: float16`, `requestedDevice: cuda`, `transcriptionDevice: cuda` |
| Meeting metadata at success | `id: 20260902_124414`, `model: tiny`, `transcriptionDevice: cuda`, `transcriptionComputeType: float16`, `transcriptionStatus: completed`, `durationSeconds: 148.4586875` |
| Transcript | looping JFK line (“ask not what your country can do for you” / “fellow Americans”) |
| Queue `seq` | `queued` (`seq` 2–3) → `waiting_resource` (`seq` 4–5) → `transcribing` (`seq` 6) → `persisting` (`seq` 7–8) → `completed`/`ready` (`seq` 9, `busyCount` 0) |

Progress: `Device: cuda` then `Device: CUDA` / `Compute type: float16` /
`Using GPU acceleration`.

### 3. Repair after an intentionally corrupted managed library

Overwrote the first 64 bytes of live `libcublas.so.12` (size unchanged). `checkCUDA`
→ `runtimeIntegrityFailed` / `Managed CUDA library hash mismatch: libcublas.so.12`.
`retryTranscription` failed closed (`hash mismatch`); no CPU child. `installGPU({ mode: "repair" })`
pip-installed the same exact staged wheel paths into
`python.staging-1788349651626-148958` and swapped (`renamedActive: true`).
Tombstone directory was deleted. Restored `libcublas.so.12` SHA-256 `5757ab58…`.
Later tiny transcription: `cuda` / `float16`.

### 4. Uninstall tombstone

**Superseded pre-follow-up evidence (Task 3 same-day pass).** At that time the
admitted profile still required CUDA after uninstall, so the next transcription
failed closed. Current behavior after the opt-in follow-up: uninstall removes
the live tree and the next transcription uses Core Beta CPU. Retain the
commands and paths below as historical context; do not treat the fail-closed
retry as current acceptance criteria. A packaged uninstall→CPU smoke after the
later UI/admission fix is listed under residual hardware smoke.

```text
Linux CUDA uninstall tombstoned: {
  "activePath": ".../ai-addons/cuda/python",
  "tombstonePath": ".../ai-addons/cuda/python.tombstone-1788350103805-158719"
}
```

`uninstallGPU` returned `{ success: true, tombstonePath: that path }`. After return,
the live `python/` tree and the tombstone were both gone; `wheelhouse` remained.
Transcription then failed closed (`missingLibraries` / managed root does not exist).

After that fail-closed retry, `meetings.json` for `20260902_124414` shows
`transcriptionStatus: failed`, `transcriptionError` = missing CUDA root, and
`transcriptionDevice: cpu` / `transcriptionComputeType: int8`. That is leftover
default metadata on a **failed** row, not a successful CPU transcription. The
happy-path persist captured above was `cuda` / `float16`.

### 5. Fail-closed (no CPU fallback) while the profile is admitted

| Case | `checkCUDA` | Transcription |
|---|---|---|
| Unexpected `nvidia/cublas/lib/libcublas.so.13` in the loader dir | `runtimeIntegrityFailed` (integrity rejects the CUDA 13 name before probe `unsupportedRuntimeMajor`) | threw; no CPU child |
| Packaged `cuda_probe.py` printed `not-json-probe` instead of JSON | `probeError` / `CUDA probe returned invalid JSON.` | threw; probe file restored afterward |
| Relaunch with `PATH` containing no `nvidia-smi` (GPU still visible in `/proc/driver/nvidia`) while a managed runtime is admitted | Final CUDA probe `probeError` / `nvidia-smi was not found on PATH.` | threw; no CPU child. Settings/install detection now uses `/proc` first and must not reject this host at the preliminary GPU check. |
| Uninstalled runtime (**superseded pre-follow-up**) | `missingLibraries` / managed root does not exist | threw; no CPU child. Current code returns to CPU after uninstall. |

Host gate at Task 3 evidence time: CachyOS x86_64 + exact `NVIDIA GeForce RTX 4070` (not Ti/Super), preferring
`/proc/driver/nvidia`. A first missing-`nvidia-smi` pass *before* the `/proc` correction used Core Beta CPU.
That was a host-gate bug; it was fixed and retested. Fail-closed evidence is the
second pass (`probeError` + throw).

The later opt-in follow-up (same day) keeps that fail-closed behavior **only while a
managed runtime is installed**. After uninstall, transcription returns to CPU.

### 6. Cancel and quit while a GPU job is running

Cancel of an in-flight `small` CUDA job: queue `active`/`transcribing` (`seq` 41,
`busyCount` 1), `cancelPendingTranscription` →
`{ success: true, cancelled: true, active: true }`, retry rejected
`Cancelled by user`, queue `failed`/`cancelled` (`seq` 44, `busyCount` 0).
Immediate later `tiny` transcription: `cuda` / `float16` (resource queue released;
completed `seq` 52).

Quit: SIGTERM during `small` `transcribing` ran `Quit drain terminating non-abortable
compute job: Transcription retry` (`Transcription retry was terminated because the app
is quitting.`). After relaunch, queue `jobs: []` `busyCount: 0`; later tiny
transcription: `cuda` / `float16`.

### 7. Residual desktop-audio smoke (best-effort; does not block CUDA acceptance)

8.00 s packaged mic+desktop Stop (Logitech C925e `pulse-source:` + FiiO
`pulse-monitor:`) wrote `recording_2026-09-02T11-55-42.opus` (116K). No
`DESKTOP_AUDIO_RESOURCE_EXHAUSTED` warning on this host. Not reproduced; CUDA
acceptance does not depend on it.

### Enablement

**Follow-up (2026-09-02, same day):** Linux CUDA is opt-in, not CachyOS/4070-gated.

Composition root passes `isLinuxCudaProfileEnabled: () => isLinuxCudaOffered({ userDataPath })`.
Offer = Linux x86_64 with a visible NVIDIA GPU (any model) or a leftover managed runtime.
GPU visibility, `check-gpu`, and install preflight share `detectLinuxNvidiaGpu`
(`/proc/driver/nvidia` first, then `nvidia-smi`). The GPU-runtime service default
remains `() => false`. Distro ID and exact GPU name are not gates. Tested host
remains CachyOS x86_64 + RTX 4070; other NVIDIA Linux is best-effort.

Transcription: no managed runtime tree → Core Beta CPU. Installed but not ready →
fail-closed (`LINUX_CUDA_UNAVAILABLE`) until repair or uninstall. `check-cuda`
reports `managedRuntimePresent` separately from `installed`, and Settings shows
Uninstall whenever `ai-addons/cuda/python` exists (Repair and Uninstall coexist
for broken installs). Uninstall tombstones the live tree and restores CPU.
Linux children always clear ambient `LD_LIBRARY_PATH`; only an admitted managed
runtime may repopulate it with validated managed and driver directories.
Linux Settings copy says uninstall returns to CPU.
Windows/macOS behavior, IPC channel names, and facade export shapes are unchanged.

## Linux AI add-ons — Task 4 Speakrs CLI packaging pins (2026-09-02)

**Decision: packaging/integrity pins recorded; Task 5 owns catalog admission.**
This is not packaged RTX 4070 Speakrs acceptance. Task 5 added `linux-x64`
catalog entries and CUDA-gated setup/guided transcription; hardware evidence
and adversarial review still block calling Task 5 accepted. Do not weaken these pins.

**CLI.** `buildSpeakrsCli()` on Linux targets `x86_64-unknown-linux-gnu` with
Cargo features `default-linalg`, `cuda`, `load-dynamic`. Compile-time ORT stays
`native/speakrs-cli/ort-compile-pins.json` `linux-x64: null`. The staged binary
must be a 64-bit little-endian x86_64 ELF named `speakrs-cli`, executable, and
structurally launchable: `ET_EXEC` or PIE `ET_DYN`, current ELF versions, a
nonzero entry point, bounded program headers, at least one `PT_LOAD`, and a
supported x86_64 interpreter (`/lib64/ld-linux-x86-64.so.2` or
`/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`). Integrity rejects 32-bit,
non-x86_64, non-ELF, shared-object, missing-interpreter, header-only, renamed,
PATH-supplied, and empty candidates without weakening PE/Mach-O checks. `file(1)`
must report an x86_64 executable/PIE, not a shared object. The canonical
`speakrs-two-speaker-16k.wav` is staged next to the CLI.

**Model pack.** Same 19 CUDA ONNX/PLDA files as Windows (`cudaPins`). Published
archive is the existing GitHub asset
`speakrs-models-5d24ffe-win32-x64-cuda.tar.gz` (sha256
`a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20`, 208,765,985
bytes). Pack-spec id is `speakrs-models-5d24ffe-linux-x64-cuda` with
`architecture: x64` and `cudaMajor: 12`.

**Setup-time runtime closure** (not installer-bundled):

| Artifact | Size (bytes) | SHA-256 | Extracted keep files |
|---|---|---|---|
| `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` | 244,763,765 | `08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf` | `libonnxruntime.so.1.27.1` 27,000,912 `67eda041546eb01cf5606add5467d8bb7305b2aedb5cf37fdc6b055c7adfc094`; `libonnxruntime_providers_shared.so` 14,632 `c6a12593396095f5670160e284c35d1700b7708cf3037b7042e2a5200ccae772`; `libonnxruntime_providers_cuda.so` 373,925,672 `cffff5fe3aac14fe50eed1113757ac8318ee12ef307fcb9def35a24398ec0ce3` |
| `nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` | 3,493,179 | `25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3` | `libcudart.so.12` 741,088 `256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7` |
| `nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` | 200,877,592 | `c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28` | `libcufft.so.11` 291,507,928 `e1d65ebd08895f9d9883f848f3974f89e0130416252477b18835ba7f15d159bc` |
| `nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl` | 68,295,626 | `49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e` | `libcurand.so.10` 166,965,432 `ab8c07338fa663c018b16df5b3f3878c84aaae98bda930e9e8bad340427b0faa` |
| `nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl` | 89,568,129 | `210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4` | `libnvrtc.so.12` 106,244,480 `7c67c6b51ea0e0279634cebd676ff7efda1674806444520c84430ad5c35fe625` |

TensorRT `.so` is not kept. CUDA-provider `NEEDED` libraries from the managed
CUDA 12 profile (`libcublas.so.12`, `libcublasLt.so.12`, `libcudnn.so.9`, with
catalog path/hash/size) plus `libcuda.so.1` (NVIDIA driver) and `libz.so.1`
(system) stay in `requiredDynamicLibraries` for Task 5 `LD_LIBRARY_PATH`
admission. Every non-system/non-driver required library maps to a pinned Speakrs
artifact or the managed CUDA catalog; `cuda-provider-needed` is not a valid
source. Never trust hashes from user-writable `install.json`.

**CI.** Ubuntu builds/tests `x86_64-unknown-linux-gnu` and runs
`scripts/run-speakrs-cpu-smoke.js` labeled **non-GPU structural check** using
`onnxruntime-linux-x64-1.27.1.tgz` (8,828,892 bytes,
`25b1ef1fea1acd210d63f8f24dc870ad6e077795ce1f54876252c6d3803c15af`). That smoke
is not RTX 4070 evidence.

## Linux AI add-ons — Task 5 Speakrs catalog and admission (2026-09-02)

**Decision: implemented, not accepted.** Stop for adversarial review before
calling Task 5 accepted. JS/CI is not packaged RTX 4070 Speakrs evidence.
Do not treat `scripts/run-speakrs-cpu-smoke.js` as that gate. Pyannote and
llama.cpp summaries were not started.

**What landed.** `linux-x64` Speakrs catalog entries (`modeByPlatform` CUDA,
pack `speakrs-models-5d24ffe-linux-x64-cuda`, Task 4 ORT/wheel/managed CUDA
closure). Setup, validate, and guided transcription re-probe CUDA via
`resolveCudaStatusForTranscription` and admit only when
`isLinuxCudaStatusReadyForAdmission` is true on x86_64. Failed preflight
leaves Speakrs `unsupported` with a CUDA/x64 reason — no CPU fallback, no
supported-but-greyed card. UI status may use the cached CUDA probe; compute
and setup re-probe. Child env is CUDA-only (`SPEAKRS_MODE=cuda`): packaged
CLI path, managed model/runtime roots, and a rebuilt `LD_LIBRARY_PATH` from
Speakrs ORT keep files, managed cublas/cublasLt/cudnn, allowlisted
`libcuda.so.1`, and system `libz.so.1`. Ambient `LD_LIBRARY_PATH` is ignored.
Every Hugging Face env var is cleared before spawn. Setup full-hashes catalog
pins for model pack files and extracted runtime libraries; compute admission
re-hashes changed `path + size + mtimeMs` fingerprints. Hashes in
user-writable `install.json` are identity-only and never trusted. Speakrs
uninstall still deletes only `models/diarization/speakrs` and
`runtimes/speakrs-ort`. Guided failure still persists an ordinary transcript.
Cancel/quit still terminate the POSIX CLI process group and must not leave a
sticky compute-queue slot.

**Task 4 pins reused (not changed):** ORT 1.27.1 Linux GPU tgz
`08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf`; extracted
`libonnxruntime.so.1.27.1` / `libonnxruntime_providers_shared.so` /
`libonnxruntime_providers_cuda.so`; cudart/cufft/curand/nvrtc wheels; managed
`libcublas.so.12` / `libcublasLt.so.12` / `libcudnn.so.9` path/hash/size from
the Task 3 CUDA catalog.

**JS validation (this session, not hardware acceptance):** passed.

```bash
node --test tests/js/diarization-payload-shape.test.js \
  tests/js/speakrs-task2-hardening.test.js \
  tests/js/linux-platform-selection.test.js \
  tests/js/quit-lifecycle.behavioral.test.js
```

**Packaged CachyOS x86_64 + RTX 4070 evidence — still required, not recorded:**
setup, validate, guided transcription, normal-transcript fallback, cancel,
remove, repair, and quit. Record here when collected: model/runtime
hashes vs Task 4 pins, `SPEAKRS_MODE=cuda`, device evidence, sidecar schema,
and child-process cleanup. Until that row is filled, Task 5 is not accepted.

### Task 5 packaged hardware-smoke attempt — blocked at prerequisites (2026-09-02)

**Status: not run; Task 5 remains unaccepted.** The available host identifies as
`CachyOS Linux`, `x86_64`, kernel `7.2.2-1-cachyos`, on branch
`feature/v2.9-linux-ai-addons` at
`3e58b15724221d279c3957d622cdfac830abca08` (`fix: harden Linux Speakrs CUDA
admission`). It is therefore the intended distribution/architecture family,
but it did not expose a working NVIDIA device to this session:

```text
$ nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader
NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.
```

No v2.9 installer was present. The only local Linux artifacts were
`AvaNevis-Setup-2.8.0.AppImage`, `.pkg.tar.zst`, and `.deb`; their hashes are
the historical 2.8.0 rows above, not evidence for this branch. They were not
launched, because they cannot establish the v2.9 packaged Speakrs behavior.

The source contracts below passed on this host, but are **not** a substitute
for a packaged GPU smoke:

```text
node --test tests/js/diarization-payload-shape.test.js \
  tests/js/speakrs-task2-hardening.test.js \
  tests/js/linux-platform-selection.test.js \
  tests/js/quit-lifecycle.behavioral.test.js \
  tests/js/speakrs-cli-integrity.test.js \
  tests/js/speakrs-model-pack.test.js \
  tests/js/linux-packaging.test.js
# pass 7, fail 0, skipped 0
```

The catalog pin record remains the expected comparison baseline only: model
pack `speakrs-models-5d24ffe-linux-x64-cuda` SHA-256
`a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20`; ORT
1.27.1 archive SHA-256
`08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf`.
Neither artifact was downloaded, extracted, or hashed in this attempt.

Consequently, there is no observed `SPEAKRS_MODE=cuda`, actual diarization or
Whisper device, setup/validation result, guided-transcription sidecar,
ordinary-transcript fallback, cancellation point (CUDA probe, extraction,
hashing, or CLI execution), remove/repair result, process-group child,
or compute/resource-queue cleanup evidence. Do not claim Linux Speakrs
hardware support from this entry. Resume only with a v2.9 packaged artifact
and a host where `nvidia-smi` reports the RTX 4070; then execute every Task 5
manual row and record the resulting artifacts and process evidence here.

**Superseded prerequisite finding (same session):** the sandbox hid
`/dev/nvidia*`, but a read-only host-level probe reported `NVIDIA GeForce RTX
4070`, driver `610.57.04`, compute capability `8.9`, and `12282 MiB`. An
isolated build of `3e58b157` completed and `npm run verify:linux:packaged`
passed for its unpacked bundle, AppImage, pacman, and deb artifacts. The
feature branch intentionally still packages version `2.8.0`; this is a v2.9
feature-lane candidate, not a release-version claim. A fresh disposable
packaged-app profile is now running on CachyOS Hyprland/Wayland to collect the
remaining live Task 5 evidence. No Speakrs support claim follows from the
build, verifier, or GPU probe alone.

**Guided-transcription finding (same session; rejected until rebuilt):** a
fresh packaged profile completed Speakrs setup and validation. Its manifest is
`ready` with engine `speakrs`; the guided bundled two-speaker WAV run produced
`guided-fixture.md`, `diarization.device: "cuda"`, and no remaining
`speakrs-cli` child. CUDA preflight also reported `statusCode: "ready"`,
`runtimeLoadable: true`, profile `cuda12`. However, the same guided result
reported Whisper `transcriptionDevice: "cpu"` / `int8`. Investigation found
that `buildDiarizationChildEnv()` supplied managed CUDA libraries but omitted
`AVANEVIS_LINUX_CUDA_REQUIRED=1`; the backend correctly coerced its default
`auto` Whisper device to CPU. A red/green contract now requires that flag for
admitted Linux CUDA Speakrs children. Rebuild and repeat the packaged guided
run before recording a CUDA Whisper pass or accepting Task 5.

**Partial packaged rerun after the guided-device fixes (same session):** the
fresh rebuilt `linux-unpacked` candidate was launched on CachyOS x86_64,
Hyprland/Wayland with an NVIDIA GeForce RTX 4070 (driver `610.57.04`, compute
capability `8.9`, 12,282 MiB). This remains a feature-lane candidate whose
package metadata says `2.8.0`, not a v2.9 release artifact. The first child-env
fix exposed a second fail-closed defect: `guided_transcription.py` still
constructed faster-whisper with `device=auto`, which correctly rejected under
`AVANEVIS_LINUX_CUDA_REQUIRED=1`. A red/green Python regression now pins the
admitted Linux path to `device=cuda`; after rebuilding, the bundled
two-speaker fixture completed with both `diarization.device: "cuda"` and
Whisper `transcriptionDevice: "cuda"`, `transcriptionComputeType: "float16"`.
The ordinary Whisper IPC path also completed with `requestedDevice: "cuda"`,
`device: "cuda"`, and `computeType: "float16"`.

The persisted guided meeting sidecar is SHA-256
`2d5fe2a6c9672d9653a89b182c8d7321c37fc6f2d65e5b71bb4a4c48b6901781` and has
the schema keys `annotationSource`, `audioPath`, `completedAt`, `device`,
`model`, `segments`, `segmentsPath`, `speakerCount`, `speakerSegments`, and
`status`; each labelled transcript segment has `start`, `end`, `speaker`, and
`text`. The observed runtime hashes match the recorded pins: ORT
`libonnxruntime.so.1.27.1` `67eda041…adfc094`, CUDA provider
`cffff5fe…98ec0ce3`, `libcudart.so.12` `256e6409…eb133b7`, and the primary
Speakrs ResNet model `203a4c67…64fcc0f`.

Quit was also issued while a long fixture had both a packaged
`guided_transcription` process and its packaged `speakrs-cli` child alive
(separate POSIX process groups). The app process exited and a post-quit process
scan found neither child; a restart against the same profile immediately
completed another CUDA/float16 Whisper request, which is positive
process-group and compute-slot recovery evidence. This is intentionally only a
partial Task 5 row: cancellation at the CUDA-probe/extraction/hashing
checkpoints, guided-failure-to-ordinary persistence, and an engine switch were
still outstanding. **Historical observation, superseded 2026-09-03:** Linux is
now Speakrs-only, so switching is no longer a Task 5 acceptance criterion.
Task 5 remains unaccepted; do not claim Linux Speakrs hardware support yet.

**Follow-up lifecycle evidence (same session):** `remove-diarization-setup`
removed the 24-file Speakrs model tree and 8-file ORT runtime tree, while the
shared managed CUDA `libcublas.so.12` stayed byte-identical at
`5757ab5839fb4f203ca47ecb336110d10f4a5606b1e097f195fbca89774569e2`.
`setup-diarization({engine: "speakrs"})` rebuilt both trees and an explicit
full `validate-diarization-setup` returned `ready`; the reinstalled ORT library
again full-hashed to `67eda041…adfc094`. A queued 28-minute local fixture was
cancelled while a live packaged `speakrs-cli` child was observed. The IPC
returned `{ success: true, cancelled: true }`; afterwards no CLI or guided
Python child and no guided temporary transcript remained, and the meeting was
durably `failed` with `Cancelled by user`. This closes the active-CLI cancel,
remove, repair, and shared-CUDA-preservation rows only.

### Task 5 fresh isolated packaged rerun — fallback metadata gate failed (2026-09-03)

**Status: not accepted.** Fresh current-head `3a585493a1d0127f20fc37bb2a9745ee2dc7feae` evidence used CachyOS x86_64, kernel `7.2.2-1-cachyos`, Hyprland/Wayland, RTX 4070 (driver `610.57.04`, compute capability `8.9`, 12,282 MiB), rebuilt `dist/linux-unpacked/avanevis`, and isolated userData `/tmp/avanevis-v29-task5-VQYDLj/user-data`. Renderer IPC was driven through local CDP; no interactive profile was used.

Fresh commands all exited 0: `npm run test:all`, `npm run build:linux`, and `npm run verify:linux:packaged` (unpacked, AppImage, pacman, and deb). The resulting artifacts hash to AppImage `f9e2581340e12d94e675174a049dd27ab14c22f3578a635651fb646cc478d778`, pacman `037a101d7bb00d7a0483f12e0de9ffd84ed1b4bc87b8c362e21d8a54be296844`, and deb `228887fc9fefdc314f26092d661423991b158c19be92a85e910bbc536e46f1de`.

Empty-profile preflight was fail-closed (`missingLibraries`: cublas, cublasLt, cudnn). Packaged CUDA install then reached `ready`/`cuda12`, `deviceAvailable=true`, `runtimeLoadable=true`; Speakrs setup and a later repair both returned ready. Full installed hashes match catalog pins: ORT `67eda041546eb01cf5606add5467d8bb7305b2aedb5cf37fdc6b055c7adfc094`, CUDA provider `cffff5fe3aac14fe50eed1113757ac8318ee12ef307fcb9def35a24398ec0ce3`, managed cublas `5757ab5839fb4f203ca47ecb336110d10f4a5606b1e097f195fbca89774569e2`, and Speakrs ResNet `203a4c67112167580ab1fcb62f4568c633499fb283805890aebe1c48564fcc0f`.

Bundled two-speaker fixture `1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998` produced persisted meeting `20260903_105917`: Whisper `cuda`/`float16`, CUDA Speakrs sidecar SHA-256 `f0349ad7460ac1ed4d437e6da6a8ee673843049768600f8266a2ca84756cf7c2`. Its keys are `annotationSource`, `audioPath`, `completedAt`, `device`, `model`, `segments`, `segmentsPath`, `speakerCount`, `speakerSegments`, and `status`; labelled segments have `start`, `end`, `speaker`, and `text`. After settlement the renderer queue was empty (`busyCount:0`) and `ps` found no guided Python or Speakrs CLI child.

**Failure:** moving the managed ResNet forced guided failure. Meeting `20260903_110001` correctly persisted an ordinary CUDA/float16 `.md`, created no sidecar, and left no child, but its metadata omitted `ai.diarization` entirely rather than storing a concise diarization error. This fails the Task 5 fallback criterion. Repair restored Ready. Removal deleted only Speakrs model/ORT roots while the cublas hash and faster-whisper tiny cache survived. DOM inspection found visible Speakrs, both Pyannote cards hidden, token field `hidden`/`display:none`, and summary `is-unsupported` with an Unsupported badge and disabled setup. Historical cancel/quit evidence above was not rerun after this failure. Do not accept Task 5 until fallback metadata is fixed and the affected packaged rows rerun.

### Task 5 follow-up — on-disk fallback metadata and Linux Pyannote CSS (2026-09-03, not accepted)

**Status: not accepted.** Same isolated profile `/tmp/avanevis-v29-task5-VQYDLj/user-data`. Do not treat this as packaged Task 5 acceptance: cancel/quit, fail-closed preflight, History fallback copy, and a rebuilt Speakrs-only UI were not re-run.

**Superseded for meetings `20260903_112216` and `20260903_112605` only:** after `resolveGuidedDiarizationStatus()` retained Speakrs `error` / cache `reason` and `runMeetingTranscriptionJob()` carried that into `guidedTranscriptionError`, those later fallback fixtures persisted concise `ai.diarization` on disk (`status: "error"`, `model: "speakrs-community1-vbx"`, timestamp, `error: "Speakrs model pack is not installed."`, `segmentsPath: null`) with ordinary CUDA/float16 transcripts and no `.speakers.json`. Meeting `20260903_110001` remains the original omitted-metadata failure and is not rewritten. A job-level JS regression now asserts `updateMeetingAiMetadata` receives that error payload; a Python `update-ai`/`get` round trip covers the meeting-manager boundary. History UI for the error banner was not re-opened in the packaged app this session.

**Superseded DOM-hidden Speakrs-only claim:** `.diarization-engine-card { display: flex }` overrode the HTML `hidden` attribute, so CDP `hidden=true` / token `display:none` was not visual absence of the Pyannote Settings/Home cards. The renderer now allowlists Pyannote to `win32`/`darwin` only, coerces Linux/unknown to Speakrs, and adds `.diarization-engine-card[hidden] { display: none !important; }` plus a single-column selector. Packaged UI must be rebuilt and inspected visually before calling the Speakrs-only row accepted.

### Task 5 rebuilt packaged acceptance rerun — remaining rows reproduced (2026-09-03)

**Status: acceptance evidence complete; formal acceptance remains pending the
required adversarial review.** This rerun used a fresh
`npm run build:linux` from the current working tree and the same isolated
profile `/tmp/avanevis-v29-task5-VQYDLj/user-data` on CachyOS x86_64,
Hyprland/Wayland, NVIDIA RTX 4070. `app.isPackaged` was true and
`process.resourcesPath` pointed at the rebuilt `dist/linux-unpacked/resources`.
The ResNet model was restored after the fallback run.

**Rebuilt UI.** Settings was visually inspected after status initialization:
only the Speakrs card was painted; Pyannote cards/text were absent from the
visible page and its hidden subtree was not keyboard-reachable. Home likewise
contained no visible Pyannote text. Meeting Summaries remained visibly
`Unsupported`, with the Linux unavailable copy and disabled controls. The
main-process Linux Pyannote rejection was unchanged. The stale-validation-copy
edge case found during this rerun is covered by a focused renderer regression:
an authoritative `unsupported` availability reason now wins over a previous
`lastValidation: ready` message.

**Rebuilt fallback.** Existing meeting `20260903_112605` was opened in History
and displayed `Speaker identification failed for this recording. Speakrs model
pack is not installed.` A fresh model-missing run created meeting
`20260903_121531` (`Task 5 post-rebuild fallback`): its ordinary transcript
persisted with `transcriptionDevice: "cuda"` and
`transcriptionComputeType: "float16"`, no `.speakers.json` existed, and
`ai.diarization` contained only `status: "error"`, model
`speakrs-community1-vbx`, `completedAt`, the concise model-pack error, and
`segmentsPath: null`. History displayed the same per-recording error line.
Restoring the ResNet and rechecking setup returned `ready` with valid model
and runtime caches.

**Rebuilt cancellation and quit.** During cancellation, process snapshots
observed the packaged Python `diarization.guided_transcription` process and
the bundled `resources/bin/speakrs-cli` child in the guided process group.
Cancellation returned `{ success: true, cancelled: true }`; the meeting was
`failed` with `Cancelled by user`, guided temporary output was absent, and
the renderer queue reported `busyCount: 0`. A second run sent quit while the
Speakrs child was live; the app exited within the bounded drain and a final
process scan found neither `speakrs-cli` nor guided Python.

**Rebuilt fail-closed preflight.** With the managed CUDA tree moved aside,
the restarted packaged app reported `checkCUDA.runtimeLoadable: false`,
`statusCode: "missingLibraries"`, and the diarization card rendered
`Unsupported` with the managed CUDA 12/NVIDIA GPU requirement. It did not
offer CPU speaker identification. The non-ready probe-status matrix and
non-x64 admission cases remain pinned by
`tests/js/linux-cuda-transcription-admission.test.js`; the packaged
missing-runtime result confirms the user-facing gate.

These observations supersede the earlier “not re-run after failure” notes
above, while preserving meeting `20260903_110001` as the original historical
omitted-metadata failure. No dedicated setup, repair, or guided-success
acceptance rerun was used to establish this follow-up beyond the
already-restored Ready check; guided jobs were exercised only as the
cancel/quit lifecycle fixtures.

### Task 5 adversarial review — never-installed Speakrs reported as a per-meeting failure (2026-09-03, defect + fix)

**Status: Task 5 acceptance evidence partially invalidated.** The targeted
adversarial review required before Task 5 acceptance was run against
`3a58549..79a508f` and found a shipping defect in
`resolveGuidedDiarizationStatus` (`src/main/transcription-service.js`).

**Defect.** The fallback-metadata fix gated on
`diarizationStatus.error || runtimeCache?.reason || packCache?.reason`. Those
`reason` fields are non-null whenever the Speakrs artifacts are *merely absent*
— `checkSpeakrsModelCache` returns `'Speakrs model pack is not installed.'` and
`checkSpeakrsRuntimeCache` returns `'Speakrs ONNX Runtime is not installed.
Missing: ...'` (`src/ai-addon/manifest-store.js`) — and a fresh manifest
defaults to `engine: 'speakrs'` (`normalizeDiarizationSelection`,
`src/ai-addon-state.js`). Nothing checked the owning
`features.diarization.status`.

**Blast radius.** Reproduced against the real derived status shape on
`linux/x64` (`requiredDevice: cuda`), `win32/x64` (`cuda`) and `darwin/arm64`
(`mps`). `getDiarizationAvailability` returns `supported: true` for Windows x64
unconditionally, so every Windows x64 install was affected, not only
CUDA-capable ones. For any user who never opted into speaker identification,
each transcription wrote durable `ai.diarization = {status:'error', model:
'speakrs-community1-vbx', error:'Speakrs ... is not installed.'}` into
`meetings.json`, producing a permanent
`Speaker identification failed for this recording.` banner
(`src/renderer/app.js:3780-3786`) plus a warning log (`:4035`). The
"Speaker identification is unavailable" progress line fired twice per meeting
because the post-pass re-ran the same admission probe.

**Impact on prior Task 5 evidence.** `removeDiarizationSetup` sets the manifest
to `notConfigured` (`src/ai-addon/diarization-setup.js:1743`), and the Remove
row ran before fallback fixtures `20260903_112216` / `20260903_112605`. Those
fixtures therefore may have demonstrated the defect rather than the fallback
criterion. `20260903_121531` is described only as a "model-missing run" and the
recorded evidence does not state `features.diarization.status` at that moment,
so it cannot be adjudicated from this document either. **The fallback row is
re-opened; a rerun must record `features.diarization.status` and passes only
when it is `error`.** `20260903_110001` remains the original historical
omitted-metadata failure and is not rewritten.

**Fix.** `resolveGuidedDiarizationStatus` now treats a cache `reason` as a
failure only when `status === 'error'` or `setupComplete === true`, and only
when the owning cache is actually `valid !== true` — matching the gating
already used by `requireDiarizationComputeAdmission`. The Linux
`LINUX_PYANNOTE_UNAVAILABLE` policy gate returns silently instead of stamping
error metadata for a deliberately hidden engine; the catch-block fallback is
gated the same way, so a transient status-probe throw degrades silently rather
than inventing a durable failure. The post-pass no longer re-probes after a
terminal admission failure (one fewer CUDA probe child and
`computeAdmission` status hash inside the held compute slot, and one warning
instead of two). An admission-level error no longer masks a concrete
guided/post-pass/sidecar failure, and
`persistDiarizationFailureArtifacts` takes a `meetingId` instead of a forged
meeting object that silently defeated its own guard.

**Regression coverage.** `tests/js/linux-cuda-transcription-admission.test.js`
gained 13 tests: `{notConfigured, downloading, validating}` ×
`{linux/x64, win32/x64, darwin/arm64}`, Linux-pyannote silence, a
single-admission-probe assertion, an error-priority assertion, and a full-job
"unconfigured writes no metadata" case. All 13 were confirmed to fail against
`79a508f` and pass with the fix. `npm run test:all` is green (868 JS pass /
0 fail / 1 skipped; 599 Python pass / 7 skipped; Python syntax clean). The two
tests introduced by `79a508f` still pass unchanged — the fix preserves the
intended installed-but-broken behaviour and only stops misclassifying
"never installed".

**Still required before Task 5 acceptance.** Packaged reruns on CachyOS
x86_64 + RTX 4070 of the re-opened fallback row (recording
`features.diarization.status`) and the new never-installed negative row, plus
the equivalent never-installed check on Windows x64 and macOS arm64. See
`tests/manual/local-ai-addons-checklist.md`.

### Task 5 packaged Linux rerun — never-installed and broken fallback pass (2026-09-03)

**Status: Linux rows pass; Task 5 is not formally accepted.** A fresh
`npm run build:linux` and `npm run verify:linux:packaged -- --unpacked --appimage
--pacman --deb` completed successfully from `8a7ec98b3f781a62c1eef33fa4854f8033ac1779`.
The smoke used `dist/linux-unpacked/avanevis` with isolated userData
`/tmp/avanevis-v29-task5-rerun-20260903/user-data`, local CDP, and no interactive
profile. Main-process startup recorded `app.isPackaged: true` and
`process.resourcesPath` as the rebuilt unpacked resources directory.

Host evidence: CachyOS x86_64, kernel `7.2.2-1-cachyos`, NVIDIA GeForce RTX 4070,
driver `610.57.04`, compute capability `8.9`, 12,282 MiB. Managed CUDA setup
returned `statusCode: "ready"`, `matchedProfile: "cuda12"`,
`runtimeLoadable: true`, and `deviceAvailable: true`. The fixture
`tests/fixtures/speakrs-two-speaker-16k.wav` is SHA-256
`1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`.
Current package hashes are AppImage
`ee7f4fed79ef447dd051b27364fbe3e1bb914924aeb07a90e30b0925f05a4b6d`,
pacman `3084b08ff93b804abaa2f7710daf4dacd08fa25c0fae6f07994f69e46d7c09a4`,
and deb `34cf814052938ce0f0b152d0010793e8e2074c8e74996601e5619742098704a6`.
Restored Speakrs ResNet SHA-256 is
`203a4c67112167580ab1fcb62f4568c633499fb283805890aebe1c48564fcc0f`;
ORT, CUDA runtime, cuFFT, cuRAND, and NVRTC extracted hashes matched the
Task 4 pins, including ORT `67eda041…adfc094` and CUDA provider
`cffff5fe…98ec0ce3`.

**Scenario A — never installed / downloading.** After CUDA became ready,
`checkAiAddonSetupStatus` reported `features.diarization.status: "notConfigured"`
for meeting `20260903_124835`. Its retry returned `device: "cuda"` and
`computeType: "float16"`; the direct `recordings/meetings.json` entry has no
`ai` key. History contained no `Speaker identification failed for this
recording` text, and the captured progress strings contained no `Speaker
identification is unavailable` line. Speakrs setup was then started explicitly;
at the moment of retry for meeting `20260903_124956`, the same status field was
`"downloading"`. That meeting also completed as ordinary CUDA/`float16`
transcription with no `ai` key, no History failure banner, and no unavailable
progress line.

**Scenario B — installed but broken fallback.** Speakrs setup first reached
`ready`. Moving only
`wespeaker-voxceleb-resnet34.onnx` aside left the runtime manifest untouched;
before retry, `features.diarization.status` was `"error"` with the concise
pack-cache reason and missing-file list. Meeting `20260903_125307` completed an
ordinary CUDA/`float16` transcript with no `.speakers.json`. Its persisted
`ai.diarization` object had exactly `status: "error"`, model
`speakrs-community1-vbx`, `completedAt`, error
`"Speakrs model pack is not installed."`, and `segmentsPath: null`. History
rendered the per-recording error line exactly once. The captured transcription
progress contained exactly one `Speaker identification is unavailable` line,
confirming no post-pass duplicate probe. The ResNet was restored and setup
returned to `ready` with valid pack/runtime caches.

After each transcription the renderer queue settled to `busyCount: 0`; the
final queue contained only terminal `ready` jobs. A final process scan found no
`speakrs-cli` or `guided_transcription` child. No sidecar was expected or
written in either negative/fallback run; the fallback schema is the concise
`ai.diarization` shape recorded above. This closes the two Linux checklist rows,
but the equivalent never-installed check remains required on Windows x64 and
macOS arm64 before release acceptance.

## Interpreters used for this matrix

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

**macOS packaged-wheel target (2026-08-29):** macOS packaging downloads the locked dependency set for `macosx_14_0_arm64` (CPython 3.11, binary wheels only) into a temporary wheelhouse, then installs only from that wheelhouse. This keeps current MLX pins while preventing a macOS 26 build host from embedding macOS-26-only wheels. Packaged support is macOS 14+ on Apple Silicon (M1 or newer); macOS 14.2+ remains recommended for CoreAudio process-tap capture.

## Package and runtime ownership

Treat these as **direct runtime dependencies** even when a resolver also reaches them through `faster-whisper`. Never prune them in Task 3 without a failed experiment.

| Package | Owner | Packaged pin today | Why it stays explicit |
|---|---|---|---|
| `onnxruntime` | faster-whisper Silero VAD (`vad_filter=True` in `faster_whisper_transcriber.py`) | Windows/Linux build `==1.26.0` | Import/VAD failure if missing. macOS `prepare-resources.js` **removes** `onnxruntime` after pip because MLX does not use it. |
| `tokenizers` | faster-whisper tokenization | Windows/Linux build `==0.23.1` | Tokenize/model load failure if missing. |
| `av` (PyAV) | faster-whisper path-based decode | Windows/Linux build `==18.1.0` | `transcribe(audio_path)` decode. Bundled ffmpeg does not replace this import. Direct runtime dep; do not prune in Task 3. |
| `ctranslate2` | faster-whisper inference | Windows/Linux build `==4.8.1` | CUDA 12 wheels. Packaged Windows GPU profile remains `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`. This host also has CUDA 13 on PATH; that does not change the packaged CUDA 12 contract. |
| `faster-whisper` | Windows + Linux transcription | `==1.2.1` | Linux default remains **CPU**. Optional managed CUDA 12 after install (Task 3 accepted on CachyOS x86_64 + RTX 4070; other NVIDIA Linux is best-effort). |
| `lightning-whisper-mlx` | Apple Silicon transcription | macOS build `==0.0.10` | Pins `tiktoken==0.3.3`. |
| `torch` | macOS resolver only | macOS build `==2.13.0`, then **pruned** | MLX never imports `torch_whisper.py`. `lightning-whisper-mlx` does not pin Torch. **Accepted** Task 2 on Apple Silicon (2026-08-28). Stays in `MACOS_RUNTIME_REMOVABLE_PACKAGES`. Not Pyannote’s `torch==2.8.0`. |
| `setuptools` | pip / wheel metadata | Windows/Linux/macOS build `==84.0.0` (also pruned from the macOS runtime) | Windows/Linux **accepted** Task 2. macOS **accepted** with Torch 2.13.0. CI no longer ignores `CVE-2025-3000` or `PYSEC-2026-3447`. |
| `numba` / `llvmlite` | MLX stack | macOS build `==0.67.0` / `==0.49.0` | **Accepted** Task 2 on Apple Silicon (2026-08-28). Numba 0.67 requires `llvmlite>=0.49,<0.50`. Matching pair; not Dependabot Numba-alone against llvmlite 0.47. |
| `numpy` | audio + ML | all build files `==2.4.6` | Stay on 2.4.x; 2.5+ needs Python ≥3.12. |
| PyObjC `ScreenCaptureKit` / `CoreAudio` / `AVFoundation` | macOS capture fallback | macOS build `==12.2.2` | **Accepted** coordinated bump (2026-08-28). Runtime files already floated to 12.2.2. |
| PyObjC `Cocoa` / `Quartz` / `core` / `CoreMedia` | ScreenCaptureKit fallback graph | macOS build `==12.2.2` | **Kept** at 12.2.2. Cocoa supplies `Foundation` (`NSObject`, `NSRunLoop`). Quartz is required by `pyobjc-framework-AVFoundation==12.2.2`. |
| `sounddevice` | macOS microphone (`InputStream`, `query_devices`) | macOS build `==0.5.6` | **Accepted** (2026-08-28). Runtime already floated to 0.5.6. Desktop capture stays the Swift helper; this pin is the mic path. |
| `tiktoken` | MLX | macOS `==0.3.3` | Dependabot ignore; do not bump alone. |
| Speakrs ONNX Runtime | add-on, **not** pip requirements | Windows setup-time archive **1.27.1** (`src/ai-addon/speakrs-pack-spec.js`) | Distinct from pip `onnxruntime==1.26.0`. Linux artifacts require a separate v2.9 investigation and acceptance record. |

Linux CUDA Whisper is **tested** on CachyOS x86_64 + RTX 4070 (Task 3, 2026-09-02) and **offered** as opt-in CUDA on other NVIDIA Linux x86_64. Speakrs remains in the evidence-gated lane; Pyannote is out of Linux product scope and summaries remain evidence-gated.

## Resolver vs packaged pins

Runtime files (`requirements.txt`, `requirements-windows.txt`, `requirements-linux.txt`, `requirements-macos.txt`, `requirements-common.txt`, `requirements-dev.txt`) use floors. Build files pin the installer. **Do not copy a runtime freeze into a build file.**

Material floats observed 2026-08-28 (runtime) versus current build pins:

| Package | Runtime resolve | Build pin | Action in v2.9 |
|---|---|---|---|
| `filelock` | 3.32.4 | 3.32.3 | Floor raised on Linux; build stays 3.32.3 |
| `av` | 18.1.0 | **18.1.0** | **Accepted** Task 2 (2026-08-28): Windows/Linux build pins; macOS does not pin `av` |
| `onnxruntime` | 1.29.0 | 1.26.0 | Keep 1.26.0 until VAD/decode/Speakrs evidence |
| `huggingface-hub` | 1.29.0 | **1.29.0** | **Accepted** macOS (2026-08-28) and Windows/Linux (2026-08-29)
| `pytest` | 9.1.1 | floor `>=9.1.1` | **Accepted** Task 2 (2026-08-28): `requirements-dev.txt` floor raised; not a packaged pin |
| `mlx` | 0.32.2 | **0.32.2** | **Accepted** macOS-only (2026-08-28) after packaged MLX smoke; `lightning-whisper-mlx` stays 0.0.10; `tiktoken` stays 0.3.3 |
| `cffi` | 2.1.1 | macOS/Linux **2.1.1** | **Accepted** macOS-only (2026-08-28). Linux already 2.1.1; Windows does not pin `cffi` |
| `regex` | 2026.7.19 | macOS **2026.7.19** | **Accepted** macOS-only (2026-08-28). macOS-only pin (`tiktoken`) |
| `Pygments` | 2.21.0 | **2.21.0** | **Accepted** macOS (2026-08-28) and Windows/Linux (2026-08-29) |
| `annotated-doc` | 0.0.5 | **0.0.5** | **Accepted** macOS (2026-08-28) and Windows/Linux (2026-08-29) |
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

**Upstream:** [huggingface-hub 1.29.0](https://github.com/huggingface/huggingface_hub/releases/tag/v1.29.0) (2026-08-27). Security/path hardening for `local_dir` filenames (CVE-2026-15717 follow-up in 1.26.0); Xet download rate-limit fix. 1.16.1 required `typer>=0.20.0` and `hf-xet>=1.4.3`. 1.29.0 **drops typer** and requires `click>=8.4.2,<9` plus `hf-xet>=1.5.2`. PyPI lists no vulnerabilities on 1.29.0. App usage is `hf_hub_download(..., local_dir=..., token=False)` in `mlx_whisper_transcriber.py` and `hf_model_downloader.py`. Distil `./mlx_models/...` filenames still pass `_validate_relative_filename`. `token=False` omits `Authorization` and disables cached/environment token discovery. The MLX call was aligned with the summary downloader after the pre-PR paper review found that it had relied on Hub's default `token=None`. No other application-code change was needed for the dependency bump.

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

Held: Electron 42.9.0; Windows/Linux pins; `filelock==3.32.3`; `onnxruntime` 1.26.0; `tokenizers` 0.23.1; `av` 18.1.0; all seven PyObjC pins at 12.2.2.

## Task 3 Windows/Linux pin trim — rejected 2026-08-28 (this PC)

Host: Windows 10 26200 x64, CPython 3.11.9 (`MSC v.1938`). Linux stand-in: WSL2 Ubuntu, uv CPython 3.11.15. Clean venvs under `%TEMP%\avanevis-v2.9-task3\win` and `/tmp/avanevis-v2.9-task3/linux`. Resolver: `pip install --dry-run --ignore-installed --only-binary=:all:` plus a real trial-2 install on each host. `pip check` text in every executed install: **No broken requirements found.**

No pins were deleted. `requirements-windows-build.txt`, `requirements-linux-build.txt`, `requirements-windows.txt`, `requirements-linux.txt`, and `requirements-common.txt` are unchanged. macOS pins were not touched. Electron stayed 42.9.0. `filelock` stays **3.32.3**. `onnxruntime==1.26.0`, `tokenizers==0.23.1`, and `av==18.1.0` remain explicit direct runtime deps. Runtime floats (`onnxruntime` 1.29.0, `huggingface-hub` 1.29.0, `filelock` 3.32.4) were **not** copied into a build file.

A packaged Windows dir rebuild / Linux AppImage was **not** run: the plan requires that gate before *accepting* a deletion, and no deletion was accepted. Trial-2 venvs used the retained lock graph (holds restored; matching pins omitted but still installed transitively) for decode and CPU transcription smoke.

### Method

Kept as first-party or documented holds: `pyaudiowpatch==0.2.12.8` (Windows), `pulsectl==24.12.0` / `SoundCard==0.4.6` / `cffi==2.1.1` (Linux), `numpy==2.4.6`, `soxr==1.1.0`, `faster-whisper==1.2.1`, `filelock==3.32.3`, `av==18.1.0`, `ctranslate2==4.8.1`, `huggingface-hub==1.16.1`, `tokenizers==0.23.1`, `onnxruntime==1.26.0`, `setuptools==84.0.0`.

Runtime files have no explicit transitive `==` pins to drop. Their floors already leave `onnxruntime` / `tokenizers` / `av` transitive under `faster-whisper>=1.0.0`; that is expected for dev installs and is not a trim of the packaged lock.

**Trial 1** omitted every other Windows/Linux build pin. Unconstrained resolve vs the lock (same version-holds on both hosts unless noted):

| Package | Lock | Unpinned resolve | Verdict |
|---|---|---|---|
| `tqdm` | 4.67.3 | 4.70.0 | **Reject** — version hold |
| `packaging` | 26.2 | 26.3 | **Reject** — version hold |
| `protobuf` | 7.35.1 | 7.36.0 | **Reject** — version hold (`onnxruntime` unpinned protobuf) |
| `fsspec` | 2026.4.0 | 2026.7.0 | **Reject** — version hold |
| `hf-xet` | 1.5.0 | 1.6.0 | **Reject** — version hold |
| `typer` | 0.25.1 | 0.27.2 | **Reject** — version + drops `click`; `colorama` becomes Windows-only |
| `anyio` | 4.13.0 | 4.14.2 | **Reject** — version hold |
| `idna` | 3.16 | 3.19 | **Reject** — version hold |
| `click` | 8.4.1 | **not installed** | **Reject** — graph change. `typer==0.27.2` no longer requires `click` |
| `colorama` | 0.4.6 | 0.4.6 on Windows; **not installed** on Linux | **Reject** on Linux — graph change. Windows still pulls it via `tqdm`/`click` Windows extras |
| `annotated-doc` | 0.0.4 | 0.0.5 | **Reject** — version hold |
| `Pygments` | 2.20.0 | 2.21.0 | **Reject** — version hold |

**Trial 2** restored those holds and omitted only the packages that still resolved to the lock version. Real venvs `%TEMP%\avanevis-v2.9-task3\win\trial2-venv` and `/tmp/avanevis-v2.9-task3/linux/trial2-venv`: `pip check` passed. Freeze matched the fully pinned baseline for every requirements package (`setuptools==84.0.0` present via `pip show` / `pip freeze --all`; default `pip freeze` omits it). Wheels stayed platform-native (`av` `win_amd64` / `manylinux_2_28_x86_64`; `onnxruntime` / `ctranslate2` `cp311` CUDA-12-compatible tags). Hypothetical SBOM would drop those names from the Windows/Linux build files while pip still installed them.

Those matches are **not parent exact-pins**. They match today because they are the current latest that satisfies a range. Removing them would let a later resolve change the packaged artifact without a requirements diff, and the SBOM generator would stop listing real runtime pieces (`flatbuffers` is Windows/Linux-only today; `colorama` is already absent from macOS). **Reject** the trim; retain the lock.

| Package | Lock | Why retain even though trial 2 matched |
|---|---|---|
| `certifi` | 2026.7.22 | `httpx` unpinned certifi; CA bundle; security-sensitive |
| `h11` | 0.16.0 | `httpcore`: `h11>=0.16` |
| `httpcore` | 1.0.9 | `httpx`: `httpcore==1.*` |
| `httpx` | 0.28.1 | `huggingface-hub==1.16.1`: `httpx<1,>=0.23.0` |
| `typing-extensions` | 4.16.0 | `huggingface-hub`: `>=4.1.0` |
| `PyYAML` | 6.0.3 | `huggingface-hub`: `>=5.1`; `ctranslate2`: `>=5.3,<7` |
| `flatbuffers` | 25.12.19 | `onnxruntime` unpinned `flatbuffers` |
| `shellingham` | 1.5.4 | `typer`: `>=1.3.0` |
| `rich` | 15.0.0 | `typer`: `>=13.8.0` |
| `markdown-it-py` | 4.2.0 | `rich`: `>=2.2.0` |
| `mdurl` | 0.1.2 | `markdown-it-py`: `mdurl~=0.1` |
| `colorama` | 0.4.6 | Windows: `tqdm`/`click` `platform_system == "Windows"`. Linux: only the explicit pin keeps it once typer floats |
| `pycparser` | 3.0 | Linux: `cffi` requires `pycparser` except on PyPy |

Held first-party / Task 2 pins (not trim candidates here): `huggingface-hub==1.16.1` vs runtime **1.29.0**; `filelock==3.32.3` vs runtime **3.32.4**; `onnxruntime==1.26.0` vs runtime **1.29.0**; `tokenizers==0.23.1`; `av==18.1.0`; `ctranslate2==4.8.1`; `setuptools==84.0.0`.

### Decode and transcription smoke

Trial-2 venvs (retained lock versions; matching pins transitive):

- Windows 3.11.9: `av 18.1.0` decoded `tests/fixtures/speakrs-two-speaker-16k.wav` → rate 16000, channels 1, frames 223, samples 227592. Offline CPU transcription `--model small --device cpu --language en --json` with `HF_HUB_OFFLINE=1` and `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1`: `Using cached Whisper model files only.`, exit 0, `device: cpu`, `computeType: int8`, duration 14.22s, English two-speaker fixture text. Imports: `faster_whisper 1.2.1`, `onnxruntime 1.26.0`, `tokenizers 0.23.1`, `ctranslate2 4.8.1`, `huggingface_hub 1.16.1`.
- WSL2 3.11.15: same decode counts. Offline CPU transcription `--model tiny.en` (the WSL cache; Windows used `small`): same flags, exit 0, `device: cpu`, `computeType: int8`, duration 14.22s, English fixture text. `cffi==2.1.1` / `pycparser==3.0`. `pulsectl` was not imported: this WSL image has no `libpulse.so.0` (resolver stand-in, not Omarchy hardware).

Temporary transcript output stayed under `%TEMP%` / `/tmp`. Do not treat WSL Pulse absence as a Linux capture gate.

### SBOM

Current `legal/PYTHON-BUNDLED-PACKAGES.md` is unchanged (63 direct pins, generated 2026-08-28T22:02:58.900Z). A trial-2 file would drop the matching Windows/Linux direct names (`flatbuffers` would disappear from the legal table entirely; `colorama` is already macOS-absent). That SBOM diff is evidence **against** accepting the trim.

## Task 3 Windows/Linux pin upgrades (keep the lock)

Stay on `feature/v2.9-dependency-hygiene`. Host: Windows 10 26200 x64, CPython 3.11.9. Linux stand-in: WSL2 Ubuntu, uv CPython 3.11.15. Packaged Windows python: embed 3.11.9 via `npm run prepare-build`. Electron stayed 42.9.0. macOS pins unchanged except where a Windows/Linux bump makes the SBOM shared. `filelock` stays **3.32.3**. `onnxruntime==1.26.0`, `tokenizers==0.23.1`, and `av==18.1.0` were not changed.

### Cluster 1: huggingface-hub 1.29.0 + pulled transitives — accepted 2026-08-29 (this PC)

**Upstream:** [huggingface-hub 1.29.0](https://github.com/huggingface/huggingface_hub/releases/tag/v1.29.0) (2026-08-27). Same notes as the macOS cluster: path hardening for `local_dir` filenames; 1.29.0 **drops typer** and requires `click>=8.4.2,<9` plus `hf-xet>=1.5.2`. PyPI still lists 1.29.0 as current (2026-08-29). App usage on this stack is `hf_hub_download(..., local_dir=..., token=False)` in `hf_model_downloader.py` (summaries; Linux add-ons remain unsupported). faster-whisper uses hub only for model cache layout. Distil filenames and `token=False` were already validated on macOS. No application-code change.

**Pin (Windows and Linux build files):**

| Package | Before | After |
|---|---|---|
| `huggingface-hub` | 1.16.1 | **1.29.0** |
| `hf-xet` | 1.5.0 | **1.6.0** |
| `click` | 8.4.1 | **8.5.0** |
| `fsspec` | 2026.4.0 | **2026.7.0** |
| `anyio` | 4.13.0 | **4.14.2** |
| `idna` | 3.16 | **3.19** |
| `packaging` | 26.2 | **26.3** |
| `tqdm` | 4.67.3 | **4.70.0** |

`filelock==3.32.3` unchanged. `typer==0.25.1` unchanged in this commit. `httpx==0.28.1` / `httpcore==1.0.9` / `h11==0.16.0` already matched. Did not add `charset-normalizer` (macOS-only pin).

**Resolver / `pip check`:**
- Windows 3.11.9 clean venv `%TEMP%\avanevis-v2.9-winlinux-c1\win`: `pip install --only-binary=:all: -r requirements-windows-build.txt` → versions in the table. `pip check`: No broken requirements found.
- WSL2 3.11.15 `/tmp/avanevis-v2.9-winlinux-c1/linux`: same for `requirements-linux-build.txt`. `pip check`: No broken requirements found.

**pip-audit:** both requirement files with no `--ignore-vuln` → **No known vulnerabilities found**.

**Tests:** trial venvs `pytest tests/python/test_hf_model_downloader.py tests/python/test_transcriber_helpers.py -q` → Windows **47 passed**; WSL **46 passed, 1 skipped**. No application-code change.

**SBOM:** `npm run legal:sbom` → `legal/PYTHON-BUNDLED-PACKAGES.md` generated 2026-08-29T15:21:38.104Z; 63 direct pins. `huggingface-hub`, `hf-xet`, `click`, `fsspec`, `anyio`, `idna`, `packaging`, and `tqdm` are now **1.29.0-era** on all three platforms.

**Packaged Windows `prepare-build`:** exit 0. Bundled `build/resources/python/python.exe -m pip check`: No broken requirements found. Bundled inventory matches the table plus `filelock==3.32.3`, `typer==0.25.1`, `onnxruntime==1.26.0`, `tokenizers==0.23.1`, `av==18.1.0`. Bundled decode of the two-speaker fixture: rate 16000, channels 1, frames 223, samples 227592.

**Transcription smoke (trial venvs, offline cache):**
- Windows `--model small --device cpu`: exit 0, `device: cpu`, `computeType: int8`, duration 14.22s, English fixture text, `Using cached Whisper model files only.`
- WSL `--model tiny.en` (WSL cache): exit 0, same device/compute/duration, English fixture text.

Held: `typer==0.25.1`; Electron 42.9.0; Linux AI add-ons; `onnxruntime` 1.26.0; `tokenizers` 0.23.1; `filelock==3.32.3`. `click` stays because hub 1.29 requires it — cluster 2 must not drop it.

### Cluster 2: typer 0.27.2 — accepted 2026-08-29 (this PC)

**Upstream:** [typer 0.27.2](https://pypi.org/project/typer/0.27.2/) (2026-08-28). Same as macOS cluster 2: 0.26.0 vendored Click; 0.27.2 requires `shellingham`, `rich`, `annotated-doc`, and `colorama` **only on Windows**. AvaNevis does not import `typer`, `click`, or `colorama`. huggingface-hub 1.29.0 still requires `click>=8.4.2,<9`, so `click==8.5.0` **stays**. No application-code change.

**Pin:** Windows and Linux `typer==0.25.1` → **`typer==0.27.2`**. Removed unused Linux `colorama==0.4.6` (not installed after the bump). Windows keeps `colorama==0.4.6` (`tqdm`/`click` Windows extras). `click==8.5.0` retained. `annotated-doc==0.0.4` unchanged (cluster 3).

**Resolver / `pip check`:**
- Windows `%TEMP%\avanevis-v2.9-winlinux-c2\win`: `typer==0.27.2`, `click==8.5.0`, `colorama==0.4.6`. `pip check`: No broken requirements found.
- WSL `/tmp/avanevis-v2.9-winlinux-c2/linux`: `typer==0.27.2`, `click==8.5.0`, colorama **not installed**. `pip check`: No broken requirements found.

**pip-audit:** both files, no ignores → **No known vulnerabilities found**.

**Tests:** same hf/transcriber helpers: Windows 47 passed; WSL 46 passed, 1 skipped.

**SBOM:** `npm run legal:sbom` → generated 2026-08-29T15:26:32.979Z; 63 direct pins. `typer` is **0.27.2** on all three platforms. `colorama` is Windows-only.

**Packaged Windows `prepare-build`:** exit 0. Bundled `pip check` passed. Bundled `typer==0.27.2`, `click==8.5.0`, `colorama==0.4.6`.

**Transcription smoke:** Windows `small` and WSL `tiny.en` offline CPU/int8, duration 14.22s, English fixture text.

Held: Electron 42.9.0; `onnxruntime` 1.26.0; `filelock==3.32.3`; leftover floats protobuf 7.35.1 / Pygments 2.20.0 / annotated-doc 0.0.4.

### Cluster 3: remaining Windows/Linux floats — accepted 2026-08-29 (this PC)

**Upstream:** leftover Task 3 version-holds that clusters 1–2 did not pull. `protobuf` 7.36.0 is the current wheel for unpinned `onnxruntime==1.26.0` protobuf. `Pygments` 2.21.0 and `annotated-doc` 0.0.5 are current `rich`/`typer` deps (macOS already at these). AvaNevis does not import these packages. No application-code change. `onnxruntime` stays **1.26.0**. `filelock` stays **3.32.3**.

**Pin (Windows and Linux build files):**

| Package | Before | After |
|---|---|---|
| `protobuf` | 7.35.1 | **7.36.0** (Windows/Linux only; macOS does not pin protobuf) |
| `Pygments` | 2.20.0 | **2.21.0** |
| `annotated-doc` | 0.0.4 | **0.0.5** |

**Resolver / `pip check`:** Windows and WSL installs of the updated build files → versions in the table, `onnxruntime==1.26.0`, `filelock==3.32.3`. `pip check`: No broken requirements found.

**pip-audit:** both files, no ignores → **No known vulnerabilities found**.

**Tests:** same hf/transcriber helpers: Windows 47 passed; WSL 46 passed, 1 skipped.

**SBOM:** `npm run legal:sbom` → generated 2026-08-29T15:29:14.162Z; 63 direct pins. `protobuf` is **7.36.0** (Windows/Linux). `Pygments` and `annotated-doc` are **2.21.0** / **0.0.5** on all three platforms.

**Packaged Windows `prepare-build`:** exit 0. Bundled `pip check` passed. Bundled `protobuf==7.36.0`, `Pygments==2.21.0`, `annotated-doc==0.0.5`, `onnxruntime==1.26.0`.

**Transcription smoke:** Windows `small` and WSL `tiny.en` offline CPU/int8, duration 14.22s, English fixture text.

Held: Electron 42.9.0; `onnxruntime` 1.26.0 vs runtime 1.29.0; `filelock==3.32.3` vs runtime 3.32.4; `tokenizers==0.23.1`; `av==18.1.0`. Range-locks that already matched current resolve stay pinned. All Windows/Linux Task 3 version-hold rows are now upgraded (clusters 1–3) or graph-changed (Linux `colorama` removed; `click` kept for hub 1.29).

## Blockers and non-goals

- **Do not** merge or land Dependabot PRs from this evidence. Use this matrix to accept or reject each candidate in its own commit.
- Electron 44.1.0 is evaluated only on `feature/v2.9-electron-44`. Do not combine it with Python/runtime upgrades. Electron 45 and all prereleases are out of scope.
- **Do not** start Linux AI add-on phases 6–9.
- **Do not** add Apple signing or notarization.
- Host CUDA 13 toolkits must not be mistaken for packaged CUDA 12 support.

## Electron 44.1.0 lane (2026-08-31)

**Branch:** `feature/v2.9-electron-44`
**Host (this session):** CachyOS x86_64, Hyprland/Wayland, PipeWire 1.6.8 (`pipewire-pulse`), Node 24.20.0, npm 11.19.0. SNI host: noctalia `org.kde.StatusNotifierWatcher`. fuse3 present; fuse2 absent.

**Registry check:** `npm view electron@latest version` → `44.1.0`. Published non-prerelease 44.x: `44.0.0`, `44.1.0`. `npm view electron-builder@latest version` → `26.15.3`.

**Stack (44.1.0):** Chromium 152.0.7977.65, Node 24.19.0 (in Electron), V8 15.2. Patch vs 44.0.0 includes a Wayland/GNOME tray-icon restore (`#53214`), Windows shutdown and AppX GPU fixes, macOS WebAuthn/notification crash fixes. No additional breaking changes beyond the 44.0.0 review below.

**Breaking-change review vs AvaNevis (no code change required unless a later gate fails):**

| Change | Impact |
|---|---|
| Unity desktop removed | No Unity branch; `password-store` is `gnome-libsecret` except KDE `kwallet6`. |
| macOS 12 dropped | Already macOS 13+ runtime / 14+ packaged Apple Silicon. |
| ANGLE statically linked; no `libEGL`/`libGLESv2` | Packaging tests do not require those libs. |
| `net.request` `Sec-Fetch-Dest` | Updater uses Node `https`, not Electron `net`. |
| 32-bit Windows/Linux dropped | We ship Windows x64 and Linux x64 only. |
| Renderer `clipboard` module removed | Renderer copy uses W3C `navigator.clipboard.writeText` from a user gesture; preload does not expose Electron `clipboard`. |
| `openAsHidden` login-item fields removed | Unused. |

**Candidate:** `package.json` `electron` `^42.9.0` → `^44.1.0` (44.0.0 was the morning pin; 44.1.0 is npm `latest` the same day). Keep electron-builder `^26.15.3`.

**Linux packaging (CachyOS, 2026-08-31):** `npm run build:linux` with electron-builder 26.15.3 produced AppImage + pacman + deb. `libEGL`/`libGLESv2` absent as expected. `npm run verify:linux:packaged` initially failed because `dpkg-deb` is not on Arch-family hosts; `readDebControlFromArchive` / `extractDebArchive` now fall back to `ar`+`tar`. Verifier passed after that fix. Re-run on **44.1.0** the same day: `npm run test:all` (769 JS pass / 1 skip, 578 Python pass / 7 skip, JS+Python syntax OK); `build:linux` packaged `electron=44.1.0`; unpacked binary reports `Chrome/152.0.7977.65`; `verify:linux:packaged` passed.

**CachyOS Hyprland smoke (packaged `linux-unpacked`, Electron 44.0.0 then pin 44.1.0):**
- `ozone-platform=wayland`, hint `auto`
- SNI item `org.freedesktop.StatusNotifierItem-*` on noctalia watcher; no tray-create failure
- `password-store=gnome-libsecret`; `encryptionAvailable=false` with no running Secret Service (fail-closed). Do not auto-activate `ksecretd` — a locked wallet hung `isEncryptionAvailable()` at startup
- Packaged `device_manager.py`: opaque `pulse-source:` / `pulse-monitor:` / `pulse-sink:` IDs; onboard front-mic `available=no` omitted; HDMI `available=yes` kept
- First-run Whisper **preload defaulted to CUDA** via CTranslate2 on this NVIDIA host. Fixed: `buildWhisperPreloadArgs` and `resolve_faster_whisper_device` force CPU on Linux. Packaged-python `--preload --model small --device cpu` loaded **CPU / int8**
- Add-ons reported `supported: false` with the Core Beta reason strings; legal notices readable
- Hardware capture (2026-08-31, same packaged `linux-unpacked`): Discard of ~10 s left `meetings.json` empty. Stop of 2:28 (Logitech C925e + FiiO `pulse-monitor`, Chrome looping the Whisper JFK fixture, no ScreenCast portal) saved one History meeting. `faster_whisper_transcriber --device cpu` wrote `transcriptionDevice: cpu`, `transcriptionComputeType: int8`. The `.md` contains the looping JFK line (“ask not what your country can do for you” / “fellow Americans”), not only level-meter activity. Setup / Install Model / Generate Summary stayed disabled. noctalia `RegisteredStatusNotifierItems` included `StatusNotifierItem-<avanevis-pid>-1` while recording; recording tray-bar crops had more red pixels than idle. Physical HDMI unplug was not performed (port still `available`); unplugged onboard analog-input stayed omitted
- macOS 13+ arm64 hardware matrix passed on **44.1.0** on 2026-09-01; evidence below.

**Windows packaging (Windows 11 Pro 10.0.26200, 2026-08-31):** Node 22.15.0, npm 10.9.2. `npm ci` installed Electron **44.1.0**. `npm run test:all`: 768 JS pass / 2 skip (the extra skip is `ar`/binutils for synthesizing a `.deb`), 578 Python pass / 7 skip. One JS test failed until patched: `assertAppImageUsesStaticRuntime`’s malformed-ELF case shelled out to Unix `file(1)`. The static-runtime case already injected `spawnSyncFn`; the malformed case now does too. Live Linux `verify:linux:packaged` still uses real `file`. `npm run build:dir` packaged `electron=44.1.0`; `AvaNevis.exe` `process.versions` reports `electron 44.1.0`, `chrome 152.0.7977.65`, `node 24.19.0`. Bundled `pip check` clean. Bundled PyAV **18.1.0** decoded `tests/fixtures/speakrs-two-speaker-16k.wav` → rate 16000, channels 1, frames 223, samples 227592. Offline CPU `--model small --device cpu` wrote `device: cpu`, `computeType: int8`, duration 14.22s, English fixture text. Speakrs packaging verifier passed; no stale `audiocapture-helper`. First electron-builder attempt in this agent shell failed with `spawn powershell.exe ENOENT` because PATH had PowerShell 7 (`pwsh`) only; retry with `C:\Windows\System32\WindowsPowerShell\v1.0` succeeded. Not a product change — CI `windows-latest` already has `powershell.exe`.

**Windows x64 smoke (packaged `win-unpacked`, Electron 44.1.0):**
- CDP `Browser`: `Chrome/152.0.7977.65`; renderer `file://…/app.asar/src/renderer/index.html`
- Packaged `device_manager.py`: WASAPI Logitech C925e mic id 39; FiiO DAC-E10 loopback id 47. Host also has CUDA 13 toolkits on PATH; this pass used the already-installed packaged CUDA 12 profile (not a CUDA 13 install)
- Discard of ~12 s (C925e + FiiO loopback) left History at 40 meetings; latest id stayed `20260827_230839`. UI returned to Ready; Cancel stayed hidden
- Stop of 2:28 (`durationSeconds` 148.82) saved meeting `20260831_231450`. Status flipped to `Ready · 1 transcribing` then completed. Metadata: `model: medium`, `transcriptionDevice: cuda`, `transcriptionComputeType: float16`. Speakrs `speakrs-community1-vbx` completed (`speakerCount: 1` — looping single-file speech). The `.md` contains the looping two-speaker fixture lines (“Morning, Zyra” / “design review starts at 10” / “Thanks, Hazel”), not only level-meter activity

**macOS packaging (macOS 26.6.2 arm64, 2026-09-01):** Node 26.8.1, npm 11.19.0. `npm ci` installed Electron **44.1.0** with no audit findings. `npm run test:all`: 768 JS pass / 2 skip, 577 Python pass / 8 skip, JS+Python syntax OK. `npm run build:mac:dir` packaged `electron=44.1.0`; the first attempt was stopped after stale local `node_modules` exposed Electron 42.9.0, then `npm ci` restored the lockfile runtime before the accepted build. `npm run verify:mac:packaged` passed with host Metal access: arm64 app/ffmpeg/Speakrs CLI, deep/strict bundle seal, helper and Speakrs signatures/entitlements, Opus encode, MLX imports, and no bundled Torch. The restricted-shell verifier reached the same seal/native checks but could not expose a Metal device; the host-GPU rerun is the accepted result. A deep/strict recheck after the first live smoke then exposed Python `__pycache__` writes inside the signed bundle. Root cause: the verifier protected its own import smoke with `PYTHONDONTWRITEBYTECODE=1`, but normal packaged children did not. `buildPythonEnv()` now forces that flag for every packaged child (caller overrides cannot disable it), with a red/green contract test. A rebuilt app retained a valid deep/strict seal after startup, CoreAudio recording, Opus finalization, Speakrs, and MLX transcription; the bundled backend contained zero `__pycache__` directories.

**macOS arm64 smoke (packaged `AvaNevis.app`, Electron 44.1.0):**
- Packaged startup selected bundled Python 3.11.7, bundled ffmpeg n8.0.1, and `transcription.mlx_whisper_transcriber`; device enumeration exposed the MacBook Pro microphone and the native system-audio source
- Automated Discard (MacBook Pro microphone + system audio) reached `recording_started` with `helperCaptureBackend=coreaudio_tap`, then returned structured `cancelled: true`; only one 2026-09-01 History meeting exists, from the later Stop pass
- Automated Stop of 1:18.45 (`durationSeconds` 78.4533125) used the same microphone while looping `tests/fixtures/speakrs-two-speaker-16k.wav` through system audio. Desktop diagnostics: `coreaudio_tap`, 7,355 helper buffers, 3,765,760 samples, peak **0.732860**. Opus integrity decode passed at 48 kHz stereo
- Meeting `20260901_080341` completed with `model: medium`, `transcriptionDevice: mps`, `transcriptionComputeType: float16`; Speakrs `speakrs-community1-vbx` completed. The `.md` repeats “Morning, Zyra”, “design review starts at 10”, and “Thanks, Hazel”, proving browser/system speech survived the saved stereo file and MLX mono transcription path
- Post-fix seal regression: rebuilt Electron 44.1.0 package recorded another 39.51 s CoreAudio-tap meeting (desktop peak **0.732753**), completed Speakrs plus base MLX on `mps`/`float16`, and transcribed “Morning, Zyra” / “design reviews start at 10” / “Thanks, Hazel”. While the app remained running, `codesign --verify --deep --strict` passed and `Contents/Resources/backend` contained zero `__pycache__` directories
