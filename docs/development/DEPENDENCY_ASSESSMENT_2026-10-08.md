# AvaNevis dependency assessment — 8 October 2026

> The maintenance work, refreshed evidence and remaining host gates are recorded in
> [DEPENDENCY_MAINTENANCE_2026-10.md](DEPENDENCY_MAINTENANCE_2026-10.md). This assessment stays
> as the dated snapshot.

## Recommendation

Prioritize the dependencies outside ordinary Dependabot coverage: optional Parakeet and pyannote runtimes, the pip bootstrap, bundled Python, and Rust transitives. Update Electron within major 44. Keep Python 3.11 for the immediate maintenance work; qualify a newer interpreter in a separate migration. Do not merge all version-update PRs together.

This assessment inspected commit `f3e58a7523221b3fe470d0232e1571b1f7a60c6a`, with an initially clean working tree. No application dependencies, lockfiles, GitHub settings, or PRs were changed. Versions below are a dated snapshot, not permanent upgrade instructions.

## Evidence and limits

- Read package.json/package-lock.json, all root requirements files, backend/requirements.txt, three Parakeet wheel closures, Rust manifest/lock/ORT pins, Swift Package.swift, runtime catalogs, packaging code, Dependabot and CI/release workflows, and canonical packaging/local-AI contracts.
- Queried all six open Dependabot PRs and their checks; inspected failing logs for AnyIO and llvmlite.
- Ran `npm audit --json`, `npm audit --omit=dev --json`, and `npm outdated --json`. The full audit found eight moderate affected-package entries, all propagated from one sprintf-js advisory; zero high/critical. The production-only audit returned zero. Electron is declared a devDependency but becomes the shipped runtime, so production-only npm audit does **not** establish desktop runtime safety.
- Queried PyPI metadata/advisories for 89 normalized package names across packaged requirements and Parakeet locks, plus separately checked pyannote's explicitly pinned packages and bootstrap pip. No advisories were returned for the exact pins in the three base build requirements. This is a metadata scan, not a fresh platform resolver run or a complete scan of pyannote's dynamically resolved transitives.
- Queried OSV for 271 registry entries in Cargo.lock; rustls was the single affected package (two advisory identifiers for the same issue). This is not a target-specific cargo-audit/build-graph analysis.
- GitHub's alerts endpoint returned HTTP 403, explicitly saying **Dependabot alerts are disabled for this repository**. The CLI also mentioned `admin:repo_hook` scope. Consequently, there is no verified GitHub security-alert count. Version-update PRs are separate and are active.
- Native runtime components (CPython, OpenSSL, FFmpeg, ORT, CUDA, llama.cpp) need artifact/SBOM-level scanning. This assessment checked their pins, upgrade sources and coverage gaps; it does not certify every embedded C/C++ library CVE.
- No installation, full regression suite, packaged build, GPU inference, hardware recording, or exploit reproduction was performed. Existing CI success is not fresh hardware acceptance. Installed userData add-ons were not enumerated or changed.

## Security priorities

### 1. High priority: pyannote installs an old Torch runtime

Evidence: `src/ai-addon-state.js:280` and `:315` pin Torch/torchaudio 2.8.0 (Windows uses +cu126), TorchCodec 0.7.0, pyannote.audio 4.0.1; Windows also pins torchvision 0.23.0. This is separate from the macOS build requirement Torch 2.13.0, which is installed during packaging and pruned.

