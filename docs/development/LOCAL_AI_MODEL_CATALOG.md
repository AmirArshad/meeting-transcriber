# Local AI Model Catalog Maintenance

This app keeps optional local AI add-on artifacts catalog-driven in `src/ai-addon-state.js`. Do not hard-code summary model or runtime filenames in renderer logic.

## Rules

- Keep AvaNevis local-only: no cloud diarization, cloud summarization, telemetry, or background uploads.
- Summary model and runtime downloads must be explicit user-triggered setup actions.
- Speaker diarization setup must be explicit and stays under Electron `userData`. Speakrs uses a self-hosted model-pack archive plus a Windows or Linux ONNX Runtime closure; pyannote uses its managed Python dependencies and Hugging Face cache.
- Speaker diarization is accelerator-only: Windows uses CUDA; macOS uses Apple Silicon CoreML for Speakrs or PyTorch Metal/MPS for pyannote. Linux is Speakrs-only, CUDA-only on x86_64 after the accepted managed CUDA 12 preflight, and has no CPU fallback. Pyannote is not a Linux product option; llama.cpp summaries stay unavailable until their later gate. Task 4 pins remain the Linux `speakrs-cli` and setup-time CUDA 12 ORT/model-pack closure in `src/ai-addon/speakrs-pack-spec.js`; do not weaken those pins.
- Setup downloads must emit redacted progress, support cancellation, clean partial `.download` files, and preserve any previously valid install when cancellation happens during validation. Redaction must cover bearer tokens, legacy `Authorization: token ...`, `token=` / `access_token=` / `api_key=` query parameters, `X-Api-Key`, and URL credentials.
- Pin every downloadable summary model and runtime artifact by immutable URL, filename, and SHA-256 checksum.
- Summary model/runtime download URLs must use HTTPS and an allowed artifact host. The allowlist is derived from catalog **download-related** keys only (`downloadUrl`, `url`, `indexUrl`, `extraIndexUrls`) plus known GitHub/Hugging Face/PyPI redirect hosts listed explicitly in `DOWNLOAD_REDIRECT_HOSTS` (`src/ai-addon/download-helpers.js`). `licenseUrl` / `releaseUrl` / docs links must not expand the allowlist. Do **not** wildcard `*.hf.co` / `*.huggingface.co`; when HF/Xet rotates CDN subdomains, add the new host to that set. HF-hosted summary models normally download via bundled Python `huggingface_hub`/`hf_xet` (bypassing the JS allowlist) and still require pinned SHA-256 verification. Arbitrary HTTPS hosts remain blocked.
- Hugging Face summary model artifacts should download through the bundled Python `huggingface_hub`/`hf_xet` path when available. Keep it unauthenticated for public GGUF models (`token=False` / implicit token disabled), confine both temporary and final paths to the managed cache, and keep post-download SHA-256 verification in the app.
- Prefer official model-owner GGUF artifacts. If unavailable, use established community quantizations with immutable revision URLs.
- Keep summary runtime flags compatible with the selected catalog model. The current Qwen3.5/llama.cpp path runs with reasoning disabled; parameterize that before adding a non-Qwen3 model that needs different flags.
- Store artifacts under Electron `userData` via the AI add-on cache helpers so app updates do not remove installed add-ons.
- Pyannote diarization must use the user's own Hugging Face token stored through Electron `safeStorage` only. Speakrs is token-free and must not inspect, decrypt, or store Hugging Face tokens.
- Adding or renaming a speaker engine must keep Settings About credits, `THIRD_PARTY_NOTICES.md`, and `tests/js/legal-notices.test.js` in sync.

## Runtime Cache Locations

- The canonical location is whatever `src/main.js` logs as `app.getPath("userData")` at startup. AI add-ons are stored below that path in `ai-addons/`.
- On Windows `npm start`, local testing has placed the app-managed AI add-ons at `%APPDATA%\avanevis\Cache\avanevis\ai-addons`. In that tree, Qwen summaries live under `models\summary`, the llama.cpp runtime lives under the selected summary model's `runtime`, Speakrs models live under `models\diarization\speakrs\<revision>`, its private ONNX Runtime closure lives under `runtimes\speakrs-ort`, and pyannote/PyTorch dependencies live under `dependencies\diarization`.
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

