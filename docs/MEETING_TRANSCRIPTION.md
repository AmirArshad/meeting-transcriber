# Meeting History And Transcript Storage

This document describes what gets saved after a recording and how Meeting Transcriber recovers existing meeting data.

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

Refreshing history triggers a filesystem scan for orphaned recordings that are not yet in `meetings.json`.

The recovery scan now:

- prefers one audio candidate per filename stem
- skips duplicates already represented in metadata
- preserves suffixed meeting IDs like `meeting_20260107_104555_1`
- prefers the healthy `.wav` fallback if both `.opus` and `.wav` exist for the same recording stem

That last rule matters when Opus compression failed but left behind a bad `.opus` file before the recorder fell back to `.wav`.

## Metadata Safety

`backend/meeting_manager.py` protects `meetings.json` with:

- `FileLock`-based cross-process locking
- atomic temp-file writes plus `os.replace()`
- duplicate-ID cleanup on load
- corrupt-file backups named `meetings.corrupt.*.json`

## Delete Behavior

Deleting a meeting removes:

- the persisted audio file
- the persisted transcript file
- the metadata entry

The renderer also clears the audio player first to reduce Windows file-lock issues.

## Current Limitations

- The renderer still has a TODO for saving/exporting transcripts through a file dialog.
- Search/filter tooling in the history view is still minimal.
- Manual filesystem edits inside the recordings directory can still confuse recovery if files are renamed arbitrarily.

## If You Need To Recover Meetings Manually

Keep matching audio and transcript files together in the recordings directory.

The scan/import flow expects:

- `meeting_<id>.<opus|wav>`
- `meeting_<id>.md`

Then use the history refresh action so the app can re-scan the recordings directory.
