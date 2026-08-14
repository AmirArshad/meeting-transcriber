# Speakrs Benchmarks (Task 7)

Soak and same-audio notes for the exclusive Speakrs / Pyannote selector. Spike tables stay in [`SPEAKRS_SPIKE_NOTES.md`](SPEAKRS_SPIKE_NOTES.md). Internal audio stays out of git.

Do **not** claim a Windows speed or DER win vs pyannote CUDA. Speakrs **0.5.0** has **no** speaker-count API — do not add `--speaker-count` / `SPEAKRS_NUM_SPEAKERS`.

## Ship bar

Closed **2026-08-14** by product from the Mac packaged and Windows CUDA smokes below. No silent Speakrs cutover. Pyannote stays selectable. Do **not** claim the original ≥25-meeting / 2×50-turn bars were fully executed.

| Bar | Status |
|-----|--------|
| ≥25 meetings (≥10/OS) guided, zero engine crashes | **Accepted with less volume.** Mac packaged CoreML guided (no crash) + Windows CUDA guided (no crash). |
| Mac 2×50-turn A/B, Speakrs not worse than **+2** vs pyannote | **Not met.** Mac 10:22 over-clustered (+1 speaker). Windows shorts matched `speakerCount`; 11:17 CUDA split-identity on the closing mic turn. Keep pyannote. |
| Selector / switch / remove | **Closed.** Switch model, hidden token/speaker-count, radios after Ready, Hugging Face token kept on Pyannote→Speakrs, About/notices credit Speakrs. |

## Mac packaged soak 2026-08-14

Apple Silicon dir build, ad-hoc signed. Whisper `medium` / `mps`. Sidecars only; no transcript text.

| Clip | Duration | Engine | `device` | sidecar `speakerCount` |
|------|----------|--------|----------|------------------------|
| 10:19 | 26 s | pyannote community-1 | `mps` | **2** |
| 10:22 | 35 s | speakrs-community1-vbx | `coreml` | **3** |

Speakrs exclusive turns were `SPEAKER_00` / `SPEAKER_01` / `SPEAKER_02`. Merge relabels those in index order to `Speaker 1` / `Speaker 2` / `Speaker 3`, so a phantom `SPEAKER_00` pushes the two real talkers onto **Speaker 2 and Speaker 3**. One in-room turn was also assigned the YouTube speaker’s label (split identity). Speed was fine (CoreML). Clustering miss, not a crash — plan risk #4.

## Same-audio A/B

The Mac 10:22 in-room+YouTube clip was not on the Windows checkout used for Task 7a.

**Windows substitute (2026-08-14):** existing pyannote CUDA sidecars vs `speakrs-cli` `cuda` on the same Opus files. Spike models `5d24ffe` + ORT 1.27.1 candidate; the app’s Ready pyannote install was left untouched. No `--speaker-count`.

| Clip | Duration | pyannote `speakerCount` | Speakrs unique speakers | Speakrs turns vs pyannote segs | wall (s) |
|------|----------|-------------------------|-------------------------|--------------------------------|----------|
| `meeting_20260813_101743` | 21.9 s | 2 | 2 | 14 vs 5 | 4.19 |
| `meeting_20260527_181446` | 27.0 s | 2 | 2 | 4 vs 4 | 1.95 |
| `meeting_20260527_183953` | 28.3 s | 2 | 2 | 4 vs 3 | 1.73 |
| `meeting_20260527_175205` | 23.9 s | 2 | 2 | 4 vs 3 | 1.65 |
| `meeting_20260518_132721` | 84.3 s | 3 | 3 | 14 vs 9 | 3.44 |

Windows CUDA did **not** reproduce the Mac +1 speaker over-cluster on these shorts. Speakrs can still emit more exclusive turns (14 vs 5 on 21.9 s), which coarsens or fragments guided Whisper windows even when `speakerCount` matches.

Keep pyannote selectable. The same-audio Mac 10:22 A/B and 2×50-turn bar were not re-run before ship.

## Windows CUDA soak 2026-08-14

Guided Speakrs CUDA on a ~39 s mic-then-YouTube clip (`meeting_20260814_111755`). Sidecar `speakerCount` **2**, `device` `cuda`, wall clock felt much faster than prior pyannote CUDA on this machine (anecdotal; do not publish a Windows speed claim).

Exclusive turns: SPEAKER_00 on the mic intro, SPEAKER_01 on the YouTube stretch **and** the user’s closing line, plus a **0.14 s** SPEAKER_00 fragment at 38.98–39.11 s. Merge labeled that closing as Speaker 2. This is the same split-identity class as the Mac 10:22 YouTube clip (plan risk #4), not a `Speaker N` remapping bug and not something a `--speaker-count` flag can fix (0.5.0 has none). Do not add a “last turn belongs to Speaker 1” heuristic.

## After ship

Task 7 soak is closed. Further meetings can still be logged here; do not overwrite Mac rows. Do not treat VoxConverse n=10 (spike) as the Task 7 human A/B.
