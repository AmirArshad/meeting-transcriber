# AvaNevis v2.12.0 · Import audio into History

**Decision.** Put **Import audio** beside **Meetings** and Refresh. Choose one file, confirm its transcription settings, then open its playable copy in History. Someone returning to yesterday’s meeting takes the same route as before. The import adds one secondary button to populated History and uses one dialog from confirmation through handoff.

## Desktop baseline · observed in source

The [release plan](2026-11-18-v2.12.md) defines the persistence boundary. The checkout is one documentation commit beyond the published v2.11.0 tag. The renderer and window configuration match the tag. The dimensions below come from the final CSS cascade and BrowserWindow options. Native window inspection was unavailable to the desktop agent. The diagrams are source-derived, and the visual checks at the end remain open.

| Carry forward | Actual selector or token | Where it works today | Import consequence |
|---|---|---|---|
| Navigation | `.icon-rail`, `.rail-btn.active::before`, `--rail-width` | Record opens first. History has a left-edge active marker. Settings sits at the foot of the rail. The legacy tabs are hidden. | Keep these three destinations. In empty Record Activity, add a quiet text action **Import audio in History** that opens History and focuses its labeled button. |
| Library and detail | `.history-layout`, `#history-tab`, `.sidebar-header` | History gives the list a 240–300px track, a 12px gap and the remaining width to detail. Search and bulk actions live above a scrolling list. | Budget against the small end of the list track. Keep playback and the detail toolbar at their current widths. |
| Type and density | `--font-display`, `--font-sans`, `--font-mono`, `.sidebar-header h3`, `.cap-time` | The 13px body uses system sans, History titles use display type, Meetings is a 10px uppercase mono label, time uses tabular digits. | Keep the heading small and the adjacent action sentence case. Use the existing 34px control height as a minimum, with room for text to grow. |
| Surfaces and edges | `--surface-0` #101214, `--surface-1` #171a1d, `--surface-2` #202428, `--hairline` #343a40 | History panes have a quiet border and 8px corners. Settings fields and playback sit on a lifted surface. | Use the same field fill and one header divider. The import needs no permanently raised card. |
| Accent and buttons | `--accent` #b8a8c9, `.record-button.idle`, `.cap-play-btn`, `.btn-primary`, `.btn-icon-only` | Record and Play have lilac fills. Refresh has a 13px stroke icon in a 34px button. Selected meetings have a soft lilac tint. | Use a neutral text button for entry, keep the Refresh icon and its accessible name, reserve filled lilac for the confirmation or result action. |
| Meaning of color | `.activity-chip.queued`, `.activity-chip.ready`, `.activity-row.is-failed`, `.btn-danger` | Activity pairs amber with Queued, slate with active phases, green with Ready and red-toned chips with Failed or Cancelled. History reserves Delete for a destructive action. | Keep the status word visible. Cancel transcription keeps the imported audio. Delete meeting is a separate action. |
| Work in progress | `#activity-list`, `#soft-queue-depth-warning`, `#activity-completion-toast` | Record Activity combines queue events with durable pending/failed meetings by ID. It shows named phases, a depth hint at three busy items, and up to five session Ready rows. | Conversion stays in the dialog. After admission, use the existing queue row and Ready announcement. History is the lasting destination. |
| Dialog and focus | `#summary-language-modal`, `.modal-actions`, `:focus-visible` | Summary confirmation focuses the select, cycles Tab/Shift+Tab among enabled controls, handles Escape and restores the connected invoker. The global ring uses a 2px lilac outline. | Name the import dialog and its fields, explain unavailable selections inline, trap focus while open and make the closed dialog inert. |
| Motion | `@media (prefers-reduced-motion: reduce)`, `getPreferredScrollBehavior()` | Reduced motion suppresses refresh rotation and smooth scrolling. | Make text sufficient for every phase. Use immediate scrolling for reduced motion and announce transitions once. |

**Sizing.** The initial native window is 1200 × 800 with the default title bar and no explicit minimum. CSS queries use the content viewport. Above 900px the rail is 56px and content has 24px side padding. At an illustrative 1200 CSS px that leaves roughly 784px for detail after a 300px list and the gap. At **900px and below**, the later rule stacks the list above detail, reserves a scrollbar gutter and gives the list row `minmax(180px, 32vh)`. The earlier 760px rule does not determine when stacking begins. At 640px and below the rail becomes 48px, the detail header stacks and playback hides the volume control. Separately, detail **container** widths of 759px and 519px reflow the toolbar groups. The top bar and shared audio setup strip precede History in both layouts.

