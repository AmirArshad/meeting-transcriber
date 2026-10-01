# Qwen language support and alternative summarisation models — design and plan

## User scope update — 2026-09-30

Use practical language checks with the current Qwen model on one runtime.
Do not repeat language-quality evaluation per OS or require a
model/language/platform benchmark matrix. Implement language propagation and
output-language matching with focused regression coverage, preserving existing
runtime admission, local-only processing, queues, cancellation, and prior-output
protection. This supersedes qualification depth below; it makes no universal
model-quality claim. Alternative models remain out of v2.10.

**Status:** Slice A implemented inline in the workspace on 2026-09-30, with practical checks on the installed Qwen3.5 9B model and one Windows CUDA runtime. [Results and limits](../../development/V2_10_SUMMARY_QUALIFICATION.md). No new per-platform acceptance or universal quality claim. Sequencing for v2.10 is in [the plan index](2026-09-06-v2.10.md). Qualify languages (slice A) before claiming support. Slice B (alternative models) was dropped from v2.10 on 2026-09-29; keep the current Qwen model.

**Goal:** Summarise retained, qualified transcript languages in that same language with the installed Qwen model.

**Architecture:** Extend the existing catalog, summary IPC service, and per-invocation Python/llama.cpp pipeline. Keep one active summary model and the existing compute/resource queues.

**Tech stack:** Electron, plain HTML/CSS/JavaScript, Python 3.11, pinned local GGUF/llama.cpp artifacts.

v2.10 keeps slice **A — current-model language qualification and enforcement**. Slice **B — alternative-model qualification and a model selector** was dropped on 2026-09-29. Keep the installed Qwen model. The [v2.10 index](2026-09-06-v2.10.md) and [scope log](../../../todo.md) remain authoritative for scope.

## 1. Current behavior

- Settings offers installation, validation, removal, and four profiles: Concise, Balanced, Detailed, Action items (`src/renderer/index.html:948`). It does not expose model selection. `src/renderer/app.js:5359` sends only a profile to setup.
- The catalog defaults to `qwen3.5-9b-q4-k-m`; it also contains Qwen3.5 4B and Qwen3 14B replacement entries (`src/ai-addon-state.js:515`). Catalog presence does not prove product quality or platform acceptance.
- Home/History generation converges on `generateSummaryForMeeting` (`src/renderer/app.js:3950`), then `src/preload.js:91`, then `src/main/summary-service.js:163`. Main loads the saved meeting, checks transcription completion and installed artifacts, rejects a model different from the installed selection, and queues generation. Setup channels belong to `src/main/ai-addon-ipc.js:741`.
- The existing argument builder in `src/main.js:966` invokes `summaries.summary_runner`. `backend/summaries/summary_runner.py:207` loads transcript/speaker segments, runs chunk summaries and an optional merge, and writes JSON/Markdown. No language argument reaches these prompts. Chunk/merge/repair instructions are English; Markdown headings and empty-section text are English (`backend/summaries/summary_pipeline.py:315`, `:330`, `:477`; `backend/summaries/summary_runner.py:83`). JSON validation is not language validation.
- Summary sidecars carry model, profile, generation time, and transcript hash. Main commits attempt-specific sidecars through `update-ai`; a failed regeneration preserves the old summary (`src/main/summary-service.js:367`, `:579`). Meeting hydration detects transcript-hash staleness (`backend/meeting_manager.py:533`). Existing meeting `language` is useful context, but scan-import can assign `en` (`:482`).
- Runtime paths are Windows x64 CUDA, Apple Silicon Metal, and Linux x64 managed CUDA 12 with live admission (`src/ai-addon-state.js:987`; `src/main/summary-service.js:401`; `backend/summaries/llama_runtime.py:55`). Linux is not universally disabled: stale prose must not override this runtime gate. Context is currently 32,768 tokens; CLI flags already differ between Windows/macOS and Linux (`backend/summaries/llama_runtime.py:18`, `:120`).

