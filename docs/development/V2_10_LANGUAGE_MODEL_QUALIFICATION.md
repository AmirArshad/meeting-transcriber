# v2.10 Whisper Large v3 functional results

## 2026-09-30 — Windows smoke

Scope follows the September 30 update in `todo.md`: identity, explicit download,
offline cache reuse and real transcription. No performance/memory studies or
per-OS qualification campaign were run.

- Workspace implementation atop `a107a10`; app package version remains 2.9.0
  pending the separate release-version change. Dev Python backend, not a packaged
  app or renderer/hardware recording acceptance run.
- Windows 11 Pro x64, build 26300; NVIDIA GeForce RTX 4070; Python 3.11.9,
  faster-whisper 1.2.1, CTranslate2 4.8.1. No Python runtime dependency changes.
- The installed dependency maps both `large` and `large-v3` to
  `Systran/faster-whisper-large-v3`. Explicit
  `python -m transcription.faster_whisper_transcriber --preload --model large-v3 --language en --device cuda`
  downloaded into the normal Whisper user cache and exited 0. Preload is the
  existing download operation; model weights remain outside the repository.
- Downloaded revision: `edaa852ec7e145841d8ffdb056a99866b5f0a478`.
  `model.bin` SHA-256:
  `69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1`.
- Fixture: `tests/fixtures/speakrs-two-speaker-16k.wav`, 14.2245 seconds of locally
  generated English speech (provenance in the fixtures README). SHA-256:
  `1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`.
- With `AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1` and `HF_HUB_OFFLINE=1`,
  `TranscriberService(model_size='large-v3', language='en', device='cuda')`
  produced nonempty text and one merged timestamped segment. No Markdown was
  written beside the fixture (`save_markdown=False`).
- `guided_transcription.create_transcriber(backend='faster', model_size='large', language='en', device='cuda')`
  resolved to v3, reused the same cache offline, and
  `transcribe_speaker_windows` produced a nonempty labeled segment from one
  whole-fixture window extracted by ffmpeg. An unrelated `HF_HUB_CACHE` was
  present; `AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR` kept Whisper in its own cache.
  Both paths reported `cuda` / `float16`. This checks guided Whisper window
  execution, not speaker detection or the complete guided service lifecycle.

## Implementation and regression coverage

Small remains the default. Record and explicit Whisper retry offer **Large (v3)**
with canonical `large-v3` payloads. Saved `large` preferences hydrate v3 rather
than reverting to Small; persisted meeting/queue selections are not migrated.
Both backend aliases share cache and lock identity. Unknown MLX model IDs fail
instead of falling back to Base.

Ordinary/guided compute now forbids implicit downloads even after cache loss;
explicit preload remains online-capable and resumable. Existing runtime
admission, queue, cancellation, quit, guarded persistence and fallback machinery
remain in place. Regression coverage checks v2/turbo/substring cache rejection,
empty-file completeness, alias preload exclusion, parked cancellation/retry,
offline compute environments, preference restart, guided backend construction,
IPC/facade contracts and existing recording/output recovery.

The first test runs exposed existing unreferenced-timer test harness failures in
one compute timeout and two Linux CUDA timeout cases. Test-scoped keepalive
handles now let those assertions settle; production timers were not changed.

Validation (exit 0): focused JS policy/cache/service/IPC/queue/engine regressions
241 passed, 1 skipped; focused Python transcriber/guided regressions 79 passed;
Linux CUDA service regressions 29 passed. Final `npm run test:all`: JS 1,062
passed, 4 skipped, no failures/cancellations; Python 734 passed, 8 skipped;
JS and Python syntax checks passed. The skips retain existing platform/tool
conditions. Final diff whitespace check also passed.

No accuracy improvement, speed advantage, memory suitability, packaged
acceptance, macOS inference or Linux inference is claimed from this short smoke.

## Follow-up CI repair — 2026-09-30

The preceding GitHub Actions run `36705696034` passed tests/builds but failed
npm audits. Existing overrides pinned vulnerable brace-expansion, fast-uri and
undici releases. Patch-only overrides now use brace-expansion 1.1.21 / 2.1.7 /
5.0.12, fast-uri 3.1.8 and undici 6.28.1 / 7.29.1, with a regenerated lockfile.
Electron and Python versions are unchanged. Clean `npm ci`, zero-vulnerability
`npm audit --audit-level=high`, and a fresh `test:all` passed with the same counts
above. Windows `npm run build:dir` and packaged Speakrs/layout verification also
passed; this is build verification, not packaged Large inference acceptance.
The first local build needed the Windows PowerShell directory added to this
session's PATH; no machine configuration or source workaround was committed.
