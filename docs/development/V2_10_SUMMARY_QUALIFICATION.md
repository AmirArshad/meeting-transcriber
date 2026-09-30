# v2.10 Qwen transcript-language checks — 2026-09-30

Bounded synthetic checks on one installed runtime, as requested by the September
30 scope update. No alternative models, downloads, performance/memory study,
or per-OS language-quality campaign. This is not universal language-quality or
packaged/hardware acceptance evidence.

- Original implementation: `c59b4370073869b82f654e2743eee65743da3f6c`, based on
  `1673ea431086305c1234abcb66de905104c9661e`; review corrections remain uncommitted
  on `codex/qwen-summary-languages`.
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
large non-Latin chunk limitation; it does not establish the exact tokenizer cause
or useful quality on repetitive data. Context/chunk-estimator redesign remains
outside this slice. Apple Silicon/Linux functional smokes remain unrun.

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