## 2. User-facing change

**Slice A:** Show “Transcript language” beside Generate/Regenerate, prefilled from meeting metadata, and “Summary will use [language]”. Confirm the language before each generation; metadata is a hint, not detected-language evidence. Subsequent generation prefills the prior confirmation only for the unchanged transcript hash, model and policy revision, while allowing correction. The user identifies the transcript's language; this is not a translation target. Unknown or mixed-language content requires an explicit choice of the predominant transcript language; genuinely balanced multilingual meetings remain unavailable in the initial slice.

Enable generation only for the intersection of product-retained languages and the selected model/platform's qualified languages. Explain “Summaries are not available for [language] with this model”; do not redirect a language failure to model repair. Keep old summaries readable, copyable, and exportable even when regeneration is unavailable.

**Slice B is out of v2.10.** The withdrawn design was: add a Settings “Summary model” selector when at least two choices qualify on this platform. Show download size, measured resource requirements, and supported languages. Keep “Profile” separate: it controls the notes' content/detail, not the model. Selection stages a choice; an explicit Install/Switch action downloads and validates it. Show both installed and pending models during a switch. No automatic choice based on transcript language or memory pressure.

Windows and Apple Silicon retain their existing acceleration/runtime behavior. Linux offers only candidates admitted through managed CUDA 12 on x64/NVIDIA; absent/broken CUDA explains unavailability and retains recovery controls. No Intel Mac, CPU, Vulkan, ROCm, or other new platform promise is introduced. Each candidate can be released on only the platforms where it passes.

## 3. Proposed behavior

1. Load capability/status data through existing add-on status. While checking, disable generation with “Checking summary availability”; a failed status fetch offers Retry. Capability data is local and must not trigger downloads or block passive status behind compute.
2. At generation, main loads the meeting and validates the confirmed language against the current retained-language policy and exact installed model/platform qualification. Bind confirmation to `sourceTranscriptHash`; reject a changed transcript and ask for reconfirmation. Do not consult today's recording-language selector for an older meeting. Reject unknown model/language IDs rather than silently resolving them to defaults.
3. Freeze model, artifact identity, language, profile, and policy revision for the attempt. Recheck admission when its queued job starts, including Linux's live loader/CUDA checks. Reject a changed installation; never silently run a different model. Keep model mutation excluded from active/pending compute through existing setup/resource coordination.
4. Pass one validated language through chunk, merge, JSON repair, and grounded regeneration prompts. Keep JSON keys, IDs, timestamps, and schema sentinels stable; localise human-readable summary values and Markdown headings, empty states, and metadata labels. Preserve proper names and source evidence. Treat transcript instructions as quoted content, not instructions to change language or invent tasks.
5. Qualify a local output-language check against substantive generated prose, excluding schema keys, names, timestamps, and fixed labels. Do not assume a detector dependency exists or use script matching as language proof. Its accuracy for short and related-language text is a release investigation gate. Reject a confident mismatch or indeterminate result before metadata finalization; allow at most the existing bounded repair budget, carrying the original language instruction. No unbounded retries or automatic translation. If a reliable check cannot be qualified, do not claim or ship enforced support for that language.
6. On success, commit the usual attempt-specific sidecars and metadata. On unavailable language, runtime failure, memory exhaustion, invalid JSON, or language mismatch, retain transcript and previous committed summary; show a specific reason and Retry or Settings action as applicable. Do not offer a smaller or replacement model in v2.10.

Generation states remain checking → queued → generating/repairing → saving → completed, with cancelling/error exits. Keep Cancel responsive during preflight, queue wait, and generation; keep finalization non-abortable from before sidecar promotion. Quit rejection, process-tree termination, bounded timeout settlement, the 90-minute generation limit, 15-minute setup-validation limit, stale-hash detection, and post-commit sidecar protection remain unchanged.