## Entry placement · proposal

Wireframes use synthetic meetings. Brackets mark controls, the triangle marks the open meeting, and check marks denote bulk selection. Rail names stand in for existing icons. The ordinary views share the same AvaNevis top bar and audio setup strip.

~~~text
Ordinary · v2.11 populated History · 1200px illustrative viewport

 Record   │ MEETINGS                 [↻] │ Yesterday’s planning [✎]         [Delete]
 History◂ │ [Search meetings…          ] │ Yesterday · 24:16
          │ ▸ Yesterday’s planning      │ [▶] 0:00 ───────────────── 24:16  [vol]
          │   Tuesday check-in          │ [Transcript] [Summary]
 Settings │   Design sync               │ Language · English   [Generate summary] [Copy] [Save]
          │                             │ We agreed to move the review to Friday.

A · proposed · same width, meeting selected and two meetings checked

 Record   │ MEETINGS   [Import audio] [↻]│ Yesterday’s planning [✎]         [Delete]
 History◂ │ [Search meetings…          ] │ Yesterday · 24:16
          │ 2 selected   [Clear] [Delete]│ [▶] 0:00 ───────────────── 24:16  [vol]
          │ ▸ Yesterday’s planning      │ [Transcript] [Summary]
          │ ✓ Tuesday check-in          │ Language · English   [Generate summary] [Copy] [Save]
 Settings │ ✓ Design sync               │ We agreed to move the review to Friday.

B · alternative · same selected meeting and checked rows, action above both panes

 Record   │                                                  [Import audio]
 History◂ │ MEETINGS                 [↻] │ Yesterday’s planning [✎]         [Delete]
          │ [Search meetings…          ] │ Yesterday · 24:16
          │ 2 selected   [Clear] [Delete]│ [▶] 0:00 ───────────────── 24:16  [vol]
          │ ▸ Yesterday’s planning      │ [Transcript] [Summary]
          │ ✓ Tuesday check-in          │ Language · English   [Generate summary] [Copy] [Save]
 Settings │ ✓ Design sync               │ We agreed to move the review to Friday.
~~~

**Choose A.** The action is at the start of the library scan, visible before search and still present while checking rows. With 12px header padding on each side, a 240px bordered pane has about 214px inside. Budget approximately 55px for Meetings, 88px for the labeled button, 34px for Refresh and two 8px gaps. At larger type, let the two-button group wrap intact below the heading and let the label wrap if needed. Keep Refresh last. B has more horizontal room and survives bulk selection, but spends a full row of height across both panes and puts the action at the far edge from the list. At narrow widths that extra row pushes playback farther down on every visit.

~~~text
Narrow · 800 CSS px · v2.11              Narrow · 800 CSS px · proposed A
 rail │ MEETINGS                    [↻]   rail │ MEETINGS         [Import audio] [↻]
      │ [Search meetings…            ]        │ [Search meetings…                ]
      │ ▸ Yesterday’s planning                │ 2 selected          [Clear] [Delete]
      │   Tuesday check-in                    │ ▸ Yesterday’s planning
      │   Design sync                         │ ✓ Tuesday check-in     ↕ list scroll
      ├───────────────────────────────        ├────────────────────────────────────
      │ Yesterday’s planning [✎] [Delete]     │ Yesterday’s planning [✎]   [Delete]
      │ Yesterday · 24:16                     │ Yesterday · 24:16
      │ [▶] 0:00 ─────────── 24:16 [vol]      │ [▶] 0:00 ─────────────── 24:16 [vol]
      │ [Transcript] [Summary]                │ [Transcript] [Summary]
      │ Language · English                    │ Language · English
      │ [Generate summary]  [Copy] [Save]     │ [Generate summary]    [Copy] [Save]
      │ We agreed to move the review…         │ We agreed to move the review…
~~~

The right sketch exercises the temporary bulk toolbar below search. The list scrolls inside its row and the History page scrolls to detail. Keep at least one meeting row visible if larger type makes the controls taller than the nominal row budget. Allow the sidebar row to grow just enough in that case. Keep rename, delete, seek, tabs and transcript actions in their existing order.

