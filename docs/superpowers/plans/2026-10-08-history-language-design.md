# History Language and Toolbar Implementation Plan

> **For agentic workers:** Execute inline by default. Ask before delegation, as required by this repository.

**Goal:** Make language metadata and transcript/summary actions feel intentional, readable and stable at every supported window size.

**Architecture:** Keep this a renderer presentation change. Separate metadata from actions, resolve human-readable language names independently of summary availability, and adapt the toolbar to the detail pane's available width. Preserve all generation, confirmation, retry and export behavior.

**Tech Stack:** Existing plain HTML/CSS/JavaScript and Node regression tests; no new dependencies.

## Global Constraints

- Follow AGENTS.md and read docs/development/contracts/ipc.md and local-ai.md before implementation.
- Work inline; ask before delegation. Do not stage, commit, push or publish.
- Preserve summary confirmation on every generation, including regeneration; meeting language is only a hint.
- Preserve hash/model/policy checks, stale handling, add-on eligibility and cancellation.
- Preserve privacy, platform behavior, existing action IDs and event handlers.
- Reuse the installed fonts, current surface/text/accent tokens and existing icon conventions.

## Review of the current design

The supplied screenshot shows a wrapped implementation-oriented sentence wedged between a redundant uppercase section heading and four equally weighted buttons. The resulting toolbar is unusually tall, while the language itself is still hard to scan.

In index.html, both language captions are children of .transcript-section-actions. In styles.css that group is a single flex row without a wrapping strategy. Viewport rules stack the outer header, but do not solve the inner group's layout. This matters especially around the History sidebar transition at 900px, where available detail width changes abruptly.

In app.js, updateSummaryLanguageCaptions derives display names from the summary add-on snapshot and falls back to the literal code. This explains how `en` can appear. It also uses one sentence for both panels and can substitute summary-confirmed language for transcript metadata. These are distinct pieces of information and should be presented with accurate labels.

This inspection explains the implementation problem; it does not establish which release review or validation steps occurred.

## Recommended design

Treat the toolbar as a quiet utility strip beneath the existing Transcript/Summary tabs. Keep the content visually dominant. Use an unboxed `Language: English` label on the left and a separate action group on the right. Remove the visible duplicate Transcript/Summary headings while retaining accessible panel names and any required visually hidden heading semantics.

Use existing body typography, 12–13px metadata, 13px button labels, 36px minimum desktop control height, 8px action gaps and 12px vertical padding. Use --text-secondary for readable metadata, --text-primary for the language value, --surface-1 for the strip and --hairline for its separator. Give Generate summary the existing restrained lilac primary treatment; keep Retry secondary and Copy/Save quiet. Avoid flags, decorative badges, gradients, new fonts and extra cards. The design's character comes from precise alignment and a compact, uncluttered reading surface.

Wide conceptual layout:

    Language: English                  [Retry with Whisper…] [Generate summary] [Copy] [Save]

Medium conceptual layout:

    Language: English
    [Retry with Whisper…] [Generate summary]                              [Copy] [Save]

Narrow conceptual layout:

    Language: English
    [Retry with Whisper…] [Generate summary]
    [Copy] [Save]

Use natural wrapping within the narrow action group if both long actions cannot fit. Keep visible actions and their relative order stable across widths. Do not introduce an overflow menu or duplicate action elements for this small set of controls.

### Language states and copy

- Transcript panel: use transcript/meeting language metadata, e.g. `Language: English`. Do not imply that a summary confirmation changed the recorded transcript language.
- Valid known codes should display readable names even before add-on status loads or when summaries are unavailable. Prefer an existing shared display-name utility; otherwise use guarded Intl.DisplayNames with a deterministic fallback. Cover region/script tags without changing the code sent to the backend. Unknown, missing, auto/undetermined and invalid values display `Language: Not identified` instead of a raw internal code or a guessed language.
- Summary panel: show `Summary language: English` only when stored summary metadata supports that statement. When no summary exists, omit its language value; for legacy output without language metadata, use `Summary language: Not recorded` if a metadata line is needed. Do not infer it from the current transcript.
- Existing stale-summary UI remains authoritative. Preserve the distinction between a stored summary's language and eligibility to reuse a confirmation for a new generation. Never add a reassuring confirmed/checkmark state based only on the current caption predicate.
- Remove `(confirm when generating)` and `Summary will use …` from the persistent toolbar. Keep language guidance in the existing confirmation dialog, where the user is making that decision. Preserve its predominant-language instructions, supported-language restrictions and explicit submission requirement.
- Language metadata is informational: no pointer cursor, dropdown chevron or implied editing affordance.

