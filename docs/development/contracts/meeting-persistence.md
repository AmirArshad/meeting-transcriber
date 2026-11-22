# Meeting persistence contract

`meeting_manager.py` retains instance seams, FileLock cross-process locking, atomic temp plus `os.replace`, transactional add-before-source-delete, corrupt backup naming, suffixed-ID scan/import preservation, recorder-temp recovery before scans, and Windows-tolerant delete retry. Saved Markdown is the transcript source of truth; rename changes metadata by ID and never files.

### Meeting metadata persistence

Changing `backend/meeting_manager.py` must preserve: `FileLock` cross-process locking (`meetings.json.lock` for atomic metadata transactions, plus separate `scan_recovery.lock` serialized outside `meetings.json.lock` for slow recorder-temp recovery and filesystem/duration probing so `list_meetings`, `update_meeting`, `add_meeting`, and `delete_meeting` never wait behind recovery scans); atomic temp-file + `os.replace()` writes; transactional add that removes originals only **after** metadata is saved; corrupt-metadata backups named `meetings.corrupt.*.json`; scan/import preservation of suffixed IDs like `meeting_20260107_104555_1`; and recorder-temp recovery before selecting scannable `.opus`/`.wav` files (never import `.pcm.tmp` or legacy `*.temp.wav` as meetings). Delete must tolerate Windows file locking with retry and clean up `{stem}.captions.json` alongside `.md`/audio.

Each recording record supports an optional canonical `tag` field (`VALID_RECORDING_TAGS` in `backend/meetings/normalization.py`: `meeting`, `appointment`, `call`, `interview`, `lecture`, `podcast`, `video`, `voice-note`, `brainstorm`, `music`, `other`). Legacy entries without `tag` remain readable and normalize lazily to `None` on read without forced file migration; clearing `tag` (`None` or `""`) sets `tag = None` and invalid values are rejected. Updating `tag` is non-destructive and never mutates audio/transcript paths, `sourceTranscriptHash`, or `summaryStale`. Completed summary metadata (`ai.summary` in `backend/meetings/paths.py`) independently persists the canonical summary format slug in `template` alongside the recording's `tag` at generation time and `templateVersion`, so choosing or overriding a summary format never mutates `meeting.tag`.

Schema-v1 caption timing sidecars store pre-merge fine-grained millisecond cues (and optional word timings) bound to the committed transcript via LF-normalized `sourceTranscriptHash` (`sha256`). Legacy meetings can read `{audioStem}.captions.json`. Transcription attempts prepare `{audioStem}.transcript-{attemptId}.captions.json` alongside their new Markdown and commit both paths in one atomic metadata write. The previous pair remains readable until that write succeeds. Successful commits clean up superseded files, and meeting deletion removes both referenced and legacy captions. Saved Markdown remains the human-readable source of truth. Stale sidecars are rejected so subtitle exporters never fabricate millisecond timings.

Speaker names live in `ai.diarization.speakerNames`, keyed by `Speaker 1` through `Speaker 99` or a two-digit `SPEAKER_XX` ID. A patch merges individual names under the metadata lock. An empty sanitized value clears the name. The same lock checks the expected transcript hash and, when supplied, the committed attempt ID before saving the patch. Saving names preserves the Markdown and all sidecars. Successful re-transcription clears the overlay with the previous diarization metadata. Failed attempts retain it. Public meeting responses expose a derived `speakerNamesHash`. History Search and Chat use it to refresh indexed speaker labels while keeping the original citation timestamps and transcript hash.

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

### Derived History Search Index & Chat Thread Persistence (`userData` only)

- **Search cache (`userData/search/history-index.sqlite`):** Disposable SQLite FTS5 cache (`INDEX_SCHEMA_VERSION = "3"`, `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `unicode61 remove_diacritics 2`, storing `tag` and `speaker_names_hash` on `indexed_meetings`) rebuilt atomically via temp file + `os.replace()` whenever missing, stale in schema, or unreadable (`sqlite3.DatabaseError`). `meetings.json`, `.md`, caption timing sidecars, and completed summary sidecars (with matching `sourceTranscriptHash` or legacy completed summaries lacking `sourceTranscriptHash`) remain the sole source of truth; hard deletes remove corresponding index rows immediately on sync so deleted recordings never surface in search or Q&A.
- **Chat threads (`userData/chat/threads.json`):** Owned by main-process `src/main/chat-thread-store.js` with serialized mutations, same-directory temp file + `fsync` + atomic rename, and corrupt-file quarantine (`threads.corrupt.<timestamp>.json`). Thread scopes accept canonical types `'all'`, `'selected_meetings'`, and `'none'` (General chat), while corrupt saved scopes fail closed to `{ type: 'selected_meetings', meetingIds: [] }`. Assistant messages persist `chatMode` (`'general'` / `'grounded'`), grounded `retrievalMode` (`'direct_full'` / `'overview'` / `'targeted'`), and optional citation `passageKey` metadata. Deleting a recording leaves historical chat messages intact while citation clicks verify live availability and show a non-blocking toast (`"This recording is no longer in History."`) if missing.

### Output & naming boundary

- Default generated titles use `Recording YYYY-MM-DD HH:MM` (renderer helpers recognize both `Recording` and legacy `Meeting` prefixes as default titles); transcript Markdown begins with `# Audio Transcript`, and summary Markdown begins with `# Summary` (localized equivalents in `backend/summaries/language_labels.py`).
- On-disk storage (`meetings.json`, `meeting_<id>.*`, `meetings.corrupt.*.json`) and `backend/meeting_manager.py` APIs intentionally retain legacy `meeting` naming until a dedicated refactor.
