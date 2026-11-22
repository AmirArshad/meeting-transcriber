# Local AI Model Catalog Maintenance

This app keeps optional local AI add-on artifacts catalog-driven in `src/ai-addon-state.js`. Do not hard-code summary model or runtime filenames in renderer logic.

For v2.10.2, Python download children enforce `HF_HUB_DISABLE_XET=1` so
Hugging Face downloads use patched certifi rather than the independent native
Xet trust stack. Keep the hf-xet dependency pin for Hub dependency closure;
re-enable acceleration only after its trust handling is patched and qualified.

## Rules

### Summary language policy

The installed `qwen3.5-9b-q4-k-m` model has bounded local synthetic evidence for
`en/es/fr/de/zh/ja/it/pa/hi/ko/pt`, including Chinese and Panjabi script cases.
See [the recorded checks and limits](V2_10_SUMMARY_QUALIFICATION.md).
`src/summary-language-policy.js` owns eligibility and policy revision
(`summary-language-v4`); add-on status exposes it without inference or downloads.
`qwen3.5-4b-q4-k-m` is installable for local Chat. Bonsai 2, Ministral 3 14B,
Gemma 4 26B-A4B, and Qwen 3.8 27B become available for Chat on each platform
after native 32k setup and Chat checks. Both Bonsai 2 models are available for
Linux CUDA Chat. The new peers' summary languages require separate native
qualification. Gemma 4 E4B and 12B
offer English summaries on Apple Silicon after the [v3.1 checks](V3_1_QUALIFICATION.md).
Other Gemma language and platform combinations remain gated. Existing platform
runtime admission still applies.
Generation requires transcript-language confirmation tied to its hash; chunk,
merge and repair share that language, and the selected local model checks prose
language before committing sidecars.

### Artifact and setup rules

- Keep AvaNevis local-only: no cloud diarization, cloud summarization, telemetry, or background uploads.
- Summary model and runtime downloads must be explicit user-triggered setup actions.
- Speaker diarization setup must be explicit and stays under Electron `userData`. Speakrs 0.7 uses direct model files at an immutable upstream revision; pyannote uses its managed Python dependencies and Hugging Face cache.
- Speaker diarization is accelerator-only: Windows uses CUDA; macOS uses Apple Silicon CoreML for Speakrs or PyTorch Metal/MPS for pyannote. Linux is Speakrs-only, CUDA-only on x86_64 after the accepted managed CUDA 12 preflight, and has no CPU fallback. Pyannote is not a Linux product option. Linux Summaries & Chat (Qwen3.5 and Gemma 4; Inkling 2 Mini gated) are CUDA-only and remain unavailable unless managed CUDA 12 admission, pinned runtime/model integrity, and platform gates pass. Linux Speakrs 0.7 requires the same live managed CUDA 12 admission before native inference.
- Setup downloads must emit redacted progress, support cancellation, clean partial `.download` files, and preserve any previously valid install when cancellation happens during validation. Redaction must cover bearer tokens, legacy `Authorization: token ...`, `token=` / `access_token=` / `api_key=` query parameters, `X-Api-Key`, and URL credentials.
- Pin every downloadable summary model and runtime artifact by immutable URL, filename, and SHA-256 checksum.
- Summary model/runtime download URLs must use HTTPS and an allowed artifact host. The allowlist is derived from catalog **download-related** keys only (`downloadUrl`, `url`, `indexUrl`, `extraIndexUrls`) plus known GitHub/Hugging Face/PyPI redirect hosts listed explicitly in `DOWNLOAD_REDIRECT_HOSTS` (`src/ai-addon/download-helpers.js`). `licenseUrl` / `releaseUrl` / docs links must not expand the allowlist. Do **not** wildcard `*.hf.co` / `*.huggingface.co`; when HF/Xet rotates CDN subdomains, add the new host to that set. HF-hosted summary models normally download via bundled Python `huggingface_hub` HTTP (bypassing the JS allowlist) and still require pinned SHA-256 verification. Arbitrary HTTPS hosts remain blocked.
- Hugging Face summary model artifacts should download through the bundled Python `huggingface_hub` HTTP path when available. Keep it unauthenticated for public GGUF models (`token=False` / implicit token disabled), confine both temporary and final paths to the managed cache, and keep post-download SHA-256 verification in the app.
- Prefer official model-owner GGUF artifacts. If unavailable, use established community quantizations with immutable revision URLs.
- Keep context, native prompt format and CLI flags bound to the model and its pinned runtime. Setups test explicitly selected models and inference stays local.
- Store artifacts under Electron `userData` via the AI add-on cache helpers so app updates do not remove installed add-ons.
- Pyannote diarization must use the user's own Hugging Face token stored through Electron `safeStorage` only. Speakrs is token-free and must not inspect, decrypt, or store Hugging Face tokens.
- Adding or renaming a speaker engine must keep Settings About credits, `THIRD_PARTY_NOTICES.md`, and `tests/js/legal-notices.test.js` in sync.

