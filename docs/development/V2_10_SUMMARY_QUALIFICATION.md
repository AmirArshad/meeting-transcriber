# v2.10 Qwen transcript-language checks — 2026-09-30

Bounded synthetic checks on one installed runtime, as requested by the September
30 scope update. No alternative models, downloads, performance/memory study,
or per-OS language-quality campaign. This is not universal language-quality or
packaged/hardware acceptance evidence.

- App base: `1673ea431086305c1234abcb66de905104c9661e`, with the uncommitted
  language implementation on `codex/qwen-summary-languages`.
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

Balanced single-chunk generation passed **15/15** fixtures: valid JSON, matching
language, Mira/checklist/Friday, Monday pilot, unchanged budget, and unresolved
supplier delivery. The summaries do not change the critical task owner/date or
invent a budget increase. These are practical language checks, not an exhaustive
grounding or fluency assessment.

| Retained ID | Checked content | Generation | Local language check |
|---|---|---|---|
| en | English | Pass | Pass |
| es | Spanish | Pass | Pass |
| fr | French | Pass | Pass |
| de | German | Pass | Pass |
| zh | Simplified and traditional Mandarin; written Cantonese | 3 pass | 3 pass |
| ja | Japanese | Pass | Pass |
| it | Italian | Pass | Pass |
| pa | Gurmukhi and Shahmukhi | 2 pass | 2 pass |
| hi | Hindi | Pass | Pass |
| ko | Korean | Pass | Pass |
| pt | Brazilian and European Portuguese | 2 pass | 2 pass |

The separate local Qwen classifier identified **15/15** input-language controls,
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

The language evidence applies to this exact model on existing admitted Windows,
Apple Silicon and Linux runtimes. Runtime admission remains platform-specific;
this document makes no new platform acceptance claim. Replacement catalog
models have no enabled language policy. Persian remains off the retained list.

## Integration evidence

The `--paths-only` run passed **9/9** cases on the same runtime:

- Spanish Concise: forced two short fixture chunks, both generated and locally
  checked, then a real same-language merge. The ordinary 32k runtime context was
  unchanged; the probe alone forced the chunk boundary.
- French Detailed and Japanese Action items: valid same-language output.
- Spanish JSON repair, German grounded regeneration and Spanish wrong-language
  regeneration: injected invalid JSON/denial/English output into the first attempt;
  the real Qwen corrective attempt passed, within the existing one-repair budget.
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
