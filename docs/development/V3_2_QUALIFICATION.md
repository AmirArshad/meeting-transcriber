# AvaNevis 3.2 Local AI Qualification Record

This document records verified runtime artifact digests, Linux ELF dynamic-library closure, and native host checks for AvaNevis 3.2. On supported platforms, setup and Chat eligibility depend on checks run on each device. Summary languages require separate qualification.

## Slice C1: Unified `llama.cpp` `b12631` Runtime Pin & Inkling 2 Mini Status (2026-11-22)

### Upstream release & verified archive digests

- **Repository:** `ggml-org/llama.cpp`
- **Tag:** `b12631` (published `2026-11-22T09:03:19Z`). The [GitHub release API](https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b12631) reported release ID `454321893` with `immutable: false`.
- **Commit:** `e300919cc704ddde3a8a8346a8714f57eeeee71b` (20 commits ahead of Inkling loop-layer scale fix `690b87d8`)
- **Shared runtime catalog:** `B12631_SUMMARY_RUNTIME_ARTIFACTS` in `src/ai-addon-state.js`. Linux Gemma 4 and Inkling 2 Mini use the shared catalog. The Windows and macOS builds still need maintainer verification.

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
- **Inkling 2 Mini (`inkling-2-mini`):** Slice C1 initially wired the catalog entry to the shared `b12631` runtime at 32k with reasoning disabled and a zero reasoning budget. The [macOS arm64 qualification (2026-11-23)](#macos-arm64-qualification-2026-11-23) below (`51c49b5`) subsequently updated `inkling-2-mini` to `disableThinking: false` (`--reasoning auto`), `reasoningEffort: 'minimal'`, and `reasoningBudget: 256` (with `[Start thinking]...[End thinking]` stripping), passing the macOS arm64 `b12631` Metal 32k setup, Chat, and English summary deadline checks (`"before Tuesday"`). Setup is available on the three supported platforms after local compatibility checks; 24+ GiB Linux CUDA and Windows CUDA native checks remain open:
  - **Linux CUDA:** This CachyOS host has 12 GiB VRAM (RTX 4070), below Inkling 2 Mini's 17.6 GB weight / 19.2 GB (`minRuntimeBytes`) footprint; requires a 24+ GiB CUDA host for native 32k Inkling setup, Chat, and English summary qualification.
  - **macOS arm64:** Passed at `51c49b5` on Apple M4 Pro (48 GiB) using `llama-cpp-b12631-darwin-arm64-metal` (see [macOS arm64 qualification (2026-11-23)](#macos-arm64-qualification-2026-11-23) below).
  - **Windows x64 CUDA:** Requires native 32k setup, Chat, and English summary verification on a 24+ GiB Windows CUDA host using `llama-b12631-bin-win-cuda-12.4-x64.zip`.
- **Summary language policy (`src/summary-language-policy.js`):** At C1, the language allowlist remained at `summary-language-v3`. C2 advances the policy revision to track platform admission without expanding the language allowlist.

## Slice C2: Bonsai 2 and peer models

### Verified Hugging Face metadata

The Hugging Face tree API at each pinned commit reports the exact filename,
byte size and LFS SHA-256 below. Both the file size and LFS size match the
catalog. The revision links point to the checked API responses.

| GGUF file | Pinned revision | Size (bytes) | LFS SHA-256 |
|---|---|---:|---|
| `Ternary-Bonsai-2-9B-Q2_0.gguf` | [`82265ccc78ddaac4700286a35e9badcc32376dd9`](https://huggingface.co/api/models/prism-ml/Ternary-Bonsai-2-9B-gguf/tree/82265ccc78ddaac4700286a35e9badcc32376dd9?expand=true) | 2,556,640,128 | `1f884aa56aacd2bbbb2e4b7abaead2b1102b74a9c75a23fc33dab916813a384d` |
| `Ternary-Bonsai-2-27B-Q2_0.gguf` *(retired — replaced by Bonsai 2.5 27B)* | [`839bd57023c1558945afea70a74fa83c054f35f9`](https://huggingface.co/api/models/prism-ml/Ternary-Bonsai-2-27B-gguf/tree/839bd57023c1558945afea70a74fa83c054f35f9?expand=true) | 7,626,008,928 | `4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e` |
| `Ternary-Bonsai-2.5-27B-Q2_0.gguf` | [`28a7093cc25bc151cc2b284c5570f12ce343fdcf`](https://huggingface.co/api/models/prism-ml/Ternary-Bonsai-2.5-27B-GGUF/tree/28a7093cc25bc151cc2b284c5570f12ce343fdcf?expand=true) | 7,673,194,848 | `84496171ca79d4d33fb45612a2afd8303ec494baf916281023b7dc9cb3b3b9fa` |
| `Ministral-3-14B-Instruct-2512-Q4_K_M.gguf` | [`9b948841b705cc11285ff274b84ba6c885908b19`](https://huggingface.co/api/models/unsloth/Ministral-3-14B-Instruct-2512-GGUF/tree/9b948841b705cc11285ff274b84ba6c885908b19?expand=true) | 8,239,067,840 | `76ce697c065f2e40f1e8e958118b02cab38e2c10a6015f7d7908036a292dc8c8` |
| `gemma-4-26B-A4B-it-Q4_0.gguf` | [`1ca99aae748b4b01f609fa51eb23682ee5f00b85`](https://huggingface.co/api/models/ggml-org/gemma-4-26B-A4B-it-GGUF/tree/1ca99aae748b4b01f609fa51eb23682ee5f00b85?expand=true) | 14,618,145,824 | `d208665ab1cd3a69f7a9a4bc59430e8448c8093d9b06334f566ac59d6d504a03` |
| `Qwen3.8-27B-UD-Q4_K_M.gguf` | [`4af51b3542f775b0a8e4b310bfb3f17e01c306c9`](https://huggingface.co/api/models/unsloth/Qwen3.8-27B-GGUF/tree/4af51b3542f775b0a8e4b310bfb3f17e01c306c9?expand=true) | 16,564,259,744 | `1bce504dfecd84153666928a41d8a66706f0158d3a317bc5196b72819d7dc529` |

### Platform and language admission

These models use the pinned stock `b12631` runtime. Bonsai uses `Q2_0`, and
both Bonsai models and Qwen 3.8 pass `--reasoning off --reasoning-budget 0`.
The catalog memory recommendations are advisory. None of the new peers has a
measured 32k Apple Silicon RSS floor yet. Summary languages stay gated pending
native language qualification.

### Native Linux CUDA 32k checks

Host: CachyOS x86_64 (`7.3.5-2-cachyos`), NVIDIA RTX 4070 (12,282 MiB,
driver `620.73.04`), stock `b12631` CUDA 12.8. SHA-256 of both downloaded
Bonsai files and the Ministral file matched their pinned LFS digests.

| Model | 32k setup and Chat results | CUDA memory |
|---|---|---:|
| Bonsai 2 9B | App setup smoke passed with full GPU offload. CLI returned `READY`. General Chat answered `Paris`. Grounded Chat answered `Friday` and the verifier accepted the citation at 45 seconds. | 3,429 MiB allocated by the CLI |
| Bonsai 2 27B | App setup smoke passed with full GPU offload. CLI returned `READY`. General Chat answered `Paris`. Grounded Chat answered `Friday` and the verifier accepted the citation at 45 seconds. | 9,306 MiB allocated by the CLI |
| Ministral 3 14B | 32k setup exhausted VRAM on this host after offloading all 41 layers. | 7,489.86 MiB weights, then a failed 5,120 MiB context allocation |

Both Bonsai models used an authenticated loopback server and returned answers
without `<think>` output. Maintainer verification on Windows and macOS is still
pending. Gemma 4 26B-A4B and Qwen 3.8 27B still need a larger GPU or suitable
Apple Silicon hardware for maintainer verification.

Ministral's CLI fallback answered `Paris` at 8,192 context using the native
GGUF template. The catalog still requires 32,768 context.

An English synthetic summary probe produced valid structured output for both
Bonsai models. Both preserved “before Thursday at noon” in key points and
shortened it to “Thursday at noon” in the action-item due field. English
summaries remain gated for both models.

## Slice C3: Dependency Sweep, Security Audits & Contract Sync (2026-11-22)

Executed on branch `chore/v3.2-c3-deps-qual` cut from `release/3.2` (`17c773c`) in the main repository checkout (non-symlinked `node_modules` / `.venv`) on CachyOS Linux x86_64 (`7.3.5-2-cachyos`, Node `v26.13.1`, npm `11.20.0`, repo `.venv` Python `3.11.16`, Rust `1.89.0`). `package.json` stays at `3.1.0` pending Task 5.3 cross-platform qualification and release cut authorization.

### Applied dependency & legal updates

- **npm (`package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`):** Updated `dompurify` `3.4.18` → `3.5.0` (2026-11-22 security release; no further `3.4.x` releases). Kept `electron-builder@^26.18.0` (`26.18.0`), `electron-updater@6.8.11`, `marked@18.2.1`, `adm-zip@0.6.1`, and security `overrides` intact.
- **Python (`requirements-windows-build.txt`, `requirements-linux-build.txt`, `requirements-macos-build.txt`, `requirements-common.txt`, `requirements-windows.txt`, `requirements-linux.txt`, `requirements-macos.txt`, `requirements.txt`, `requirements-dev.txt`):** Updated `filelock` `4.2.12` → `4.3.0` (`py3-none-any`, `requires_python >=3.11`, zero transitive dependencies; POSIX atomic-exchange/permission fixes and Windows `release_with_timeout` support).
- **Rust (`native/speakrs-cli/Cargo.lock`):** Updated compatible patch crate `hashbrown` `0.17.1` → `0.17.2` under Rust `1.89.0` while keeping `speakrs = "=0.7.0"` and vendored `ndarray-npy` (`zip = "=9.0.5"`). `native/speakrs-cpu-smoke/Cargo.lock` had no compatible patch updates.
- **Legal SBOM (`legal/PYTHON-BUNDLED-PACKAGES.md`):** Regenerated via `npm run legal:sbom` (`68` direct pins).
- **Contract docs synced:** Updated `docs/development/contracts/local-ai.md`, `docs/development/contracts/ipc.md`, and `docs/development/contracts/meeting-persistence.md` to match the integrated v3.2 surfaces (device fit states + `0.94` nominal GPU tolerance, `unloadLoadedModel` / `SUMMARY_MODEL_LOADED_IN_MEMORY`, unified `b12631` Linux CUDA 12.8 runtime without NCCL, 3-tier `direct_full`/two-stage Chat routing, General Chat `scope.type = 'none'` + mode-switch boundary + `[E\d+]` stripping, and `ai.summary.template` persistence).

### Documented holds (verified live on 2026-11-22)

- **Electron (`46.0.0-alpha.11`):** Held because npm still has no stable `46.x` release (`npm view electron dist-tags`: `latest: 45.4.1`, `beta: 45.0.0-beta.7`, `alpha-46-x-y: 46.0.0-alpha.12`). Linux `safeStorage` version-pinned guards (`src/ai-addon-token-store.js`, `src/main-process/linux-electron-bootstrap.js`) remain unchanged until a stable `46.x` release is published and qualified.
- **FFmpeg (`8.1.2`):** Held across Windows, macOS, Linux, and source (`build/download-manifest.js`) because `shaka-project/static-ffmpeg-binaries` still tops at `n8.1.2-2` (`8.1.2`) while `GyanD/codexffmpeg` is at `9.1`, so no matched cross-platform release `> 8.1.2` exists.
- **Bundled CPython (`3.11.18+20261110`) & `pip` (`26.3`):** Already current against `astral-sh/python-build-standalone` (`20261110`) and PyPI (`pip 26.3`).
- **Held Python upgrades & Python 3.11 ceilings:**
  - `onnxruntime==1.31.1` (latest `1.32.0`): held pending native Windows active ETW telemetry verification (unsuppressed positive control + guarded VAD) and Linux `strace --check-network` VAD parity.
  - `ctranslate2==4.8.5` (latest `4.9.1`): held pending native Windows and Linux CPU (`int8`) + CUDA (`float16`) Whisper transcript parity.
  - `pyobjc-*==12.2.2` (latest `13.0`): held pending native macOS ScreenCaptureKit / CoreAudio permission smoke.
  - Python 3.11 / upstream ceilings: `numpy==2.4.6` (`2.5.5` requires `>=3.12`), `scipy==1.17.1` (`1.18.1` requires `>=3.12`), `av==18.1.1` (`19.0.2` requires `>=3.12`), `networkx==3.6.1` (`3.7` requires `>=3.12`), `huggingface-hub==1.33.0` (`<2`), `mpmath==1.3.0` (`sympy==1.14.0` requires `<1.4`), and `tiktoken==0.3.3` (`lightning-whisper-mlx` compatibility); Parakeet lockfiles and Pyannote runtime pins retained.
- **Rust `speakrs` (`=0.7.0`):** Held because `speakrs 0.8.0` switches to `ort ^2.0.0-rc.15`, requiring full Windows CUDA, Linux CUDA, and macOS CoreML CLI requalification.

### Linux Electron `safeStorage` smoke (`tests/fixtures/electron/token-migration-smoke.js`)

Run directly under Electron `46.0.0-alpha.11` with isolated temporary profiles on CachyOS Linux (`gnome_libsecret` desktop keyring active):

| Case | Mode | Backend switch | D-Bus | Exit | `backend` | `format` | `available` | `protectedByAppPolicy` | `roundTrip` |
|---|---|---|---|---:|---|---|---|---|---|
| Keyring roundtrip | `async-roundtrip` | `gnome-libsecret` | active | `0` | `gnome_libsecret` | `v11` | `true` | `true` | `true` |
| Keyring persist | `async-write` → `restart` | `gnome-libsecret` | active | `0` | `gnome_libsecret` | `v11` | `true` | `true` | `true` |
| Basic store reject | `async-roundtrip` | `basic` | active | `0` | `basic_text` | `v10` | `true` | `false` | `true` |
| Unavailable keyring reject | `async-write` → `restart` | `gnome-libsecret` | disabled | `0` | `gnome_libsecret` | `v10` | `true` | `false` | `true` |

Confirmed `v11` keyring encryption is accepted while `v10` fixed-key fallbacks (`basic_text` and unavailable-D-Bus `gnome_libsecret`) are rejected by `isTokenEncryptionAvailable`.

### Audit, closure & test results

- **GitHub Dependabot:** `gh api repos/AmirArshad/meeting-transcriber/dependabot/alerts?state=open --jq 'length'` returned `0`.
- **npm audits:** `npm audit --omit=dev` and `npm audit` both exited `0` (`found 0 vulnerabilities`).
- **Python closure (`scripts/check-build-requirements-closure.py`):**
  - `requirements-linux-build.txt`: `ok` (exit `0`).
  - `requirements-windows-build.txt`: `ok` (cross-host check from Linux, exit `0`).
  - `requirements-macos-build.txt`: cross-host check from Linux cannot resolve `torch==2.15.0` because `pip --dry-run` evaluates `cuda-bindings<14,>=13.0.3; platform_system == "Linux" and python_version < "3.15"` against the Linux host; native macOS host closure check remains an open Task 5.3 gate.
- **`pip-audit` (`scripts/pip_audit_inventory.py`):** `0` findings across `requirements-windows-build.txt`, `requirements-linux-build.txt`, `requirements-macos-build.txt`, `parakeet-linux-cuda`, `parakeet-macos-metal`, `parakeet-windows-cuda`, and `bootstrap` (`pip 26.3`); the intentionally vulnerable canary (`tests/fixtures/dependency-inventory/vulnerable-parakeet.lock.json`) detected all `8` expected CVEs (`exit 0` with `--expect-findings`).
- **Rust (`cargo audit --deny warnings` & tests):** `0` findings on `native/speakrs-cli/Cargo.lock` (110 crate dependencies) and `native/speakrs-cpu-smoke/Cargo.lock` (72 crate dependencies); `cargo +1.89.0 test --locked` in `native/speakrs-cli` passed (`8` unit + `1` integration test).
- **Full automated suite & setup checks:**
  - `npm run test:all`: exit `0` (JS `1,398` tests: `1,397 passed, 0 failed, 1 skipped`, including real Chromium strict CSP `DOMPurify 3.5.0` XSS test; Python `1,006 passed, 4 skipped` with `filelock 4.3.0`; JS and Python syntax checks clean).
  - `python3 scripts/agents/validate_setup.py`: exit `0`.

### Remaining cross-platform gates (Task 5.3)

- **macOS arm64:** Native `scripts/check-build-requirements-closure.py macos`, `tests/fixtures/electron/token-migration-smoke.js` (Keychain), `build:mac` + `verify:mac:packaged`/`verify:mac:installer`, and Task 4.1/4.2 native `b12631` model checks.
- **Windows 10/11 x64:** `tests/fixtures/electron/token-migration-smoke.js` (`DPAPI`), `build` + `verify-windows-installer.ps1`, and native CUDA model/Job Object checks.
- **Linux x86_64:** Interactive desktop acceptance and `npm run legal:release-assets` at the release version cut remain open. The pre-cut package build and verifier passed as recorded below.

## Task 5.3: integrated pre-release gate (2026-11-22)

On clean `release/3.2` at `735bd5d5777196d85cf1106086c2d0af094d6f3e` after Waves A–C, CachyOS Linux x86_64 kernel `7.3.5-2-cachyos`, Node `v26.13.1`, npm `11.20.0`, and repo `.venv` Python `3.11.16`:

- `npm run test:all` exited `0`: JavaScript `1,397 passed, 0 failed, 1 skipped` of `1,398`; Python `1,006 passed, 4 skipped`; JavaScript and Python syntax checks passed.
- `python3 scripts/agents/validate_setup.py` exited `0`; 16 canonical skills validated.
- `npm audit --omit=dev` and `npm audit` each exited `0` with `0 vulnerabilities`.
- `npm run legal:release-assets` exited `0`, verified FFmpeg `8.1.2` source, and staged the `3.1.0` legal archive (SHA-256 `812328c609b9bbd58ba12d7b78d218738397e0af7942954beb494500a3926b94`). This must be repeated for the authorized release version.
- `npm run build:linux` and `npm run verify:linux:packaged` each exited `0`; the verifier checked unpacked resources and all three packages, including pacman and deb dependencies. Artifacts are pre-cut `3.1.0` builds, not `3.2.0` release artifacts:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `AvaNevis-Setup-3.1.0.AppImage` | 379183505 | `1515dd720a59dd4b762a74347a73963ba4d7d27d7d5ae54f62fe0ac55c6b34ad` |
| `AvaNevis-Setup-3.1.0.pkg.tar.zst` | 346914438 | `6c8f3cfcac78a52f211595d7a2342b1f62668142d4339b05c23f2acf3c741dae` |
| `AvaNevis-Setup-3.1.0.deb` | 284843604 | `fa6189733d323a9c58ba3b16deb89b701284806f4b88ecec3be38cef5cb0b624` |

Command logs are retained locally under ignored `logs/v3.2-task-5.3/`. This gate does not establish interactive Linux hardware acceptance or native Windows/macOS qualification. The remaining gates above, including the native macOS dependency closure and model checks, remain open; no new cross-platform limits were accepted in this run. Prior C3 Python and Rust audit evidence is recorded above. Version bump, release-version artifacts, merge, and tag await release-cut authorization.

## macOS arm64 qualification (2026-11-23)

On `release/3.2` (starting at `27d4488`, followed by the `Inkling 2 Mini` reasoning-mode fix), macOS 26.7.3 (25G342), Apple M4 Pro, 48 GiB unified memory, Node 26.13.1, npm 11.20.0, repo Python 3.11.18:

- **Automated gates & audits (after final edit):** `npm run test:all` exited 0 (JavaScript 1,395 passed, 0 failed, 3 skipped of 1,398; Python 1,006 passed, 6 skipped; both syntax checks passed). `python3 scripts/agents/validate_setup.py` exited 0 (17 skills). Both `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities. Native `python3 scripts/check-build-requirements-closure.py macos` exited 0 (`ok   requirements-macos-build.txt`).
- **Keychain (`safeStorage`):** Electron 46.0.0-alpha.11 Keychain fixture with a disposable profile: `async-roundtrip`, `async-write`, and `restart` each exited 0 and reported `available`, `protectedByAppPolicy`, and `roundTrip` true, with `v10` format.
- **Packaged build & verifiers (after final edit):** `npm run build:mac`, `npm run verify:mac:packaged`, and `npm run verify:mac:installer` exited 0. The build used ad-hoc signing, without notarization. These are pre-cut **3.1.0** artifacts, not release-version artifacts: DMG 1,011,071,503 bytes, SHA-256 `c7c21b368965e587c3140ee1ae9c8810fdb7fe9c8af1dade69b2a439ec6f1e8d`; ZIP 975,902,788 bytes, SHA-256 `ae474a6847a10b04367cbf7fa62f1ce7b35d355b0793613e8705b8003b1fc823`.
- **Audio capture, MLX Whisper & packaged Speakrs CoreML:** In separate disposable profiles, both the development app and packaged app recorded the repository's two-speaker speech fixture through system-audio-only capture. The packaged run saved 22.65 seconds, reported `coreaudio_tap` and peak `0.731964`, and transcribed the spoken design-review dialogue in History with MLX Whisper Small on Metal. Packaged Speakrs setup reached `ready` in the isolated profile, and packaged `speakrs-cli` via `speakrs_runner.py` (`--mode coreml`) ran on `tests/fixtures/speakrs-two-speaker-16k.wav` and returned 6 segments (`exclusive_speaker_diarization`, `coreml`). The packaged microphone-only preflight stopped because macOS microphone permission was not granted. Microphone and mixed-source hardware acceptance remain open.
- **Inkling 2 Mini (`inkling-2-mini`) `b12631` diagnosis, fix & verification:** Explicit setup downloaded and verified `Inkling-2-Mini-IQ4_NL.gguf` (17,627,940,768 bytes) and `llama-cpp-b12631-darwin-arm64-metal`. Initial grounded Chat failed with `malformed_json` because `--reasoning off --reasoning-budget 0` and `chat_template_kwargs.enable_thinking: false` caused `Inkling 2 Mini` on `b12631` to loop on `<|message_model|><|content_thinking|><|end_message|>`. Updated `inkling-2-mini` in `src/ai-addon-state.js` to `disableThinking: false`, `reasoningEffort: 'minimal'`, `reasoningBudget: 256`, wired `--reasoning auto` in `src/main/history-qa-service.js` and `backend/summaries/llama_runtime.py`, omitted `enable_thinking: false` in `backend/history_qa/qa_runner.py` when `disableThinking` is `false`, and added `[Start thinking]...[End thinking]` stripping in `backend/summaries/summary_pipeline.py` and `backend/history_qa/citation_verifier.py`. Re-running against `b12631` `llama-server` and `llama-cli` passed: Grounded Chat (`direct_full`, verified `[E1]` citation), follow-up Chat (`"Go deeper..."`, `direct_full`, `[E1]`), General Chat (`scope.type = 'none'`, 0 citations), and English summary pipeline JSON generation preserving `"before Tuesday"`. Summary language policy stays at `summary-language-v4` (`languages: []` for Inkling) pending cross-platform checks.
- **Bonsai 2 (`b12631` Metal):** Downloaded and SHA-256-verified both `Ternary-Bonsai-2-9B-Q2_0.gguf` (2,556,640,128 bytes, `1f884aa56aacd2bbbb2e4b7abaead2b1102b74a9c75a23fc33dab916813a384d`) and `Ternary-Bonsai-2-27B-Q2_0.gguf` (7,626,008,928 bytes, `4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e`). Both passed 32,768-context `llama-cli` `READY` (`--reasoning off --reasoning-budget 0`), `llama-server` Grounded Chat (`direct_full`, verified `[E1]` citation), General Chat (`scope.type = 'none'`), and English summary deadline preservation (`"before Tuesday"`).

### Bonsai 2.5 27B replacement & upstream verification (2026-11-24)

- **Upstream source:** `prism-ml/Ternary-Bonsai-2.5-27B-GGUF` at commit `28a7093cc25bc151cc2b284c5570f12ce343fdcf` (`Apache-2.0`, built from `Qwen/Qwen3.8-27B`). Upstream released Bonsai 2.5 at `27B` only, so `bonsai-2-9b-q2-0` stays in the Compact tier while `bonsai-2.5-27b-q2-0` replaces `bonsai-2-27b-q2-0` in the Balanced tier.
- **Format & runtime selection:** Selected `Ternary-Bonsai-2.5-27B-Q2_0.gguf` (`7,673,194,848` bytes, LFS SHA-256 `84496171ca79d4d33fb45612a2afd8303ec494baf916281023b7dc9cb3b3b9fa`, verified HTTP `302` to allowlisted `us.aws.cdn.hf.co`) for the shared stock `llama.cpp` `b12631` runtime (`ggml-org/llama.cpp#29600`, merged in `b11556`). `PTQ1_0`, `PQ2_0`, and `-mtp` speculative drafting (`--spec-type draft-mtp`) remain fork-specific to `PrismML-Eng/llama.cpp`.
- **GGUF v3 header comparison vs `Ternary-Bonsai-2-27B-Q2_0.gguf`:** Verified matching `general.architecture = "qwen35"`, `general.file_type = 41`, `851` tensors (64 blocks, `context_length = 262144`), identical `prism.hadamard.*` keys, and identical `8,952`-byte `tokenizer.chat_template`. Tensor type change is strictly promoting the `96` `(5120, 48)` `blk.*.ssm_{alpha,beta}.weight` tensors from `BF16` to `F32` (`+47,185,920` bytes).
- **Lifecycle & migration:** Existing `bonsai-2-27b-q2-0` installations remain usable (`retired: true` legacy badge, validation, default selection, and removal supported), new downloads of `bonsai-2-27b-q2-0` are rejected, and uninstalled Chat threads referencing `bonsai-2-27b-q2-0` migrate to `bonsai-2.5-27b-q2-0` when installed.
- **Open native checks:** Native 32,768-token setup, Grounded/General Chat, English summary, and Linux CUDA VRAM floor measurement for `bonsai-2.5-27b-q2-0` remain open on Linux CUDA, macOS arm64 Metal, and Windows x64 CUDA (untested on the headless CPU-only VPS).

Logs are retained locally under ignored `logs/v3.2-macos-qualification/`. Remaining open items: macOS microphone & mixed-source capture (TCC permission), macOS native checks for `bonsai-2.5-27b-q2-0`, `ministral-3-14b`, `gemma-4-26b-a4b`, and `qwen3.8-27b`, Windows and Linux qualification gates, release-version (`3.2.0`) artifacts, and the authorized release cut. No new cross-platform limits are accepted by this run.

## VPS Hardening, Upstream Reconnaissance & Structured JSON Export (2026-11-25)

Executed on a headless CPU-only Linux VPS on `release/3.2` (`package.json` remains `3.1.0`). **No Electron GUI (`BrowserWindow`), audio capture hardware, CUDA GPU, or local LLM binaries were executed here**; only non-hardware static/unit/integration suites and read-only upstream checks ran on this host.

### Read-only upstream dependency & runtime reconnaissance (no pins changed)

- **GitHub Dependabot alerts & npm audits:** `gh api repos/AmirArshad/meeting-transcriber/dependabot/alerts?state=open --jq 'length'` returned `0` (3 held Dependabot PRs remain open: `#159` `onnxruntime 1.32.0`, `#160` `electron 46.0.0-alpha.12`, `#161` `ctranslate2 4.9.0`). Both `npm audit --omit=dev` and `npm audit` exited `0` (`0` vulnerabilities).
- **Python 3.11 dependency closure:** `.venv/bin/python scripts/check-build-requirements-closure.py linux windows` exited `0` (`ok requirements-linux-build.txt`, `ok requirements-windows-build.txt`). Native `macos` closure requires a macOS host.
- **Electron & bundled binaries (holds confirmed):**
  - `npm view electron dist-tags --json`: `latest: "45.5.0"`, `beta: "45.0.0-beta.7"`, `alpha` / `alpha-46-x-y`: `"46.0.0-alpha.13"` — still no stable Electron `46.x`; held at `46.0.0-alpha.11`.
  - `shaka-project/static-ffmpeg-binaries`: remains at `n8.1.2-2` (`8.1.2`); matched cross-platform FFmpeg hold at `8.1.2` remains valid.
  - `astral-sh/python-build-standalone`: `20261124` tag rebuilds the same CPython `3.11.18` version (`cpython-3.11.18+20261124`) while `pip` remains `26.3`; pinned `3.11.18+20261110` stays current.
- **PyPI / npm upstream deltas (no pins changed without approval/native gates):** `marked` has `18.3.0` (`18.2.1` pinned, 0 advisories), `filelock` has `4.3.1` (`4.3.0` pinned), macOS `regex` has `2026.11.24` (`2026.11.19` pinned); `onnxruntime` (`1.32.0`), `ctranslate2` (`4.9.1`), `pyobjc-*` (`13.1`), and Rust `speakrs` (`0.8.0`) remain held pending native verification; Python 3.11 ceilings (`av 18.1.1`, `numpy 2.4.6`, `scipy 1.17.1`, `huggingface-hub <2`) remain valid.
- **`ggml-org/llama.cpp` upstream check (`b12631..b12722`):**
  - Upstream reached tag `b12722` (`2026-11-25T10:37:37Z`, commit `e6443bd7eb970d940b0669cd9ea0d82d91d620a1`, 106 commits ahead of `b12631`) with matching release binaries published across macOS arm64, Windows CUDA 12.4, and Ubuntu CUDA 12.8.
  - Inspecting `b12631..b12722` shows Inkling 2 graph/grammar/weight fixes (`d2bceda3`, `dd53f70d`, `e683365a`, `396ed2cc`, `33aeb17f`), Qwen3.5 GDN cache-slot replay (`d35dc4d9`), CUDA kernel fixes (`46f4da21`, `4c92c5bf`, `9578bd3f`, `922cff91`, `22b99122`), and `server` prompt-cache fixes (`c212d25a`, `82dd9704`, `40fe9164`), with no breaking changes to Gemma 4, Ministral 3, Qwen 3.8, or Hadamard `Q2_0`.
  - **Recommendation: STAY on `b12631` for v3.2.0** unless native Windows CUDA or `bonsai-2.5-27b-q2-0` qualification uncovers a specific defect. `b12631` already carries full Linux CUDA 12.8 ELF closure (`51` binaries / `29` shared libraries + `3` cudart pins) and passing Linux/macOS native 32k qualification checks, whereas bumping to `b12722` would invalidate all prior `b12631` runtime evidence and alter `inkling-2-mini`'s tuned chat grammar behavior.

### Code hardening & Structured JSON export pulled into `release/3.2`

- **Lifecycle / queue / retired-model hardening:** Disarmed `updater-service` `'installing'` state when `clearQuitCommitted()` cancels an interrupted recording-quit flow (`cancelPendingInstall()`), prevented installed-but-unready `bonsai-2-27b-q2-0` threads from silently overwriting `thread.modelId` during transient errors, and serialized Linux CUDA live probes inside `readSummaryModelAdmission` and `validate-diarization-setup` through `enqueueGpuResourceAction`.
- **Structured JSON Transcript Export (`.json`):** Extended `VALID_EXPORT_FORMATS`, `src/renderer/subtitle-export-helpers.js` (`serializeTranscriptToJson`, schema version `1` `avanevis-transcript`), `src/main/file-export-ipc.js` (`save-transcript-as` with `EXPORT_FORMAT_FILTERS.json` and Windows-safe filename sanitization), and the renderer export picker speaker toggle. Exported `.json` files include safe recording metadata, speaker names (unless `includeSpeakers: false`), Markdown + plain-text transcript + `sourceTranscriptHash`, validated caption cues when `.captions.json` is fresh (or explicit `captions.available: false` status when absent/stale without failing export), and completed summary data, while enforcing `recordings` path-jail and non-symlink checks and omitting all host filesystem paths.

## Return-to-PC/Mac Ordered Qualification Runbook

Run the steps below on each target hardware host before cutting `v3.2.0` (while `package.json` stays `3.1.0` for pre-cut verification, then repeat final release-version checks after the authorized bump to `3.2.0`):

### 1. Windows 10/11 x64 (with NVIDIA CUDA GPU)

1. `npm ci && npm run test:all` (must exit `0`, including all Electron `BrowserWindow` suites)
2. `py -3.11 scripts/agents/validate_setup.py` and `py -3.11 scripts/check-build-requirements-closure.py windows`
3. `npm audit --omit=dev && npm audit`
4. Electron `DPAPI` smoke: `node scripts/run-electron-token-migration-smoke.js` (`tests/fixtures/electron/token-migration-smoke.js`)
5. Pre-cut build & installer check: `npm run build` and `powershell -ExecutionPolicy Bypass -File scripts/verify-windows-installer.ps1`
6. Native hardware / UI acceptance on isolated profile:
   - Recording capture + Whisper transcription (CPU & CUDA) + Speakrs setup & diarization
   - Summaries & Chat on `b12631` CUDA 12.4: `bonsai-2-9b-q2-0`, `bonsai-2.5-27b-q2-0` (32k setup, Chat, English summary, Job Object exit, cancel cleanup), `gemma-4-e4b` / `gemma-4-12b` (for `b12631` adoption decision), and any 16–24+ GiB host models (`ministral-3-14b`, `gemma-4-26b-a4b`, `qwen3.8-27b`, `inkling-2-mini`)
   - Interactive UI: device fit badges, unload-before-download modal, Chat direct fit / follow-ups / granular timestamps / General Chat mode, ≥5 s speaker voice samples + `"Sample"` caption, always-available Summary format dropdown, and **Save transcript as -> Structured JSON (`.json`)** native dialog + payload spot-check (confirm no host paths in exported JSON)
   - Only if qualifying held Python upgrades: `powershell -ExecutionPolicy Bypass -File scripts/qualify-windows-onnx.ps1` (ETW telemetry) and `ctranslate2` CPU/CUDA parity

### 2. macOS arm64 (Apple Silicon, macOS 15+)

1. `npm ci && npm run test:all` (exit `0`)
2. `python3 scripts/agents/validate_setup.py` and `python3 scripts/check-build-requirements-closure.py macos` (native macOS closure gate)
3. `npm audit --omit=dev && npm audit`
4. Electron Keychain smoke: `node scripts/run-electron-token-migration-smoke.js`
5. Pre-cut build & verifiers: `npm run build:mac && npm run verify:mac:packaged && npm run verify:mac:installer`
6. Native hardware / UI acceptance on isolated profile:
   - Microphone-only and mixed-source (mic + system audio) hardware capture with microphone TCC permission granted
   - Native Metal 32k checks on `b12631`: `bonsai-2.5-27b-q2-0`, `ministral-3-14b`, `gemma-4-26b-a4b`, `qwen3.8-27b`, and `gemma-4-e4b` / `gemma-4-12b` (for unified `b12631` adoption decision)
   - Interactive UI: Settings device fit & library, History, Prepare summary format picker, Chat modes/citations, and **Save transcript as -> Structured JSON (`.json`)** save-dialog + payload spot-check
   - Only if qualifying `pyobjc 13.x`: ScreenCaptureKit / CoreAudio permission smoke

### 3. Linux x86_64 Desktop (CachyOS / Omarchy with NVIDIA CUDA)

1. `npm ci && npm run test:all` (confirm all JS including the 4 Chromium `BrowserWindow` suites + Python pass after `ff47f8a`, `929b164`, and 2026-11-25 commits)
2. `.venv/bin/python scripts/agents/validate_setup.py` and `.venv/bin/python scripts/check-build-requirements-closure.py linux`
3. `.venv/bin/python scripts/pip_audit_inventory.py` and `cargo audit --deny warnings`
4. `npm run build:linux && npm run verify:linux:packaged`
5. Native desktop & GPU checks on isolated profile:
   - `bonsai-2.5-27b-q2-0` 32k setup, VRAM floor measurement, Grounded/General Chat, and English summary check on `b12631` CUDA 12.8
   - Interactive desktop acceptance: RTX 4070 `12,282 MiB` device fit + Gemma 4 12B, unload-before-download modal, Chat direct fit / follow-ups / granular timestamps / General Chat guardrails, ≥5 s speaker samples + `"Sample"` caption, always-available Summary format dropdown, and **Structured JSON (`.json`)** save-dialog + payload spot-check
   - Optional 16–24+ GiB host checks for `ministral-3-14b`, `gemma-4-26b-a4b`, `qwen3.8-27b`, `inkling-2-mini` (or record hardware ceilings as accepted limits)
   - Only if qualifying held Python upgrades: `strace --check-network` VAD parity (`onnxruntime`) and `ctranslate2` parity

### 4. Authorized `v3.2.0` Cut Sequence (Only After Qualification Sign-Off)

1. Update `docs/development/V3_2_QUALIFICATION.md`, `docs/releases/v3.2.0.md` (replacing `[PENDING NATIVE QUALIFICATION]` placeholders), `docs/initiatives/ROADMAP.md`, and `todo.md`.
2. Bump `package.json` & `package-lock.json` (`3.1.0` -> `3.2.0`), regenerate `npm run legal:sbom` if Python pins changed, and run `npm run legal:release-assets` (`3.2.0` legal archive).
3. Run final `npm run test:all`, build release-version (`3.2.0`) installers across target platforms, run packaged verifiers, and publish via authorized PR + `v3.2.0` tag.
