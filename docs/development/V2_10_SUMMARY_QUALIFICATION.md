# v2.10 Qwen transcript-language checks — 2026-09-30

Bounded synthetic checks on one installed runtime, as requested by the September
30 scope update. No alternative models, downloads, performance/memory study,
or per-OS language-quality campaign. This is not universal language-quality or
packaged/hardware acceptance evidence.

- Original implementation: `c59b4370073869b82f654e2743eee65743da3f6c`, based on
  `1673ea431086305c1234abcb66de905104c9661e`; review corrections are included in
  `02061112c6a76f9b334dbcd5ae9fd52e6149bc70` on `codex/qwen-summary-languages`.
  The chunk-budget follow-up below was committed as `7496cfb`.
- Host: Windows x64, NVIDIA RTX 4070; installed Windows CUDA llama.cpp `b9173`
  (`49d1701bd24e4cedf6dfec9e50e185111203946b`) runtime,
  unchanged 32,768 context, existing generation parameters.
- Model: Qwen3.5 9B Q4_K_M, SHA-256
  `03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8`.
- Extracted `llama-cli.exe` SHA-256:
  `d7c0f19e3429d6e238a352601486fc44c9ee9edb59351f7997ee144a7e0d80df`.
  Existing full-hash setup-status verification returned `ready`; model and runtime
  caches were valid. No runtime/model pins or installed bytes were changed.
- Reproducible public synthetic inputs: `tests/manual/summary-language-fixtures.json`;
  explicit offline runner: `scripts/check-summary-languages.py`. Raw synthetic
  outputs stay outside the repository. No recordings or user paths in this report.
  Fixture SHA-256: `746531f189a002478da2fe09cecba85e85cb34eeb7716dbe0f85e9490fd014e4`.

## Results recorded before enabling languages

Balanced single-chunk generation completed **15/15** fixtures: schema-valid JSON
and the same installed Qwen model's classifier accepted the output language.
These are one combined pipeline signal, not two independent validations. Manual
inspection of the saved synthetic outputs found Mira/checklist/Friday, Monday
pilot, unchanged budget and unresolved supplier delivery; these content findings
were not automated assertions or independent fluent-reviewer qualification.
Each original case ran once, at temperature 0.1 with no fixed seed. These checks
are not an exhaustive grounding or fluency assessment.

| Retained ID | Checked content | Original combined pipeline result |
|---|---|---|
| en | English | Pass |
| es | Spanish | Pass |
| fr | French | Pass |
| de | German | Pass |
| zh | Simplified and traditional Mandarin; written Cantonese | 3 pass |
| ja | Japanese | Pass |
| it | Italian | Pass |
| pa | Gurmukhi and Shahmukhi | 2 pass |
| hi | Hindi | Pass |
| ko | Korean | Pass |
| pt | Brazilian and European Portuguese | 2 pass |

The original local Qwen classifier identified **15/15** input-language controls,
including Spanish/Portuguese, French/Italian, and Hindi/Panjabi. Short name/date
labels and equal English/Spanish prose both returned `unknown`, `certain=false`
(**2/2** indeterminate controls). It sees only substantive prose and never the
requested language. JSON keys, owner names, dates, timestamps and fixed labels
are excluded. A deterministic 40-letter evidence floor rejects very short text
before classification; it is not script-based language identification. Long input
is bounded to 6,000 characters sampled across beginning, middle and end; minority
language outside those samples may be missed.

This reuses the pinned installed Qwen model, not a new detector dependency or
network service. It is a probabilistic check, not proof: related languages,
code-switching, and sparse notes can still be ambiguous. Indeterminate or wrong
language fails closed. Balanced multilingual input is rejected; users confirm
the predominant language for other mixed transcripts. Prose may be formalized
(notably written Cantonese); script/variety preservation is prompted, not a
claim of dialect-perfect reproduction.

The runtime evidence is Windows-only. Apple Silicon and Linux CUDA functional
smokes (one English and one non-English summary each) remain unrun because those
hosts are unavailable here. Policy is enabled under their existing admission
gates, but portability of these checks is an engineering assumption, not measured
language evidence. Replacement catalog
models have no enabled language policy. Persian remains off the retained list.

## Integration evidence

The `--paths-only` run passed **9/9** cases on the same runtime:

- Spanish Concise: forced two short fixture chunks, both generated and locally
  checked, then a real same-language merge. The ordinary 32k runtime context was
  unchanged; the probe alone forced the chunk boundary.
