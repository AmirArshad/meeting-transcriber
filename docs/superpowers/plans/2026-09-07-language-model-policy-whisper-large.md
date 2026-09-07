# Language/model policy and Whisper Large — Design and Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Status:** Design only, 2026-09-07. No implementation, downloads, benchmarks, or platform acceptance performed.

**Goal:** Offer a curated language list and Small/Medium/Large Whisper choices without changing saved jobs or weakening local runtime guarantees.

**Architecture:** Keep renderer → preload → transcription service → tracked Python subprocesses. Separate selectable product choices from compatibility for persisted jobs; resolve Large to an explicit runtime identity consistently across download, cache checks, and ordinary/guided transcription.

**Tech Stack:** Existing plain HTML/CSS/JS, Electron, Python, faster-whisper and lightning-whisper-mlx.

**Global constraints:** Local-only processing; explicit downloads; stable IPC ownership and facade exports; existing queue, cancellation, quit, timeout, cache and persistence invariants. Windows 10/11 x64, Apple Silicon macOS 14+, Linux x86_64 under existing support tiers. [Local AI contract](../../development/contracts/local-ai.md) and [AGENTS.md](../../../AGENTS.md) govern implementation.

## 1. Current behavior

- `src/renderer/index.html:195` offers 12 languages, including `fa` (Farsi/Persian), `pa` (Panjabi), and a single `zh` option labeled Chinese (Mandarin/Cantonese). Models at line 215 are Tiny, Base, Small (default), and Medium. There is no automatic-language option.
- `src/renderer/app.js:1691` stores preferences in localStorage; `applySavedSettings` at line 1713 directly assigns stored values to the selects. Startup checks the raw saved model before applying controls (`:1789`), then immediately invokes the first-time download flow when missing (`:1881`). That flow has cancellation and simulated progress. Changing a selector currently only saves its value (`:2610`).
- Stop calls `finalizeRecordingTranscription` with the selected language/model (`src/renderer/app.js:4078`). History retry also sends current selections (`:4183`). `src/preload.js:63` and `:83` bridge cache/download and transcription calls to their existing channels.
- `src/main/transcription-service.js:1955` persists a pending meeting before admitting its compute job. Resume uses each meeting's persisted language/model, explicitly ignoring current controls (`:2065`); retry can override them (`:2799`). Ordinary transcription spawns tracked Python (`:373`); guided transcription builds the same language/model arguments (`:347`). `src/main/python-runtime.js:198` owns the spawn environment. `backend/diarization/guided_transcription.py:214` selects the corresponding Whisper backend.
- Large is partly wired: `src/main-process/transcription-model-helpers.js:6` accepts `large` and `large-v3` alongside Tiny/Base. MLX maps both Large names to `mlx-community/whisper-large-v3-mlx` (`backend/transcription/mlx_whisper_transcriber.py:51`). faster-whisper passes its model string to the dependency (`backend/transcription/faster_whisper_transcriber.py:408`), while JS and Python cache checks interpolate that string (`transcription-model-helpers.js:60`, `faster_whisper_transcriber.py:73`). The dependency's actual alias/cache resolution has **not** been verified here; this is a release blocker for exposing Large.
- Existing Large budgets are 120 minutes ordinary, 180 minutes plus 30 seconds outer margin guided, and 30 minutes admitted preload (`src/main-process/compute-timeout-helpers.js:3`, `:27`, `:327`). Backend language tables are broader than the UI. MLX currently falls back to Base for an unknown model key (`mlx_whisper_transcriber.py:249`). These are implementation facts, not proof of model quality or hardware suitability.

Investigation was limited to this flow, the local-AI contract, scope/index, model/cache/timeout helpers and relevant tests. A few extra narrow reads beyond 15 files were needed to verify pending-job recovery, guided execution and tracked spawning; no unrelated roadmap or release history was loaded.

## 2. User-facing change

