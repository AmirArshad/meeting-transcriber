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
- **Inkling 2 Mini (`inkling-2-mini`):** Catalog entry is wired to the shared `b12631` runtime at 32k with reasoning disabled and a zero reasoning budget. Setup is available on the three supported platforms after local compatibility checks. Maintainer qualification still needs these native runs:
  - **Linux CUDA:** This CachyOS host has 12 GiB VRAM (RTX 4070), below Inkling 2 Mini's 17.6 GB weight / 19.2 GB (`minRuntimeBytes`) footprint; requires a 24+ GiB CUDA host for native 32k Inkling setup, Chat, and English summary qualification.
  - **macOS arm64:** Requires repeating the v3.1 M4 Pro 32k setup, Chat, and English summary deadline-preservation (`"before Tuesday"`) checks using the published `llama-b12631-bin-macos-arm64.tar.gz` archive.
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
| `Ternary-Bonsai-2-27B-Q2_0.gguf` | [`839bd57023c1558945afea70a74fa83c054f35f9`](https://huggingface.co/api/models/prism-ml/Ternary-Bonsai-2-27B-gguf/tree/839bd57023c1558945afea70a74fa83c054f35f9?expand=true) | 7,626,008,928 | `4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e` |
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