- French Detailed and Japanese Action items: valid same-language output.
- Spanish JSON repair, German grounded regeneration and Spanish wrong-language
  regeneration: injected invalid JSON/an **English** denial/English output into the first attempt;
  the real Qwen corrective attempt passed, within the existing one-repair budget.
  The original German probe therefore did not establish localized denial handling;
  the review corrections below replace that injection with a German denial.
- Wrong confirmation (English input confirmed Spanish) and balanced English/Spanish
  input: rejected by the real local input check before summary generation.
- Spanish full runner: JSON/Markdown sidecars and hash-bound language/model/policy
  provenance saved successfully. Localized headings, empty sections and metadata
  labels are regression-covered; schema keys, names and timestamps remain stable.

Report fingerprints (raw synthetic reports retained locally, not in git):
`results.json` SHA-256 `8e46277f9c7d654166df0223f3c58e47c6b9a1ef7bf952a89ef3cd10ed433259`;
`paths.json` SHA-256 `1069ce3e806db8cee652ed0cb42a674bcc210cfdd6b50cc0f5352e8bf333542e`.

Focused JS/Python regressions passed, including real CLI argument construction,
dialog submission/cancel/focus/quit behavior, unknown/removed languages, stale
hashes and CRLF parity, queued model changes, all generation/repair prompt paths,
wrong/indeterminate prose, metadata round trips, legacy reads and prior-output
protection. Final `npm run test:all` exited 0: **1,077 JS passed / 4 skipped** and
**748 Python passed / 8 skipped**, with both syntax gates passing. Skips retain
their existing environment/hardware limits; CI is not hardware acceptance.

No packaged UI or per-OS language campaign was performed. Existing explicit
setup, runtime admission, resource/compute queues, tracked process cancellation,
quit handling, non-abortable finalization and prior-summary protection remain in
place. No eager migration or automatic regeneration of historical meetings.

## Adversarial-review corrections — 2026-09-30

The English-only absence-of-transcript guard accepted localized denials. A red
regression reproduced the failure; the corrected guard rejects 13 supplied
English/localized/script-variant denial examples before language classification,
retries only once, and preserves prior JSON/Markdown sidecars on failure.
Affirmative mentions of a supplied transcript are separately checked. These are
finite phrase guards, not general factual-grounding verification.
The speech heuristic now counts letters within words despite combining vowel
signs; a Hindi-only example without three consecutive regex letters previously
bypassed the denial guard and is regression-covered.

The old classifier confidently mislabeled the Marathi neighbor fixture as Hindi.
Policy `qwen-language-v2` asks for the actual ISO 639-1 language of any input,
rather than choosing from the supported menu. Well-formed region/script tags
retain the primary language (`zh-HK` → `zh`); Marathi, Nepali, Urdu, Catalan and
Galician are never aliases for enabled languages. JS/Python policy/version parity
is now tested by importing the actual JS export from Python.

Mixed-input prompt trials showed why confidence alone is insufficient: some
wordings accepted balanced English/Spanish as confidently English or Spanish.
The final input prompt reports language identity and approximate language share;
production requires both a matching confident identity and share ≥ 0.6, with
missing/invalid shares rejected. The balanced control reports 0.5 and fails
admission. The roughly 70/30 Spanish/Hindi controls report 0.6/0.75 respectively.
Output checks retain their stricter substantially-mixed rejection rule. Share
estimates and language checks come from Qwen itself, not an independent detector;
they can still misclassify or overestimate predominance. Prompt trials are not
repeatability or statistical quality evidence.

Public review inputs are `tests/manual/summary-language-review-fixtures.json`;
`--review-only` checks five neighbors, two predominant mixtures, a names-only
control above the 40-letter floor, balanced input, and real short Chinese/Hindi
Concise summaries, plus predominant Spanish/Hindi generation. `--controls-only` checks the 15 retained input/script/variety
cases without claiming new generation coverage. `--paths-only` now injects the
German denial in German. All modes use the same installed runtime and unchanged
temperature/context, with no fixed seed, downloads or model comparison.

Every Generate/Regenerate now shows an editable confirmation dialog. A previous
hash/model/policy-bound confirmation is only its default; changing or cancelling
does not overwrite prior output. Cross-process policy parity, dialog behavior,
invalid/missing share admission and localized denial protection have regressions.

The requested `--long-only` probe failed at 25,590 estimated tokens against a
25,868-token Concise budget (100,653 characters of repeated public Chinese prose).
Generation and its one JSON repair both failed with no JSON object. It exercises
no sidecar writer, so prior files remain untouched. This establishes an existing
large non-Latin chunk limitation; that initial run did not establish the exact
tokenizer cause or useful quality on repetitive data. The targeted follow-up
below investigates this failure. Apple Silicon/Linux functional smokes remain unrun.

