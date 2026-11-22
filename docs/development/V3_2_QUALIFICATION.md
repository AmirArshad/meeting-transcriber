# AvaNevis 3.2 Local AI Qualification Record

This document records verified runtime artifact digests, Linux ELF dynamic-library closure, and native host checks for AvaNevis 3.2. Platform gates stay closed until matching native hardware evidence is recorded here.

## Slice C1: Unified `llama.cpp` `b12631` Runtime Pin & Inkling 2 Mini Status (2026-11-22)

### Upstream release & verified archive digests

- **Repository:** `ggml-org/llama.cpp`
- **Tag:** `b12631` (published `2026-11-22T09:03:19Z`). The [GitHub release API](https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b12631) reported release ID `454321893` with `immutable: false`.
- **Commit:** `e300919cc704ddde3a8a8346a8714f57eeeee71b` (20 commits ahead of Inkling loop-layer scale fix `690b87d8`)
- **Shared runtime catalog:** `B12631_SUMMARY_RUNTIME_ARTIFACTS` in `src/ai-addon-state.js`. Linux Gemma 4 uses the shared catalog, and Inkling 2 Mini references it behind its platform gates. The Windows and macOS builds are candidates for native qualification.

Downloads use the [numeric GitHub release-asset endpoint](https://docs.github.com/en/rest/releases/assets#get-a-release-asset) with `Accept: application/octet-stream` and GitHub's required user-agent header. Replacing an asset creates a different ID, and deleting the pinned asset makes that download fail. All five assets redirect to the allowlisted `release-assets.githubusercontent.com` CDN. Local `stat` and `sha256sum` results matched the API's exact sizes and published digests for all five files.

| Platform | Archive | GitHub asset ID | Size (bytes) | Expanded (bytes) | Published and computed SHA-256 |
|---|---|---:|---:|---:|---|
| `darwin-arm64` | `llama-b12631-bin-macos-arm64.tar.gz` | 778478489 | 16,599,970 | 42,656,342 | `8de65a20e743b27405f05e6f89c636b879fd040fdd2c9abd4730fc0632ca49a5` |
| `win32-x64` | `llama-b12631-bin-win-cuda-12.4-x64.zip` | 778480590 | 357,975,625 | 833,394,973 | `2c0a950896f370185f704ef0bc4085278462c444049c47158007af870515aef5` |
| `win32-x64` | `cudart-llama-bin-win-cuda-12.4-x64.zip` | 778477150 | 391,443,627 | 574,138,880 | `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6` |
| `linux-x64` | `llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz` | 778478682 | 220,074,287 | 281,493,150 | `7d5cbac777defa888ed81bd7095da5d8eff780538254faed50ab4303eeaa7408` |
| `linux-x64` | `cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz` | 778475193 | 594,376,039 | 868,893,264 | `5e921d59295bc67642055b73d348a6c488e375a910185523bf89fca9fb795cc6` |

### Linux CUDA 12.8 ELF closure (`readelf -d`)

Inspected all 51 regular ELF files in `llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz` (29 shared libraries and 22 executables) and all 3 CUDA runtime libraries in `cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz`. Both archives passed the application extractor and full runtime cache verification.

- **No NCCL dependency:** `libggml-cuda.so` `DT_NEEDED` is strictly `libggml-base.so.1`, `libcudart.so.12`, `libcublas.so.12`, `libcublasLt.so.12`, `libcuda.so.1`, `libstdc++.so.6`, `libm.so.6`, `libgcc_s.so.1`, `libc.so.6`, `ld-linux-x86-64.so.2`. Unlike `ai-dock/llama.cpp-cuda`, `libnccl.so.2` is not referenced anywhere in the `b12631` closure.
- **Bundled CUDA 12.8 runtime (`summary-runtime`):** `libcudart.so.12`, `libcublas.so.12`, and `libcublasLt.so.12` are pinned by SHA-256 and byte size from `cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz`.
- **External `DT_NEEDED` closure:** `libcuda.so.1` (`nvidia-driver`) plus standard system libraries (`libssl.so.3`, `libcrypto.so.3`, `libstdc++.so.6`, `libgcc_s.so.1`, `libm.so.6`, `libgomp.so.1`, `libpthread.so.0`, `libdl.so.2`, `librt.so.1`, `libc.so.6`, `ld-linux-x86-64.so.2`).
- **Runtime file pins:** `llama-b12631/llama-cli` (1,493,760 B), `llama-b12631/llama-server` (30,872 B), all 29 regular `.so*` files, and `LICENSE`. The app launches the CLI and server, which use `RUNPATH=$ORIGIN`.
- **Validator:** The NCCL exemption is limited to the audited Linux `b12631` runtime identity. It requires the CUDA 12.8 archive with regular-file pins and declarations for all three bundled libraries, plus a declared NVIDIA driver dependency. The legacy NCCL path still requires an `nccl-wheel` and the pinned `libnccl.so.2`.

### CLI & Server flag verification (`b12631` Linux CUDA 12.8)

Confirmed via `llama-cli --help` and `llama-server --help`:
- `llama-cli`: `--no-warmup`, `--single-turn`, `--simple-io`, `--fit [on|off]`, `--reasoning [on|off|auto]`, `--reasoning-effort LEVEL`, `--reasoning-budget N`.
- `llama-server`: `--no-webui`, `--parallel N`, `--fit [on|off]`, `--reasoning [on|off|auto]`, `--reasoning-effort LEVEL`, `--reasoning-budget N`, `LLAMA_API_KEY` env (`--api-key`).

### Native Linux CUDA 32k verification

- **Host:** CachyOS Linux x86_64 (`7.3.5-2-cachyos`), GNU libc `2.44`, NVIDIA GeForce RTX 4070 (`12,282 MiB` VRAM, driver `620.73.04`).
- **`llama-cli` 32,768-token smoke (`gemma-4-12b` `Q4_0`, `--n-gpu-layers 999 --fit off --single-turn --simple-io --reasoning off --no-warmup`):** exited `0` in `2.72s`, all layers assigned to `CUDA0` (`NVIDIA GeForce RTX 4070`), `297.9 t/s` prompt, `53.7 t/s` generation, returned `READY`.
- **`llama-cli` 32,768-token smoke (`qwen3.5-9b-q4-k-m`, `--n-gpu-layers 999 --fit off --single-turn --simple-io --reasoning off --no-warmup`):** exited `0` in `2.05s`, `402.2 t/s` prompt, `70.0 t/s` generation, returned `READY`.
- **`llama-server` 32,768-token loopback check (`gemma-4-12b` `Q4_0`, `127.0.0.1`, `--no-webui --parallel 1 --reasoning off --fit off`, `LLAMA_API_KEY` auth):** `/health` returned HTTP `200`, authenticated `/v1/chat/completions` returned `READY`, `SIGTERM` exited cleanly with code `0`.
- **Asset-ID pin recheck:** Using the app's Linux loader environment and both verified archives, Gemma 4 12B returned `READY` at 32,768 context in both CLI and loopback server checks. The server used 8,196 MiB of GPU memory, rejected an unauthenticated completion with HTTP `401`, and exited with code `0` after `SIGTERM`.

### Platform gates & remaining hardware checks

- **Gemma 4 E4B & 12B:** Linux uses `b12631` with native runtime evidence from the RTX 4070 Gemma 4 12B checks above. macOS arm64 and Windows x64 CUDA retain `b12606` pending native `b12631` setup, Chat, and summary checks at 32k.
- **Inkling 2 Mini (`inkling-2-mini`):** Catalog entry is wired to the shared `b12631` runtime with `inference: { contextTokens: 32768, family: 'inkling', promptFormat: 'chatml', disableThinking: true, singleTurnOnly: true, reasoningEffort: 'none', reasoningBudget: 0 }`, while **all three platform gates (`win32`, `darwin`, `linux`) remain `gated`** pending native 32k Inkling 2 Mini verification on representative hosts:
  - **Linux CUDA:** This CachyOS host has 12 GiB VRAM (RTX 4070), below Inkling 2 Mini's 17.6 GB weight / 19.2 GB (`minRuntimeBytes`) footprint; requires a 24+ GiB CUDA host for native 32k Inkling setup, Chat, and English summary qualification.
  - **macOS arm64:** Requires repeating the v3.1 M4 Pro 32k setup, Chat, and English summary deadline-preservation (`"before Tuesday"`) checks using the published `llama-b12631-bin-macos-arm64.tar.gz` archive.
  - **Windows x64 CUDA:** Requires native 32k setup, Chat, and English summary verification on a 24+ GiB Windows CUDA host using `llama-b12631-bin-win-cuda-12.4-x64.zip`.
- **Summary language policy (`src/summary-language-policy.js`):** Remains at `summary-language-v3` until Inkling 2 Mini and Gemma 4 platform/language checks pass natively.