## Updating Speakrs Model-Pack Pins

These rules live **alongside** the still-live pyannote dependency-pin rules above. Do not delete pyannote pins.

| Pin | Value |
|-----|--------|
| Upstream repo | `avencera/speakrs-models` |
| Revision | `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f` (`5d24ffe`) |
| Windows pack | `speakrs-models-5d24ffe-win32-x64-cuda.tar.gz` — sha256 `a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20`, 208765985 bytes, 19 ONNX/PLDA files |
| Linux pack | same published CUDA archive as Windows (`speakrs-models-5d24ffe-win32-x64-cuda.tar.gz`, same hash/size/19 files); pack-spec and catalog id `speakrs-models-5d24ffe-linux-x64-cuda`, `architecture: x64`, `cudaMajor: 12`. Setup and guided transcription admit only after x64/CUDA preflight. |
| macOS pack | `speakrs-models-5d24ffe-darwin-arm64-coreml.tar.gz` — sha256 `0677b5eee394402ddd4cbdb991afd0736c24e955b145d4b98f69d63523cc8d50`, 375813778 bytes, 76 CoreML/ONNX/PLDA leaves |
| Windows ORT | official `onnxruntime-win-x64-gpu_cuda12-1.27.1.zip` plus NVIDIA `cudart64_12` / `cufft64_11` wheels — setup-time only |
| Linux ORT | official `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` (244,763,765 bytes, `08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf`) plus NVIDIA `libcudart.so.12` / `libcufft.so.11` / `libcurand.so.10` / `libnvrtc.so.12` wheels — setup-time only; compile-time pin `linux-x64: null` |

Per-mode file lists and per-file SHA-256 values live in `src/ai-addon/speakrs-model-files.json` (`cudaPins` / `coremlPins`). Do not invent a shorter list.

1. Pin the immutable `avencera/speakrs-models` revision in `src/ai-addon/speakrs-pack-spec.js`; keep `scripts/build-speakrs-model-pack.js`'s binding revision identical.
2. Update `src/ai-addon/speakrs-model-files.json` only from the exact `speakrs` `required_files` lists and verify every source size and SHA-256.
3. Build one archive per platform with:
   - `node scripts/build-speakrs-model-pack.js --platform win32-x64 --source <snapshot-dir> --out <output-dir>`
   - `node scripts/build-speakrs-model-pack.js --platform darwin-arm64 --source <snapshot-dir> --out <output-dir>`
   - `node scripts/build-speakrs-model-pack.js --platform linux-x64 --source <snapshot-dir> --out <output-dir>` (same CUDA ONNX subset as Windows; Linux currently publishes that existing archive URL)
