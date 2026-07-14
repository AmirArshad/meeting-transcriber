# Dependabot PR triage (Phase 5)

> **Historical triage (2026-05-27).** The phased dependency-upgrade branch work and the “Close now” / “Defer” PR actions below are complete. For current dependency and release hygiene, use root `todo.md`. Keep this file as background for why pins and Dependabot ignores look the way they do.

Last reviewed: 2026-07-14 on branch `chore/dependency-hygiene` (Track A Windows pins + open Dependabot set #52–#58). Prior phased review: 2026-05-27.

## Current open set (2026-07-14)

| PR | Bump | Risk | Action | Why / validation |
|----|------|------|--------|------------------|
| #52 | filelock 3.29.0→3.29.7, certifi 2026.5.20→2026.6.17 | Low | **Absorbed** on `chore/dependency-hygiene` | Close Dependabot PR after hygiene PR merges. |
| #54 | protobuf 7.35.0→7.35.1 | Low | **Absorbed** on `chore/dependency-hygiene` | Close after hygiene PR merges. |
| #56 | regex 2026.5.9→2026.7.10 | Low | **Absorbed** on `chore/dependency-hygiene` | Close after hygiene PR merges. |
| #55 | adm-zip 0.5.17→0.6.0 | Medium | **Absorbed** on `chore/dependency-hygiene` | Security bump; AvaNevis uses `extractAllTo`. Close after hygiene PR merges. |
| #58 | ctranslate2 4.7.2→4.8.1 | Medium | **Defer** → dedicated Windows ML PR | Still CUDA 12 wheels; includes Whisper `align()` zero-div fix + security harden. Needs Windows CPU transcription + CUDA path if available; do not merge Dependabot branch raw. Official GPU target remains `nvidia-cublas-cu12` / `nvidia-cudnn-cu12`. |
| #53 | electron 42.2.0→43.1.0 | High | **Defer** | Nice-to-have (startup perf, Chromium security, macOS Notification APIs). No product blocker on 42.x; separate Win/mac packaged smoke required. Not a drive-by. |
| #57 | numpy 2.4.6→2.5.1 | High (broken) | **Closed 2026-07-14** | numpy 2.5.x requires **Python ≥3.12**; AvaNevis is Python **3.11**. CI fails install. Stay on `numpy==2.4.6` until a coordinated Python upgrade. |

### Track A — Windows `onnxruntime` / `tokenizers` / `av` (2026-07-14)

| Package | Role in AvaNevis graph | Verdict |
|---------|------------------------|---------|
| `onnxruntime` | Hard dep of `faster-whisper==1.2.1`; Silero VAD for `vad_filter=True` in `faster_whisper_transcriber.py` | **Keep pin** (`==1.26.0`). Removal → VAD/import failure. (macOS build prunes onnxruntime after pip; Windows must keep it.) |
| `tokenizers` | Hard dep of faster-whisper Whisper tokenization | **Keep pin** (`==0.23.1`). Removal → model/tokenize failure. |
| `av` (PyAV) | Hard dep of faster-whisper path-based audio decode | **Keep pin** (`==17.0.1`). Removal → decode failure on `transcribe(audio_path)`. Bundled ffmpeg does not replace this path. |

These are not “reproducibility-only” optional pins: pip declares them required, and AvaNevis hits all three at runtime. Explicit `==` pins stay for reproducible packaged builds / installer size control. Dev `requirements-windows.txt` may continue to leave them transitive under `faster-whisper>=1.0.0`.

Do **not** remove from packaged Windows without a full experiment: temp venv install without the three → `pip check` → `import faster_whisper` → short CPU transcription with `vad_filter=True`. Expect failure; do not ship that build.

Use this when closing or scheduling follow-up dependency work. **Do not merge Dependabot PRs blindly** into `master`; prefer a small follow-up PR with tests + smoke.

## Already closed on GitHub (superseded by phased work)

| PR | Title | Action |
|----|-------|--------|
| #2 | python-runtime-pins group (filelock, certifi, …) | Closed — absorbed in **Phase 1** |
| #3 | numpy 1.26.4 → 2.x | Closed — absorbed in **Phase 4** (`numpy==2.4.6`) |
| #4 | scipy 1.11.4 → 1.17.1 | Closed — absorbed in **Phase 4** (macOS build pin) |
| #5 | soxr 0.3.7 → 1.1.0 | Closed — absorbed in **Phase 2** |
| #6 | more-itertools | Closed — absorbed in **Phase 1** (macOS) |
| #7 | click | Closed — absorbed in **Phase 1** |
| #8 | idna | Closed — absorbed in **Phase 1** |
| #9 | pytest ≥9 | Closed — absorbed in **Phase 3** |

No further action on #2–#9 unless reopened by Dependabot.

## Close now (superseded by this branch)

These are **open** but already match pins on `chore/phased-dependency-upgrades`:

| PR | Package | Branch pin | Close comment |
|----|---------|------------|---------------|
| #12 | ctranslate2 4.7.1 → 4.7.2 | `requirements-windows-build.txt` → **4.7.2** | Superseded by Phase 4 on `chore/phased-dependency-upgrades` |
| #20 | python-runtime-pins group | Phase 1 certifi/idna/click/filelock bumps | Superseded by Phase 1 on `chore/phased-dependency-upgrades` |

```bash
gh pr close 12 --comment "Superseded by chore/phased-dependency-upgrades (Phase 4: ctranslate2==4.7.2)."
gh pr close 20 --comment "Superseded by chore/phased-dependency-upgrades (Phase 1 runtime pins)."
```

## Defer — do not merge standalone

| PR | Package | Risk | Recommendation |
|----|---------|------|----------------|
| #19 | tiktoken 0.3.3 → 0.13.0 | **High** — `lightning-whisper-mlx==0.0.10` pins `tiktoken==0.3.3` | **Close** with comment; keep `.github/dependabot.yml` ignore on `tiktoken` |
| #18 | pyobjc ScreenCaptureKit 10 → 12 | **High** — macOS capture; mixed pyobjc 10/12 pins today | **Close**; plan coordinated pyobjc bump + `build:mac:dir` smoke |
| #15 | pyobjc CoreAudio 10 → 12 | **High** — same as above | **Close**; same coordinated macOS PR |

```bash
gh pr close 19 --comment "Declined: lightning-whisper-mlx==0.0.10 requires tiktoken==0.3.3. Tracked via dependabot ignore."
gh pr close 18 --comment "Declined: coordinate all pyobjc-framework pins (10→12) in one macOS-tested change."
gh pr close 15 --comment "Declined: coordinate all pyobjc-framework pins (10→12) in one macOS-tested change."
```

## Incorporated on `chore/phased-dependency-upgrades` (close Dependabot PRs)

| PR | Package | Branch pin |
|----|---------|------------|
| #17 | pyaudiowpatch 0.2.12.4 → 0.2.12.8 | `requirements-windows-build.txt`, dev `>=0.2.12.8` |
| #14 | protobuf 7.34.1 → 7.35.0 | `requirements-windows-build.txt` |
| #16 | setuptools 81 → 82 (mac) | Windows **82.0.1**; macOS **81.0.0** (`torch==2.12.0` requires `setuptools<82`) |
| #21 | huggingface-hub 1.15.0 → 1.16.1 | both `requirements-*-build.txt` |
| #13 | mpmath 1.3.0 → 1.4.1 | Deferred on macOS (`sympy==1.14.0` requires `mpmath<1.4`) |

Close with `scripts/close-superseded-dependabot-prs.ps1` after `gh auth login`.

## Dependabot policy (`.github/dependabot.yml`)

- Pip updates **re-enabled** (`open-pull-requests-limit: 5`).
- **Major** `numpy` / `scipy` remain manual (`ignore` + `update-types: semver-major`).
- **`tiktoken`** fully ignored (MLX pin).
- **`soxr`** / **`pytest`** no longer ignored (Phases 2–3 complete).

## Weekly hygiene checklist

1. List open Dependabot PRs: `gh pr list --author app/dependabot --state open`
2. Map each to this doc (supersede / defer / follow-up).
3. Never merge isolated numpy/scipy **major** bumps outside a coordinated ML phase.
4. After merging runtime pin changes: `npm test`, `npm run test:python`, `pip-audit` on both `requirements-*-build.txt`, packaged smoke on affected platform.
