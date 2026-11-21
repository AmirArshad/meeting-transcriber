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

`npm run test:all` exited 0 on macOS arm64. JavaScript reported 1,320 passed
and 3 skipped. Python reported 976 passed and 10 skipped. Both syntax checks
passed. `git diff --check` exited 0.