Torch 2.8.0 has published advisories. Most consequentially, CVE-2026-24747 describes malicious checkpoint loading with `weights_only=True` causing memory corruption and possible code execution; its fix starts at 2.10.0. Other returned advisories have fix floors through 2.13.0, and PYSEC-2026-139 has no fixed version listed in the queried record. Do not treat 2.10.0 as an adequate universal target or promise that updating clears every finding. [PyTorch maintainer advisory](https://github.com/pytorch/pytorch/security/advisories/GHSA-63cw-57p8-fm3p), [Torch 2.8.0 metadata](https://pypi.org/pypi/torch/2.8.0/json).

App-specific exposure is conditional: the user must install this optional add-on, and the checkpoint issue requires a malicious checkpoint. Existing pinned/verified model handling reduces exposure; this review did not prove an attack through the UI. Also, `backend/diarization/diarization_pipeline.py:44` deliberately scopes `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1` around trusted pyannote loading. That means the weights-only advisory is evidence of an affected installed package, not proof that this particular restricted-loader exploit is the app's active path. The legacy loader still depends on trusted checkpoints; upgrading Torch does not make arbitrary pickle checkpoints safe. An optional inference runtime deserves the same security maintenance as the base app.

Recommendation: qualify a coordinated, patched PyTorch/torchaudio/TorchCodec/pyannote set for Python 3.11, CUDA 12 and macOS MPS. PyPI currently reports Torch 2.14.1 and pyannote.audio 4.0.7, but **these are research candidates, not a verified compatible set**. Check matching official wheels and decoder compatibility before choosing exact pins. Lock/audit the full resolved closure, preserve explicit setup and repair/uninstall paths, and make obsolete installed runtimes visibly require repair. If no secure supported closure exists, report that blocker rather than silently accepting CPU/CUDA-13 fallbacks or keeping an apparently ready vulnerable installation.

### 2. High priority: Parakeet macOS lock missed security updates

Evidence: `build/parakeet/macos-metal.lock.json:7069` pins msgpack 1.1.2; `:32210` pins urllib3 2.7.0. The base macOS requirements already pin urllib3 2.8.0, but the isolated Parakeet environment has its own closure.

- msgpack: upgrade to **1.2.3**, at least 1.2.1. GHSA-6v7p-g79w-8964 is an upstream high-severity out-of-bounds/crash issue when reusing an Unpacker after an error. Presence is confirmed; exploitability through AvaNevis was not established. [Advisory](https://github.com/advisories/GHSA-6v7p-g79w-8964).
- urllib3: upgrade to **2.8.0**, fixing CVE-2026-97687/97688/97689 (HTTPS proxy TLS handling and two response-streaming denial-of-service issues). Networking/proxy/response conditions determine reachability. [TLS advisory](https://github.com/advisories/GHSA-8988-9cw3-xx77), [deflate advisory](https://github.com/advisories/GHSA-gh4c-6fx4-qh6g), [chunk parsing advisory](https://github.com/advisories/GHSA-vxq7-64xx-v4gw).

Regenerate wheel URL, size, SHA-256 and extracted-file inventory from real wheel bytes. Changing the version string alone breaks the integrity contract. Check lock identity invalidation and existing-install repair. Keep the CUDA closures independent from macOS and from Whisper.

### 3. High maintenance priority: bootstrap pip has published advisories

Evidence: `build/download-manifest.js:46` pins pip 26.0.1, consumed by `build/prepare-resources.js:347`.

Upgrade to **pip 26.2.1**, with its actual wheel URL/checksum. Metadata for 26.0.1 reports CVE-2026-3219, CVE-2026-6357, CVE-2026-8643 and CVE-2026-13346, including archive ambiguity and installation-path issues. Fix floors extend to 26.2. Trusted package sources and checksums reduce exposure; these are installer/build/setup risks, not a proven remote app exploit. [Version-specific advisory data](https://pypi.org/pypi/pip/26.0.1/json).

### 4. Medium priority: Rust TLS transitive dependency

Evidence: `native/speakrs-cli/Cargo.lock:1545` contains rustls **0.23.43**. Upgrade the compatible lockfile entry to **0.23.45** or a newer audited patch. RUSTSEC-2026-0285 / GHSA-2mjx-qc3c-rqvc describe accepting TLS handshake messages across encryption boundaries. The transcript remains authenticated; the advisory does not claim a network attacker can complete an altered handshake. Inspect reverse dependencies/features to distinguish download/build paths from the offline CLI. [RustSec advisory](https://rustsec.org/advisories/RUSTSEC-2026-0285.html).

Speakrs **0.5.0 is still the latest stable crate**. Do not upgrade its API or ORT simply to repair rustls. Preserve `--locked`, Rust 1.88 minimum compatibility, platform features and frozen stdout contract.

### 5. Medium priority: npm build-chain advisory has no straightforward patch

The sole root advisory is [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): sprintf-js unbounded precision can cause denial of service. Its chain passes through roarr/global-agent/@electron/get into electron-builder. All eight npm entries refer to this dependency chain, not eight independent CVEs. Runtime reachability through user content was not established.

Registry latest sprintf-js remains 1.1.3, which the audit flags. npm proposes electron-builder 26.5.0, a **downgrade** from 26.16.1. Do not run `npm audit fix --force` or apply that downgrade blindly. Investigate a newer builder/transitive closure; if unresolved, retain a narrow documented advisory exception with owner, expiry and reachable-input analysis. Do not suppress the entire dev dependency tree.

## Runtime upgrades and compatibility decisions

### Electron and npm

- **Electron 44.1.0 → 44.7.0:** recommend next maintenance release. Both npm and the upstream GitHub release confirm 44.7.0 (7 October 2026), with Chromium/V8 and other upstream backports. Regenerate the npm lock, verify tray, dialogs, preload/IPC, recording lifecycle and packaged app startup on all supported hosts. [Release notes](https://github.com/electron/electron/releases/tag/v44.7.0). Electron supports its latest three stable majors and only the latest minor of each; schedule regular updates rather than pinning 44 indefinitely. [Support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
- **electron-builder 26.16.1:** evaluate **26.17.0**, but hold adoption until provenance/release notes and a clean packaged matrix are verified. npm's `v26` tag is 26.17.0 while `latest` is 26.15.3; the GitHub v26.17.0 release lookup returned 404. This inconsistency is not proof of compromise, but prevents a confident automatic recommendation. Avoid 27 alpha and blind downgrade to `latest`.
- **adm-zip 0.6.1:** retain; npm reported no newer version and no production audit findings. Preserve existing archive traversal guards.
- Existing npm overrides currently remove older known issues; do not delete them wholesale. Reassess each against the regenerated graph and upstream ranges, and retire only those demonstrably redundant. No new forced-major override is recommended.

### Packaged Python and FFmpeg

- Windows bundles **Python 3.11.9**; macOS/Linux bundle **3.11.7+20240107** (`build/download-manifest.js:5–18`). Latest standalone release **20261003** exposes **3.11.17** artifacts for all three architectures. Upgrade macOS/Linux to those vetted artifacts after wheel/OS validation. Windows requires an explicit layout decision: standalone Python is **not** a drop-in replacement for the official embedded archive. [Standalone release assets](https://github.com/astral-sh/python-build-standalone/releases/tag/20261003).
- Windows packaging and Parakeet depend on `python311._pth`, `python311.zip`, `_ctypes.pyd`, isolated import roots and embedded layout. Preserve those guarantees when qualifying a maintained interpreter distribution; check OpenSSL/zlib and provenance, not just the version label. Do not invent a nonexistent official 3.11.17 embedded URL. Python 3.11 entered security-only maintenance after its last normal binary release. [Python 3.11 release guidance](https://www.python.org/downloads/release/python-31114/).
- Python 3.11 security support ends **October 2027**. Start a Python **3.13 qualification** project now, with 3.12 as a compatibility fallback rather than assuming the newest interpreter has every GPU wheel. Target a migration decision in Q1 2027. This is a proposed roadmap, not an approved baseline change. [Python lifecycle](https://devguide.python.org/versions/).
- **FFmpeg 8.0.1 → 8.0.3** is the conservative maintenance candidate; evaluate **8.1.3** if trustworthy matching artifacts are available across all hosts. Latest 9.0.2 is a separate major qualification. Refresh binary pins, source bundle/legal notices and codec provenance together. Upstream publishes source, not the third-party binaries used here. Test Opus encode/decode, stereo/downmix, resampling, recovery and malformed/imported media. No specific FFmpeg CVE exploit was established in this assessment. [Official releases](https://ffmpeg.org/download.html).

### Python packages

Recommended relatively small updates, still subject to resolution and focused tests:

- filelock **3.32.3 → 3.32.7**; retain major 3 until model-download/concurrent-process lock semantics are tested against 4.0.12.
- anyio **4.14.2 → 4.15.1**; tokenizers **0.23.1 → 0.23.2**; protobuf **7.36.0 → 7.36.2**; tqdm **4.70.0 → 4.70.1**; typer **0.27.2 → 0.27.3**; idna **3.19 → 3.20**; charset-normalizer **3.5.1 → 3.5.2**; MarkupSafe **3.0.3 → 3.0.4**.
- fsspec **2026.7.0 → 2026.9.0**, hf-xet **1.6.0 → 1.7.0**, huggingface-hub **1.29.0 → 1.33.0**: coordinate downloader/cache/offline tests; do not jump to hub 2.1.1 because both current and candidate tokenizers require hub `<2.0`.
- CTranslate2 **4.8.1 → 4.8.2**, PyAudioWPatch **0.2.12.8 → 0.2.12.9**, MLX/MLX-Metal **0.32.2 → 0.32.3**, parakeet-mlx **0.5.2 → 0.5.3**: useful candidates, but require CUDA/capture/Metal hardware checks respectively. Keep coupled versions aligned only within the environments that use them.
- Base Python ONNX Runtime **1.26.0 → 1.30.0**: reasonable candidate; Python 3.11 wheels exist and its PR is green. This does **not** authorize changing Speakrs native ORT or Parakeet GPU ORT.
- Numba **0.67.0 + llvmlite 0.49.0 → 0.68.0 + 0.50.0 together**. Existing Numba requires llvmlite `<0.50`; candidate Numba requires `>=0.50.0dev0,<0.51`. Regenerate and validate the macOS closure; isolated llvmlite upgrades cannot resolve.

Hold these updates on Python 3.11:

- NumPy **2.4.6 → 2.5.3**, SciPy **1.17.1 → 1.18.1**, PyAV **18.1.0 → 19.0.1**, NetworkX **3.6.1 → 3.7**, librosa **0.11.0 → 1.0.0**: latest metadata requires Python **>=3.12**. Current compatibility branches queried have no newer patch than the current pins.
- tiktoken **0.3.3 → 0.14.0**: lightning-whisper-mlx 0.0.10 explicitly requires `tiktoken==0.3.3`; an independent update is incompatible. Investigate a maintained MLX Whisper adapter/replacement during Python migration; this is architectural work with transcription parity tests, not a security fix established here.
- mpmath **1.3.0 → 1.4.1**: SymPy 1.14.0 requires `<1.4`.
- faster-whisper 1.2.1, lightning-whisper-mlx 0.0.10, PyObjC 12.2.2 family, sounddevice 0.5.6, SoundCard 0.4.6, pulsectl 24.12.0 and soxr 1.1.0 are already latest according to queried metadata. Keep all seven PyObjC packages coordinated. Latest alone is not a guarantee of maintenance or security.

The complete per-package inventory follows below; its latest column is informational, not an instruction to upgrade.

### Native GPU, summary and Swift components

Speakrs uses Rust `ort`/`ort-sys` 2.0.0-rc.13, a compile-time macOS ORT 1.28.0 archive, and setup-time Windows/Linux ORT 1.27.1 CUDA-12 archives. Parakeet separately uses onnxruntime-gpu 1.23.2 and cuDNN 9.26.0.51; Whisper's Linux catalog uses cuDNN 9.22.0.52. These differences are intentional compatibility boundaries. ORT latest 1.30.0 and cuDNN 9.27.0.42 warrant qualification, not synchronization by version number. Check provider ABI, driver floors, cuBLAS/cuDNN, OS minimums, extracted hashes and real offline inference.

Summaries pin llama.cpp **b9173** on Windows/macOS and ai-dock **v0.3.0** on Linux (`src/ai-addon-state.js:77–162`). ai-dock latest is v0.6.0. ggml-org's latest-release API returned v0.6.0 with only a nightly-tag.txt asset; it is not itself a verified replacement binary set. Select an immutable release with the required CUDA-12/macOS assets, inspect security/release changes, and benchmark JSON-schema output, multilingual output, context limits, cancellation and memory before adoption. Do not assume a current tag contains a compatible binary.

Swift has **no external package dependencies**. Its tools version 5.9 is a minimum language/toolchain declaration, not a downloadable dependency pin. Use a supported Xcode/Swift toolchain while keeping macOS support requirements and audio helper behavior. Avoid an unrelated Swift language-mode migration.

## Disposition of the open Dependabot PRs

- [#112 ONNX Runtime 1.30.0](https://github.com/AmirArshad/meeting-transcriber/pull/112): all eight checks successful at assessment time. First reasonable normal dependency candidate after security work; still needs packaged Windows/Linux transcription verification.
- [#111 AnyIO 4.15.1](https://github.com/AmirArshad/meeting-transcriber/pull/111): seven checks successful; JS/build-smoke check failed with Windows EPERM rename errors in Parakeet/Speakrs tests. No direct AnyIO incompatibility was shown. Rerun once and investigate persistent filesystem failures; do not waive them as proven flakiness.
- [#109 llvmlite 0.50.0](https://github.com/AmirArshad/meeting-transcriber/pull/109): do not merge alone. macOS audit explicitly failed resolution against Numba 0.67.0; macOS backend also had a recorder test failure. Replace with coordinated Numba/llvmlite work.
- [#110 NumPy 2.5.3](https://github.com/AmirArshad/meeting-transcriber/pull/110): hold for interpreter migration; six failed checks and Python >=3.12 requirement.
- [#93 SciPy 1.18.1](https://github.com/AmirArshad/meeting-transcriber/pull/93): hold for interpreter migration; macOS tests/audit failed and Python >=3.12 requirement.
- [#101 Electron 44.3.0](https://github.com/AmirArshad/meeting-transcriber/pull/101): supersede its dependency target with 44.7.0. The current PR diff also contains plan/todo and inference benchmark/test files; there were no reported checks. Inspect why before any merge. Do not assume it is a clean bot-only bump or discard unrelated work.

These PRs were assessed as references; none was modified, rebased, closed or merged.

## Prevention and maintenance policy

1. Enable and verify GitHub dependency graph, Dependabot alerts and security updates using an authorized repository-admin session. The YAML alone does not enable security alerts. Preserve a written record if policy or permissions prevent enabling them.
2. Add Dependabot `cargo` coverage for `/native/speakrs-cli` and `github-actions` coverage for `/`. Separate Electron from packaging tooling and group genuinely coupled Python families (Numba/llvmlite, PyObjC); avoid grouping every ML dependency together. Current NumPy/SciPy major-only ignores do not prevent incompatible **minor** updates. Encode/document Python-3.11-compatible ceilings and revisit them with migration. Keep tiktoken's reasoned constraint, with a review date.
3. Expand CI to audit Linux build requirements, all three Parakeet closures, resolved pyannote closures, Cargo.lock, and bootstrap/build/runtime catalogs. Custom JS/JSON catalogs need an extraction step or submitted dependency snapshot; Dependabot does not automatically interpret them. Validate that an intentionally vulnerable fixture makes the extractor/audit fail.
4. Run security scans on a schedule as well as pushes/PRs; current CI has no schedule. Fail on actionable high/critical advisories, surface moderate findings, and use only narrow, expiring exceptions after applicability review. Keep resolver failures visibly distinct from clean audit results. Pin audit-tool versions and periodically upgrade them.
5. Pin Actions by full immutable commit SHA with readable version comments. Current candidates: checkout v6 → **v7.0.1**, setup-node v6 → **v7.1.0**, setup-python v6 → **v7.0.0**, cache v4 → **v6.1.0**, markdownlint action v23 → **v24.2.0**. Upload/download artifact majors 7/8 and softprops major 3 are current (latest patches 7.0.2/8.0.2/3.0.3). rust-cache 2.9.2 is current and already SHA-pinned; link-check 1.0.17 is latest. Review runner/toolchain requirements before major action bumps. Add minimal read permissions to CI and scope release write permissions to publishing jobs.
6. Keep Node **24 LTS** as the build-tool baseline pending an explicit toolchain review; the Node used by Electron is updated via Electron. Broad host `24` tracking and hashed action pins solve different problems. Record actual build tool versions in release provenance.
7. Produce per-platform SBOMs for **what is shipped after pruning**, plus separate setup-time add-on SBOMs. Include Python interpreter/OpenSSL, FFmpeg and native libraries, Cargo components, and checksummed GPU/summary assets. Existing Python SBOM/legal scripts provide a starting point, not complete add-on coverage.
8. Make development/CI reproduce packaged pins via shared constraints or an equivalent lock workflow. Current `>=` development manifests can test a different environment from shipped requirements. Remove/deprecate stale backend/requirements.txt only after identifying consumers. Full hashes for build wheels and resolved pyannote closures reduce drift and index substitution risk.
9. Suggested service targets: investigate high/critical alerts within 48 hours; ship applicable fixes within seven days; review Electron/security patches weekly; assess native binaries monthly; review interpreter/OS/GPU support quarterly. These are proposed project policy, not automations created by this assessment.

## Acceptance for the implementation session

Run focused tests while changing each closure, then `npm run test:all`. Resolve/audit each platform's pinned environment on a matching runner. Use actual wheel/archive bytes for integrity changes. Rebuild installers without publishing; verify post-pruning SBOMs and resource invalidation. Record manual recording/recovery, CPU/CUDA/Metal/CoreML transcription, optional add-on install/repair/cancel/uninstall, offline behavior and summary output where affected. Preserve Windows 10/11 x64, macOS 14+ arm64, Linux x86_64 Core Beta and CUDA 12 policy. Report unavailable-host checks as outstanding, never as passing.

## Complete pinned Python package inventory

Source: live PyPI version-specific metadata queried 8 October 2026. Includes base build requirements and 82 wheel entries across the three Parakeet locks, normalized to 89 package names overall. “Latest” does not imply compatibility, an available target wheel or a security requirement. Optional pyannote and pip are assessed separately above. Python requirements shown are for the latest release. Scopes identify declared pins, not installations on this machine.

- **annotated-doc**: pinned 0.0.5; latest 0.0.5; latest Python `>=3.9`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/annotated-doc/json).
- **anyio**: pinned 4.14.2; latest 4.15.1; latest Python `>=3.10`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/anyio/json).
- **audioread**: pinned 3.1.0; latest 3.1.0; latest Python `>=3.9`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/audioread/json).
- **av**: pinned 18.1.0; latest 19.0.1; latest Python `>=3.12`. Scope: linux, windows. [Metadata](https://pypi.org/pypi/av/json).
- **certifi**: pinned 2026.7.22; latest 2026.7.22; latest Python `>=3.7`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/certifi/json).
- **cffi**: pinned 2.1.1; latest 2.1.1; latest Python `>=3.10`. Scope: linux, macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/cffi/json).
- **charset-normalizer**: pinned 3.5.1; latest 3.5.2; latest Python `>=3.7`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/charset-normalizer/json).
- **click**: pinned 8.5.0; latest 8.5.0; latest Python `>=3.10`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/click/json).
- **colorama**: pinned 0.4.6; latest 0.4.6; latest Python `!=3.0.*,!=3.1.*,!=3.2.*,!=3.3.*,!=3.4.*,!=3.5.*,!=3.6.*,>=2.7`. Scope: windows. [Metadata](https://pypi.org/pypi/colorama/json).
- **coloredlogs**: pinned 15.0.1; latest 15.0.1; latest Python `>=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*, !=3.4.*`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/coloredlogs/json).
- **ctranslate2**: pinned 4.8.1; latest 4.8.2; latest Python `>=3.9`. Scope: linux, windows. [Metadata](https://pypi.org/pypi/ctranslate2/json).
- **dacite**: pinned 1.9.2; latest 1.9.2; latest Python `>=3.7`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/dacite/json).
- **decorator**: pinned 5.2.1; latest 5.3.1; latest Python `>=3.8`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/decorator/json).
- **faster-whisper**: pinned 1.2.1; latest 1.2.1; latest Python `>=3.9`. Scope: linux, windows. [Metadata](https://pypi.org/pypi/faster-whisper/json).
- **filelock**: pinned 3.32.3; latest 4.0.12; latest Python `>=3.10`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/filelock/json).
- **flatbuffers**: pinned 25.12.19; latest 25.12.19; latest Python `not declared`. Scope: linux, windows, Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/flatbuffers/json).
- **fsspec**: pinned 2026.7.0; latest 2026.9.0; latest Python `>=3.10`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/fsspec/json).
- **h11**: pinned 0.16.0; latest 0.16.0; latest Python `>=3.8`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/h11/json).
- **hf-xet**: pinned 1.6.0; latest 1.7.0; latest Python `>=3.8`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/hf-xet/json).
- **httpcore**: pinned 1.0.9; latest 1.0.9; latest Python `>=3.8`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/httpcore/json).
- **httpx**: pinned 0.28.1; latest 0.28.1; latest Python `>=3.8`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/httpx/json).
- **huggingface-hub**: pinned 1.29.0; latest 2.1.1; latest Python `>=3.10.0`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/huggingface-hub/json).
- **humanfriendly**: pinned 10.0; latest 10.0; latest Python `>=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*, !=3.4.*`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/humanfriendly/json).
- **idna**: pinned 3.19; latest 3.20; latest Python `>=3.9`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/idna/json).
- **jinja2**: pinned 3.1.6; latest 3.1.6; latest Python `>=3.7`. Scope: macos. [Metadata](https://pypi.org/pypi/jinja2/json).
- **joblib**: pinned 1.5.2; latest 1.6.0; latest Python `>=3.10`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/joblib/json).
- **lazy-loader**: pinned 0.4; latest 0.6; latest Python `>=3.9`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/lazy-loader/json).
- **librosa**: pinned 0.11.0; latest 1.0.0; latest Python `>=3.12`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/librosa/json).
- **lightning-whisper-mlx**: pinned 0.0.10; latest 0.0.10; latest Python `not declared`. Scope: macos. [Metadata](https://pypi.org/pypi/lightning-whisper-mlx/json).
- **llvmlite**: pinned 0.49.0; latest 0.50.0; latest Python `>=3.10`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/llvmlite/json).
- **markdown-it-py**: pinned 4.2.0; latest 4.2.0; latest Python `>=3.10`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/markdown-it-py/json).
- **markupsafe**: pinned 3.0.3; latest 3.0.4; latest Python `>=3.9`. Scope: macos. [Metadata](https://pypi.org/pypi/markupsafe/json).
- **mdurl**: pinned 0.1.2; latest 0.1.2; latest Python `>=3.7`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/mdurl/json).
- **mlx**: pinned 0.32.2; latest 0.32.3; latest Python `>=3.10`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/mlx/json).
- **mlx-metal**: pinned 0.32.2; latest 0.32.3; latest Python `>=3.10`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/mlx-metal/json).
- **more-itertools**: pinned 11.1.0; latest 11.1.0; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/more-itertools/json).
- **mpmath**: pinned 1.3.0; latest 1.4.1; latest Python `>=3.9`. Scope: macos, Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/mpmath/json).
- **msgpack**: pinned 1.1.2; latest 1.2.3; latest Python `>=3.10`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/msgpack/json). **Advisories returned for an existing pin; see security findings.**
- **networkx**: pinned 3.6.1; latest 3.7; latest Python `!=3.14.1,>=3.12`. Scope: macos. [Metadata](https://pypi.org/pypi/networkx/json).
- **numba**: pinned 0.67.0; latest 0.68.0; latest Python `>=3.10`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/numba/json).
- **numpy**: pinned 2.4.6; latest 2.5.3; latest Python `>=3.12`. Scope: linux, macos, windows, Parakeet Linux, Parakeet macOS, Parakeet Windows. [Metadata](https://pypi.org/pypi/numpy/json).
- **nvidia-cublas-cu12**: pinned 12.9.2.10; latest 12.9.2.10; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-cublas-cu12/json).
- **nvidia-cuda-nvrtc-cu12**: pinned 12.9.86; latest 12.9.86; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-cuda-nvrtc-cu12/json).
- **nvidia-cuda-runtime-cu12**: pinned 12.9.79; latest 12.9.79; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-cuda-runtime-cu12/json).
- **nvidia-cudnn-cu12**: pinned 9.26.0.51; latest 9.27.0.42; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-cudnn-cu12/json).
- **nvidia-cufft-cu12**: pinned 11.4.1.4; latest 11.4.1.4; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-cufft-cu12/json).
- **nvidia-curand-cu12**: pinned 10.3.10.19; latest 10.3.10.19; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-curand-cu12/json).
- **nvidia-nvjitlink-cu12**: pinned 12.9.86; latest 12.9.86; latest Python `>=3`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/nvidia-nvjitlink-cu12/json).
- **onnx-asr**: pinned 0.12.0; latest 0.12.0; latest Python `>=3.10`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/onnx-asr/json).
- **onnxruntime**: pinned 1.26.0; latest 1.30.0; latest Python `>=3.11`. Scope: linux, windows. [Metadata](https://pypi.org/pypi/onnxruntime/json).
- **onnxruntime-gpu**: pinned 1.23.2; latest 1.30.0; latest Python `>=3.11`. Scope: Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/onnxruntime-gpu/json).
- **packaging**: pinned 26.3; latest 26.3; latest Python `>=3.9`. Scope: linux, macos, windows, Parakeet Linux, Parakeet macOS, Parakeet Windows. [Metadata](https://pypi.org/pypi/packaging/json).
- **parakeet-mlx**: pinned 0.5.2; latest 0.5.3; latest Python `>=3.10`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/parakeet-mlx/json).
- **platformdirs**: pinned 4.4.0; latest 4.12.4; latest Python `>=3.10`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/platformdirs/json).
- **pooch**: pinned 1.8.2; latest 1.9.0; latest Python `>=3.9`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/pooch/json).
- **protobuf**: pinned 7.36.0, 7.36.2; latest 7.36.2; latest Python `>=3.10`. Scope: linux, windows, Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/protobuf/json).
- **pulsectl**: pinned 24.12.0; latest 24.12.0; latest Python `not declared`. Scope: linux. [Metadata](https://pypi.org/pypi/pulsectl/json).
- **pyaudiowpatch**: pinned 0.2.12.8; latest 0.2.12.9; latest Python `not declared`. Scope: windows. [Metadata](https://pypi.org/pypi/pyaudiowpatch/json).
- **pycparser**: pinned 3.0; latest 3.0; latest Python `>=3.10`. Scope: linux, macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/pycparser/json).
- **pygments**: pinned 2.21.0; latest 2.21.0; latest Python `>=3.9`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/pygments/json).
- **pyobjc-core**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-core/json).
- **pyobjc-framework-avfoundation**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-framework-avfoundation/json).
- **pyobjc-framework-cocoa**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-framework-cocoa/json).
- **pyobjc-framework-coreaudio**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-framework-coreaudio/json).
- **pyobjc-framework-coremedia**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-framework-coremedia/json).
- **pyobjc-framework-quartz**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-framework-quartz/json).
- **pyobjc-framework-screencapturekit**: pinned 12.2.2; latest 12.2.2; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/pyobjc-framework-screencapturekit/json).
- **pyreadline3**: pinned 3.5.4; latest 3.5.6; latest Python `>=3.8`. Scope: Parakeet Windows. [Metadata](https://pypi.org/pypi/pyreadline3/json).
- **pyyaml**: pinned 6.0.3; latest 6.0.3; latest Python `>=3.8`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/pyyaml/json).
- **regex**: pinned 2026.7.19; latest 2026.9.29; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/regex/json).
- **requests**: pinned 2.34.2; latest 2.34.2; latest Python `>=3.10`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/requests/json).
- **rich**: pinned 15.0.0; latest 15.0.0; latest Python `>=3.9.0`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/rich/json).
- **scikit-learn**: pinned 1.7.2; latest 1.9.1; latest Python `>=3.11`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/scikit-learn/json).
- **scipy**: pinned 1.17.1; latest 1.18.1; latest Python `>=3.12`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/scipy/json).
- **setuptools**: pinned 84.0.0; latest 84.0.0; latest Python `>=3.10`. Scope: linux, macos, windows. [Metadata](https://pypi.org/pypi/setuptools/json).
- **shellingham**: pinned 1.5.4; latest 1.5.4; latest Python `>=3.7`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/shellingham/json).
- **soundcard**: pinned 0.4.6; latest 0.4.6; latest Python `>=3.5`. Scope: linux. [Metadata](https://pypi.org/pypi/soundcard/json).
- **sounddevice**: pinned 0.5.6; latest 0.5.6; latest Python `>=3.7`. Scope: macos. [Metadata](https://pypi.org/pypi/sounddevice/json).
- **soundfile**: pinned 0.13.1; latest 0.14.0; latest Python `>=3.10`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/soundfile/json).
- **soxr**: pinned 1.1.0; latest 1.1.0; latest Python `>=3.9`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/soxr/json).
- **sympy**: pinned 1.14.0; latest 1.14.0; latest Python `>=3.9`. Scope: macos, Parakeet Linux, Parakeet Windows. [Metadata](https://pypi.org/pypi/sympy/json).
- **threadpoolctl**: pinned 3.6.0; latest 3.7.0; latest Python `>=3.9`. Scope: Parakeet macOS. [Metadata](https://pypi.org/pypi/threadpoolctl/json).
- **tiktoken**: pinned 0.3.3; latest 0.14.0; latest Python `>=3.9`. Scope: macos. [Metadata](https://pypi.org/pypi/tiktoken/json).
- **tokenizers**: pinned 0.23.1; latest 0.23.2; latest Python `>=3.10`. Scope: linux, windows. [Metadata](https://pypi.org/pypi/tokenizers/json).
- **torch**: pinned 2.13.0; latest 2.14.1; latest Python `>=3.10`. Scope: macos. [Metadata](https://pypi.org/pypi/torch/json).
- **tqdm**: pinned 4.70.0; latest 4.70.1; latest Python `>=3.8`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/tqdm/json).
- **typer**: pinned 0.27.2; latest 0.27.3; latest Python `>=3.10`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/typer/json).
- **typing-extensions**: pinned 4.16.0; latest 4.16.0; latest Python `>=3.9`. Scope: linux, macos, windows, Parakeet macOS. [Metadata](https://pypi.org/pypi/typing-extensions/json).
- **urllib3**: pinned 2.8.0, 2.7.0; latest 2.8.0; latest Python `>=3.10`. Scope: macos, Parakeet macOS. [Metadata](https://pypi.org/pypi/urllib3/json). **Advisories returned for an existing pin; see security findings.**