Model switching is out of v2.10. The withdrawn design was: switching must preserve the active installation and manifest until the candidate fully validates. Download/validation failure or cancellation removes only candidate partial artifacts and restores the active status. Promotion must be atomic and reject concurrent compute/mutation; crash recovery chooses the last validated active selection. Reclaim an obsolete model only after successful promotion and under existing destructive-removal exclusion, without deleting shared runtime files. This extends the current partial-file protection in `src/ai-addon/summary-setup.js:435`; it must not be assumed to already provide transactional model switching.

## 4. Technical impact and file-level plan

Execute inline only if implementation is separately authorised. These are planned changes, not completed tasks.

| Phase | Files and intended work | Validation boundary |
|---|---|---|
| A1: qualification | Create `docs/development/V2_10_SUMMARY_QUALIFICATION.md`; define fixture IDs, model/runtime hashes, language/script variants, and acceptance results for the installed Qwen model. Update `docs/development/LOCAL_AI_MODEL_CATALOG.md` only with verified findings. | No enabled-language claim from upstream marketing or catalog membership alone. |
| A2: language contract | Extend `src/ai-addon-state.js` with per-model/platform qualified language IDs and policy revision. Add a focused `src/renderer/summary-language-helpers.js`; update `src/renderer/app.js` and `src/renderer/index.html` for confirmation, availability, and explanations. Coordinate the retained-language list with the separate transcription-language scope item. | Pure state tests, language-policy intersection tests, stale confirmation and unknown-ID rejection. |
| A3: cross-process enforcement | Extend the options of existing `generate-summary` with `transcriptLanguage` and `sourceTranscriptHash`. Keep `src/preload.js` channel names/export shape unchanged; update its documented payload contract. Main validates options in `src/main/summary-service.js`. Extend the existing builder in `src/main.js:966` only to pass validated arguments; keep new policy logic out of the composition root. | IPC/CLI parity, main-authoritative rejection before inference, queued installation changes, cancellation races. |
| A4: generation and provenance | Update `backend/summaries/summary_runner.py` and `summary_pipeline.py` for language propagation, reviewed label tables, and bounded language validation. Add an isolated local language-check adapter only after A1 establishes a viable dependency/algorithm. Extend summary metadata handling in `src/main/summary-service.js` and `backend/meetings/paths.py:80`. | Chunk/single-chunk/merge/repair language tests, output rejection before commit, metadata round trips and legacy reads. |
| B1: alternative evaluation — out of v2.10 | Do not evaluate replacement entries or newer candidates for this release. | Keep the installed Qwen model. |
| B2: curated switching — out of v2.10 | Do not add a summary-model selector or transactional model switch. | The active installation stays the current Qwen model. |

Add optional `language`, `languageSource` (`userConfirmed`), `modelId`, and `languagePolicyVersion` to summary JSON metadata and the `ai.summary` allowlist. Main copies only validated bounded values; keep existing `model` for historical display and `sourceTranscriptHash` for staleness. Store confirmation with the successful summary; no eager migration, transcript rewrite, or top-level meeting-language mutation. Missing new fields mean legacy/unconfirmed, not English. A model or policy change does not retroactively invalidate readable historical output, but the next generation rechecks current eligibility. Existing add-on manifest selection remains the active model source; pending installation state must not masquerade as ready.

Keep facade export key sets and progress/cancellation constants stable. Setup retains the add-on queue; inference and runtime validation retain compute admission; destructive removal retains resource exclusion. Any new language-check work belongs inside the tracked, cancellable job, not a new worker or network service.

## 5. Risks and constraints

