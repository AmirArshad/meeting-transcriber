# Design brief to run before building audio import

Use the text below as the prompt in a new design session.

---

Design the local audio import experience for AvaNevis v2.12.0. Use the published v2.11.0 desktop app as the visual baseline. Someone opening AvaNevis with an existing recording should be able to find Import audio, understand what happens to their file, and reach the transcript. Someone opening History to revisit yesterday’s meeting should still recognize the screen and reach playback just as easily. Deliver a design spec with annotated wireframes. Leave implementation for the build session.

### Read the interface first

Read the [release plan](2026-11-18-v2.12.md), then trace History, Record/Activity and Settings through src/renderer/index.html, src/renderer/styles.css and the relevant handlers in src/renderer/app.js. Start at .history-layout, .sidebar-header, #selection-toolbar, #meeting-details-empty, .history-detail-toolbar and #summary-language-modal. Find the actual window sizing and responsive rules. Use the rendered app and the current cascade to resolve differences from older roadmap descriptions.

Make a compact table of design decisions worth carrying forward. For each, give its actual selector or token, a screen where it works, and what it means for import. Cover the rail and split pane, type and density, surfaces and hairlines, dusty lilac accent, semantic colors, icon and button treatments, progress, dialogs, focus and motion. Distinguish “no meetings yet,” “search found nothing,” and “no meeting selected.” Look for how existing dialogs return focus and how Activity reports queued work.

### Keep optional computer use small

Begin with source inspection. If seeing the running app would settle a layout or interaction question, delegate computer use to one **gpt-6.1-terra** subagent with a short, self-contained brief. Ask it to use a disposable profile with synthetic meetings and inspect History at ordinary and narrow desktop widths, plus the existing dialog or Activity state relevant to the question. Have it return the decisive observations, dimensions and only the screenshots needed to support them. Reuse those observations. If Terra or a desktop session is unavailable, use source-grounded wireframes and label the visual checks still open.

### Design the entry point and the handoff

Compare two plausible placements in the current History screen. Sketch both in the populated split pane, with a meeting selected. Consider a labeled action beside Meetings/Refresh as one candidate. Test discoverability, width taken from the list or transcript, and what happens when bulk actions appear. Choose one placement and explain the trade-off. Let an empty library offer a shortcut to the same flow if it helps. Keep Record prominent and preserve search, refresh, selection, rename, playback and transcript actions.

Walk one example, “Project review.opus,” from file choice to playback. Use the native picker for one local MP3, WAV or Opus. Show how the user confirms language and engine, where any unavailable choice is explained, and which action starts transcription. Specify where focus lands after picker cancellation, confirmation and completion. Show the smallest feedback that answers three questions: did AvaNevis accept my file, where is it now, and what can I do next?

Distinguish conversion from the durable History entry and the queued transcription. Cover cancel before persistence, cancellation after enqueue, an already-busy queue, a decode or disk-space failure, retry and reopening after restart. Preserve the source file and make the outcome understandable. Use existing Activity and History status conventions. Summaries remain user-triggered. Include exact visible copy for the main action, busy state and one recoverable error.

### Propose a small visual cleanup

Inspect adjacent Record, History and Settings surfaces. Pick up to three concrete inconsistencies that cost users attention or make controls harder to operate. For each, show the current pattern, a location where the app already handles it well, the smallest correction, and any shared selector that could affect another screen. Rank them and distinguish import prerequisites from independently shippable polish. Keep the rail, typography, palette and overall density recognizable.

### Return a buildable design

Deliver one Markdown spec with the design-system table, placement decision, and annotated before/after wireframes of populated History at ordinary and narrow widths, the confirmation step, and the handoff to queued work. Include a compact state/action table for the remaining cases. Label observations, proposals and checks awaiting a running app.

End with a file-level implementation map and visual acceptance checks. Verify that a long filename, a long meeting title, bulk selection, keyboard-only navigation, text scaling, reduced motion and a busy Activity queue all have a usable presentation. A user should be able to cancel back to the same History selection, tell when a file is safely imported, and find the result again after restart. Identify the smallest design that satisfies those checks.