4. The builder must preserve nested `.mlmodelc` paths and inject `legal/speakrs-model-pack/ATTRIBUTION.md` plus every complete text under `LICENSES/`. Do not publish a pack if those files are missing.
5. Publish packs only on a dedicated GitHub model-artifact release, not an AvaNevis application release. Record each exact public URL, byte size, and SHA-256 in `SPEAKRS_MODEL_PACK_ARTIFACTS`; absent metadata must keep production setup fail-closed.
6. Keep the Windows and Linux runtimes separate from the model pack. Windows must use the pinned ONNX Runtime 1.27.1 CUDA 12 archive and NVIDIA runtime/cuFFT wheels, extract only `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll`, `cudart64_12.dll`, and `cufft64_11.dll`. Linux must use the pinned `onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz` archive and NVIDIA `libcudart.so.12` / `libcufft.so.11` / `libcurand.so.10` / `libnvrtc.so.12` wheels, extract only `libonnxruntime.so.1.27.1`, `libonnxruntime_providers_shared.so`, `libonnxruntime_providers_cuda.so`, `libcudart.so.12`, `libcufft.so.11`, `libcurand.so.10`, and `libnvrtc.so.12`. Pin each extracted file's SHA-256 and size in catalog/spec `extractedFiles`. Installation and setup validation full-hash those immutable pins. Passive status checks enforce the pinned sizes plus archive identity; every Speakrs compute admission hashes changed `path + size + mtimeMs` fingerprints before spawn. Never trust hashes written into user-writable `install.json`.
7. Never delete shared CUDA pip packages, Whisper caches, or the packaged `Resources/bin/speakrs-cli`. Speakrs uninstall owns only `models/diarization/speakrs` and `runtimes/speakrs-ort`.
8. Keep `licenseUrl` / `licenseUrls` metadata accurate. These fields document the MIT, CC-BY-4.0, and Apache-2.0 constituents and must not expand the download allowlist.
9. Validate archive traversal rejection, per-file model checksums, all five Windows DLLs, cancellation cleanup, token-store isolation, and redacted progress with `npm test`.
10. `speakrs-cli` is built by `build/prepare-resources.js` and installer-bundled. Pin `ort` compile-time downloads in `native/speakrs-cli/ort-compile-pins.json` only — never in `build/download-manifest.js`.

## Updating Summary Model Pins

1. Pick the catalog entry in `src/ai-addon-state.js` or add a new summary model entry.
2. Use an immutable Hugging Face revision URL, not a moving branch like `main`.
3. Record the exact filename, model label, quantization, expected size, and runtime architecture.
4. Collect the LFS SHA-256 checksum for the exact artifact.
5. Confirm the configured URL and any expected redirects are covered by the setup download host allowlist; setup rejects unallowed hosts even when SHA-256 metadata exists.
6. Update the summary model source metadata and the model metadata in `AI_MODEL_CATALOG`.
7. Confirm packaged Windows and macOS requirements still include compatible `huggingface-hub` and `hf-xet` pins if the artifact is hosted on Hugging Face.
8. Run `npm test` to verify catalog normalization, checksum status, setup selection, cancellation, and syntax checks.

## Updating llama.cpp Runtime Pins

1. Update `PINNED_LLAMA_CPP_RUNTIME` in `src/ai-addon-state.js` with the release tag and commit.
2. Update every platform entry in `SUMMARY_RUNTIME_ARTIFACTS`.
3. Include all runtime archives needed for the platform, including CUDA dependency archives when required.
4. Keep runtime archive URLs under trusted release hosts covered by the setup download host allowlist; setup rejects unallowed hosts even when SHA-256 metadata exists.
5. Keep `executableName` aligned with the extracted `llama-cli` binary. Runtime archives extract under the managed runtime cache's `extract/` directory, and execution should prefer the extracted archive layout so Windows DLLs and macOS dylibs remain beside the executable.
6. For ZIP and `tar.gz` archives, keep extraction paths relative and safe; shared validation lives in `src/ai-addon-archive-helpers.js`. On-disk runtime archives extract off the main thread (`src/ai-addon-zip-extractor-worker.js` on Windows, `src/ai-addon-tar-extractor-worker.js` on macOS). Setup creates the extraction directory and rejects unsafe or unparseable archive entries before extraction.
7. Confirm the pinned runtime supports the non-interactive CLI flags used by setup/generation (`--no-warmup`, `--single-turn`, `--simple-io`, and the current Qwen reasoning flag) before changing runtime pins.
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
- Missing `llama-cli`: inspect the runtime archive layout under `runtime/<platform-arch>/extract/`, cleaned extraction staging, and `executableName` before updating pins.
- Unsupported platform: keep status `unsupported`; do not add fallback cloud behavior.
- Missing accelerator: keep speaker setup out of `ready`; do not silently run CPU diarization.
- Missing pyannote cache during diarization: keep runtime offline/local-only and ask the user to re-run speaker identification setup.