- Keep the Record page controls. Use **Transcription language** and **Whisper model**; offer Small, Medium and **Large (v3)**, with Small still the default. Describe Large as requiring more download space, memory and processing time; do not promise better accuracy for every language or publish unmeasured sizes/speeds.
- Remove Persian from new selections. Retain the other 11 languages until the qualification slice supplies evidence for a product decision. The current Chinese label must be tested separately for Mandarin and Cantonese; one code does not establish both claims.
- Migrate saved Tiny/Base preferences to Small once, with a visible explanation. Preserve valid Small/Medium preferences and normalize a saved `large` preference to `large-v3`. A removed/unknown saved language shows **Choose a transcription language**, not a silent English substitution. Fresh profiles retain English. Require a choice before starting new recording/transcription; existing recordings and History remain accessible.
- Show model states beside the selector: **Checking**, **Download required**, **Waiting for current AI work**, **Downloading**, **Downloaded**, **Unavailable**, and **Download failed**. “Downloaded” describes cache completeness, not successful inference on this machine. Actual inference keeps existing Activity loading/running/error states. Use indeterminate progress unless real byte totals are available.
- Offer explicit **Download model**, **Cancel download**, and **Retry download** actions at this control/setup flow. Selecting a model or migrating a preference must not start a transfer. Recheck the active selection after asynchronous checks so an old result cannot overwrite a newer choice.
- Windows uses faster-whisper CPU/CUDA under current fallback policy; Apple Silicon uses MLX; Linux uses faster-whisper CPU by default and managed CUDA only under current admission rules. Large is exposed only for qualified platform/runtime paths; an unqualified path shows a reason and Small/Medium alternatives. Do not infer Large readiness from NVIDIA presence or MLX cache files alone.

## 3. Proposed behavior

1. Normalize local preferences **before** startup cache checking and control hydration. Apply the product policy for new choices; keep legacy backend acceptance separate. New Large selections carry canonical `modelSize: 'large-v3'` through existing payloads.
2. Check cache completeness without network access. A missing model requires an explicit download action, which reuses `download-model` and `cancel-download-model`. Reuse the resource queue's between-job admission, active-download lock and admitted wall clock. Cancel while waiting must prevent later spawn; cancel during download must settle before the UI offers another transfer. Preserve resumable partial files and every previously complete model.
3. Require the chosen model to be downloaded before a new recording starts; cancellation leaves the user free to select a cached model. Recheck before transcription admission. If files disappear during a recording, preserve Stop's durable pending-meeting save and surface the missing-model failure; do not reject the recording's persistence or fetch weights implicitly. Offer download then retry/resume. A compute-time cache race must fail without an unapproved download.
4. Main validates new selections before compute/spawn, using the same curated policy as the renderer. Do not accept a renderer-supplied compatibility bypass. Internal pending-job resume continues to use persisted language/model, including Tiny/Base/Persian. Cache checks and explicit preload retain legacy model support for that recovery path. If legacy files are absent, expose an explicit download of that saved model from the pending-job recovery UI; retain its saved choices. If unavailable, leave the meeting recoverable with a clear error rather than substituting a model or language.
5. Explicit retry uses the currently chosen supported language/model, as today. A retry call without overrides may retain the saved choices for compatibility; validate any supplied overrides under the new policy. This distinction belongs in the service, not in a global narrowing of `ALLOWED_WHISPER_MODELS` or backend language tables.
6. Resolve Large's runtime key, cache directory and download lock identity consistently. Prefer explicit `large-v3` for new work; preserve old metadata values and support the `large` alias only after verifying its shipped-runtime meaning. Never treat a v2/turbo or merely similarly named directory as v3. Keep complete-cache offline behavior and the separate guided Whisper cache environment.
7. On resource exhaustion, corrupt cache, unsupported runtime or timeout, retain audio and existing recoverable failure behavior. Explain how to choose Small/Medium and explicitly retry; do not silently downgrade the model. Preserve existing Windows device fallback and actual-device reporting. Linux with a managed runtime tree remains fail-closed: Repair/Uninstall is the route back to an admitted CUDA runtime or CPU. MLX gains no alternate backend fallback.

Unchanged: queue sequencing and per-job snapshots; one GPU-heavy job at a time; preload stays off the compute queue; quit rejection and late-child termination; pending/active cancellation semantics; timeout settlement; recording/discard lifecycle; guided-to-ordinary transcription fallback; actual device/compute metadata; transcript/sidecar formats and atomic meeting persistence. A download cancel does not become an active-transcription cancel.

## 4. Technical impact