### Summaries & Chat model library

The catalog is organized into three hardware tiers (`Compact`, `Balanced`, and
`High-Capability`) so Settings stays scannable across 10 curated models:

- **Compact:** `qwen3.5-4b-q4-k-m` (2.74 GB) and Prism ML `bonsai-2-9b-q2-0`
  (`prism-ml/Ternary-Bonsai-2-9B-gguf` `Q2_0`, 2,556,640,128 bytes).
- **Balanced:** `qwen3.5-9b-q4-k-m` (5.68 GB, default), official ggml-org
  `gemma-4-e4b` (`Q4_0`, 4,590,807,392 bytes) and `gemma-4-12b` (`Q4_0`,
  7,219,673,216 bytes), Prism ML `bonsai-2-27b-q2-0`
  (`prism-ml/Ternary-Bonsai-2-27B-gguf` `Q2_0`, 7,626,008,928 bytes), and
  Mistral AI `ministral-3-14b` (`unsloth/Ministral-3-14B-Instruct-2512-GGUF`
  `Q4_K_M`, 8,239,067,840 bytes).
- **High-Capability:** official ggml-org `gemma-4-26b-a4b` (`Q4_0`,
  14,618,145,824 bytes), `qwen3.8-27b` (`unsloth/Qwen3.8-27B-GGUF` `UD-Q4_K_M`,
  16,564,259,744 bytes), and `inkling-2-mini` (`IQ4_NL`, 17,627,940,768 bytes,
  platform-gated pending 24+ GiB qualification).

Bonsai 2 (`9B` and `27B`) uses stock `Q2_0` on upstream `llama.cpp b12631`.
Both Bonsai models, `qwen3.8-27b`, and `inkling-2-mini` pass `--reasoning off`
and `--reasoning-budget 0` to preserve output tokens for structured responses.
The catalog uses text weights with a 32,768-token context window. Memory tiers
are advisory, and Linux CUDA fit uses measured allocation floors for both Bonsai
models. The [qualification record](V3_2_QUALIFICATION.md) lists verified pins,
measurements and platform checks.

Gemma 4 E4B and 12B use official `ggml-org/llama.cpp` `b12631` on Linux x64
CUDA 12.8. Gemma 4 E4B and 12B keep `b12606` on macOS arm64 Metal and Windows
x64 CUDA 12.4 while the pinned `b12631` builds await native qualification.
Bonsai 2 (`9B`, `27B`), Ministral 3 14B, Gemma 4 26B-A4B, Qwen 3.8 27B, and
Inkling 2 Mini share the official `b12631` runtime across Windows, macOS, and
Linux. Qwen3.5 retains its qualified runtime pins (`b9173` on Windows/macOS,
ai-dock `v0.3.0` on Linux) for zero-redownload continuity while the library
shares each runtime version among compatible models. Existing private runtimes
remain readable until verified adoption. Check the hardware results and
remaining gates in the [v3.1 qualification record](V3_1_QUALIFICATION.md) and
[v3.2 qualification record](V3_2_QUALIFICATION.md).