### Responsive behavior

Use detail-pane inline-size container queries where practical, scoped to History. Start with >=760px for the single row, 520–759px for metadata above actions, and <520px for separate processing/export rows. These are initial content-fit thresholds; adjust against the real rendered controls and longest valid states. Allow wrapping as a fallback even in wider modes.

Use min-width: 0 on shrinking grid/flex children and minmax(0, 1fr) where the History grid's automatic minimum causes overflow. Keep action text intact; wrap between controls instead of compressing or clipping labels. Long metadata may wrap naturally without moving into the buttons. The toolbar grows in normal flow, while the transcript retains usable vertical scrolling. Scope changes carefully against existing 760px, 900px and 640px viewport rules.

## Implementation tasks

### Task 1: Separate metadata and toolbar structure

**Files:** src/renderer/index.html, src/renderer/styles.css.

Move each caption out of .transcript-section-actions. Introduce scoped metadata, processing-action and export-action groups, preserving existing button IDs, hidden/disabled states and tab accessibility. Remove duplicate visible section titles. Implement the visual and responsive specifications above for both panels.

**Validation:** Inspect the actual rendered History page in every layout mode, including all conditionally visible retry controls, not just a simplified component mockup. Confirm hidden attributes still hide controls despite CSS display rules.

### Task 2: Make metadata truthful and readable

**Files:** src/renderer/app.js; src/renderer/summary-language-helpers.js; tests/js/summary-language-helpers.test.js.

Refactor updateSummaryLanguageCaptions to produce separate transcript and summary labels. Keep pure display formatting in the existing helper module if no suitable shared helper exists. Keep backend policy and confirmation logic unchanged. Add focused assertions for English with no add-on snapshot, a non-English name, a region/script tag, missing/invalid/undetermined codes, stored summary language differing from transcript language, and absent legacy summary metadata. Ensure changing meetings or add-on status does not leave old caption text behind.

**Validation:** node --test tests/js/summary-language-helpers.test.js tests/js/history-detail-helpers.test.js tests/js/transcription-engine-renderer.behavioral.test.js

### Task 3: Verify responsive and interaction quality

**Files:** Changed renderer files and relevant existing tests only.

Run npm test. Run npm run test:all before any later PR or if scope expands across processes. Do not write source-string tests merely to pin CSS declarations.

Capture and inspect actual rendered views at 1440x900, 1200x800, 1024x768, 900x700, 899x700, 768x700, 640x700 and 480x700. The narrowest sizes are renderer stress tests if native window constraints prevent them. Also test detail-pane widths around 760px and 520px, each just above and below the transition, and 200% zoom. Check the sidebar transition in both directions.

Exercise transcript and summary panels with normal, no-summary, missing-language, legacy, stale, generating/cancelling, disabled/unavailable and applicable retry states. Include long meeting titles and long language names. Confirm all actions remain reachable, Copy and Save still work, Generate/Regenerate always opens the confirmation dialog, cancel/progress states remain correct, focus is visible, tab order follows visual order, and the dialog returns focus correctly. Verify normal-size text contrast of at least 4.5:1; use 44px targets in coarse-pointer layouts.

Acceptance: no horizontal page overflow, clipped controls, overlapping metadata, unexplained gaps or broken transcript scrolling; no premature truncation of language names; no layout jump when an add-on snapshot supplies a name that should already have resolved. Review the final diff. Report screenshots and verification actually performed, and explicitly identify any unavailable visual checks.

## Copy-ready prompt for Sol

Implement the History language/toolbar redesign in `docs/superpowers/plans/2026-10-08-history-language-design.md`. Treat it as the design brief and acceptance criteria. The current design squeezes a wrapped language sentence into the button group and sometimes displays raw codes such as `en`. Replace it with quiet, accurately labelled language metadata and a compact, responsive toolbar using the existing AvaNevis visual system.

Read the plan, relevant renderer code and canonical contracts first, then implement inline. Preserve every action, explicit language confirmation on every summary generation, and all eligibility/hash/model/policy checks. Keep scope focused on the History transcript and summary presentation. Validate the actual rendered UI across the specified widths, conditional states and zoom, and iterate on what you see. Deliver the code changes, representative screenshots, test results and any remaining limitations. Do not delegate, stage, commit, push or publish.