Final focused regressions passed; `npm run test:all` exited 0 with **1,079 JS
passed / 4 skipped** and **814 Python passed / 8 skipped**, plus both syntax gates.
The corrected real runtime path run passed **9/9**, including German localized
denial regeneration, merge, JSON repair, language retry, negative admission and
sidecar provenance. Review controls passed **9/9**; short Chinese/Hindi and
predominant Spanish/Hindi Concise generation each passed (**4/4**). These are
bounded functional checks, with the failed long probe retained above.
Current-policy input controls passed **15/15** retained language/script/variety
cases; the short control remained indeterminate and balanced input failed the
share gate. This rerun validates input classification, not new generation or
independent quality evidence for all 15 fixtures.

Report SHA-256 fingerprints (public synthetic reports retained locally):
- Current-policy retained input controls: `c84269a464955f6b8517ffe3f901d222def38561d5f14aa19aa87c661e169291`.
- Review controls and short generations: `ece207847098effed633d846a83a2ccacba3d0c3096ed45545b22f742ffad970`.
- Corrected paths: `e9f65682ffe3ab05b15bbe2e3e54a86e15e400c0423b2d759bbc3ba920bd8675`.
- Predominant Spanish/Hindi generation: `fe63137be3a8b3e00e47d4b5c4944650a95d9a9edfd5b044e8d46cc35aadc487` / `49794bfff6ba763a508bed1efd4340bfa5cd6a266e6cfa693bdd151477f49f9f`.
- Failed long probe: `e4937d21c558db7e348456e5ed6ce1642a1249ec3c54015eee69180ddb275cf1`.

## Targeted Chinese chunk-budget fix — 2026-09-30

Continued inline from `02061112c6a76f9b334dbcd5ae9fd52e6149bc70`, with changes
subsequently committed as `7496cfb`. The installed model and CLI were rehashed and match the hashes
above. No downloads, dependency/runtime changes or context increase.

The unmodified `scripts/check-summary-languages.py --long-only` reproduced the
same failure and report fingerprint: 853 repetitions of the public `zh` fixture,
100,653 normalized characters, 25,590 estimated tokens versus a 25,868 budget.
The installed `llama-tokenize --file --ids --show-count --log-disable` counted
**55,802** tokens in the complete chunk prompt. An invocation using the ordinary
production CLI arguments reported **55,814** input tokens exceeding **32,768**.
The CLI exited 0 despite its request error, so generation returned no summary
JSON; the one repair also failed. The constructed repair had **56,451** raw
tokens. This establishes character undercounting as the demonstrated cause.
Standalone counts exclude CLI template overhead; the CLI's count is the direct
overflow evidence. No change to CLI error handling is included in this fix.

The small fix uses `ceil(UTF-8 bytes / 4)` for chunk estimates, preserving ASCII
behavior and accounting for multibyte text. Quoted invalid repair output is capped
at **12,000 UTF-8 bytes**, with an incomplete final code point dropped; the complete
grounded source and language instructions remain. The existing 6,000-token prompt
reserve, profile output allowances, 32,768 context and one shared retry remain.
Three new regressions failed before the fix and pass afterwards: multibyte
estimation, splitting the original fixture, and multilingual repair-output size.

Bounded results on the same Windows CUDA runtime:

- `--long-only`: **pass**, 25,604 estimated tokens / 40,827 characters (346 fixture
  repetitions) against the same 25,868 budget. Equivalent complete prompt raw
  count: **22,847**. Generation and the local Chinese prose check passed. The first
  successful run saved its report but hit Windows cp1252 printing; rerunning with
  `PYTHONIOENCODING=utf-8` exited **0**.
- Original 853-repetition input through the ordinary pipeline: **pass**, three
  chunks with estimates **25,826 / 25,826 / 11,618**, one-segment overlap and raw
  prompt counts **23,042 / 23,042 / 10,562**. All chunk language checks and the final
  merge/check passed; the merge raw prompt had **1,963** tokens.
- Near-budget JSON repair: **pass**. A probe injected 12,000 Chinese invalid-output
  characters into the first attempt; the byte cap retained 4,000 characters.
  Real Qwen repair used the full grounded near-budget source, with **27,168** raw
  prompt tokens and the unchanged 900-token output allowance. It returned valid
  Chinese JSON and passed the local language check within **one** corrective call.

