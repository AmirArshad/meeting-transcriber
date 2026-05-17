# Local AI Model Catalog Maintenance

This app keeps optional local AI add-on artifacts catalog-driven in `src/ai-addon-state.js`. Do not hard-code summary model or runtime filenames in renderer logic.

## Rules

- Keep AvaNevis local-only: no cloud diarization, cloud summarization, telemetry, or background uploads.
- Summary model and runtime downloads must be explicit user-triggered setup actions.
- Speaker diarization dependency installs must be explicit user-triggered setup actions and stay under Electron `userData`.
- Speaker diarization is accelerator-only: Windows uses CUDA, macOS uses Apple Silicon PyTorch Metal/MPS, and CPU-only fallback must not be enabled.
- Setup downloads must emit redacted progress, support cancellation, clean partial `.download` files, and preserve any previously valid install when cancellation happens during validation. Redaction must cover bearer tokens, legacy `Authorization: token ...`, `token=` / `access_token=` / `api_key=` query parameters, `X-Api-Key`, and URL credentials.
- Pin every downloadable summary model and runtime artifact by immutable URL, filename, and SHA-256 checksum.
- Summary model/runtime download URLs must use HTTPS and an allowed artifact host. The allowlist is derived from the configured catalog URLs plus known GitHub/Hugging Face/PyPI redirect hosts; Hugging Face/Xet redirect subdomains under `hf.co` and `huggingface.co` are allowed, while arbitrary HTTPS hosts remain blocked.
- Hugging Face summary model artifacts should download through the bundled Python `huggingface_hub`/`hf_xet` path when available. Keep it unauthenticated for public GGUF models (`token=False` / implicit token disabled), confine both temporary and final paths to the managed cache, and keep post-download SHA-256 verification in the app.
- Prefer official model-owner GGUF artifacts. If unavailable, use established community quantizations with immutable revision URLs.
- Store artifacts under Electron `userData` via the AI add-on cache helpers so app updates do not remove installed add-ons.
- Speaker diarization must use the user's own Hugging Face token stored through Electron `safeStorage` only.

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
10. Run `npm test`, `npm run test:python`, and platform speaker setup smoke tests including cancel during dependency install.

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
6. For ZIP and `tar.gz` archives, keep extraction paths relative and safe; setup creates the extraction directory and rejects unsafe or unparseable archive entries before extraction.
7. Run `npm test` and `npm run test:python`.

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
