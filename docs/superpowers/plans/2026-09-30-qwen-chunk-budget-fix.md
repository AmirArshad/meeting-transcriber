# Qwen multilingual chunk budget fix implementation plan

> **For agentic workers:** Execute inline. Do not delegate.

**Goal:** Fix the demonstrated Chinese chunk overflow with the installed Qwen model.

**Architecture:** Keep the 32,768 runtime context and existing prompt pipeline. Estimate chunk size using UTF-8 bytes rather than character count, and bound quoted invalid repair output in the same units. This remains a heuristic, not exact tokenizer admission.

**Tech Stack:** Python 3.11, installed Qwen3.5 9B Q4_K_M and Windows CUDA llama.cpp.

## Global constraints

- Preserve local-only processing, runtime admission, explicit downloads, queues, cancellation, finalization, language propagation, bounded retries, and prior-summary protection.
- No context increase, model comparisons, performance/memory studies, or per-OS quality campaign.
- Leave changes uncommitted; do not re-review unchanged work.

### Task 1: Reproduce and correct prompt sizing

**Files:** `backend/summaries/summary_pipeline.py`, `backend/summaries/summary_runner.py`, `tests/python/test_summary_pipeline.py`, `tests/python/test_summary_runner.py`.

Reproduce using `scripts/check-summary-languages.py --long-only`. Compare the complete prompt with the installed tokenizer and CLI error. Preserve ASCII estimates; count UTF-8 bytes for multilingual chunks. Cap quoted invalid output at 12,000 UTF-8 bytes without cutting a code point, retaining the complete grounded source and language instructions. Add regressions for the public Chinese fixture and multilingual repair size.

**Validation:** Focused summary Python suites, then the installed-runtime near-budget check and the original repeated input through chunk/merge. Use a bounded forced malformed-output repair check to verify repair sizing.

### Task 2: Record fresh evidence

**Files:** `docs/development/V2_10_SUMMARY_QUALIFICATION.md`, `todo.md`, `docs/development/contracts/local-ai.md`.

Record exact reproduction, resulting checks, report fingerprints, heuristic limits and unavailable platform checks. Run one English/non-English functional summary on Apple Silicon/Linux CUDA only if such hosts are available. Run `npm run test:all` and inspect the changed diff.
