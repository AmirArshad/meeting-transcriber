# Meeting History And Transcript Storage

This document describes what gets saved after a recording and how AvaNevis recovers existing meeting data.

## What Gets Saved

After a successful recording/transcription flow, the app stores:

- an audio file for the meeting (`.opus` when compression succeeds, `.wav` fallback otherwise)
- a markdown transcript (`.md`)
- metadata in `meetings.json`

Meeting data lives in Electron's `userData` recordings directory, not in the repository.

## History View Behavior

The renderer keeps the history list responsive by separating metadata display from transcript loading:

- selecting a meeting shows the details panel immediately
- transcript text loads asynchronously in the background
- a race guard prevents a late transcript load from overwriting a newer selection

## Transcript Loading Rules

When loading a meeting by ID, the backend now prefers:

1. the transcript markdown file on disk
2. legacy inline transcript text stored in older metadata records
3. an empty transcript if neither exists

That preserves transcript access for older meetings whose `.md` file is missing but whose metadata still contains inline transcript text.

## Scan / Import Recovery

The app rescans the recordings folder on launch and when you explicitly refresh history. Listing or searching meetings does not rescan the filesystem on every load (that keeps large libraries responsive).

The scan looks for orphaned recordings that are not yet in `meetings.json`.

The recovery scan now:

- prefers one audio candidate per filename stem
- skips duplicates already represented in metadata
- preserves suffixed meeting IDs like `meeting_20260107_104555_1`
- prefers the healthy `.wav` fallback if both `.opus` and `.wav` exist for the same recording stem
- recovers or cleans orphan recorder temps (`.pcm.tmp`) before selecting scannable audio; never imports `.pcm.tmp`, legacy `*.temp.wav`, or `{stem}.capture/` spool files as meetings

That Opus/WAV preference matters when Opus compression failed but left behind a bad `.opus` file before the recorder fell back to `.wav`.

## Interrupted Capture Recovery (v2.5.0+)

If the app or recorder process dies mid-recording, durable `{stem}.capture/` track spools may remain on disk. On the next launch AvaNevis discovers those sessions asynchronously (after the first window paints) and offers:

- **Recover Now** — finalize the capture into meeting audio, then run the normal scan/import path so the meeting appears in History
- **Later** — dismiss the prompt; a banner keeps the deferred count/disk estimate visible; recovery remains available next launch

Recovery never auto-runs, never deletes capture files on dismiss or failure, and shares one maintenance gate with scan/start so an active recording always wins. Failed recoveries keep all capture files and offer **Retry**.

## Metadata Safety

`backend/meeting_manager.py` protects `meetings.json` with:

- `FileLock`-based cross-process locking
- atomic temp-file writes plus `os.replace()`
- duplicate-ID cleanup on load
- corrupt-file backups named `meetings.corrupt.*.json`
- path guards: meeting audio, transcript, and AI sidecar paths must stay under the recordings directory; symlinks are rejected

The Electron main process applies the same recordings-directory rules before spawning Python for meeting mutations and local AI work. Persisted `ai.*.error` fields are sanitized so tokens and other secrets do not land in `meetings.json`.

## Delete Behavior

Deleting a meeting removes:

- the persisted audio file
- the persisted transcript file
- the metadata entry

The renderer also clears the audio player first to reduce Windows file-lock issues.

## Renaming Meetings

Meetings can be renamed inline from both the history detail view and the post-recording view:

- Click the pencil icon next to the title, edit, then press Enter or click Save.
- Esc cancels.
- The rename is persisted via the `update-meeting` IPC, which calls `MeetingManager.update_meeting(meeting_id, title=...)`.
- Filenames stay anchored to the meeting ID; only the `title` field in `meetings.json` changes. Existing audio and transcript files are not moved or rewritten.

## Saving / Exporting Transcripts

Transcripts can be exported to disk via Electron's native save dialog:

- Available from the history detail view (Save button next to the transcript header) and from the post-recording view (Save Transcript button).
- The default filename is derived from the meeting title with filesystem-unsafe characters sanitized.
- File-type filters: Markdown (`.md`), Plain Text (`.txt`), All Files.
- Wired through the `save-transcript-as` IPC, which uses `dialog.showSaveDialog` and writes via `fs.promises.writeFile`. The raw `.md` content from disk is preserved as the export source so the user always gets the original Markdown formatting.

## Current Limitations

- Search/filter tooling in the history view is functional (sidebar text filter, multi-select with bulk delete) but does not yet support semantic search or full-text indexing.
- Manual filesystem edits inside the recordings directory can still confuse recovery if files are renamed arbitrarily.

## If You Need To Recover Meetings Manually

Keep matching audio and transcript files together in the recordings directory.

The scan/import flow expects:

- `meeting_<id>.<opus|wav>`
- `meeting_<id>.md`

Then use the history refresh action so the app can re-scan the recordings directory.
