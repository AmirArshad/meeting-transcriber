# Python modernization

> **For a later session.** Do this on its own branch. Do not start it on `master`. The partial editor cleanup in `backend/summaries/summary_pipeline.py` and `backend/summaries/summary_language.py` was reverted on 2026-10-09.

**Goal:** Bring the Python in this repo up to current 3.11 practice so the code is consistently typed, imports are orderly, and the editor is quiet for rules the project actually accepts.

**Architecture:** Keep the running app the same. Modernize annotations and formatting first. Change control flow, exception handling, file lifetime, or process calls only in a separate reviewed slice with tests that cover the old behavior.

**Tech stack:** Python 3.11, Ruff, basedpyright. The app stays Electron 44, plain JavaScript, and the existing local audio and AI subprocesses.

## What this is

Zed is running Ruff and basedpyright against a tree that never adopted those tools. On 2026-10-09 a full pass reported:

| Check | Result |
|---|---|
| `npm run test:python-syntax` | Passed |
| CI flake8 `E9,F63,F7,F82` on `backend/` | 0 findings |
| Ruff on `backend`, `tests`, and `scripts`, with no repo config | 1,428 findings |
| basedpyright on `backend/` | 5,154 findings in 66 files: 324 errors, 4,830 warnings |

The largest groups are style and missing types, not crashes: `typing.Dict` / `List` / `Optional`, unsorted imports, unsorted `__all__`, f-strings with nothing to interpolate, and basedpyright `reportAny` / unknown parameter and argument types. `pyrightconfig.json` only names the virtualenv and Python 3.11, so basedpyright uses its own strict default. CI does not run Ruff or basedpyright. Its flake8 step is limited to syntax and undefined names, and that step is allowed to fail without failing the job.

The app's own bug-class checks were clean. Summary tests passed before the partial edit was reverted.

## Outcome

- Python 3.11 annotations use builtins and `| None`, with `Iterable` and other abstract types imported from `collections.abc`.
- Imports and `__all__` follow one committed Ruff layout.
- A committed Ruff and basedpyright config is the project standard. The editor and CI check that standard. They do not flag every upstream rule by default.
- `npm run test:all` passes on the branch before it is ready to merge.

## How to do it

Work on a new branch from current `master`. Suggested name: `python-modernization`.

1. Add the Ruff and basedpyright config first, with the rule set this project will enforce. Start from formatting, import order, pyupgrade annotation rewrites, and the basedpyright rules that match those rewrites. Leave behavior-changing rules out of the first slice.
2. Apply that slice across `backend/`, `tests/python/`, and `scripts/`. Redo the reverted summary-file edit as part of this slice.
3. Run `npm run test:python` and `npm run test:python-syntax` while iterating. Run `npm run test:all` before calling the branch ready.
4. Only after that, open a second slice for findings that can change runtime behavior. Each one needs a reason and a test. Do not autofix this slice.

## Leave these alone in the first slice

These Ruff groups can change recording, transcription, recovery, or add-on setup even when a test suite stays green:

- Broad `except` and `except: pass` / `except: continue` (`BLE001`, `S110`, `S112`, `E722`)
- Opening files without a context manager (`SIM115`)
- `subprocess` without `check=True` (`PLW1510`)
- Closures that read a loop variable (`B023`)
- basedpyright notes that a value might be `None` where a string or number is required, mostly in the recorder modules

Also leave optional-import failures alone when the package is platform-specific or not installed in the local virtualenv, such as MLX or a gated model runtime.

## Constraints

- Preserve recorder, meeting, packaging, and local-AI behavior. Read the matching contract before editing one of those surfaces.
- Do not add cloud processing, telemetry, hidden downloads, or a CPU/cloud fallback for a gated add-on.
- Do not edit `AGENTS.md`, adapters, or skill wiring.
- Do not stage, commit, push, or open a pull request unless the user asks.