Inkling 2 Mini uses the official ggml-org `IQ4_NL` pin and is wired to the
shared `b12631` runtime (20 commits ahead of the loop-layer scale fix
`690b87d8`) with 32,768-token context and non-thinking CLI settings. Each
platform gate (`win32`, `darwin`, `linux`) stays `gated` until native 32k
Inkling 2 Mini setup, Chat, and summary qualification is recorded in the
[v3.2 qualification record](V3_2_QUALIFICATION.md) on a 24+ GiB GPU or 32+ GiB
Apple Silicon host. Working-memory figures remain planning estimates until
measured on representative supported hosts.

### Linux Qwen and Gemma 4 summary runtime pins

The active Linux Qwen3.5 summary lane uses the catalog entry
`llama-cpp-v0.3.0-linux-x64-cuda-12.8`: ai-dock's MIT llama.cpp v0.3.0
CUDA 12.8 amd64 release paired with the pinned NVIDIA CUDA runtime and NCCL
wheels. The NCCL wheel is used only by the legacy Linux Qwen3.5 summary
runtime and carries the NVIDIA Software License Agreement at
`nvidia/nccl/lib/LICENSE.txt`. The Linux Gemma 4 and v3.2 shared
summary lane uses `llama-cpp-b12631-linux-x64-cuda-12.8`: official
`ggml-org/llama.cpp` `b12631` Ubuntu CUDA 12.8 x64 paired with its official
`cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz` archive (`libcudart.so.12`,
`libcublas.so.12`, `libcublasLt.so.12`; no NCCL dependency). The Windows
`b12631` candidate pairs with `cudart-llama-bin-win-cuda-12.4-x64.zip`.
Both official CUDA archives are covered by the
[NVIDIA CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/index.html).
The release archives, wheel sizes, SHA-256 values, extracted regular-file pins,
and license links live in `src/ai-addon-state.js` and the v2.9 / v3.1 / v3.2
qualification records. Linux requires managed CUDA 12 admission and local
artifact verification before setup or compute.

## Runtime Cache Locations

- The canonical location is whatever `src/main.js` logs as `app.getPath("userData")` at startup. AI add-ons are stored below that path in `ai-addons/`.
- On Windows `npm start`, local testing has placed the app-managed AI add-ons at `%APPDATA%\avanevis\Cache\avanevis\ai-addons`. Summary weights live under `models\summary`, shared llama.cpp builds under `runtimes\llama-cpp\<runtime-id>`, and older private builds under the model's `runtime`. Speakrs models live under `models\diarization\speakrs\<revision>\<install-id>`, and pyannote/PyTorch dependencies live under `dependencies\diarization`. Older Speakrs installations can also have a private ONNX Runtime under `runtimes\speakrs-ort`.
- Packaged Windows installs may resolve the same physical profile path because Windows paths are case-insensitive. Do not delete `ai-addons` when you intend to preserve installed Qwen/diarization setup for the packaged app.
- Safe cleanup candidates for duplicate downloads are transient caches such as `%LOCALAPPDATA%\pip\cache`, `%LOCALAPPDATA%\Temp\pip-*`, incomplete `*.download` files, and stale Hugging Face/Xet transfer staging directories. These are redownloadable and are not the installed model/runtime cache.

## Updating Diarization Dependency Pins

