# AvaNevis v2.11 qualification record

## 2026-11-15 · CachyOS x86_64

| Field | Observed |
| --- | --- |
| Source | `codex/next-version` at `d74f732e56c602a3b6b6594d0c0e10583e158bc1` plus uncommitted implementation and test changes. The source handoff patch has a separate SHA-256. |
| Machine | CachyOS x86_64, kernel `7.3.4-1-cachyos`, Hyprland 0.57.2 on Wayland, PipeWire 1.6.11, RTX 4070 (compute capability 8.9), NVIDIA 620.70.06. |
| Toolchain | Rust 1.89.0, Node 26.13.1, npm 11.20.0, repo-local Python 3.11.16, packaged Python 3.11.9, electron-builder 26.18.0. |
| Electron | npm versions and official release notes select exact prerelease `46.0.0-alpha.10`, Chromium 159.0.8153.0 and Electron's Node 26.13.0. The package, native process, and sandboxed-preload test reported the same Electron version. Recheck before release. [Release notes](https://releases.electronjs.org/release/v46.0.0-alpha.10) · [Exact-tag breaking changes](https://github.com/electron/electron/blob/v46.0.0-alpha.10/docs/breaking-changes.md) |
| Speakrs | Crates.io `0.7.0`, checksum `61315252c89558117552bcc7eef1d693043fa6fcf72ff46f655b21852f30375e`. Locked Linux/Windows feature graphs resolve native CUDA and SM75/80/90/120 features. SM90 shares upstream PTX infrastructure. The macOS graph resolves CoreML. All three graphs exclude online/HF/ORT. Windows and macOS graph review is structural evidence. [Upstream](https://github.com/avencera/speakrs/tree/v0.7.0) |
| Model bytes | `node scripts/verify-speakrs-packaging.js --verify-pack-checksums` verified 69 distinct leaves (305,025,846 bytes). The catalog uses nine CUDA/CPU leaves and 67 CoreML leaves at the pinned upstream revision, with SHA-256 and size on each file. [Pinned source](https://huggingface.co/avencera/speakrs-models/tree/67f963b6a1d94fcd4678948237b3cc8bd69bf1d8) |
| Cargo lock SHA-256 | Product `4300248dbd87373a4cf8f1ece80d0a106eaaea0b53b891d56480c6d4165781d8`. CPU smoke `45765ebbffbc0b91933388ff7cb53e271dfae9fc23484b976ffd0919b14384d1`. |

### Linux source and packaged checks

| Check | Actual evidence |
| --- | --- |
| Native scratch CUDA feasibility | From a separate probe directory, `cargo +1.89.0 generate-lockfile` and `cargo +1.89.0 build --release --locked --target x86_64-unknown-linux-gnu` passed. Scratch lock SHA-256 `62d617c83682ea33dd442ca01d23f6e29f5c2824feb365d7da700bfc93627600`. Binary SHA-256 `bc977868a1d045be6b120f3cde7a02d2836401df64dcaba59d7fd54fd2cdb277`. Nine model leaves matched. Repository WAV produced six exclusive segments and one label, device `cuda`. The initial scratch probe used existing admitted libraries read-only. The packaged checks used an independently staged disposable runtime. |
| Managed runtime | A disposable profile verified all 13 catalogued CUDA library leaves. The packaged Python CUDA probe reported `ready`, `cuda12`, RTX 4070 CC 8.9 and driver 620.70.06 after the CTranslate2 check. Added `.so` and same-size CUDA corruption both failed integrity admission. Same-size model corruption failed the pinned model hash. Driver loss, symlink, missing tree, repair failure and CPU restoration are covered by the automated admission tests. The host's `/usr/lib64` alias resolves to the explicitly allowlisted `/usr/lib`. |
| Model migration | The packaged Electron renderer invoked the production setup IPC with a disposable legacy-ready manifest. During explicit repair, cancellation left the manifest bytes unchanged. Retry fetched the pinned leaf set, validated staged native inference, activated the manifest, and reached ready. Explicit validation with the installed model passed. Remove reset the state while preserving shared CUDA. A real-filesystem regression additionally checks an old revision file, wrong accelerator, cancellation after validation, a failed manifest rename and a restart with a promoted but unreferenced directory. |
| Inference and contained load | Packaged Speakrs CLI and packaged Python validation returned `cuda`. A direct packaged binary diagnosis found `/usr/lib/libcuda.so` and the NVIDIA driver closure. Guided runs loaded the pinned scratch cuBLAS and cuBLASLt and the system driver. The trace did not show cuDNN or ORT loading for native Speakrs. The build has no Speakrs compile-time ORT download. |
| Known speakers and longer guided run | Two offline eSpeak NG voices alternated scripted turns with 0.6 s overlaps. Scratch WAV hashes are listed below. The packaged backend returned 8 and 32 exclusive segments and guided windows, respectively, with two labels across both samples. Guided tiny.en transcription on CUDA float16 produced text for all 8 and all 32 turns. Per sample, Speaker 1 matched A 4/4 and 16/16, and Speaker 2 matched B 4/4 and 16/16, using maximal timing overlap against the turn manifest. The comparison is bounded to synthetic speech and these timings. |
| Same-backend comparison | The scratch HEAD Speakrs 0.5 adapter ran both WAVs on CUDA with the historical pinned model archive and private ORT/CUDA closure. Both 0.5 and packaged 0.7 returned 8 and 32 exclusive segments, matching speaker partitions up to label permutation. Maximum boundary change was 0.642 s. A separate 0.7 overlap-mode run emitted `speaker_diarization` and retained 0.641 s of simultaneous turns. These are bounded comparisons of generated speech. |
| Offline inference | The Whisper snapshot `0d3d19a32d3338f10357c0889762bd8d64bbdeba` was explicitly preloaded into a disposable cache. `model.bin` SHA-256 `1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a`. Both guided runs were traced after setup with Arch strace 7.3 (`-f -e trace=network,openat`) and no IPv4 or IPv6 socket activity was observed. The trace recorded local NVIDIA socket attempts. |
| Recording, tray and normal transcription | Started the unpacked app and the AppImage through their native launch paths with disposable profiles and Wayland. Used independent PipeWire virtual microphone and desktop monitor streams playing synthetic audio. Both runs started recording, produced a non-quiet Opus recording, discarded a second take, returned to idle and exited 0. The AppImage registered one additional StatusNotifierItem. Bundled faster-whisper transcribed the resulting audio offline from the pinned scratch cache on CPU int8. Physical microphone and natural-speech quality were outside these synthetic checks. |
| Secure storage | The disposable Secret Service migration fixture ran Electron 45.2.3 legacy write → 46.0.0-alpha.10 async read/write → 46 restart → 45 read on a profile copy. All round trips passed with `gnome_libsecret`. The installed async ciphertext used `v11`; native reads reported `shouldReEncrypt: false`. Forced basic and missing-D-Bus both produced fixed-key `v10`, and app policy rejected them despite Electron reporting true availability. The packaged dual-opt-in hook passed a Secret Service round trip and exited 1 on the missing-D-Bus fallback. Synthetic deferred-rotation and atomic failure tests cover rotation; native key rotation was not induced. [Chromium POSIX provider](https://chromium.googlesource.com/chromium/src/+/159.0.8153.0/components/os_crypt/async/browser/posix_key_provider.cc) · [Chromium encryption format](https://chromium.googlesource.com/chromium/src/+/159.0.8153.0/components/os_crypt/async/common/encryptor.cc) |
| Installers | `AVANEVIS_SKIP_DIST_CLEAN=1 npm run build:linux` preserved older installers and generated the three current-version candidates. `node scripts/verify-speakrs-packaging.js --packaged` and `node scripts/verify-linux-packaging.js` passed on the current artifacts. The pacman and Debian payloads were verified by extraction. |
| Automated tests | `npm ci`, `npm run test:all`, `npm run test:syntax`, `git diff --check` passed. Full suite: 1,138 JS passed (Windows embedded Python skip), 855 Python passed (two Windows-only and two explicit native-model skips). The focused native Python run used the explicit Linux target executable and verified models: 73 passed, no skips. Product Cargo tests: 8 unit and 1 NPZ passed. The separate CPU smoke returned six segments, device `cpu`. The production binary rejected CPU and fast modes. Both locked Cargo audits passed with the obsolete webpki exception removed. `npm audit --audit-level=high` passed, with six moderate findings in the electron-builder/minimatch chain. |

### Artifact and fixture hashes

| File | SHA-256 |
| --- | --- |
| `dist/AvaNevis-Setup-2.10.3.AppImage` | `fef152a9482aa0570408bd49fc0472a57b7809ca3827bf85022f759f14850270` |
| `dist/AvaNevis-Setup-2.10.3.pkg.tar.zst` | `abb11674b54c5f6c5d1213342061e20cb4da35e4788d3b62e99687f70128241c` |
| `dist/AvaNevis-Setup-2.10.3.deb` | `d0bc7e64f1ed56505035bfd27a12531557b6c5d7bc6b5386932e27b54d6fd2f7` |
| `dist/linux-unpacked/resources/app.asar` | `4feddbd5cd4575b1fecb08145c53ebb7ef4a8c7e3cb0a64a44880c334239f111` |
| Packaged Linux Electron executable | `ca220217ce0e236561388144288e90480d17850e94432c943b0e53c6c966cb92` |
| Packaged Linux Speakrs executable | `2f765f13563a096f6f833f03dee30345365425a6f660eb8fba36d5b0be868055` |
| Scratch 0.5 CLI | `bafd6148ef6f288112f5b53404ad6e32b9661292c9922fb7b159372c52b39a3c` |
| Scratch 0.5 model archive and ORT archive | `a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20`, `08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf`. All seven extracted private library pins matched. |
| Repository validation WAV | `1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998` |
| Synthetic short and long WAVs | `7f68f00729c787a4a4c1a33218b3cdbb53387dc0b4f13a0ac0a74d3bff531f56`, `f04c875f767fe96710badef9f052e4aaa6c540aff7b404d4b9c524dad85daf93`. Recreate timings with `scripts/generate-speakrs-qualification-fixtures.py`. eSpeak NG PCM bytes can vary. |

## 2026-11-15 · Windows x64 NVIDIA (in progress)

Source `28b8a557551e2373913dd5161aaa131534eb72f7`; Windows 11 Pro
10.0.26300, RTX 4070 (CC 8.9), driver 621.24, Node 22.15.0, npm
10.9.2, repository Python 3.11.9, MSVC 14.29 and Rust 1.89.0. The
isolated `scripts/probe-speakrs-windows-cuda.ps1` run built unmodified
Speakrs 0.7.0 CUDA for MSVC; its graph includes SM75/80/90/120 and no
online/HF/ORT. Scratch lock SHA-256
`62d617c83682ea33dd442ca01d23f6e29f5c2824feb365d7da700bfc93627600`;
binary SHA-256 `9c36f7c1642fd89ea1015d1b2dbf7bbe45adba2878d456d8dc90aebb8c9f7351`.
All nine model lengths and hashes matched the catalog. The repository fixture
returned CUDA, six exclusive segments and one speaker; it does not qualify
multi-speaker quality. `dumpbin /DEPENDENTS` showed Windows system and VC
runtime imports, not the delayed CUDA loads. A separate scratch experiment
using System32-only DLL search and a restricted PATH also returned CUDA for
the short fixture; sampled modules included System32 `nvcuda.dll` and the
NVIDIA DriverStore driver. Sampling can miss transient loads: this is not a
complete image-load trace or an approved product loader policy. Scratch probe
artifacts are local under `D:\avanevis-v211-windows-probe-4`.

The probe script was corrected for an empty Git diff and for Windows process
environment removal (setting a variable to null produced an empty variable).
The native contract and related Python tests ran against the explicit product
CLI and verified models: 73 passed. A disposable Windows profile exercised
real secure storage using synthetic tokens: Electron 45.2.3 synchronous write,
46.0.0-alpha.10 product token-store async read/write, 46 restart, and 45
synchronous read all passed. The profile was allowed to shut down normally so
Electron persisted its encryption state. This does not exercise real key
rotation or a user's existing profile.

`npm ci` and the explicit Electron binary install corrected a pre-existing
stale Electron 44.7.0 node_modules tree. With the locked Electron
46.0.0-alpha.10, `npm run test:all` passed: 1,135 JS passed / 4 skipped and
850 Python passed / 9 skipped. The JS skips concern Unix symlinks, ar,
Unix-layout Python and a Linux Parakeet adapter. Python skips comprise three
Linux/POSIX-only checks and six native CLI checks, which were separately run
with the explicit target binary and verified model directory (73 passed).
The focused packaging and IPC JS tests passed 80/80. `npm audit
--audit-level=high` passed with six moderate packaging-chain advisories.

`AVANEVIS_SKIP_DIST_CLEAN=1 npm run build` produced an unsigned x64 NSIS
candidate with electron-builder 26.18.0 and Electron 46.0.0-alpha.10;
the Speakrs packaged-layout verifier passed. The installer is 249,538,118
bytes, SHA-256 `934388a3b45452fba35669d786950caec2375a8552eededbf9d9df399f0a94f9`.
Unpacked `AvaNevis.exe` SHA-256
`4270872e4de488f25a0dca344f48428ace3ebfd22bae92183ea0e74266fd4cdb`;
packaged CLI SHA-256
`9b66c34412c02e2cc0ae85158dfcbfcbf696709e364f939c9ef4a8445a04773e`.
That CLI also returned CUDA and six exclusive segments for the fixture using
the scratch models and ambient host loader environment. This is a direct
binary check, not packaged setup or end-to-end application acceptance.
The unpacked app opened its main window with a disposable `--user-data-dir`;
the test process tree was then terminated, so this is not tray or graceful
quit acceptance. A separate forced-PTX scratch run on this GPU returned the
same six CUDA fixture segments. It does not establish a minimum driver or
qualify other GPU tiers. Product Cargo tests passed 8 unit and 1 NPZ test;
the test-only CPU crate passed 8 unit tests and its explicit-feature CPU
smoke returned six segments. Both Cargo audits passed using the reviewed
product audit configuration.

### Windows follow-up · 2026-11-15

The Windows product CLI now calls `SetDefaultDllDirectories` with
`LOAD_LIBRARY_SEARCH_SYSTEM32` before inference and fails closed if that
call fails. The direct-file setup gate was opened. On this host, a native
debug-event image-load trace of the release-built CLI with real decoy DLLs in
the working directory and PATH observed no decoy loads. A positive control
with the unhardened scratch executable did load a decoy. On a 231.6-second
synthetic two-voice WAV, the hardened binary returned 48 exclusive segments,
matching the 48 known turns by maximum overlap (24/24 per voice). The trace
showed the System32 NVIDIA driver and its DriverStore dependency; it does not
qualify every GPU tier or driver-dependent load path. The NVIDIA driver files
and full traces are inventoried in local scratch
`D:\avanevis-v211-windows-probe-3`.

On the same synthetic short and long WAVs, isolated v2.10.3 Speakrs 0.5 and
0.7 CUDA runs produced identical segment boundaries and speaker labels: 8 and
48 segments respectively. This is not representative natural-speech or DER
evidence. The WAV SHA-256 values are
`0f2ff819e34b51d53797f581874edcc8f9aca560d563f0bed19663b205bf4ef2` and
`98ec6239c6632e93c859dd8285872f9d24e22160fe8a50f3f026a9c9f0a80539`.

The integrated unpacked application explicitly installed its pinned models
into a disposable profile, validated CUDA and reported Ready. A desktop-only
WASAPI recording of the short synthetic sample then produced an eight-turn
guided Whisper transcript with both voices correctly associated, and a CUDA
exclusive speaker sidecar. The earlier candidate's NSIS installer installed
to a scratch directory, launched, and uninstalled with `/KEEP_APP_DATA`;
its profile survived. The integrated rebuild below has not itself been
installed or uninstalled. A normal desktop-only recording also transcribed
the repository fixture with Whisper Small on CUDA. A warning appeared after
the playback stopped and no desktop callbacks arrived for 10 seconds.

After the loader change, `npm run test:all` passed: 1,135 JS passed / 4 skipped
and 854 Python passed / 5 skipped. The rebuilt unsigned NSIS candidate is
249,539,953 bytes, SHA-256
`a846343b20b18e3ce9f80e2a7d159029ee79a9ecc804a2d512633516706a56e1`;
its packaged CLI SHA-256 is
`23ec1b0d347fd878ecc7183aa1d18032c0386710058cbe0c67c3f3d3d185059f`.
`node scripts/verify-speakrs-packaging.js --packaged` passed on that unpacked
payload. The candidate remains an Electron 46 alpha, versioned 2.10.3 and
unsigned; it is not a published release.

### Windows continuation · 2026-11-16

On the same Windows 11 / RTX 4070 / driver 621.24 host, the unpacked app
repaired a disposable legacy-ready Speakrs profile containing a 0.5 model
file and private ORT DLL. It downloaded and validated the 0.7 files on CUDA,
reported Ready and retained the old model. A UI cancellation attempt arrived
after the fast download and validation completed, so it is not cancellation
evidence. Separately, the real source setup service on a fresh synthetic legacy
profile handled an injected cancellation and an injected download failure
without changing the old manifest or model. Retry copied the nine pinned files,
verified their hashes and validated them using the bundled Windows CUDA CLI.
A second setup completed with a downloader that would fail if called. Removal
deleted the owned model and legacy runtime trees while preserving a shared
CUDA sentinel. These controlled service checks are not an installed-app UI
cancellation/removal test or proof of a network-disconnected machine.

The packaged Python backend ran the 231.6-second synthetic sample with
`HF_HUB_OFFLINE=1` and local-only Whisper. It returned CUDA Speakrs and CUDA
float16 Whisper, 48 non-empty guided turns and two speakers, matching the
known synthetic turns 24/24 per voice by maximum overlap. This was an offline
configuration, not an independently observed network isolation trace. A
native debug-event trace of the final unpacked CLI on the same sample returned
CUDA and 48 segments; no scratch CWD/PATH decoy DLL was loaded. Only the
System32 NVIDIA driver and its DriverStore dependency appeared among CUDA
loads. Other GPU/driver tiers remain untested.

The native model footprint now excludes legacy ORT downloads from estimates;
the rebuilt installed app displayed 31 MB instead of 536 MB. The final NSIS
candidate installed to a scratch directory, launched with the repaired test
profile and showed speaker setup Ready; its uninstaller exited 0 with
`/KEEP_APP_DATA`, removed the app executable and retained the test models.
The unsigned installer is 249,538,139 bytes, SHA-256
`0df3c28f62f30a481208d7f2a7cf39ca5507eb076e88f492e4aca870dc4e216e`;
the packaged CLI SHA-256 remains
`23ec1b0d347fd878ecc7183aa1d18032c0386710058cbe0c67c3f3d3d185059f`.
The packaged-layout verifier and `npm run test:all` passed: 1,136 JS passed /
4 skipped and 854 Python passed / 5 skipped. The npm registry still lists
46.0.0-alpha.10 as the latest Electron 46 alpha on this date.

## 2026-11-16 · macOS arm64 continuation

Source `be8d3c0` plus the accompanying architecture-aware test fixes. Apple
M4 Pro, macOS 26.7.3, Node 26.13.1, npm 11.20.0, repo Python 3.11.18,
Rust 1.89.0 and Electron 46.0.0-alpha.10. This is not a macOS 15 host.
The npm registry's Electron 46 alpha tag still selected alpha.10 on this date.

`npm ci` restored the locked Electron after a stale 45.2.1 installation was
found. The initial suite exposed five host-dependent Speakrs test failures:
simulated x64 platforms used the real arm64 architecture, and two tests
expected CUDA on macOS. The accompanying fix makes the architecture explicit
for simulated platforms and asserts CoreML on Apple Silicon. The focused 83
tests and `npm run test:all` passed: 1,137 JavaScript passed / 3 skipped and
849 Python passed / 10 skipped. `python3 scripts/agents/validate_setup.py` and
`npm audit --audit-level=high` passed; npm reported six moderate advisories.

`AVANEVIS_SKIP_DIST_CLEAN=1 npm run build:mac` produced an ad-hoc signed,
non-notarized DMG, still versioned 2.10.3. `npm run verify:mac:packaged` and
`node scripts/verify-speakrs-packaging.js --packaged` passed. The DMG checksum
verified with `hdiutil`; its read-only mounted app passed deep strict signature
verification and contained the same CLI as the unpacked app. The packaged
verifier checked the 15.0 plist and CLI deployment floors, nested signatures,
helper and CLI inherit entitlements, MLX imports, and Opus encoding. DMG
SHA-256 `64d0f513847721902270036167bfa3f8c902af139ad8f18d4759596bc3d1a8b4`;
packaged CLI SHA-256
`77ece0622e2469ff14f014b80df50c33db19f92d3ff6504eae27915dc7bc8fb2`.

All 67 CoreML model leaves at revision `67f963b6a1d94fcd4678948237b3cc8bd69bf1d8`
matched their pinned sizes and hashes. Both an isolated locked native build
and the packaged CLI ran the repository fixture on CoreML and returned six
segments, all labeled `SPEAKER_00`. This establishes model loading and native
execution on this host, not speaker separation or natural-speech quality.
The fixture SHA-256 is
`1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`.
The packaged Python backend also transcribed 4.576 seconds of synthetic `say`
speech from a copied local base model with local-files-only enabled, reporting
`metal` / `float16`. The output contained a recognition error; this direct
backend smoke is not a recording or Electron UI acceptance test.
The Keychain migration was not exercised: the current user's login Keychain
is the default, and the available fixture isolates profile files but not the
Keychain. Use an isolated Keychain session and consistent identity.

### Release acceptance · 2026-11-16

The user accepted the release on the evidence recorded above and waived further
qualification on other macOS versions and NVIDIA GPU tiers. This is acceptance
of the coverage limits, not evidence that those configurations were tested.
The user also accepted the release with the other outstanding qualification
limits: natural multi-speaker quality, installed-app cancellation/removal,
independently isolated offline inference, missing/old drivers, macOS packaged
setup and live recording/permission flows, and Keychain migration. The earlier
transient Windows pending-transcription banner was not resolved by this sign-off.

At acceptance, release preparation still needed final versioning, documentation
and artifact checks. The candidates described above are local, ad-hoc signed or
unsigned, and carry the old 2.10.3 version; they are not published artifacts.

### Final-version preparation · 2026-11-16

On the same macOS 26.7.3 M4 Pro host, the npm registry's `alpha-46-x-y`
tag still selected `46.0.0-alpha.10`; the qualified pin was unchanged. This
is an Electron prerelease. The Linux safeStorage provider mapping and native
migration evidence above therefore still refer to the same Chromium build.
`npm audit --audit-level=high` exited 0 with six moderate minimatch findings in
the packaging toolchain; the suggested forced fix changes major dependencies.
Open Dependabot alerts were empty. The dependency decisions are in [todo.md](../../todo.md).

After the version and dependency changes, `npm run test:all` passed on this
host: 1,137 JavaScript passed / 3 skipped and 849 Python passed / 10 skipped.
`AVANEVIS_SKIP_DIST_CLEAN=1 npm run build:mac` built an ad-hoc signed,
non-notarized `AvaNevis-Setup-2.11.0.dmg`. The packaged macOS and Speakrs
verifiers passed; `hdiutil verify` reported a valid checksum. The mounted app
reported version 2.11.0 and passed deep strict signature verification. Its CLI
hash matched the unpacked CLI. DMG SHA-256:
`8cc2c4dbbf95fd662c8f0062d4b14d4ee9dd1c161c35957d8201fdd9cfc82907`.
CLI SHA-256:
`77ece0622e2469ff14f014b80df50c33db19f92d3ff6504eae27915dc7bc8fb2`.
These checks do not add live recording, setup or Keychain migration evidence.
No final-version Windows or Linux installers were built on this macOS host.
The local DMG is a preparation artifact, not a published release.
