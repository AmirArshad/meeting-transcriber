# Local AI contract

No cloud transcription, diarization, summaries, telemetry, or background downloads. Pyannote uses only the user's safeStorage-protected token: never log, proxy, persist, or pass it except via stdin; clear all HF token environment variables and set `HF_TOKEN_PATH` to `os.devNull`, never an empty string. Speakrs and Pyannote are exclusive; Linux permits Speakrs only, CUDA-only, with no CPU fallback.

Catalogs own model refs, URLs, names, checksums, and runtime pins. Downloads are HTTPS and explicitly host-allowlisted; archives are hash-checked and traversal-guarded. Setup/validate full-hash catalog pins, compute rehashes changed fingerprints, and neither trusts user-writable `install.json`. Summary sidecars are never removed after metadata commit.

One compute queue serializes transcription, diarization, guided transcription, and generation. Preload and GPU runtime work admit between jobs through the resource queue. Preserve timeout termination/settlement, quit rejection, actual-device metadata, cache-completeness parity across JS/Python, offline-only behavior for complete caches, and user-triggered-only summary setup/generation.