- **Language evidence:** Current UI codes include `en/es/fr/de/zh/ja/fa/it/pa/hi/ko/pt` (`src/renderer/index.html:196`), but the v2.10 retained list is not final. Exclude Persian when that product removal lands. Chinese script/variety and Panjabi script coverage require explicit fixtures; a generic code is not proof of all varieties. Summary quality cannot rescue an inaccurate transcript.
- **Runtime compatibility:** No newer alternative or language-detector package is assumed available. Verify license, pinned quantized bytes, architecture support, chat template, reasoning controls, JSON behavior, and CLI flags on each actual platform pin. No remote-code loading or renderer-supplied model paths/URLs.
- **Performance:** Non-Latin token density and English topic-boundary heuristics can change chunk quality. Check real token usage and long-transcript overflow; do not assume the current estimator is a tokenizer. Keep context tuning separate from this feature's language/model policy.
- **Privacy/supply chain:** All transcript, validation, and generation processing remains local. Downloads require explicit setup, HTTPS allowlists, catalog hashes and safe extraction. Preserve cleared token environments, offline inference, cache fingerprint semantics, and no sensitive prompt/transcript logging. Evaluation fixtures must be synthetic or explicitly consented, never uploaded meeting data.
- **Packaging/migration:** New runtime pins or detector resources require packaging/license inspection before implementation. Preserve signed-bundle immutability and managed loader rules. Staging a model switch needs temporary disk space for both installs; check space before download. A single active model does not imply it is safe to delete the old install early.

## 6. Validation outline

Focused suites: `tests/js/summary-service.behavioral.test.js`, `summary-ui-helpers.test.js`, `ai-addon-state.test.js`, `ai-addon-setup.test.js`, and `ipc-contract-snapshot.test.js`; Python `tests/python/test_summary_pipeline.py`, `test_summary_runner.py`, and `test_summary_llama_runtime.py`. Add focused helper/metadata cases where the new behavior lives. Existing inspected tests cover prompts/Markdown, chunk and single-chunk paths, unsupported Linux admission, preservation on failed regeneration, and successful metadata commit despite malformed stdout.

Require tests for unknown/removed languages, stale hashes, all prompt stages, translated labels without translated JSON keys, wrong-language output, ambiguous short output, switched model while queued, candidate cancellation without active-install deletion, and failures before/after metadata commit. Use real dependency types/artifacts for detector/runtime behavior; mocked prose and a one-token runtime smoke cannot establish language quality. Run focused suites while implementing and `npm run test:all` before a cross-cutting PR/release.

Manual release evidence belongs in the proposed qualification document. For every enabled model/language/platform combination, record exact artifact/runtime hashes, app revision, hardware/RAM/VRAM, profile, fixture hash, wall time, peak memory, repair count, and reviewer outcome. Cover all four profiles, short and multi-chunk meetings, noisy transcripts, names/dates/owners, empty sections, and mixed-language negatives. Use fluent reviewers and a predeclared rubric: correct output language, schema validity, grounded decisions/owners/dates, and useful coverage; any invented critical decision/owner or wrong-language final output fails that fixture. Publish fixture counts and failure rates rather than implying universal support from a small sample.

Check packaged Windows x64, Apple Silicon macOS, and supported Linux x64/NVIDIA separately: offline generation, missing/broken GPU runtime, low memory, interrupted setup, queue wait cancellation, quit during compute/finalization, and restart recovery. Model switching is out of v2.10. Capability remains disabled where language evidence is incomplete.

## 7. Explicitly out of scope

Cloud APIs, arbitrary Hugging Face URLs/local model import, a general model marketplace, automatic model downloads/switches, translation to a different language, full app localisation, simultaneous active models, CPU/AMD/Intel runtime expansion, persistent workers, context/performance redesign, transcription model changes, and automatic regeneration of old meetings. Broader Settings terminology/navigation changes remain their own scope item.

## 8. Open decisions

1. Confirm the initial language/variety priorities for the installed Qwen model. Qualification determines feasibility; it does not decide which languages the product wants to retain.
2. Closed on 2026-09-29: no summary-model selector in v2.10.
3. Closed on 2026-09-29: no alternative-model evaluation in v2.10. Keep the installed Qwen model.

Language-check feasibility, runtime compatibility, licensing, and per-platform support are engineering investigations, not product approval questions. No candidate or supported-language list is claimed as qualified by this design.
