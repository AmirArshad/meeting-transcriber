# Meeting persistence contract

`meeting_manager.py` retains instance seams, FileLock cross-process locking, atomic temp plus `os.replace`, transactional add-before-source-delete, corrupt backup naming, suffixed-ID scan/import preservation, recorder-temp recovery before scans, and Windows-tolerant delete retry. Saved Markdown is the transcript source of truth; rename changes metadata by ID and never files.
