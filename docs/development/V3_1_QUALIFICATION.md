# AvaNevis v3.1 Phase 4 qualification

## Artifact checks on 2026-11-21

- The immutable Hugging Face metadata for Qwen3.5 9B and 4B matches the existing revision, file size and SHA-256 pins.
- Gemma 4 E4B and 12B `Q4_0` bytes matched the immutable source revisions and SHA-256 values in the catalog. [E4B source](https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/tree/8903cb408c7df39cde2ed15fac397e6d7be92951) and [12B source](https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF/tree/501d13dba70e3c02b1b12c78fd9e6b08ad413960).
- The macOS arm64 and Windows CUDA 12.4 `b12606` archive bytes matched the published digests. The Linux x86_64 CUDA 12.8 ai-dock `v1.0.0` archive matched its digest, and the extracted ELF dependencies and file pins were inspected. [Upstream b12606 release](https://github.com/ggml-org/llama.cpp/releases/tag/b12606) and [ai-dock v1.0.0 release](https://github.com/ai-dock/llama.cpp-cuda/releases/tag/v1.0.0).
- `b12606` includes the initial Inkling support and precedes the subsequent loop-slot fix. Inkling stays gated on macOS, Windows and Linux pending a build containing the fix and native validation. [Initial support](https://github.com/ggml-org/llama.cpp/pull/32694) and [loop-slot fix](https://github.com/ggml-org/llama.cpp/pull/32704).

### Inkling 2 Mini artifact recheck

The newest numbered llama.cpp release listed by GitHub was `b12608` at
`93cb37ea7b5f134cc500b1c5b91d971190600a1a`. GitHub's commit comparison
confirmed it contains initial support at
`29b52d398b294509746ec0a3f28948a3107c0213`. The loop-layer scale fix at
`690b87d88151dbd775bb6eff5581663688785928` is three commits ahead of
`b12608` and contains the initial support. Upstream reported that IQ4_NL
was unaffected by the scale bug. Phase 4 requires both commits. The fix
commit's Release workflow was pending and had no downloadable artifacts.
[Numbered release](https://github.com/ggml-org/llama.cpp/releases/tag/b12608),
[ancestry comparison](https://github.com/ggml-org/llama.cpp/compare/b12608...690b87d88151dbd775bb6eff5581663688785928),
[scale fix](https://github.com/ggml-org/llama.cpp/pull/32704),
and [Release workflow](https://github.com/ggml-org/llama.cpp/actions/runs/44897849261).

The downloaded `Inkling-2-Mini-IQ4_NL.gguf` matched the catalog and Hugging Face
metadata at immutable revision `e8a2cecf0e78914f07cc27b9be711a9b2c7561d9`.
The file measured 17,627,940,768 bytes with SHA-256
`cbdf3fa9dc50a4124977980f37da4f1fa764b0cfe800d275cd43d26ce2a81af4`.
[Immutable model files](https://huggingface.co/ggml-org/Inkling-2-Mini-GGUF/tree/e8a2cecf0e78914f07cc27b9be711a9b2c7561d9).

The downloaded release archives matched GitHub's published sizes and digests.
`b12608` remains unsuitable for the Inkling pin because of its commit ancestry.

| Archive | Bytes | SHA-256 |
| --- | ---: | --- |
| `llama-b12608-bin-macos-arm64.tar.gz` | 16,576,422 | `8c1909d59cf2bbe9c973df786fcf7505c13bcb0d3eb33e8d957bd0f78f805090` |
| `llama-b12608-bin-win-cuda-12.4-x64.zip` | 357,938,905 | `f923d55e4813e1c0bb65a52771465b2561168a48ea1c9971ee74910613f3db00` |
| `cudart-llama-bin-win-cuda-12.4-x64.zip` | 391,443,627 | `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6` |

Apple Silicon qualification used a local Metal build of the pinned fix commit
under an isolated profile with its own runtime ID. The source archive was
39,279,228 bytes with SHA-256
`3da0702f6760faac5476f546f2b2556ec48b4efe55e46ab995a20563b1acb31c`.
The local runtime archive was 22,118,553 bytes with SHA-256
`3f3cd042edc0780918745bd2c50e3bc6337a1591f5380f1e584f6ce78dfc42a5`.
The build used AppleClang 21 and embedded Metal kernels. The local archive
depends on the host's OpenSSL and is for qualification only.
[Pinned source archive](https://codeload.github.com/ggml-org/llama.cpp/tar.gz/690b87d88151dbd775bb6eff5581663688785928).

## Apple Silicon smoke

On macOS 26.7.3 arm64 with an M4 Pro and 48 GiB unified memory, both Gemma
models ran an explicit `llama-cli` text generation at a 32,768-token context.
E4B offloaded 43 of 43 layers and reached a maximum resident set of 5,331,582,976
bytes. The 12B model offloaded 49 of 49 layers and reached 8,409,792,512 bytes.
Both returned the requested string and exited. These are process readings from
one host and short prompts. Lower-memory devices and long prompts still need
qualification before publishing minimum memory requirements.

An isolated add-on profile used the actual pinned files and the production
extractor and runtime validator. The two models reached Ready, shared one
runtime download and accepted a saved default change. Removing that default
preserved the remaining model and runtime. Removing the last model reclaimed
the shared runtime. The harness seeded its download source with the verified
files and used no existing user recordings or application profile.

An offline Chat harness ran the local Python Q&A runner over authenticated
loopback through E4B → 12B → E4B. All three answers identified Mira and Friday
with a verified citation. The shared process slot confirmed each POSIX process
group had exited before launching the next server.

Both Gemma models generated valid English meeting summaries from the pilot
fixture and the timestamped context fixture. Review checked the named tasks,
pilot decisions, unchanged pilot budget and the unresolved supplier question.
The same pipeline rejected the Spanish input and the names-only control when
English was requested. Policy `summary-language-v3` enables English for these
models on macOS arm64. These bounded checks cover short synthetic English input.

### Inkling 2 Mini on Apple Silicon

The same M4 Pro host used a new user-data directory and production setup,
History retrieval, Chat and process-slot services. A test-only catalog pointed
Inkling to the commit-pinned local archive. Gemma E4B used the published
`b12606` runtime. The harness supplied verified files to explicit setup
requests and blocked outbound traffic outside loopback. The regular app profile
was outside the harness.

- The installed Inkling weights passed the production runtime validator. At
  32,768 tokens, the CLI and Chat server offloaded 49 of 49 layers to Metal.
  The timed CLI run peaked at 19,217,088,512 bytes RSS (17.9 GiB). llama.cpp
  accounted for 21,012 MiB of Metal buffers, including 1,267 MiB for context
  and 3,414 MiB for compute. The timed prompt hit its short token limit
  during reasoning. These readings cover one 48 GiB host.
- Inkling → Gemma E4B → Inkling answered the checklist question over
  authenticated loopback. Every turn named Mira and Friday with a citation
  resolved against the synthetic recording at 00:02. Each prior process group
  was confirmed absent before the next model launched. Inkling also answered
  with the same verified citation using the CLI fallback.
- Canceling a staged transfer removed its partial file. A damaged archive
  failed checksum verification. Both checks preserved the Ready Gemma
  installation and its saved default. Canceling an Inkling Chat load stopped
  its process group and saved no turn.
- Removing Inkling reclaimed its weights and private runtime. The Gemma
  weights, runtime and saved default survived, as did the synthetic recording
  metadata, saved summary and prior Inkling Chat turn.
- The production CLI flags yielded an indeterminate English transcript
  language check. Adding `--reasoning-effort none` alone gave the same result.
  An experimental run adding both `--reasoning-effort none` and
  `--reasoning-budget 0` generated English summaries for the pilot and
  timestamped context fixtures. It rejected the Spanish-as-English and
  names-only controls. Review found the pilot decision, checklist owner and
  deadline, unchanged budget, and unresolved supplier question. The context
  summary retained the named actions and deadlines in prose, while one
  structured due date shortened “before Tuesday” to “Tuesday.” The
  experimental flags and Inkling summary languages remain outside the
  production catalog.

## Open hardware checks

- Windows 10/11 CUDA and CachyOS/Omarchy CUDA need native generation, device-fit and process-exit testing. Windows Job Object behavior needs a native cancel and timeout check.
- Packaged desktop qualification still includes in-app switching, live memory release under pressure, summary language and long-context quality by model, and install/removal through Settings.
- Inkling remains gated on Apple Silicon pending a published Metal archive containing the fix and a repeat of native checks with those exact bytes.
- Windows Inkling remains gated. The verified `b12608` CUDA 12.4 archive predates the fix. A compatible archive and native Windows CUDA host are required.
- Linux Inkling remains gated. The newest ai-dock CUDA release checked, `v1.0.0`, predates initial Inkling support. The managed CUDA 12 path needs a compatible x86_64 build, verified library and executable pins, and native testing. [ai-dock release](https://github.com/ai-dock/llama.cpp-cuda/releases/tag/v1.0.0).

## Integrated automated checks

`npm run test:all` exited 0 on macOS arm64. JavaScript reported 1,349 passed
and 3 skipped. Python reported 983 passed and 10 skipped. Both syntax checks
passed. `git diff --check` exited 0.

## Phase 5 dependency sweep, audits & macOS arm64 qualification (2026-11-21)

Executed on branch `chore/v3.1-phase5-dependencies` cut from `release/3.1` (`c54a437`) on macOS 26.7.3 arm64 (Apple M4 Pro, 48 GiB unified memory, Node `v26.13.1`, Python `3.11.18`, Rust `1.89.0` for `speakrs-cli` / `speakrs-cpu-smoke`). `package.json` remains at `3.0.0` pending final cross-platform qualification and release cut authorization.

### Applied dependency & qualification updates

- **npm security `overrides` (`package.json`, `package-lock.json`):** Updated `brace-expansion@1` (`1.1.21` → `1.1.22`), `brace-expansion@2` (`2.1.7` → `2.1.8`), and `undici@7` (`7.30.1` → `7.30.2`) via `npm install`. Kept `electron@46.0.0-alpha.11`, `electron-builder@26.18.0`, `electron-updater@6.8.11`, `marked@18.2.1`, `dompurify@3.4.18`, `adm-zip@0.6.1`, `picomatch@4.0.7`, and `build.toolsets.appimage: "1.0.2"` intact.
- **Python 3.11 build & dev/runtime pins:**
  - `requirements-windows-build.txt` & `requirements-linux-build.txt`: `av==18.1.0` → `18.1.1` (`<19` ceiling), `PyYAML==6.0.3` → `6.0.4`, `pydantic==2.14.3` → `2.14.4`, `pydantic-core==2.50.4` → `2.50.5`, `certifi==2026.10.23` → `2026.11.20`.
  - `requirements-macos-build.txt`: `regex==2026.11.18` → `2026.11.19`, `PyYAML==6.0.3` → `6.0.4`, `pydantic==2.14.3` → `2.14.4`, `pydantic-core==2.50.4` → `2.50.5`, `certifi==2026.10.23` → `2026.11.20`.
  - `requirements-common.txt`, `requirements-windows.txt`, `requirements-linux.txt`, `requirements-macos.txt`, `requirements.txt`: bumped `certifi` floor from `>=2026.10.23` to `>=2026.11.20`.
- **Rust (`native/speakrs-cli/Cargo.lock`, `native/speakrs-cpu-smoke/Cargo.lock`):** Updated compatible patch crates under Rust `1.89.0` (`cc 1.11.2` → `1.11.3`, `nix 0.31.3` → `0.31.4` in `speakrs-cli`, `pin-project-lite 0.2.17` → `0.2.18`, `ucd-trie 0.1.7` → `0.1.8`) while keeping vendored `ndarray-npy` (`zip = "=9.0.5"`) and `.cargo/audit.toml` (`ignore = []`).
- **Legal SBOM & release assets:** Regenerated `legal/PYTHON-BUNDLED-PACKAGES.md` (68 direct pins) via `npm run legal:sbom` and verified `npm run legal:release-assets` (`ffmpeg-8.1.2.tar.xz` SHA-256 `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` + `avanevis-legal-3.0.0.zip`).
- **Chat Q&A inline-citation prompt/repair fix (`backend/history_qa/qa_runner.py`, `backend/history_qa/citation_verifier.py`, `tests/python/test_history_qa.py`):** During isolated Qwen3.5 9B `llama-server` host qualification, the `"All recordings"` overview query failed `verification_failed` (`missing_citations`) because Qwen emitted uncited bullets followed by a standalone `- [E1]` bullet on both initial and repair turns. Updated `build_qa_messages()` rule 4 and `build_repair_prompt(..., reason="missing_citations")` to forbid standalone `- [Ek]` bullets/lines and provide an inline example while keeping `verify_grounded_response()` strictly fail-closed; added regression coverage in `test_standalone_citation_bullets_fail_closed_and_prompts_forbid_them`.

### Documented holds (verified live on 2026-11-21)

- **Electron (`46.0.0-alpha.11`):** Held because npm still has no stable `46.x` release (`latest: 45.4.1`, `alpha-46-x-y: 46.0.0-alpha.12`). Linux `safeStorage` version guards (`src/ai-addon-token-store.js`, `src/main-process/linux-electron-bootstrap.js`) remain untouched until a stable `46.x` release is qualified.
- **FFmpeg (`8.1.2`):** Held across Windows, macOS, Linux, and source (`ffmpeg.org`) because `shaka-project/static-ffmpeg-binaries` still tops at `n8.1.2-2` (`8.1.2`) while `GyanD/codexffmpeg` is at `9.1`, so no matched cross-platform release `> 8.1.2` exists.
- **Bundled CPython (`3.11.18+20261110`) & `pip` (`26.3`):** Already at latest upstream releases (`astral-sh/python-build-standalone` `20261110` and PyPI `pip 26.3`); Windows `python311._pth` isolation and CA bundle replacement remain intact.
- **`llama.cpp` & Inkling 2 Mini:** Latest numbered `ggml-org/llama.cpp` release remains `b12608` (3 commits behind the loop-layer scale fix `690b87d8`). Kept Phase 4 `llama.cpp` pins (`b9173`/`v0.3.0` for Qwen3.5; `b12606`/`v1.0.0` for Gemma 4) and kept Inkling 2 Mini gated.
- **Python 3.11 ceilings & platform qualification holds:** Kept `numpy==2.4.6` (`<2.5`), `scipy==1.17.1` (`<1.18`), `av==18.1.1` (`<19`), `networkx==3.6.1` (`<3.7`), `huggingface-hub==1.33.0` (`<2`), `mpmath==1.3.0` (`<1.4`), `tiktoken==0.3.3`; kept `onnxruntime==1.31.1` (ETW + Linux `strace` verification required for `1.32.0`), `ctranslate2==4.8.5` (Win/Linux CPU+CUDA parity required for `4.9.0`), `pyobjc-*==12.2.2` (macOS permission smoke required for `13.0`), `HF_HUB_DISABLE_XET=1`, `build/parakeet/*.lock.json`, `DIARIZATION_DEPENDENCY_ARTIFACTS` (`pyannote.audio==4.0.7`, `torch==2.13.0`), and `linux-cuda-runtime-catalog.js` (`nvidia-cublas-cu12==12.9.2.10` / `nvidia-cudnn-cu12==9.22.0.52`, rejecting CUDA 13).
- **`speakrs` (`=0.7.0`):** Held because `0.8.0` switches to `ort ^2.0.0-rc.15`, requiring full CoreML and CUDA CLI contract requalification across all three platforms.

### Fresh security & closure audit results

- **GitHub PRs & Dependabot:** `gh pr list --state open` returned `[]`; `gh api repos/:owner/:repo/dependabot/alerts?state=open` returned `0` open alerts.
- **npm audits:** `npm audit` and `npm audit --omit=dev` both exited `0` (`found 0 vulnerabilities`).
- **Python closure & `pip-audit`:** `scripts/check-build-requirements-closure.py windows macos linux` exited `0` (`ok` for all three build files); `scripts/pip_audit_inventory.py` reported `0` findings on `requirements-windows-build.txt`, `requirements-linux-build.txt`, `requirements-macos-build.txt`, `parakeet-linux-cuda`, `parakeet-macos-metal`, `parakeet-windows-cuda`, and `bootstrap` (`pip 26.3`); the intentionally vulnerable canary (`tests/fixtures/dependency-inventory/vulnerable-parakeet.lock.json`) flagged all `8` expected CVEs; `scripts/qualify-pyannote-runtime.py --resolve-only --platform-key darwin-arm64` resolved `94` distributions with `0` `pip-audit` findings.
- **Rust `cargo audit`:** `cargo audit --deny warnings` exited `0` on both `native/speakrs-cli/Cargo.lock` (110 crate dependencies) and `native/speakrs-cpu-smoke/Cargo.lock` (72 crate dependencies).

### Fresh macOS arm64 host qualification evidence

- **Automated & build gates:** `npm run test:all` exited `0` (`JS: 1,349 passed, 0 failed, 3 skipped`; `Python: 988 passed, 6 skipped`; JS and Python syntax checks clean); `python3 scripts/agents/validate_setup.py` exited `0`; `cargo +1.89.0 test --locked` passed (`8 + 1` tests), `verify-speakrs-packaging.js --check-product-modes` passed, and `run-speakrs-cpu-smoke.js` passed (`6 segment(s)`); `npm run build:mac:dir` and `npm run verify:mac:packaged` exited `0` (`AvaNevis.app` `984M`, Python `677M`, FFmpeg `32M`, designated-requirement valid, no bundled torch).
- **Electron 46 alpha token smoke (`tests/fixtures/electron/token-migration-smoke.js`):** Passed on macOS arm64 (`async-roundtrip`, `async-write`, `restart` all exited `0` with `available: true`, `protectedByAppPolicy: true`, `roundTrip: true`, `format: "v10"`).
- **Isolated packaged-resource Task 5.4 harness (disposable `tempUserData`, packaged Python `3.11.18`/backend/FFmpeg `8.1.2`, APFS-cloned `Qwen3.5-9B-Q4_K_M.gguf` + `llama-b9173`):**
  - *Chat Q&A Suite (`llama-server` loopback):* Date-filtered `"05/09/2026"` query disambiguated `2026-09-05` from decoy recordings and answered with verified citation; `"All recordings"` overview query answered with `3` verified citations across all seeded recordings; legacy recording without `.captions.json` and legacy summary lacking `sourceTranscriptHash` answered with verified citation; two-turn pronoun follow-up (`"What did Andy say about deadlines?"` → `"What were the risks?"`) maintained thread continuity and cited `targetDateRec`; speaker-renamed search for `"Alice"` returned the meeting and Chat cited `Alice` with timestamp metadata.
  - *Tags & Tag-Aware Summaries (`Qwen3.5-9B`):* Assigned and verified all `11` canonical tags + `search-history` tag filtering; generated real Qwen summaries across `meeting` (`balanced`), `appointment`, `call`, `lecture`, `voice-note`, and `music` (`concise`) templates with `templateVersion: "tag-templates-v1"` and clean empty-section omission (`"None captured."` absent on non-meeting templates); re-tagging (`meeting` → `interview`) preserved FTS5 search hits while retaining `ai.summary.tag == "meeting"` for mismatch detection.
  - *Speaker Naming & Exports:* `ai.diarization.speakerNames` (`Speaker 1` → `Alice`) left the committed `.md` bytes and `.captions.json` `sourceTranscriptHash` intact, propagated `speakerNamesHash` into summary metadata, and rendered `**Alice:**` (`.md`), `Alice:` (`.txt`/`.srt`), and `<v Alice>` (WebVTT).
  - *Model Library, Process Slot & Removal:* Verified legacy v3.0 `qwen3.5-9b-q4-k-m` adoption into `summaryLibrary` (`5,734,282,238` installed bytes), competing `generate-summary` unloading the resident `llama-server` and confirming POSIX process-group exit before launching `llama-cli`, manual `unload-history-qa-model` confirming POSIX process-group exit (`ESRCH`), and `remove-summary-model` deleting cloned weights/runtime (`installedBytes: 0`, `status: "notConfigured"`) while preserving recordings, summaries, and all `6` surviving Chat threads. Paired with same-day Phase 4 M4 Pro evidence for Gemma 4 E4B/12B two-model switching, fit, default replacement, and shared runtime cleanup.

### Remaining cross-platform gates before `v3.1.0` tag

- **Windows 10/11 x64:** `npm ci` + `npm run test:all`, `scripts/check-build-requirements-closure.py windows`, native `build:dir` / NSIS installer build + `verify-windows-installer.ps1`, Electron `token-migration-smoke.js` (`DPAPI`), Task 5.4 Chat Q&A / Tags / Speaker naming / Model library + Windows Job Object cancel/timeout verification on native CUDA hardware.
- **Linux x86_64 (CachyOS / Omarchy Hyprland/Wayland/PipeWire):** `npm ci` + `npm run test:all`, `scripts/check-build-requirements-closure.py linux`, `build:linux` (`AppImage` / `pacman` / `deb`) + `verify:linux:packaged`, Electron `token-migration-smoke.js` (`v11`/`v12` vs `v10` fixed-key rejection), `qualify-onnx-vad.py`, and Task 5.4 Chat Q&A `"All recordings"` / Tags / Speaker naming / managed CUDA 12 Model library verification.
- **Interactive desktop & release cut:** Final interactive macOS desktop UI pass (History voice-preview playback, responsive `#summary-language-modal` + Settings Model Library UI), `package.json` version bump `3.0.0` → `3.1.0`, `docs/releases/v3.1.0.md` + `npm run legal:release-assets` for `3.1.0`, PR merge to `release/3.1` → `master`, and authorized `v3.1.0` tag.