1. Update `DIARIZATION_DEPENDENCY_ARTIFACTS` in `src/ai-addon-state.js`.
2. Keep dependency installs under `userData/ai-addons/dependencies/diarization` so app updates do not remove them.
3. Keep any package indexes HTTPS-only, catalog-driven, and covered by the setup download host allowlist.
4. Keep `runtime.modelRef` catalog-owned; renderer input must not decide which Hugging Face model is loaded.
5. Keep platform pins accelerator-specific: `win32-x64` must remain CUDA-only and `darwin-arm64` must remain MPS-only. Do not add `darwin-x64` or CPU-only artifacts.
6. Validate that setup calls the backend with a required device (`cuda` or `mps`) and refuses Ready when `torch.backends.mps.is_built()` / `torch.backends.mps.is_available()` or CUDA checks fail.
7. Keep managed dependency installs under packaged Python with `pip` available. Source builds are allowed only through curated pinned source artifacts such as `julius`; do not enable broad transitive source builds. Keep the macOS Command Line Tools preflight and validate dependency resolution before changing this policy.
8. Validate that packaged build requirements do not include `pyannote.audio` unless every transitive dependency fits the build policy.
9. Confirm old artifact directories under `userData/ai-addons/dependencies/diarization` are cleaned when a new dependency artifact is installed.
10. Confirm actual diarization runs load pyannote from the local Hugging Face cache only after setup; missing or incomplete cache should tell the user to re-run speaker setup.
11. Run `npm test`, `npm run test:python`, and platform speaker setup smoke tests including cancel during dependency install.

## Updating Speakrs model pins

The active 0.7 upstream revision is `avencera/speakrs-models@67f963b6a1d94fcd4678948237b3cc8bd69bf1d8`. Keep the seven shared files, two CUDA/CPU safetensors, and 60 CoreML leaves in `src/ai-addon/speakrs-model-files.json`. Normal CoreML requires the bundle formats supported by macOS 15+.

1. Derive the file sets from the exact upstream crate's backend requirements. Recompute each size and SHA-256 from actual downloaded bytes, preserving bundle-relative paths.
2. Pin immutable public HTTPS URLs in the catalog and verify allowed redirect hosts. Run `node scripts/verify-speakrs-packaging.js --verify-pack-checksums` to check all distinct files.
3. Explicit setup stages files in the owned model root. Native validation uses staged paths and the required accelerator. The atomic manifest update activates the verified installation. Old revision files remain available for a manual downgrade or repair. Remove owns the Speakrs models and private legacy runtime tree.
4. Keep shared CUDA and Whisper runtime ownership independent. Linux requires live admission even when the Speakrs kernels only load the NVIDIA driver. Windows native loader ownership remains pending qualification.
5. Keep attribution and complete license texts under `legal/speakrs-model-pack/`. The optional offline archive builder uses the same pinned files, with no required archive publication for product setup.
6. Run the focused setup, integrity and packaging tests plus native packaged inference before activating a platform.

## Updating Summary Model Pins

The existing Qwen summary implementation is enabled for Windows x64 CUDA
and macOS arm64 Metal. Linux uses the same summary service, sidecar contract,
profiles, and `aiComputeActionQueue`, but its catalog entry must be a distinct
CUDA-only `linux-x64` artifact/runtime admission: x86_64, NVIDIA detection,
admitted managed CUDA 12, verified model/runtime closure, and packaged RTX 4070
evidence are all required before status can become `ready`. Linux must not
reuse a CPU, Vulkan, SYCL, ROCm, cloud, or ambient-library path.

1. Pick the catalog entry in `src/ai-addon-state.js` or add a new summary model entry.
2. Use an immutable Hugging Face revision URL, not a moving branch like `main`.
3. Record the exact filename, model label, quantization, expected size, and runtime architecture.
4. Collect the LFS SHA-256 checksum for the exact artifact.
5. Confirm the configured URL and any expected redirects are covered by the setup download host allowlist; setup rejects unallowed hosts even when SHA-256 metadata exists.
6. Update the summary model source metadata and the model metadata in `AI_MODEL_CATALOG`.
7. Confirm packaged Windows and macOS requirements still include compatible `huggingface-hub` and `hf-xet` pins if the artifact is hosted on Hugging Face.
8. Run `npm test` to verify catalog normalization, checksum status, setup selection, cancellation, and syntax checks.

