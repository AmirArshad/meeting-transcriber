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
| [Python](https://www.python.org/) | Embedded / standalone runtime in installer | PSF License | See python.org license page |
| [ffmpeg](https://ffmpeg.org/) | Opus compression after recording | **GPLv3** (typical third-party builds) | See [legal/ffmpeg-SOURCE-OFFER.txt](legal/ffmpeg-SOURCE-OFFER.txt) and [legal/FFMPEG-COMPLIANCE.json](legal/FFMPEG-COMPLIANCE.json). Windows: gyan.dev essentials build. macOS: shaka-project/static-ffmpeg-binaries arm64 static build. Windows builds may include `legal/ffmpeg-upstream-*` copied from the gyan.dev archive. |
| Python packages in `requirements-*-build.txt` | Recording, transcription, HF downloads | Mostly MIT / BSD / Apache-2.0 | Non-exhaustive list below |
| macOS `audiocapture-helper` (Swift) | Desktop audio capture | Same as AvaNevis (MIT) unless otherwise noted in `swift/` | |

### Notable bundled Python packages

| Package | License (typical) |
|---------|-------------------|
| faster-whisper, ctranslate2 | MIT |
| lightning-whisper-mlx, mlx | MIT |
| numpy, scipy, soxr | BSD |
| pyaudiowpatch, sounddevice | MIT |
| huggingface-hub, hf-xet, httpx | Apache-2.0 |
| pyobjc-* (macOS) | MIT |

Full pinned versions: `requirements-windows-build.txt`, `requirements-macos-build.txt`. A generated table of direct pins lives in [legal/PYTHON-BUNDLED-PACKAGES.md](legal/PYTHON-BUNDLED-PACKAGES.md) (refresh with `npm run legal:sbom`).

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

### Optional speaker diarization — pyannote

| Item | License | Terms |
|------|---------|--------|
| `pyannote/speaker-diarization-community-1` | **CC BY 4.0** | Gated on Hugging Face; users must accept model terms and provide their own Hugging Face token. AvaNevis does not ship model weights or maintainer tokens. |
| `pyannote.audio`, PyTorch (CUDA/MPS) | MIT / BSD-style (+ NVIDIA CUDA redistribution terms when CUDA builds are installed) | Installed during explicit speaker setup into user data |

**Attribution (CC BY 4.0):** When using speaker diarization, credit the model, for example:  
*Speaker diarization uses [pyannote Speaker Diarization Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (CC BY 4.0).*

### Optional meeting summaries — Qwen + llama.cpp

| Item | License (typical) | Source |
|------|-------------------|--------|
| Qwen3 / Qwen3.5 GGUF weights (catalog pins) | **Apache-2.0** | e.g. [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B), community GGUF repos such as `unsloth/Qwen3.5-9B-GGUF` |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) runtime binaries | MIT | Downloaded from pinned GitHub releases during summary setup |
| NVIDIA CUDA runtime archives (Windows summary/diarization GPU paths) | NVIDIA Software License Agreement | Bundled only as part of optional user-triggered GPU runtime downloads |

**Trademark:** “Qwen” is associated with Alibaba Cloud. AvaNevis is not affiliated with or endorsed by Alibaba.

---

## 3. Development-only dependencies

`npm install` pulls JavaScript tooling (e.g. electron, electron-builder, adm-zip) under their respective npm licenses (mostly MIT). These are not redistributed as application logic in the same way as the Python runtime.

---

## 4. Trademarks

Names such as **Whisper**, **Qwen**, **pyannote**, **Hugging Face**, **Electron**, **NVIDIA**, and **CUDA** are trademarks of their respective owners. AvaNevis uses them only to describe compatible components and does not claim endorsement.

---

## 5. Copyleft compliance (ffmpeg)

If you distribute AvaNevis installers that bundle ffmpeg:

1. Include this file (or the copy installed to `resources/legal/`).
2. Include [legal/ffmpeg-SOURCE-OFFER.txt](legal/ffmpeg-SOURCE-OFFER.txt) and [legal/FFMPEG-COMPLIANCE.json](legal/FFMPEG-COMPLIANCE.json).
3. On [GitHub Releases](https://github.com/AmirArshad/meeting-transcriber/releases), attach **`ffmpeg-8.0.1.tar.xz`** (official FFmpeg source, SHA-256 pinned in `build/download-manifest.js`) on the **same page** as the Windows/macOS installers. CI runs `node scripts/stage-release-legal-assets.js` when publishing a version tag.
4. Mention FFmpeg in release notes (see `docs/development/RELEASE_FFMPEG_NOTICE.md`).
5. Honor GPLv3 obligations for the specific ffmpeg build you ship (license text, source offer, and any notices from the third-party binary archive).

Installers intentionally omit the full source tarball to save size; the release page is the canonical source distribution channel for AvaNevis builds produced by this repository.

---

## 6. Questions

For license questions about AvaNevis itself, open a GitHub Discussion or Issue on the project repository. For legal advice about your specific distribution, consult a qualified attorney.

*Last updated for AvaNevis 2.1.x open-source distribution.*