| History condition | Observed v2.11 text and location | Proposed treatment |
|---|---|---|
| Successful load, zero meetings | “No meetings recorded yet” in the list | “No meetings yet. Record a meeting or import an audio file.” The labeled header button is immediately above. Omit the redundant select-a-meeting prompt in the blank detail pane. |
| Library has meetings, zero search matches | “No matches for your search” in the list | Keep the query and any open detail. The search field remains available to edit or clear. |
| Library has meetings, no detail selection | “Select a meeting to view details” in `#meeting-details-empty` | Keep this prompt. Selecting a row opens its player. A load failure warrants a refresh/error message before making an empty-library claim. |

## From file to transcript · proposed interaction

1. From History, activate **Import audio**. Main opens the platform picker for **one local MP3, WAV or Opus**. Capture the invoker, selected ID, checked IDs, search, detail tab and scroll positions. Leave the underlying view mounted, including its player and any rename draft. A dismissed picker returns focus to the invoker. Selecting a file opens confirmation and starts no work.
2. Show the basename and plain-language copy below. The fields start with the active transcription preferences. Changes apply to this file. Engine comes first because it determines the available languages. For Whisper, show the saved model and offered languages/models from current policy. For Parakeet v2 show **English only** as static text. Changing back restores the draft Whisper choices. A retired selection requires an explicit replacement. Keep an unavailable saved engine visible with its reason directly under the field. For example, **Parakeet needs setup in Settings. Choose Whisper or cancel to set it up.** Disable submission until the chosen combination is ready. Apply the actual host readiness and repair gates, including required local model setup. Announce changed field guidance. Never silently switch engine or start a download.
3. **Import and transcribe** freezes engine, language and model for this attempt. Focus **Cancel import** during conversion. Show **Preparing audio…** until the playable copy is decoded, then **Saving to History…** when commit begins. During commit, disable cancellation and focus the status heading programmatically. Keep that phase brief and settle its actual outcome before closing. Use one polite status region, with no invented percentage or queue ETA.
4. Once main confirms the saved meeting and admission, replace the dialog body with the result below. Focus **Open meeting**. This is the first success message. **Done** or Escape returns to the original History context. **Open meeting** explicitly selects the saved ID, opens Transcript and focuses Play after the detail mounts. Reveal the row, clearing a search only if it excludes this meeting. Preserve other checked IDs and exclude the new row from bulk selection. Respect an unsaved rename through the existing cancel/save interaction before switching detail.
5. Playback works immediately from the saved copy. While pending, put **Awaiting transcription** in the transcript panel and offer **View in Activity**, which opens Record, scrolls to the matching row and focuses its title. When the transcript is saved, update the selected transcript in place without resetting playback, seek, scroll or keyboard focus. If the user has moved elsewhere, leave them there. From Activity, **Open in History** on Ready opens the same ID and Transcript. Use the usual eligible **Generate summary** button for a later explicit request.

~~~text
After the picker · modal over yesterday’s selected meeting
┌──────────────────────────────────────────────────────┐
│ Import audio                                         │
├──────────────────────────────────────────────────────┤
│ Project review.opus                                  │ ← full basename can wrap
│ AvaNevis saves a playable copy in History and        │
│ transcribes it on this device. Your original stays   │
│ where it is.                                         │
│ Engine          [Whisper                         ▾]  │ ← initial focus
│ Language        [English                         ▾]  │
│ Whisper model   [Small                           ▾]  │
│                                                      │
│                  [Cancel]   [Import and transcribe]  │
└──────────────────────────────────────────────────────┘

Same dialog · conversion                  Same dialog · confirmed save and queue
 Import audio                              Imported into History
 Project review.opus                       Project review
 Preparing audio…                          Transcription queued. You can play the audio now.
                         [Cancel import]                         [Done] [Open meeting]

Open meeting · History detail              View in Activity · Record, existing controls above
 Project review [✎]            [Delete]    Activity
 Today · 18:42                             Yesterday’s planning   TRANSCRIBING   24:16
 [▶] 0:00 ───────────── 18:42 [vol]                                  [Rename] [Delete] [Cancel]
 [Transcript] [Summary]                    Project review         QUEUED         18:42
 Awaiting transcription   [View in Activity]                         [Rename] [Delete] [Cancel]
                                           …later, same row…
                                           Project review         READY          18:42
                                                               [Rename] [Delete] [Open in History]
~~~

