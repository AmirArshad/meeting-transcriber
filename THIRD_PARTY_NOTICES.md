# Third-Party Notices

AvaNevis incorporates and/or facilitates optional use of open-source software
and machine-learning models. This document summarizes licenses and attribution
requirements. It is provided for convenience and does not replace the full
license texts of each component.

**AvaNevis application source code** (this repository, excluding third-party
components listed below) is licensed under the [MIT License](LICENSE.txt).

---

## 1. Bundled with installers

These components are included when you build installers via
`npm run prepare-build` and `electron-builder`.

| Component | Role | License (summary) | Notes |
|-----------|------|-------------------|--------|
| [Electron](https://www.electronjs.org/) | Desktop shell | MIT | |
| [electron-updater](https://www.electron.build/auto-update) (`6.8.11`) | Differential in-app update checks and downloads | MIT | Bundled inside `app.asar` |
| [adm-zip](https://github.com/cthackers/adm-zip) (`0.6.1`) | Safe ZIP archive inspection and extraction | MIT | Bundled inside `app.asar` |
| [marked](https://marked.js.org/) (`18.2.1`) | Offline Markdown parsing for Chat responses and release notes | MIT | Bundled inside `app.asar` |
| [DOMPurify](https://github.com/cure53/DOMPurify) (`3.4.18`) | HTML sanitization for rendered Markdown | Apache-2.0 (or MPL-2.0) | Bundled inside `app.asar` |
| [Python](https://www.python.org/) | Embedded / standalone runtime in installer | PSF License | See python.org license page |
| [ffmpeg](https://ffmpeg.org/) | Opus compression after recording | **GPLv3** (typical third-party builds) | See [legal/ffmpeg-SOURCE-OFFER.txt](legal/ffmpeg-SOURCE-OFFER.txt) and [legal/FFMPEG-COMPLIANCE.json](legal/FFMPEG-COMPLIANCE.json). Windows: gyan.dev essentials build. macOS: shaka-project/static-ffmpeg-binaries arm64 static build. Linux (when packaged): shaka-project `ffmpeg-linux-x64` static build. Windows builds may include `legal/ffmpeg-upstream-*` copied from the gyan.dev archive. |
| Python packages in `requirements-*-build.txt` | Recording, transcription, HF downloads | Mostly MIT / BSD / Apache-2.0 | Non-exhaustive list below |
| macOS `audiocapture-helper` (Swift) | Desktop audio capture | Same as AvaNevis (MIT) unless otherwise noted in `swift/` | |
| `speakrs-cli` | Token-free speaker-identification engine (optional add-on) | Apache-2.0 | Built from `native/speakrs-cli` (Speakrs 0.7.0) and bundled under `Resources/bin/`. Pinned native model files are explicit setup-time downloads. |

### Notable bundled Python packages

| Package | License (typical) |
|---------|-------------------|
| faster-whisper, ctranslate2 | MIT |
| lightning-whisper-mlx, mlx | MIT |
| numpy, scipy, soxr | BSD |
| pulsectl, SoundCard | MIT / BSD-3-Clause |
| pyaudiowpatch, sounddevice | MIT |
| huggingface-hub, hf-xet, httpx | Apache-2.0 |
| pyobjc-* (macOS) | MIT |

Full pinned versions: `requirements-windows-build.txt`, `requirements-macos-build.txt`, `requirements-linux-build.txt`. A generated table of direct pins lives in [legal/PYTHON-BUNDLED-PACKAGES.md](legal/PYTHON-BUNDLED-PACKAGES.md) (refresh with `npm run legal:sbom`).

---

## 2. Downloaded at runtime (not shipped in the installer)

Users download these artifacts on first use or during explicit setup in Settings.

### Transcription — OpenAI Whisper

| Item | License (typical) | Source |
|------|-------------------|--------|
| Whisper model weights | MIT | [openai/whisper](https://github.com/openai/whisper) |
| Windows: Systran `faster-whisper-*` on Hugging Face | MIT (converted weights) | e.g. `Systran/faster-whisper-small` |
| macOS: MLX Whisper models | MIT (derived from Whisper) | e.g. `mlx-community/whisper-small-mlx` via [lightning-whisper-mlx](https://github.com/mustafaaljadery/lightning-whisper-mlx) |

**Trademark:** “Whisper” is associated with OpenAI. AvaNevis is not affiliated with or endorsed by OpenAI.

### Optional transcription — NVIDIA Parakeet

| Item | License | Source |
|------|---------|--------|
| NVIDIA Parakeet (`parakeet-tdt-0.6b-v2`) | **CC BY 4.0** | [nvidia/parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) |
| Windows / Linux CUDA ONNX weights | **CC BY 4.0** (converted weights) | [`istupakov/parakeet-tdt-0.6b-v2-onnx`](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx) via `onnx-asr` |
| macOS Apple Silicon MLX weights | **CC BY 4.0** (converted weights) | [`mlx-community/parakeet-tdt-0.6b-v2`](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v2) via `parakeet-mlx` |
| Silero VAD ONNX | MIT | [`istupakov/silero-vad-onnx`](https://huggingface.co/istupakov/silero-vad-onnx) |

**Attribution (CC BY 4.0):** When using Parakeet transcription, credit the model, for example:  
*Transcription uses NVIDIA Parakeet ([nvidia/parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), CC BY 4.0).*

### Optional speaker diarization — pyannote

| Item | License | Terms |
|------|---------|--------|
| `pyannote/speaker-diarization-community-1` | **CC BY 4.0** | Gated on Hugging Face; users must accept model terms and provide their own Hugging Face token. AvaNevis does not ship model weights or maintainer tokens. |
| `pyannote.audio`, PyTorch (CUDA/MPS) | MIT / BSD-style (+ NVIDIA CUDA redistribution terms when CUDA builds are installed) | Installed during explicit speaker setup into user data |

**Attribution (CC BY 4.0):** When using speaker diarization, credit the model, for example:  
*Speaker diarization uses [pyannote Speaker Diarization Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (CC BY 4.0).*

### Optional speaker diarization — Speakrs model packs

The token-free Speakrs engine downloads a platform model pack from a dedicated
AvaNevis model-artifact release. The pack is not included in the application
installer. Each pack contains `ATTRIBUTION.md` and complete license texts; the
same source notices are installed under
`Resources/legal/speakrs-model-pack/`.

| Title | Author | Source | License | Changes |
|-------|--------|--------|---------|---------|
| `pyannote/segmentation-3.0` | pyannoteAI / CNRS | [original model](https://huggingface.co/pyannote/segmentation-3.0); [pinned repacked source](https://huggingface.co/avencera/speakrs-models/tree/67f963b6a1d94fcd4678948237b3cc8bd69bf1d8) | MIT; Copyright (c) 2020 CNRS | Converted upstream to safetensors/CoreML and repackaged; weights unmodified by AvaNevis |
| `wespeaker-voxceleb-resnet34-LM` | WeSpeaker contributors; upstream pyannote/Speakrs conversion authors | [WeSpeaker](https://github.com/wenet-e2e/wespeaker); [pinned repacked source](https://huggingface.co/avencera/speakrs-models/tree/67f963b6a1d94fcd4678948237b3cc8bd69bf1d8) | CC BY 4.0 | Converted upstream to safetensors/CoreML and repackaged; weights unmodified by AvaNevis |
| PLDA/VBx parameters from `speaker-diarization-community-1` | pyannoteAI | [original pipeline](https://huggingface.co/pyannote/speaker-diarization-community-1); [pinned repacked source](https://huggingface.co/avencera/speakrs-models/tree/67f963b6a1d94fcd4678948237b3cc8bd69bf1d8) | CC BY 4.0 | Extracted upstream and repackaged; parameters unmodified by AvaNevis |
| `speakrs` 0.7.0 | avencera / Praveen Perera | [source](https://github.com/avencera/speakrs/tree/v0.7.0) | Apache-2.0; Copyright 2026 Praveen Perera | AvaNevis selects the offline platform file set and repackages it with notices |
| `cudarc` 0.19.10 | cudarc contributors | [crate source](https://crates.io/crates/cudarc/0.19.10) | MIT OR Apache-2.0 | Dynamically loads NVIDIA CUDA driver APIs. License texts are under `legal/speakrs-model-pack/LICENSES/`. |
| `speakrs-ptx-sm75`, `speakrs-ptx-sm80`, `speakrs-ptx-sm120` 0.7.0 | Speakrs contributors | [kernel source and build](https://github.com/avencera/speakrs/tree/v0.7.0) | Apache-2.0 | Embedded PTX from the checksum-pinned crates.io releases. |
| Vendored `ndarray-npy` | ndarray-npy contributors | [local patch record](native/speakrs-cli/vendor/ndarray-npy/AVANEVIS-PATCH.md) | MIT OR Apache-2.0 | AvaNevis's patched dependency is shared by the native product and separate CPU smoke crates. |
| ONNX Runtime 1.27.1 CUDA 12 | Microsoft Corporation | [release](https://github.com/microsoft/onnxruntime/releases/tag/v1.27.1) | MIT; Copyright (c) Microsoft Corporation | AvaNevis selectively extracts five required DLLs; binaries unmodified |

**Attribution (CC BY 4.0):** When using Speakrs speaker identification, credit the CC BY pack components, for example:  
*Speaker identification uses [Speakrs](https://github.com/avencera/speakrs) (Apache-2.0) with WeSpeaker embeddings and pyannote PLDA/VBx parameters (CC BY 4.0).*

### Optional summaries and Chat — model weights and llama.cpp

| Item | License (typical) | Source |
|------|-------------------|--------|
| Qwen3 / Qwen3.5 GGUF weights (catalog pins) | **Apache-2.0** | e.g. [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B), community GGUF repos such as `unsloth/Qwen3.5-9B-GGUF` |
| Gemma 4 E4B and 12B GGUF weights | **Apache-2.0** | [Gemma 4 E4B](https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF), [Gemma 4 12B](https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF) |
| Inkling 2 Mini GGUF weights (where supported) | **Apache-2.0** | [ggml-org/Inkling-2-Mini-GGUF](https://huggingface.co/ggml-org/Inkling-2-Mini-GGUF) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) runtime binaries | MIT | Downloaded from pinned GitHub releases during summary setup |
| [ai-dock/llama.cpp-cuda](https://github.com/ai-dock/llama.cpp-cuda) Linux CUDA build scripts | MIT | The Linux summary runtimes are pinned to the v0.3.0 (Qwen) and v1.0.0 (Gemma 4) builds; the contained llama.cpp binaries remain MIT |
| NVIDIA CUDA runtime and [NCCL](https://pypi.org/project/nvidia-nccl-cu12/2.31.2/) archives | NVIDIA Software License Agreement (the NCCL wheel's `nvidia/nccl/lib/LICENSE.txt`) | Downloaded only as part of optional user-triggered managed CUDA runtime and Linux summary setup; the pinned wheel is recorded in the catalog |

**Trademark:** “Qwen” is associated with Alibaba Cloud; “Gemma” with Google; and “Inkling” with Thinking Machines Lab. AvaNevis is not affiliated with or endorsed by these organizations.

---

## 3. Development-only dependencies

`npm ci` pulls JavaScript build tooling (e.g. `electron`, `electron-builder`) under their respective npm licenses (mostly MIT). These are not redistributed as application logic in the same way as the Python runtime.

---

## 4. Trademarks

Names such as **Whisper**, **Parakeet**, **Qwen**, **Gemma**, **Inkling**, **pyannote**, **Speakrs**, **Hugging Face**, **Electron**, **NVIDIA**, and **CUDA** are trademarks of their respective owners. AvaNevis uses them only to describe compatible components and does not claim endorsement.

---

## 5. Copyleft compliance (ffmpeg)

If you distribute AvaNevis installers that bundle ffmpeg:

1. Include this file (or the copy installed to `resources/legal/`).
2. Include [legal/ffmpeg-SOURCE-OFFER.txt](legal/ffmpeg-SOURCE-OFFER.txt) and [legal/FFMPEG-COMPLIANCE.json](legal/FFMPEG-COMPLIANCE.json).
3. On [GitHub Releases](https://github.com/AmirArshad/meeting-transcriber/releases), attach **`ffmpeg-8.1.2.tar.xz`** (official FFmpeg source, SHA-256 pinned in `build/download-manifest.js`) on the **same page** as the Windows, macOS, and Linux installers. CI runs `node scripts/stage-release-legal-assets.js` when publishing a version tag.
4. Mention FFmpeg in release notes (see `docs/development/RELEASE_FFMPEG_NOTICE.md`).
5. Honor GPLv3 obligations for the specific ffmpeg build you ship (license text, source offer, and any notices from the third-party binary archive).

Installers intentionally omit the full source tarball to save size; the release page is the canonical source distribution channel for AvaNevis builds produced by this repository.

---

## 6. Questions

For license questions about AvaNevis itself, open a GitHub Discussion or Issue on the project repository. For legal advice about your specific distribution, consult a qualified attorney.

*Last updated for AvaNevis 3.1.x.*