| Surface | Proposed impact |
|---|---|
| Renderer/UI | Add `src/transcription-policy.js`, a small browser/CommonJS-compatible pure module for selectable IDs, preference normalization and legacy distinctions; load it from `src/renderer/index.html`. Update targeted selection, startup/setup and retry/recovery paths in `src/renderer/app.js`. Keep model repos/URLs out of UI data. |
| Preload/IPC | Keep existing channel names and payload shapes in `src/preload.js`. Use existing error envelopes with specific error codes/messages for invalid new selections, missing model and unavailable runtime. No new catalog service or renderer-controlled compatibility flag. |
| Main/queues | Import the policy directly in `src/main/transcription-service.js`; preserve internal resume compatibility and save-before-compute. Align Large resolution in `src/main-process/transcription-model-helpers.js` without altering its exported key set or the facade. `src/main.js:336` can retain the general runtime validator; new product validation belongs in the owning service. No new queue or timer. |
| Python/runtime | Align explicit Large resolution and lock/cache identities in both transcribers. Keep broad language/legacy model support for recovery; reject unknown MLX model IDs instead of falling back to Base. Ensure compute-only invocations cannot download missing files while explicit preload stays resumable; trace existing environment handling before choosing the smallest CLI/env change. Guided execution must receive equivalent behavior. No assumed dependency upgrade, native helper change, distillation or quantization. |
| Persistence | No meeting schema migration or bulk rewrite. Existing `language`, `model`, status and error fields suffice. Only localStorage preferences migrate; no cache deletion. New jobs save `large-v3`; historical IDs remain intact. Failed preference writes still require safe in-memory values, not blank selectors. |

## 5. Risks and constraints

- **Identity/packaging gate:** Verify the exact shipped faster-whisper/CTranslate2 and MLX dependency versions against real v3 artifacts, cache paths, required files, public download/token behavior and packaged runtime. The code's MLX repo mapping is not availability evidence. Record model revisions/digests in qualification evidence; investigate reproducible revision selection before release. Do not add arbitrary repo IDs or URLs to IPC. Any necessary dependency/pin change needs its own packaging-contract review.
- **Performance gate:** Measure peak RAM/VRAM, disk usage and wall time for ordinary and guided Large on each intended device path, including Linux CPU. Preserve current budgets first; do not lengthen them merely to make a benchmark pass. “Downloaded” can still fail at runtime. Resource thresholds or warnings must derive from measurements, not guessed GPU sizes.
- **Language gate:** The committed Persian removal reflects reported poor performance, not a measured conclusion from this investigation. Test retained languages on consented/public, locally processed representative speech, noise, accents and domain vocabulary, with reference transcripts and fluent review. Use language-appropriate WER/CER plus omission, hallucination and mixed-language checks; no universal WER threshold across scripts. Include Small as the floor and Medium/Large comparisons. Audit Mandarin/Cantonese separately. No automatic removals from a small sample or language table.
- **Migration/privacy:** Blindly pruning backend allowlists breaks saved recovery; silently changing Persian to English changes meaning. Downloads need explicit consent even after migration or cache loss. Do not upload customer recordings for evaluation or add telemetry. Retaining unused Tiny/Base caches is intentional; global HF caches may be shared with other applications.
- **Adjacent scope:** Parakeet owns its optional English-only engine policy; summary-language gating owns summary eligibility. Share stable language codes and evaluation identities with those designs and the inference-performance baseline, without treating Whisper support as summary or Parakeet support.

## 6. Validation outline and implementation plan

Three independently deliverable slices: **A — selectable policy and upgrade compatibility**; **B — Large qualification and exposure**; **C — retained-language evaluation**. A can ship Small/Medium without B; C supplies evidence and any additional removals require a separate product decision. B depends on canonical identity and download/recovery safeguards, not on finishing every language evaluation.

### A. Curated choices and safe migration

**Files:** Create `src/transcription-policy.js` and `tests/js/transcription-policy.test.js`; modify `src/renderer/index.html`, targeted paths in `src/renderer/app.js`, and `src/main/transcription-service.js`. Extend `tests/js/transcription-service-admission.test.js`.

**Work:** Separate new choices from persisted compatibility, migrate Tiny/Base safely before startup checks, require selection for removed languages, and implement explicit missing-model download/retry states using existing channels. Keep Stop persistence ahead of cache-related compute failure. Block unintended model downloads in ordinary/guided compute while allowing explicit legacy preload for pending recovery; touch the two transcribers and `backend/diarization/guided_transcription.py` only where required for that boundary.

**Focused checks:** New-policy rejection versus legacy acceptance; fresh/malformed preferences; `fa`, Tiny/Base and Large upgrade cases; failed localStorage writes; stale cache-check responses; no download from migration/selection/resume; cache deletion between Start and Stop still saves audio/meeting; omitted retry overrides versus explicit unsupported overrides; pending snapshots remain unchanged after dropdown changes and restart. Exercise both guided and ordinary paths.