Manual inspection of these synthetic summaries found the Monday pilot, unchanged
budget, Mira's Friday checklist, unresolved supplier delivery and no assigned
supplier follow-up owner. This is bounded content inspection, not independent
fluent-reviewer or general long-meeting quality evidence. Repetition is an overflow
probe; Qwen's language checks remain self-classification. Byte estimates remain
heuristic and can undercount other text. Arbitrarily oversized individual segments
and large merge prompts retain their existing limitations and were not qualified.
No model comparisons, performance/memory study or per-OS quality campaign.

Fresh focused regressions passed **146/146**. `npm run test:all` exited **0**:
**1,079 JS passed / 4 skipped**, **817 Python passed / 8 skipped**, both syntax
gates passed. Existing queue, cancellation, finalization, admission, language
propagation and prior-summary regressions remain passing. These long probes use
no sidecar writer and do not modify prior summaries. Apple Silicon and Linux CUDA
English/non-English functional smokes are **unrun**: no such host is available in
this session. No packaged/hardware acceptance claim is added.

Report SHA-256 fingerprints (synthetic reports retained outside the repository):

- Reproduced failure: `e4937d21c558db7e348456e5ed6ce1642a1249ec3c54015eee69180ddb275cf1`.
- Successful first long check (console encoding failure): `233e36a163dae28efb4703d41c2f7822b40788bd346440f8731c4f375d1bb2e9`.
- Verified UTF-8 `--long-only`: `d1352364ce664c60d735b00709cd74d4393955701a65f2620ea0aa574dd8a0af`.
- Original-input merge and forced-repair report: `59ce8dae11e8aee45423114552c1aba1abf2773f3b30de2733c15988a3d6f6dd`.

## Apple Silicon functional validation — 2026-10-01

Host: Apple M4 Pro, 48 GB, macOS 26.7.1, arm64. Runtime/application code is
`7496cfb`; this follow-up changes test fixtures and evidence only. Installed
Qwen3.5 9B Q4_K_M and the pinned darwin-arm64 Metal llama.cpp `b9173` runtime
passed the application's full-checksum setup-status path (`ready`). The model
hash matches the Windows evidence above. Extracted `llama-cli` SHA-256:
`eec00d923f7f1307ca01691e86c7cb8e98fe5ded327cd1352559bca8fac3992d`.
The CLI lists Apple M4 Pro as `MTL0`; production arguments retain all-GPU-layer
selection, the 32,768 context and existing generation settings.

- English and Spanish public fixtures passed the full Python runner (**2/2**),
  including input/prose language checks, JSON/Markdown sidecars and hash-bound
  language/model/policy metadata. Manual inspection found the Monday pilot,
  unchanged budget, Mira's Friday checklist and unresolved supplier delivery.
  No new supplier follow-up owner was invented.
- `--paths-only` passed **9/9**: real Spanish chunk/merge, French Detailed,
  Japanese Action items, Spanish JSON repair, German localized-denial retry,
  wrong-language regeneration, wrong-confirmation and balanced-input rejection,
  and full Spanish sidecar generation.
- `--long-only` passed the Chinese overflow probe at **25,604 estimated tokens**,
  **40,827 characters**, against the unchanged **25,868** Concise chunk budget.
  Manual inspection found the same pilot/checklist/budget/supplier facts.
  Repetition remains a context-sizing probe, not general long-meeting quality
  evidence; UTF-8 estimates remain heuristic.
- `npm run build:mac:dir` and `npm run verify:mac:packaged` exited **0**. The app is
  ad-hoc signed, not notarized; packaged Python/MLX imports, arm64 helpers,
  FFmpeg/Opus encoding, fixture layout and strict bundle signatures passed.
- The packaged renderer/preload/main/Python pipeline generated English and
  Spanish summaries (**2/2**) in an isolated profile using the installed cache.
  Every generation displayed an editable confirmation dialog. Spanish
  regeneration prefilled Spanish; an empty choice disabled submission. Cancel
  preserved the prior summary and restored focus to the Regenerate button.
  Restart retained both completed summaries and checksum-verified cache readiness.
  Strict bundle signatures still passed after execution. This is restart/cache
  evidence, not packaged update-survival or recording-hardware acceptance.

The first Mac regression gate found **12** JS failures: Windows/Linux service
fixtures overrode the platform but inherited the host's `arm64` architecture,
creating unsupported platform/architecture pairs. Fixtures now specify their
matching architecture, and propagation is covered for Windows and Apple Silicon.
No production behavior changed in this correction. Fresh `npm run test:all`
exited **0**: **1,080 JS passed / 4 skipped**, **816 Python passed / 9 skipped**,
with both syntax gates passing (Node 26.10.0, Python 3.11.17). The additional
Mac Python skip is the existing CachyOS `/proc` telemetry check.