The duration in the sketch is illustrative. Display the measured duration. If the job has already advanced, replace “Transcription queued” with the actual phase or “Transcript ready.” An update after the result appears changes its text only. Escape and Cancel use the same pre-commit cleanup path. While the dialog is open, contain Tab and Shift+Tab among enabled controls and make the background inert. Give the status heading a focus target even when every button is disabled. At large type the dialog body scrolls and the footer actions wrap in reading order.

## State and action contract · proposal

| Event or boundary | What the user sees and can do | Durable result and focus |
|---|---|---|
| Picker or confirmation cancelled | Return directly to the same History view. | No meeting or queue job. Restore invoking button, query, open title, tab, checkbox set and scroll. |
| Long conversion, cancel or quit | **Preparing audio…** and **Cancel import**. During cancellation show **Cancelling import…** until acknowledged. Allow one conversion at a time. | Main owns the chosen input and a unique staging directory under recordings. Stop decoding, drain and remove staging before reporting cancellation. Return focus to Import audio. Restart cleans abandoned staging. |
| Invalid, empty or undecodable audio | **AvaNevis couldn’t read audio from this file. Choose another MP3, WAV or Opus file.** Offer **Choose another file** and Cancel. | Confirm with the bundled decoder. Remove partial output. Focus recovery action. A replacement returns to confirmation. |
| Out of space before commit | **There isn’t enough space to save this recording. Free up space, then try again.** Offer **Try again** and Cancel. | Show the filename and retained settings. Retry conversion from the main-owned source handle if still valid, otherwise reopen the picker. No partial meeting appears on refresh or after restart. |
| Save in progress, including late cancel or quit | **Saving to History…**. Close/quit waits for settlement. | The commit includes playable audio, placeholder, title, measured duration and pending request with attempt ID. Reconcile any interrupted promotion under the metadata lock before scan. |
| Saved, admission delayed or failed | **Saved in History. Transcription hasn’t started.** Offer **Open meeting**. Show the existing resume/retry action according to durable status. | Resolve the saved ID before suggesting recovery. Reuse the meeting and reconcile the attempt. A second import would create an unwanted duplicate. |
| Queue already busy | Result shows **Transcription queued. You can play the audio now.** Activity shows the existing active job and this meeting’s Queued row. | Use normal FIFO and sequenced updates. Keep Record available per its existing gates. If work is waiting for GPU/model setup or saving the transcript, use Activity’s actual phase label. |
| Cancel after enqueue or fail during transcription | Use Activity **Cancel** and wait for its acknowledgement. Session chip reads **Cancelled** or **Failed**. Offer **Retry** or **Open in History**. History can show its existing failed status with the cancellation/error reason in detail. | Keep the playable copy. Retry Transcription uses the same ID and saved selection. Keep the explicit **Retry with Whisper…** route where eligible. On rerender restore focus within the same row. |
| Restart, retry or delete | Find **Project review** by title in History. Pending eligible requests resume through existing post-scan logic and the pending-work banner when applicable. Completed meetings reopen with Play and Transcript. | Deduplicate jobs by meeting/attempt. Failed or cancelled attempts remain available for explicit retry. Same-name imports have separate IDs, dates and durations. Deleting either meeting removes only its app-owned files. |

Read the input without modifying it, including for Opus. Decode only the selected local audio into a verified app-owned Opus copy. Only staged files may reach the existing add path, which can remove its inputs after commit. Playback and restart must work even after the user moves the original.

## Ranked visual cleanup

| Rank | Observed friction | Working precedent | Smallest correction and scope |
|---|---|---|---|
| 1 · prerequisite | In History, clicking a meeting opens it, but the list’s keyboard-focusable checkbox only toggles bulk selection. Its opacity can stay zero on focus. A keyboard user needs a reliable route back to a completed import. | Record Activity has a native **Open in History** button. History’s rename pencil reveals itself on `:focus-visible`. | Make the title area a native, text-styled open button with the full title as its accessible name. Keep checkbox and Delete as siblings. Reveal the checkbox on row `:focus-within` and name it for its meeting. Scope to `.meeting-item` to protect Activity and the global button treatment. |
| 2 · prerequisite at small widths | In Record Activity, `.activity-row-title` ellipsizes while `.activity-row-actions` refuses to shrink. Rename/Delete/Cancel can consume nearly all the width. | History’s detail toolbar moves its actions onto their own line when its container narrows. | Let Activity actions move below title and status when the row cannot fit them together. Keep button order and full names. Scope wrapping to Activity rows, including Ready and failed rows. |
| 3 · independent polish | Refresh animates through a full turn on hover even before a refresh is requested. Both History and the shared device strip use the rule. | Settings controls and History’s Play button use a color change on hover. | Use the existing color hover and reserve rotation for `.spinning`. Check both Refresh controls and keep the reduced-motion override. |

