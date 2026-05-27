# Dependabot PR triage (Phase 5)

Last reviewed: 2026-05-27 on branch `chore/phased-dependency-upgrades` after Phases 1–4 and packaged smoke.

Use this when closing or scheduling follow-up dependency work. **Do not merge Dependabot PRs blindly** into `master`; prefer this branch or a small follow-up PR with tests + smoke.

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