Synthetic reports remain outside git. SHA-256 fingerprints:

- Full runner: `2b0139c1bb10647b3426b7bc2d85cf16e3b05719b67c2cb76fd5ba8c046068e2`.
- Integration paths: `494db18572526d1bbaab585d9d57a8a8ce185ddf431a28335e3d1f42dec8d65c`.
- Chinese near-budget: `14b61d030da0a1703e0418fa5e33d11e1e2b8c1a2c1d86dbca71ddc4fc6b19dc`.
- Packaged UI/persistence: `3ebd25ba768ddd085525f60111d9fb07ea743a348e2b43aa1d091c77cd622e07`.
- Packaged `app.asar`: `2673c26c51f19da40428db755a35e6e400eff3612760fe204708a2b56af3620c`.

This closes the Apple Silicon English/non-English functional smoke. Linux CUDA
functional/hardware checks are explicitly deferred until before the v2.10 release
by the October 1 scope update and do not block this branch's merge. No repeated
per-OS language-quality campaign, alternative-model evaluation, performance or
memory study is added. The separate four Parakeet lifecycle checks and Linux
microphone-volume investigation remain release work.

## Inherited macOS dependency-audit repair — 2026-10-01

PR #108 CI found three urllib3 2.7.0 advisories in the packaged Mac requirements
already present on `master`: CVE-2026-97687, CVE-2026-97688 and CVE-2026-97689.
The packaged pin is now 2.8.0, as specified by the audit and
[upstream security release](https://urllib3.readthedocs.io/en/stable/changelog.html).
The generated direct-pin legal inventory was refreshed. Source commit: `c1aeffa`.
Installed Qwen/model/runtime pins and Parakeet locks were unchanged.

- `.venv/bin/python -m pip_audit -r requirements-macos-build.txt`: exited 0,
  no known vulnerabilities found. The GitHub macOS Python audit also passed. All eight PR CI checks
  passed for source commit `c1aeffa`, including Mac/Windows/Linux packaging.
- Fresh `npm run test:all`: exited 0, 1,080 JS / 816 Python passed, 4 / 9 existing
  skips and both syntax gates passing. Focused legal/resource checks passed 17/17.
- The requirements change invalidated prepared resources and rebuilt the Mac
  runtime through the normal build script. A PyPI read timeout on the first
  attempt was resolved by retrying with a longer pip timeout. The rebuild and
  packaged verification exited 0; bundled Python reports urllib3 2.8.0.
- The newly signed packaged UI again generated English/Spanish summaries 2/2,
  preserved Spanish regeneration prefill, disabled invalid submission and kept
  the prior summary on cancel. Post-execution strict signatures passed.

Updated packaged UI report SHA-256:
`ca1878edcf439d7d3ddfeea3122a7265f1547d4d6b6360b53605901fc289490a`.
Updated packaged `app.asar` SHA-256:
`f6d4a87d7ef146c686d5b4ad995867480c9e9c2c8f658641346a4803cce8d73a`.
Earlier fingerprints remain the evidence for the pre-audit build. Linux hardware
and the separate Parakeet release checks remain deferred as recorded above.

## Linux packaged-backend functional smoke — 2026-10-03

The 2.10.0 candidate based on `278aa204` plus the unstaged release-preparation
changes passed English/Spanish full-runner generation with installed Linux
Qwen3.5 9B Q4_K_M and managed CUDA. Actual prose inspection confirmed the Monday
pilot, unchanged budget, Mira's Friday checklist and unresolved supplier delivery
in the respective language. Live packaged CUDA admission and full-checksum setup
status returned `ready`. Wrong confirmation and process cancellation preserved
previous sidecars/transcript/audio bytes.

This closes the bounded Linux backend English/non-English functional smoke;
it does not close packaged renderer confirmation/edit/regeneration/cancel/restart
acceptance. Native desktop input APIs were unavailable. No language-quality or
performance campaign was added. Artifact/report hashes, exact execution scope
and remaining gates are in the [Linux release evidence](V2_10_LINUX_RELEASE_QUALIFICATION.md).
Historical Windows/Mac reports above remain unchanged.

## Subsequent manual acceptance — 2026-10-03

The user confirmed all remaining checks were completed manually and good. This
closes packaged confirmation/edit/regeneration/cancel/restart acceptance by user
sign-off; it does not expand the agent-measured backend smoke above. See the
[manual acceptance record](V2_10_LINUX_RELEASE_QUALIFICATION.md).