## File-level build map

| Files | Responsibility |
|---|---|
| `src/renderer/index.html`, `src/renderer/styles.css` | Place the header action and named modal, form fields, status, error and result actions. Reuse the system tokens, responsive detail layout and focus ring. Bound dialog height and allow header, list and action-group reflow. |
| `src/renderer/app.js`, `src/renderer/transcription-engine-helpers.js`, `src/renderer/transcription-activity-helpers.js` | Wire picker/draft/result, snapshot per-file settings, preserve History context, support keyboard row opening and handle focus across asynchronous rerenders. Reuse Activity’s queue projection, durable ID and completion behavior. |
| `src/preload.js`, `src/main.js`, new `src/main/audio-import-service.js` | Narrow picker, start, cancel and phase interfaces. Main owns source path, opaque operation identity, bundled decoder, staging cleanup and quit settlement. Renderer receives the basename and operation/result state. |
| `src/main/transcription-service.js`, `src/main/meeting-manager-client.js`, `backend/meeting_manager.py`, `backend/meetings/scan_import.py` | Use main-owned finalizeRecordingTranscription with the staged copy and frozen request. Return a committed meeting ID independently of queue outcome. Exercise the transaction and add interrupted-commit recovery if scan can expose partial final files. |
| `tests/js/history-detail-interaction.test.js`, `tests/js/transcription-activity-helpers.test.js`, `tests/js/transcription-service-admission.test.js`, `tests/js/ipc-contract-snapshot.test.js`, `tests/python/test_meeting_manager.py` | Cover focus/context restoration, queue snapshots racing commit, cancel/retry and resume by ID. Add focused import coverage using real encoded inputs and interruption during final-file promotion. Update the [IPC](../../development/contracts/ipc.md), [persistence](../../development/contracts/meeting-persistence.md) and [local AI](../../development/contracts/local-ai.md) contracts for the shipped behavior. |

## Visual acceptance · build-session checks awaiting a running app

| Exercise | Pass condition |
|---|---|
| Open with an existing file; revisit yesterday | Starting on Record, a first-time user finds the empty Activity hint or History rail destination. In populated History, Import audio is legible beside Refresh. Yesterday’s title still opens detail in one activation and Play is in the same place. |
| Default, narrow and zoomed windows | Compare v2.11 and proposed views at 1200 × 800 native size and 800 CSS px. Cross 901/900 and 641/640 CSS px, then test 200% zoom and enlarged text. Check the 759/519px detail-container transitions. Search, Refresh, at least one list item, volume where supported, dialog buttons and transcript actions remain reachable without horizontal page scrolling. |
| Long names and bulk selection | Use a long unbroken Unicode basename ending in .opus and two long titles with the same prefix. Confirmation wraps through the extension. In detail expose the full title on focus or expansion. The list’s ellipsis preserves room for checkbox and Delete. Check two rows while a third is open. Dismissing the picker, cancelling conversion and choosing Done each restore that context. |
| Keyboard and motion | Use keyboard alone from the rail through picker, form, error recovery, Open meeting, Play, Transcript and Activity. Shift+Tab wraps in the modal. Escape before commit restores the invoker. No hidden control receives focus. With reduced motion, all phases and completion remain readable with stationary controls. |
| Busy queue and playback | Import behind a running recording transcription. Check one row per meeting, current phase, usable buttons and working recording controls. Play before Ready. Transcript arrival keeps playhead and focus. Cancel one attempt and retry from the saved copy. Generate summary remains a separate user action. |
| Save boundary and reopening | Use real MP3, WAV and Opus. Interrupt conversion, interrupt commit, exhaust disk and restart after commit before admission. Check History after scan, source byte identity, absence of partial entries and exactly one resumable saved meeting after commit. Move the original, restart, search the stem, open the result by keyboard and play it. Repeat on packaged target hosts, including the Windows pending-banner transition. |

The smallest release slice is the labeled History action, an empty-Activity pointer, one picker and one stateful dialog feeding the existing meeting player and queue. The two prerequisite control fixes make that path usable by keyboard and at narrow widths. The Refresh animation change can ship separately.