The prior Linux summary deferral is historical: the pinned `b9173` release was
rejected because it did not publish a Linux CUDA x86_64 asset. Preserve that
rejection as evidence, and do not add Linux catalog pins until a redistributable
CUDA runtime decision has an exact source/release/commit, license, archive
layout, byte size, SHA-256, complete dynamic-library closure, and RTX 4070
inference smoke record.

## Updating llama.cpp Runtime Pins

1. Update `PINNED_LLAMA_CPP_RUNTIME` (and model-specific runtime entries) in `src/ai-addon-state.js` with the release tag and commit.
2. Update every platform entry in `SUMMARY_RUNTIME_ARTIFACTS`.
3. Include all runtime archives needed for the platform, including CUDA dependency archives when required.
4. Keep runtime archive URLs under trusted release hosts covered by the setup download host allowlist; setup rejects unallowed hosts even when SHA-256 metadata exists.
5. Keep `executableName` (`llama-cli`) and `serverExecutableName` (`llama-server`) aligned with the extracted layout under `ai-addons/runtimes/llama-cpp/<runtime-id>/extract/` so Windows DLLs, Linux `.so` libraries, and macOS dylibs remain beside the executables. Shared runtimes are reused across models pinned to the same runtime ID.
6. For ZIP and `tar.gz` archives, keep extraction paths relative and safe; shared validation lives in `src/ai-addon-archive-helpers.js`. On-disk runtime archives extract off the main thread (`src/ai-addon-zip-extractor-worker.js` on Windows, `src/ai-addon-tar-extractor-worker.js` on macOS/Linux). Setup creates the extraction directory and rejects unsafe or unparseable archive entries before extraction.
7. Confirm the pinned runtime supports the non-interactive CLI flags used by setup/generation (`--no-warmup`, `--single-turn`, `--simple-io`, and the model's reasoning flag) and `llama-server` loopback flags (`--no-webui`, `--parallel 1`, `--reasoning off`, `LLAMA_API_KEY` env) before changing runtime pins.
8. Run `npm test` and `npm run test:python`.

## Validation Checklist

- `npm test`
- `npm run test:python`
- `npm run prepare-build` when runtime packaging or prepared resources change
- Manual summary setup on Windows CUDA and macOS Apple Silicon when artifacts change
- Cancel summary setup during the Hugging Face model download and confirm the downloader child process exits and partial files are removed
- Confirm failed checksum/runtime validation keeps setup out of `ready`
- Confirm canceling setup removes partial downloads and does not remove a previously valid model/runtime
- Confirm Windows speaker setup still requires CUDA and macOS speaker setup still requires Apple Silicon MPS, with no CPU fallback on either platform
- Confirm no transcript text, prompts, or tokens appear in progress events or logs
- Confirm summary generation and diarization are serialized so concurrent local AI runs do not compete for GPU memory
- Confirm meeting AI metadata only stores `diarization` and `summary`, with sidecar paths under recordings and concise string fields

## Troubleshooting Pins

- Missing checksum: setup must refuse to mark the model ready.
- Missing URL: setup must refuse to download the artifact.
- Unallowed download host: setup must refuse to download the artifact.
- Checksum mismatch: delete the cached file, re-download intentionally, and verify whether the upstream artifact changed.
- Unsafe or unparseable runtime archive entry: reject the archive and verify the upstream runtime packaging before updating pins.
- Missing `llama-cli` or `llama-server`: inspect the runtime archive layout under `ai-addons/runtimes/llama-cpp/<runtime-id>/extract/` (or legacy `runtime/<platform-arch>/extract/`), cleaned extraction staging, and `executableName` before updating pins.
- Unsupported platform: keep status `unsupported`; do not add fallback cloud behavior.
- Missing accelerator: keep speaker setup out of `ready`; do not silently run CPU diarization.
- Missing pyannote cache during diarization: keep runtime offline/local-only and ask the user to re-run speaker identification setup.
