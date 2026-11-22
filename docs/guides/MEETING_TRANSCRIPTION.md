# Recording History And Transcript Storage

This document describes what gets saved after a recording and how AvaNevis recovers existing recording data. (On-disk filenames such as `meetings.json` and `meeting_<id>.*`, as well as internal `meeting_manager.py` / `update-meeting` APIs, keep legacy `meeting` naming.)

## What Gets Saved

After a successful recording or audio import flow, the app stores:

- an audio file for the recording (`.opus` when compression succeeds, `.wav` fallback otherwise)
- a markdown transcript (`.md`)
- metadata in `meetings.json`

Recording data lives in Electron's `userData` recordings directory, not in the repository.

## History View Behavior

The renderer keeps the history list responsive by separating metadata display from transcript loading:

- selecting a recording shows the details panel immediately
- transcript text loads asynchronously in the background
- a race guard prevents a late transcript load from overwriting a newer selection

## Transcript Loading Rules

When loading a recording by ID, the backend prefers:

1. the transcript markdown file on disk
2. legacy inline transcript text stored in older metadata records
3. an empty transcript if neither exists

That preserves transcript access for older recordings whose `.md` file is missing but whose metadata still contains inline transcript text.

## Scan / Import Recovery

The app rescans the recordings folder on launch and when you explicitly refresh history. Listing or searching recordings does not rescan the filesystem on every load (that keeps large libraries responsive).

The scan looks for orphaned recordings that are not yet in `meetings.json`.

The recovery scan:

- prefers one audio candidate per filename stem
- skips duplicates already represented in metadata
- preserves suffixed IDs like `meeting_20260107_104555_1`
- prefers the healthy `.wav` fallback if both `.opus` and `.wav` exist for the same recording stem
- recovers or cleans orphan recorder temps (`.pcm.tmp`) before selecting scannable audio; never imports `.pcm.tmp`, legacy `*.temp.wav`, or `{stem}.capture/` spool files as recordings

That Opus/WAV preference matters when Opus compression failed but left behind a bad `.opus` file before the recorder fell back to `.wav`.

## Interrupted Capture Recovery (v2.5.0+)

If the app or recorder process dies mid-recording, durable `{stem}.capture/` track spools may remain on disk. On the next launch AvaNevis discovers those sessions asynchronously (after the first window paints) and offers:

- **Recover Now** — finalize the capture into recording audio, then run the normal scan/import path so the recording appears in History
- **Later** — dismiss the prompt; a banner keeps the deferred count/disk estimate visible; recovery remains available next launch

From v2.10, recovered recordings retain their captured engine/model/language
selection. A durable recovery handoff survives restart until meeting metadata
acknowledges that selection, including when finalization succeeds but its process
response is lost. An unavailable saved engine fails recoverably instead of
silently switching to another engine.

Recovery never auto-runs, never deletes capture files on dismiss or failure, and shares one maintenance gate with scan/start so an active recording always wins. Failed recoveries keep all capture files and offer **Retry**.

## Importing Local Audio

Use **Import audio** in History or the sidebar to choose one local WAV, MP3 or
Opus file. Confirm the engine and language, then start the import. AvaNevis
creates a playable copy in its own storage and queues transcription in Activity;
the original file stays in place. You can cancel preparation before the copy is
saved. After it is saved, use Activity to cancel or retry transcription without
deleting the imported audio. Summaries remain a separate user-triggered action.

## Metadata Safety

`backend/meeting_manager.py` protects `meetings.json` with:

- `FileLock`-based cross-process locking
- atomic temp-file writes plus `os.replace()`
- duplicate-ID cleanup on load
- corrupt-file backups named `meetings.corrupt.*.json`
- path guards: meeting audio, transcript, and AI sidecar paths must stay under the recordings directory; symlinks are rejected

The Electron main process applies the same recordings-directory rules before spawning Python for meeting mutations and local AI work. Persisted `ai.*.error` fields are sanitized so tokens and other secrets do not land in `meetings.json`.

## Delete Behavior

Deleting a recording removes:

- the persisted audio file
- the persisted transcript file
- any derived speaker, subtitle timing, and summary sidecars
- the metadata entry

The renderer also clears the audio player first to reduce Windows file-lock issues.

## Renaming Recordings

Recordings can be renamed inline from both the history detail view and Activity:

- Click the pencil icon next to the title, edit, then press Enter, click Save, or click away to save.
- Esc cancels.
- The rename is persisted via the `update-meeting` IPC, which calls `MeetingManager.update_meeting(meeting_id, title=...)`.
- Filenames stay anchored to the recording ID; only the `title` field in `meetings.json` changes. Existing audio and transcript files are not moved or rewritten.

## Saving / Exporting Transcripts

Transcripts can be exported to disk via Electron's native save dialog:

- Available from the history detail view (Export / Save button next to the transcript header).
- The default filename is derived from the recording title with filesystem-unsafe characters sanitized.
- Supported formats: Markdown (`.md`), Plain Text (`.txt`), SubRip Subtitles (`.srt`), and WebVTT Subtitles (`.vtt`).
- Wired through the `save-transcript-as` IPC, which uses `dialog.showSaveDialog` and writes via `fs.promises.writeFile`. The raw `.md` content from disk is preserved as the export source so the user always gets the original Markdown formatting.

## Transcript Retry And Derived Output (v2.10)

Failed transcription retries preserve the previous transcript and source audio.
A successful replacement clears obsolete speaker metadata. Newly generated
speaker sidecars carry the committed transcript hash; summaries use speaker text
only when that hash matches the current Markdown. Legacy or mismatched speaker
sidecars are not used as the source for new summaries.

## Recording Tags & Summary Formats (v3.1)

Recordings can carry an optional tag from 11 canonical types: **Meeting**, **Appointment**, **Phone / Support Call**, **Interview**, **Lecture / Study**, **Podcast**, **Video**, **Voice Note**, **Brainstorm**, **Music**, or **Other**.

- Assign or change a tag from **Record**, **Import audio**, **Activity**, the **History** detail header, or **Prepare summary** (when untagged).
- Filter the **History** list and **Chat** search scope by tag.
- Changing a tag updates metadata only (`meetings.json`) and never renames files or marks transcripts stale.
- Each tag selects a dedicated summary template when generating a summary (untagged recordings use the **Other** general format). If a recording already has a summary under an older tag, the Summary panel offers a non-blocking **Regenerate** banner without overwriting the existing summary.

## Speaker Naming (v3.1)

When speaker identification finds speakers (`Speaker 1`, `Speaker 2`, etc.):

- Use the inline **Speakers** bar above the History transcript—or the optional **Speaker names** section inside **Prepare summary**—to assign real names.
- Each speaker row includes a 1-line transcript quote and a timestamped play button so you can identify voices quickly before naming them.
- Saving names updates `ai.diarization.speakerNames` in metadata, refreshing History display, full-text search, Chat attribution, summaries, and `.md`/`.txt`/`.srt`/`.vtt` exports while keeping the underlying `.md` transcript file untouched.

## Current Limitations

- Local SQLite FTS5 full-text search and optional local Chat Q&A (with clickable timestamp citations) are supported, while semantic/embedding search is not implemented.
- Manual filesystem edits inside the recordings directory can still confuse recovery if files are renamed arbitrarily.

## If You Need To Recover Recordings Manually

Keep matching audio and transcript files together in the recordings directory.

The scan/import flow expects:

- `meeting_<id>.<opus|wav>`
- `meeting_<id>.md`

Then use the history refresh action so the app can re-scan the recordings directory.
