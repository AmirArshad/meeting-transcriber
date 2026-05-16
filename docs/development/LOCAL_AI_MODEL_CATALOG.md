# Local AI Model Catalog Maintenance

This app keeps optional local AI add-on artifacts catalog-driven in `src/ai-addon-state.js`. Do not hard-code summary model or runtime filenames in renderer logic.

## Rules

- Keep AvaNevis local-only: no cloud diarization, cloud summarization, telemetry, or background uploads.
- Summary model and runtime downloads must be explicit user-triggered setup actions.
- Speaker diarization dependency installs must be explicit user-triggered setup actions and stay under Electron `userData`.
- Pin every downloadable summary model and runtime artifact by immutable URL, filename, and SHA-256 checksum.
- Summary model/runtime download URLs must use HTTPS and an allowed artifact host (`github.com` for llama.cpp runtime archives, `huggingface.co` for GGUF model artifacts).
- Prefer official model-owner GGUF artifacts. If unavailable, use established community quantizations with immutable revision URLs.
- Store artifacts under Electron `userData` via the AI add-on cache helpers so app updates do not remove installed add-ons.
- Speaker diarization must use the user's own Hugging Face token stored through Electron `safeStorage` only.

## Updating Diarization Dependency Pins

1. Update `DIARIZATION_DEPENDENCY_ARTIFACTS` in `src/ai-addon-state.js`.
2. Keep dependency installs under `userData/ai-addons/dependencies/diarization` so app updates do not remove them.
3. Keep any package indexes HTTPS-only and catalog-driven.
4. Keep `runtime.modelRef` catalog-owned; renderer input must not decide which Hugging Face model is loaded.
5. Validate that packaged build requirements do not include `pyannote.audio` unless every transitive dependency has a binary wheel under the build policy.
6. Run `npm test`, `npm run test:python`, and a Windows speaker setup smoke test.

## Updating Summary Model Pins

1. Pick the catalog entry in `src/ai-addon-state.js` or add a new summary model entry.
2. Use an immutable Hugging Face revision URL, not a moving branch like `main`.
3. Record the exact filename, model label, quantization, expected size, and runtime architecture.
4. Collect the LFS SHA-256 checksum for the exact artifact.
5. Confirm the resolved download URL remains under `huggingface.co`; setup rejects unallowed hosts even when SHA-256 metadata exists.
6. Update the summary model source metadata and the model metadata in `AI_MODEL_CATALOG`.
7. Run `npm test` to verify catalog normalization, checksum status, setup selection, and syntax checks.

## Updating llama.cpp Runtime Pins

1. Update `PINNED_LLAMA_CPP_RUNTIME` in `src/ai-addon-state.js` with the release tag and commit.
2. Update every platform entry in `SUMMARY_RUNTIME_ARTIFACTS`.
3. Include all runtime archives needed for the platform, including CUDA dependency archives when required.
4. Keep runtime archive URLs under `github.com`; setup rejects unallowed hosts even when SHA-256 metadata exists.
5. Keep `executableName` aligned with the extracted `llama-cli` binary. Runtime archives extract into a cleaned staging directory and the executable is copied to the stable runtime directory.
6. For ZIP archives, keep extraction paths relative and safe; setup rejects archive entries that escape the extraction directory.
7. Run `npm test` and `npm run test:python`.

## Validation Checklist

- `npm test`
- `npm run test:python`
- `npm run prepare-build` when runtime packaging or prepared resources change
- Manual summary setup on Windows CUDA and macOS Apple Silicon when artifacts change
- Confirm failed checksum/runtime validation keeps setup out of `ready`
- Confirm no transcript text, prompts, or tokens appear in progress events or logs
- Confirm summary generation and diarization are serialized so concurrent local AI runs do not compete for GPU memory
- Confirm meeting AI metadata only stores `diarization` and `summary`, with sidecar paths under recordings and concise string fields

## Troubleshooting Pins

- Missing checksum: setup must refuse to mark the model ready.
- Missing URL: setup must refuse to download the artifact.
- Unallowed download host: setup must refuse to download the artifact.
- Checksum mismatch: delete the cached file, re-download intentionally, and verify whether the upstream artifact changed.
- Unsafe ZIP entry: reject the archive and verify the upstream runtime packaging before updating pins.
- Missing `llama-cli`: inspect the runtime archive layout, cleaned extraction staging, and `executableName` before updating pins.
- Unsupported platform: keep status `unsupported`; do not add fallback cloud behavior.
