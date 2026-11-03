# Dependency sweep — 2026-11-03

This records the local review of every open Dependabot branch, the pinned
Python build inventories, npm and Cargo advisories, and the separate Parakeet
locks. It includes the fixes for the failed CI run. It does not claim that
GitHub Actions, Windows/macOS installers, or audio hardware checks passed on
these uncommitted changes.

| PR | Local decision |
|---|---|
| [#142 Actions](https://github.com/AmirArshad/meeting-transcriber/pull/142) | Apply the four immutable action revisions and update workflow assertions. Confirmed release tags for setup-python 7.1.0, rust-cache 2.9.3 and markdownlint 25.0.0; the rust-toolchain revision is upstream master and its one-commit change updates its revision script. Rust itself remains 1.88.0. |
| [#141 Electron](https://github.com/AmirArshad/meeting-transcriber/pull/141) | Supersede 45.1.0 with stable 45.2.1. The actual sandboxed preload is tested for invoke, event delivery and unsubscribe. Native installer, tray, recording and safeStorage gates remain. |
| [#140 Python runtime pins](https://github.com/AmirArshad/meeting-transcriber/pull/140) | Supersede with filelock 4.2.7 and certifi 2026.10.23 in the build pins; update the macOS Parakeet filelock wheel using the real-wheel generator. |
| [#139 filelock](https://github.com/AmirArshad/meeting-transcriber/pull/139) | Superseded by 4.2.7 in the local requirements and macOS Parakeet lock. |
| [#136 setuptools](https://github.com/AmirArshad/meeting-transcriber/pull/136) | Apply 84.2.1 to all three build closures. |
| [#135 electron-builder](https://github.com/AmirArshad/meeting-transcriber/pull/135) | Apply 26.18.0. A Linux unpacked build and layout check ran using previously prepared resources. Full native installer qualification remains. |
| [#132 serde_json](https://github.com/AmirArshad/meeting-transcriber/pull/132) | Apply 1.0.154; the Rust locked tests and audit pass. |
| [#130 CTranslate2](https://github.com/AmirArshad/meeting-transcriber/pull/130) | Supersede 4.8.3 with 4.8.5 on Linux only. On CachyOS with an RTX 4070, the same cached tiny model and local speech fixture produced identical transcripts on CPU and CUDA with 4.8.2 and 4.8.5. Windows remains 4.8.2 pending native CUDA/CPU and shutdown qualification. |
| [#129 more-itertools](https://github.com/AmirArshad/meeting-transcriber/pull/129) | Apply 11.2.1 to the macOS build closure. |
| [#127 MLX](https://github.com/AmirArshad/meeting-transcriber/pull/127) | Update the paired pins to 0.32.4 after the native Metal Whisper check recorded below. Packaged-app and full hardware qualification remain. |

Additional build pins updated: AnyIO 4.16.0 and pycparser 3.12. The pinned bootstrap pip wheel is now 26.3; its downloaded SHA-256 was verified against the PyPI release metadata and it imports under isolated Python 3.11. The latest
compatible PyPI inventory also identifies Numba 0.68.1, ONNX Runtime 1.31.1,
hf-xet 1.8.0, Torch 2.15.0 and PyObjC 13.0. These remain unchanged: they
need native inference, telemetry/ETW, download, or macOS compatibility
qualification respectively. Python 3.11 and the existing constraints also
hold back newer NumPy, PyAV, SciPy, NetworkX, huggingface-hub, tiktoken and
mpmath releases. Pyannote's separate certifi 2026.10.19 pin remains patched;
its installed environments are not invalidated for a routine root-bundle
refresh. The three isolated Parakeet inventories and updated bootstrap pip audit clean.

The Electron 45 release removes several sandboxed-preload Node shims, changes
screen-capture permission routing and deprecates synchronous safeStorage APIs
for removal in Electron 46. AvaNevis's preload uses the Electron bridge only;
recording uses native helpers, and the new fixture exercises actual sandboxed
IPC. The async safeStorage migration is a separate future requirement and
must preserve existing encrypted tokens. See [Electron 45 release notes](https://www.electronjs.org/blog/electron-45-0).

Security audits report no high or critical npm advisories, zero findings in
the three exact Python build inventories and Parakeet lock inventories, and no
unignored Cargo warnings. npm still reports 15 moderate findings through the
packaging toolchain's minimatch dependencies; npm's suggested force fix is a
breaking electron-builder downgrade. The prior zip 6 exceptions were removed
because the compatibility patch now uses zip 9.0.5. The separate webpki-roots
compatibility-facade exception remains documented in the Cargo audit config.

Local `npm run test:all` under a virtual X display passed: 1,132 JavaScript
and 852 Python tests, with two and four skips respectively. The Linux and
cross-host Windows pin closures passed; cross-host Windows does not replace the
native CI run. A macOS cross-host closure attempt cannot establish the macOS
closure because pip evaluates Linux environment markers. The macOS Python
inventory audit nevertheless reported no known advisories. All action and
platform-native checks must run on the final changes before release. Existing
macOS Parakeet installations will require the normal repair flow because the
lock identity changed.

## macOS follow-up — 2026-11-03

On macOS 26.7.1 arm64 with Python 3.11.18, the updated macOS build-pin
closure resolved for `macosx_14_0_arm64`, and the exact-pin inventory audit
reported zero findings. The actual macOS 14-targeted MLX and MLX Metal 0.32.4
wheels were installed into a temporary target, leaving the repo venv's MLX
unchanged. Three fresh-process, offline production-path Whisper Small trials
using the cached model and `tests/fixtures/speakrs-two-speaker-16k.wav`
completed with timestamped output on Metal / float16. A separate production
path run confirmed `Device(gpu, 0)` and recognizable fixture speech. These
are short inference checks, not a macOS 14 host test or a recording and full
hardware acceptance run. The Parakeet runtime is independent and was not
upgraded by this change.

The local `npm run test:all` gate passed with 1,131 JavaScript tests and 847
Python tests (4 and 9 skipped respectively), plus both syntax checks. The repo
venv was not fully realigned to the build pins for this suite; the separate
Metal check explicitly loaded the 0.32.4 wheels.

An isolated directory build with `npm run build:mac:dir` and
`npm run verify:mac:packaged` passed. It included Electron 45.2.1, the
updated macOS 14-targeted wheel set, and the rebuilt Speakrs helper; the
verification covered signatures, MLX imports and an Opus encode. This was an
ad-hoc signed directory build, not a notarized DMG or a packaged recording and
inference acceptance test.

## Windows follow-up — 2026-11-03

On Windows 11 x64 with Python 3.11.9 and RTX 4070 driver 621.01, isolated
actual CTranslate2 4.8.2 and 4.8.5 wheels were tested with faster-whisper
1.2.1, the locally cached base model and the two-speaker fixture, with
Hugging Face offline mode enabled. Fresh processes on CPU/int8 and CUDA/float16
produced identical four timestamped segments across both versions and exited
normally. The Windows build pin advances to 4.8.5, matching Linux. This is a
short inference and process-exit check, not a long recording or full add-on
acceptance test.

ONNX Runtime 1.31.1 remains held pending the disposable-runner ETW positive
control, guarded VAD parity and source review required by the local AI contract.
The hf-xet pin remains held pending explicit-download qualification; Xet remains
disabled in the application transport policy.

The native Windows build-pin closure resolved exactly and its inventory audit
reported zero findings. `npm run test:all` passed (1,131 JavaScript passed,
4 skipped; 848 Python passed, 8 skipped; Python syntax clean) using the repo
venv, which was not fully realigned to the build pins. An unsigned `build:dir`
with a separate output directory succeeded with Electron 45.2.1 and rebuilt
Speakrs. Its embedded Python loaded CTranslate2 4.8.5 from the package and
reproduced the same offline CPU/int8 and CUDA/float16 fixture transcript;
CUDA DLLs came from the local Python CUDA 12 installation. This did not test an
NSIS installation, packaged GUI recording, or add-on acceptance.

## ONNX and hf-xet qualification follow-up � 2026-11-03

ONNX Runtime 1.31.1 advances the shared Windows and Linux CPU build pins.
The [upstream 1.31.0�1.31.1 comparison](https://github.com/microsoft/onnxruntime/compare/v1.31.0...v1.31.1)
changes release/version assertions and an OpenVINO provider declaration, with
no telemetry source changes. This source review does not replace measurement.
[Disposable CI run 41634848524](https://github.com/AmirArshad/meeting-transcriber/actions/runs/41634848524)
installed the actual Windows and Linux Python 3.11 wheels. Windows ETW captured
20 candidate events in the unsuppressed control and zero in the guarded worker;
CPU VAD probabilities and speech boundaries matched 1.31.0, and silence stayed
empty. Linux CPU VAD matched too, with no network syscalls observed under the
existing strace gate and process-start opt-out. These checks do not qualify GPU
hardware, managed Speakrs/Parakeet runtimes, or a packaged recording.

hf-xet remains at 1.7.0. The app forces `HF_HUB_DISABLE_XET=1` for ordinary
and isolated Python children and summary downloads, retaining the HTTP path and
token scrubbing. A native Windows 1.8.0 wheel with huggingface-hub 1.33.0
installed was tested with Xet disabled: a small public, revision-pinned HTTP
download passed the summary wrapper's SHA-256 check, and a wrong checksum was
rejected. This does not exercise hf-xet's native transport, a large model, or
all explicit Whisper and add-on downloads on the supported platforms. Its
independent TLS behavior and those paths remain unqualified; the disabled-Xet
policy and current pin are unchanged. The [1.8.0 release](https://github.com/huggingface/xet-core/releases/tag/v1.8.0)
also introduces experimental upload behavior, which the application does not
need. No token was used in this test.

## hf-xet 1.8.0 follow-up — 2026-11-03

**Decision: hold the base pins at 1.7.0 and the separate macOS Parakeet lock
at 1.6.0.** Installing the candidate and enabling its transport are separate
decisions. The following partial evidence does not meet the requested native
platform and explicit-download gates for changing either inventory.

- On Windows 11 x64, Python 3.11.9 loaded the real
  `hf_xet-1.8.0-cp38-abi3-win_amd64` wheel and Hub 1.33.0 in a temporary
  target. On x86_64 WSL2 Linux, Python 3.11.15 loaded the real
  `hf_xet-1.8.0-cp38-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64`
  wheel and Hub 1.33.0 in a temporary venv. These were isolated dependency
  environments, not packaged apps or full build-pin installations.
- With `HF_HUB_DISABLE_XET=1`, implicit tokens disabled and `HF_TOKEN_PATH` set to the null device,
  each host called
  the installed faster-whisper `utils.download_model` for the public
  `Systran/faster-whisper-tiny` snapshot. Both downloaded its 75,538,270-byte
  `model.bin` at revision `d90ca5fe260221311c53c58e660288d3deb8d356`, and
  returned the same cached snapshot with `local_files_only=True`. Both replaced
  Hub's `xet_get` and `hf_xet.download_files` with failing sentinels; neither
  fired. This exercises the third-party download helper, not the entire app
  setup flow, and is not a model integrity or cancellation test. No user token
  was used. The previous small Windows summary-wrapper and wrong-checksum test
  is documented above; it is not a substantial summary-model test.
- Temporary candidate copies of the Windows and Linux build requirements
  resolved to exactly their respective pinned closures on their native OS
  environments (Linux under WSL2), using the existing closure checker. The
  actual repository pins were unchanged. The macOS arm64 1.8.0 wheel was
  downloaded on Windows (SHA-256
  `3e8934784425781f0f779b91044df441f3a7af4dab47375d7e3aeaecbb8eecb4`),
  but was not imported or executed on macOS. Downloading a foreign wheel does
  not establish its compatibility, its native closure or app behavior.
- Existing focused tests cover launcher enforcement, token stdin/environment
  handling, summary hash/path checks and mocked setup cancellation; they do not
  substitute for candidate-wheel real-artifact cancellation, altered-file,
  summary or gated-pyannote tests. macOS MLX explicit download and the separate
  Parakeet Hub 1.29.0 / Xet 1.6.0 lock also remain unqualified. No real user
  credential was used to access gated pyannote. Native macOS testing and
  closure resolution, real applicable setup flows and packaged checks are
  still needed before advancing the affected pins and generated inventory.

The application still forces `HF_HUB_DISABLE_XET=1` after caller overrides;
no TLS checks were weakened. Re-enabling acceleration would require independent
review and native testing of hf-xet's own TLS trust handling against the
compromised-intermediate chain set (with a meaningful vulnerable positive
control), plus packaged Windows, macOS and Linux download, checksum, cancellation,
offline/cache, token-boundary and failure-recovery qualification. Success of
HTTP downloads with Xet disabled is not evidence for that native TLS stack.

### macOS candidate follow-up — 2026-11-03

On macOS 26.7.1 arm64, Python 3.11.18 and Hub 1.33.0, the actual hf-xet
1.8.0 arm64 wheel was loaded from an isolated target. The summary downloader
fetched a 540,217-byte public Xet-backed fixture and verified its SHA-256 with
`HF_HUB_DISABLE_XET=1`; instrumentation confirmed no native Xet call. A
separate opt-in probe exercised the native Xet path and verified the same
bytes. Both probes disabled implicit tokens and telemetry and used temporary
caches. The native macOS candidate build-pin closure and exact-inventory
audit passed (zero findings). Focused downloader and transcription-helper
tests passed (64 passed, one Windows-only skip), as did 115 JavaScript add-on
setup and privacy tests.

An ad-hoc signed directory build with the candidate pin passed
`npm run verify:mac:packaged`; its bundled Python completed the same HTTP-path
fixture download with no native Xet call. These checks do not establish native
Xet TLS or telemetry behavior, a substantial summary download, cancellation,
MLX explicit download, Parakeet compatibility, a notarized installer, or full
hardware acceptance. The existing 1.7.0 base pins, separate Parakeet lock, and
disabled-Xet policy remain in place pending the outstanding gates above.

A separate candidate-wheel check used the app's MLX Tiny download method with
Xet disabled and a failing native-Xet sentinel. It downloaded 74,418,540-byte
weights and configuration into a fresh temporary cache, then accepted that
cache with local-only mode enabled. No inference, cancellation, or packaged GUI
setup flow was exercised by that check.

### Further macOS qualification — 2026-11-03

Using the candidate 1.8.0 wheel in the ad-hoc packaged Python and the app's
JavaScript download helper with Xet disabled, the pinned Qwen3.5 4B GGUF
(2,740,937,888 bytes) downloaded and matched its catalog SHA-256. The real
summary setup installed the pinned macOS runtime and reached ready in an
isolated userData directory. The real cache checker accepted the model,
rejected a one-byte alteration, and accepted it after restoration.

A live cancellation after more than 10 MB exposed a pre-existing cleanup bug:
terminating the Python child bypassed its `finally` cleanup and left the
`.hf-download` staging directory. The downloader now removes that directory
when the cancelled child closes. The regression test first reproduced the
failure, then passed with the fix. A second live cancellation through summary
setup returned `notConfigured`, removed the partial staging directory, and
kept the already-installed runtime. This used the production setup module and
candidate bundled Python in isolated temporary directories, not the Electron UI.

The existing isolated Parakeet runtime with Hub 1.29.0 was tested with the
candidate hf-xet 1.8.0 wheel overlaid in a temporary import path; the managed
runtime and lock were not modified. With Xet disabled, its pinned configuration
was downloaded, SHA-256 verified, and retrieved offline. The local Metal
Parakeet adapter transcribed the speech fixture using cached model files.
This is candidate compatibility evidence, not an installed-lock repair or
managed-runtime integrity qualification. The base pins, Parakeet lock, and
native-Xet disable remain unchanged pending the other-platform and trust gates.
A disposable checkout also regenerated the macOS Parakeet lock from the real
1.8.0 wheel; its generator's dependency-closure checks passed and produced
candidate lock digest `99d3a35c3a5758542211b76acfbe34999410789bae6817dfb9163af451304cf9`.
An isolated repair then downloaded the locked wheels, copied the existing local
model into a disposable userData directory, verified the model and runtime
hashes, probed Metal, and promoted the candidate runtime to ready. The real
user installation was not modified.
The candidate runtime passed the live compute-integrity check and transcribed
the speech fixture offline via the production bootstrap on Metal (six
segments). The existing user installation reports repair-required when
inspected against the candidate lock, as expected; it was not altered.

After the cancellation fix, an ad-hoc app directory was repackaged from the
candidate prepared resources and passed the macOS packaged verifier. A further
live cancellation through its packaged JavaScript and bundled Python terminated
the child after more than 10 MB and left no partial staging data. The full
regression suite passed: 1,131 JavaScript tests and 847 Python tests; four and
nine platform tests were skipped, respectively, and Python syntax passed.

### v2.10.3 dependency decision — 2026-11-03

After the user confirmed the Windows and Linux tests and requested release,
the base Windows, macOS, and Linux build inventories advance hf-xet to 1.8.0.
The macOS Parakeet lock is regenerated from the same real wheel and changes its
runtime identity to `99d3a35c3a5758542211b76acfbe34999410789bae6817dfb9163af451304cf9`;
existing installations require the normal explicit repair. The qualification
results and limits above remain the evidence for these decisions. The native
Xet transport is still forced off; installing the wheel does not qualify or
enable its independent certificate trust or telemetry behavior.