### B. Qualify explicit Large v3, then expose it

**Files:** `src/main-process/transcription-model-helpers.js`, `src/main/transcription-service.js`, `backend/transcription/faster_whisper_transcriber.py`, `backend/transcription/mlx_whisper_transcriber.py`; the policy/UI files from A. Extend `tests/js/main-process-helpers.test.js`, `tests/python/test_transcriber_helpers.py` and service admission tests. Create `docs/development/V2_10_LANGUAGE_MODEL_QUALIFICATION.md` for measured evidence during execution.

**Work:** Confirm actual dependency resolution first; unify canonical/alias cache and lock identities, preserve legacy metadata, reject unknown MLX IDs, then enable Large only for qualified paths. Keep existing timeouts and compute types. Record exact artifact identity, dependency versions, OS/package, hardware, languages, ordinary/guided timings, RAM/VRAM and failures. Failed gates leave Large unavailable on that path; no fabricated readiness claim.

**Focused checks:** Both Large IDs resolve to the verified v3 identity; no duplicate download/lock; reject v2/turbo/substring caches; complete/nonempty file parity across JS/Python; offline ordinary and guided reuse; incomplete preload remains downloadable; failed preload rechecks completeness; cancellation while parked and active, followed by successful retry; unknown models fail; facade exports and IPC remain pinned. Existing tests at `tests/js/main-process-helpers.test.js:770` and `tests/python/test_transcriber_helpers.py:635` provide cache/MLX seams, not real model qualification.

**Commands during implementation:** `node --test tests/js/transcription-policy.test.js tests/js/main-process-helpers.test.js tests/js/transcription-service-admission.test.js tests/js/ipc-contract-snapshot.test.js tests/js/compute-queue-membership.test.js`; `python -m pytest tests/python/test_transcriber_helpers.py -q`; then `npm run test:all` before any implementation PR. Add targeted Python guided tests if that contract changes. No runtime tests are claimed for this design-only task.

**Manual release gates:** Packaged Windows CPU/CUDA (including device fallback), Apple Silicon MLX, supported Linux CPU/managed CUDA, with cold download, interrupted/resumed download, offline restart, low-memory failure, long ordinary/guided meetings and subsequent queue recovery. Test upgrade with Persian/Tiny/Base preferences and pending jobs; new recording while earlier work is queued; download cancellation; quit during waiting/loading/running; Linux broken managed runtime and Repair/Uninstall recovery. Use real artifacts and hardware; mocks and complete files do not establish acceptance. A CPU-only pass does not qualify CUDA, or vice versa.

### C. Evaluate other listed languages

**Files:** Add results to `docs/development/V2_10_LANGUAGE_MODEL_QUALIFICATION.md`; update this plan and `todo.md` with decisions. Only approved removals change the policy/UI and migration tests from A.

**Work/evidence:** Record fixture provenance, reference-transcript method, language/dialect, duration, runtime/model identity, WER/CER, fluent-review findings and sample limits. Publish retained, removal-proposed and not-yet-evaluated outcomes distinctly. Product review of failure patterns precedes additional removal; pending-job compatibility remains intact. Link evidence in the v2.10 index before checking off scope items.

## 7. Explicitly out of scope

Parakeet implementation, summary models/languages, automatic language detection or translation, per-segment language switching, arbitrary Hugging Face models, Large-v2/turbo/distilled variants, runtime upgrades without qualification, new GPU fallback rules, resident workers, performance tuning, cache cleanup/model deletion, recording pipeline changes, meeting schema redesign, settings/navigation overhaul, and cloud evaluation/processing. No implementation or PR is authorized by this document.

## 8. Open decisions

1. Confirm the compatibility policy: remove Persian/Tiny/Base from **new choices**, while allowing existing pending jobs to finish with their saved values. This is recommended to preserve the locked resume contract; a prohibition on legacy execution would require a separately designed blocked-job flow, not silent substitution.
2. If Large passes only some platform/runtime gates, may those paths ship first, or must exposure wait for all target platforms? Recommendation: independent exposure with explicit unavailable reasons.
3. For additional language removals, who provides fluent acceptance review and approves the quality bar/representative use cases? Retain current non-Persian choices until that evidence and decision exist. Dependency compatibility, cache identity and resource measurements are engineering investigations, not product questions.
