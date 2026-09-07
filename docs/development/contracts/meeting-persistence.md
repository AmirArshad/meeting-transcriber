# Meeting persistence contract

`meeting_manager.py` retains instance seams, FileLock cross-process locking, atomic temp plus `os.replace`, transactional add-before-source-delete, corrupt backup naming, suffixed-ID scan/import preservation, recorder-temp recovery before scans, and Windows-tolerant delete retry. Saved Markdown is the transcript source of truth; rename changes metadata by ID and never files.

### Meeting metadata persistence

Changing `backend/meeting_manager.py` must preserve: `FileLock` cross-process locking; atomic temp-file + `os.replace()` writes; transactional add that removes originals only **after** metadata is saved; corrupt-metadata backups named `meetings.corrupt.*.json`; scan/import preservation of suffixed IDs like `meeting_20260107_104555_1`; and recorder-temp recovery before selecting scannable `.opus`/`.wav` files (never import `.pcm.tmp` or legacy `*.temp.wav` as meetings). Delete must tolerate Windows file locking with retry.

Public methods stay instance methods — the tests monkeypatch them as seams.
