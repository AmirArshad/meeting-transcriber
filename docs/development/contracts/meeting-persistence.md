# Meeting persistence contract

`meeting_manager.py` retains instance seams, FileLock cross-process locking, atomic temp plus `os.replace`, transactional add-before-source-delete, corrupt backup naming, suffixed-ID scan/import preservation, recorder-temp recovery before scans, and Windows-tolerant delete retry. Saved Markdown is the transcript source of truth; rename changes metadata by ID and never files.

### Meeting metadata persistence

Changing `backend/meeting_manager.py` must preserve: `FileLock` cross-process locking (`meetings.json.lock` for atomic metadata transactions, plus separate `scan_recovery.lock` serialized outside `meetings.json.lock` for slow recorder-temp recovery and filesystem/duration probing so `list_meetings`, `update_meeting`, `add_meeting`, and `delete_meeting` never wait behind recovery scans); atomic temp-file + `os.replace()` writes; transactional add that removes originals only **after** metadata is saved; corrupt-metadata backups named `meetings.corrupt.*.json`; scan/import preservation of suffixed IDs like `meeting_20260107_104555_1`; and recorder-temp recovery before selecting scannable `.opus`/`.wav` files (never import `.pcm.tmp` or legacy `*.temp.wav` as meetings). Delete must tolerate Windows file locking with retry and clean up `{stem}.captions.json` alongside `.md`/audio.

Schema-v1 caption timing sidecars (`{stem}.captions.json`) store pre-merge fine-grained millisecond cues (and optional word timings) bound to the committed transcript via LF-normalized `sourceTranscriptHash` (`sha256`). Saved Markdown remains the human-readable source of truth; sidecars are written/replaced atomically with transcript commit, removed on delete or audio-only add, and ignored/rejected when stale so subtitle exporters never fabricate millisecond timings for edited or legacy transcripts.

Public methods stay instance methods — the tests monkeypatch them as seams.

### Local audio import commit

Main converts and verifies a user-selected source into a unique app-owned
`recordings/.audio-import-*/audio.opus` staging directory before passing it to
the ordinary add path. The source is never passed to the destructive add path.
For this staged import, the backend flushes both staged files before acquiring
the metadata lock, then creates a durable `.meeting-import-<id>` marker before
promoting the files by atomic rename. It retains the pending transcription
request and attempt guard in that same atomic metadata write. Metadata is the
commit point. Scan holds the metadata lock while reconciling markers and scanning:
uncommitted final files are removed, while a committed meeting and its files are
retained. If the metadata cannot be trusted, recovery preserves both the files
and markers. Abandoned staging cleanup must leave these root markers alone. A failed
cleanup leaves its marker for a later reconciliation; it must not expose a partial
import as a scanned meeting.
