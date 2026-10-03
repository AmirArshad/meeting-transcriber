# v2.10.0 Linux release candidate qualification — 2026-10-03

**Review status:** Release preparation and manual acceptance complete; pending
adversarial code review. No release was published. Historical Windows/macOS
qualification remains in its original documents.

## User manual acceptance — 2026-10-03

The user confirmed: “i have done it all manually and its all good” and asked to
close the last scope bullet, update the plan, commit and push. This closes the
remaining release acceptance gates by user sign-off: packaged UI shortcuts,
navigation, rename/tray/quit/restart, capture/playback/transcription, Qwen
confirmation/edit/regeneration/cancel/restart, and the deferred Parakeet
offline/memory-failure/recovery/update checks. The Linux microphone investigation
is closed with the retain-current decision accepted; no gain change was added.

This is user-reported manual acceptance, not additional agent-measured evidence.
No new per-platform measurements or artifact reports were supplied. Historical
Windows/macOS reports and the bounded automated Linux results below retain their
original scope. Adversarial code review is the next step; no release publication
or tag is authorized.

## Automated-pass baseline and candidate identity

- Clean `master` at `278aa204e188a39febbd64bc518765ea31292cc0` before work.
  Candidate includes the 2.10.0 version metadata and Parakeet memory-error
  reporting fix described below. The initial automated pass preceded the
  subsequently authorized release-preparation commit.
- Latest CI at that revision completed successfully:
  [CI run](https://github.com/AmirArshad/meeting-transcriber/actions/runs/36842836796)
  and [companion run](https://github.com/AmirArshad/meeting-transcriber/actions/runs/36842682684).
- CachyOS x86_64, Hyprland/Wayland, PipeWire 1.6.9; NVIDIA RTX 4070, 12 GiB,
  driver 615.71.09. Repo Python 3.11.16; packaged Python 3.11.7 and FFmpeg n8.0.1.
  Installed system package remained 2.9.0-1. No personal meetings or tokens were
  copied into qualification fixtures or modified.
- Existing managed CUDA, Qwen and prior synthetic Parakeet runtime/model caches
  were copied into dedicated test profiles. No add-on model download, runtime
  upgrade, dependency-pin change or fallback policy change was made.
- Actual prior and candidate executable launches reported `app.isPackaged: true`,
  Wayland, `gnome_libsecret`, encryption available and successful startup checks.
  This establishes startup only, not UI operation.

## Automated and packaging checks

Baseline `npm run test:all`: exit 0; **1,082 JS passed / 2 skipped**, **818 Python
passed / 7 skipped**; both syntax gates passed. Focused memory-error tests were
observed failing before the fix, then passing. Final source regression gate:
**1,085 JS passed / 2 skipped**, **818 Python passed / 7 skipped**, both syntax
gates passed. No hardware acceptance is inferred from these tests.

`npm run build:linux` built AppImage, pacman and deb. Fresh
`npm run verify:linux:packaged` verified the unpacked payload and all three
archives, including packaged Python isolation, bundled helper/legal layout and
package dependencies. The deb is structurally verified on CachyOS; no Debian
host/install acceptance is claimed.

Final artifacts in `dist/`:

| Artifact | SHA-256 |
|---|---|
| `AvaNevis-Setup-2.10.0.AppImage` | `9b6229b1bf65f24202ca93318d84d0a4a9abd8fc8d360204561ece582c6649a8` |
| `AvaNevis-Setup-2.10.0.pkg.tar.zst` | `733c8a8220bf7b97a7cecdeecbc73649fea506b6d9f45fe9a9b9d0767dfc0a4a` |
| `AvaNevis-Setup-2.10.0.deb` | `9882dc2c14fe9d83e2ffe2fdaa597978649e7c45380a7aef2b556c973fa336d2` |
| `linux-unpacked/resources/app.asar` | `0d29cca10b77c3784aff772eebe7e0be7362a94f5df72213399af0d6c23412c9` |

## Qwen functional smoke

The candidate's packaged Python/backend ran the full summary runner with the
installed Qwen3.5 9B Q4_K_M model and production managed Linux loader paths.
The extracted production GPU service ran its real packaged CUDA probe and
integrity checks: `ready`, installed/device/runtime true, CUDA 12 admitted.
Full-checksum add-on status returned summary `ready`.

English and Spanish synthetic fixtures passed **2/2**, producing JSON/Markdown
and hash-bound language/model/policy provenance. Inspection of actual prose found
English and Spanish respectively, the Monday pilot, unchanged budget, Mira's
Friday checklist and unresolved supplier delivery. These are functional checks,
not a fluency, performance or general language-quality campaign. No cloud/CPU
fallback was used.

Confirming the English fixture as Spanish failed with actionable language-retry
guidance and left both prior sidecars, transcript and fixture audio unchanged.
Terminating an active runner and its observed llama.cpp child, including a final
owned-process-group SIGKILL as in production cleanup, also left those
bytes unchanged. This is backend/process cancellation, not the Cancel button.
Native UI confirmation, edited confirmation, regeneration, UI cancellation and
meeting-summary restart restoration were not exercised by the agent on Linux;
subsequent user manual sign-off closes that acceptance.

## Parakeet deferred checks

All runtime tests below used candidate-packaged Python/backend/FFmpeg and real
CUDA inference, with existing pinned model/runtime copies. They were not dev
Electron, mocked inference or hand-authored capture metadata.

| Check | Demonstrated result | Agent execution limits (manual acceptance recorded above) |
|---|---|---|
| Offline inference | Linux passed: isolated user/network namespace, empty routing table, outbound connect returned network unreachable. 14.22 s and 85.34 s fixtures transcribed `cuda` / `float32`, retained source and timestamped output. | No new agent-measured Windows/macOS disconnected-network evidence. Current renderer/IPC path was not exercised. |
| Bounded memory pressure | Child-only 8 GiB address-space limit caused a real ORT encoder BFCArena 16 MiB allocation failure; exit 1, source and prior transcript hashes unchanged, no Whisper/CPU substitution. Repeated on final candidate resources. | Actionable main message is regression-tested and mapped from the real final diagnostic, but the packaged UI failure/retry display and explicit Whisper retry were unavailable. Agent did not exercise the UI lifecycle; subsequent manual sign-off closes acceptance. |
| Live recording recovery | A real desktop-monitor capture with Parakeet selection was killed after synthetic playback. Packaged recovery finalized 9.00 s / 83,777-byte Opus; packaged FFmpeg decoded it and all capture-time selection fields survived. | Capture start and recovery used production backend CLIs. Packaged-app interruption/reopen/recovery-dialog flow was unavailable; subsequent manual sign-off closes acceptance. |
| Packaged upgrade survival | Scoped pacman package/profile survival checks described below. | Agent did not exercise the normal system-installed upgrade or platform matrix. |

Short source SHA-256:
`1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`.
Linux runtime lock:
`5e1a8d698e50111e088ce8b8909ed2447b17513a8536bd4761edfb60e1489e51`;
model revision `0bbb45a3365852604aef28b538a8f066f4ccaa85`.
No speed/accuracy/memory-win claim is made.

The memory experiment exposed classification after 300-character stderr
truncation: startup diagnostics hid the actual allocation failure. Main now
classifies complete captured stderr, recognizes ORT allocation failure,
`MemoryError` and `std::bad_alloc`, and persists bounded retry guidance while
retaining existing explicit error codes and candidate-output commit guards.
No new IPC fields, fallback or retry policy was added.

## Scoped package upgrade

A real pacman install followed by upgrade ran in a user namespace with its own
root/database/profile. The first prior asset was the cached September 23
qualification package; it is distinct from the installed system package and
is historical qualification evidence only. Both actual packaged versions were
launched using that isolated profile. The candidate retained Parakeet selection
and separate Whisper English Small preferences (read from the LevelDB WAL),
real backend-created meeting metadata/audio/transcript and runtime device
identity. Candidate transcription completed; runtime/model/VAD full checksums
passed and passive Parakeet status remained `ready`.

System hooks/scriptlets and dependency checks were disabled in the scoped root;
the app linked against host libraries. This does not qualify host package-manager
integration. A normal system-installed upgrade was unavailable because
noninteractive sudo requires a password. The official v2.9.0 release-package
repeat is recorded separately below; no host package was changed.

### Official v2.9.0 package repeat

The published v2.9.0 pacman asset was downloaded explicitly from the repository's
release. Asset SHA-256:
`af2eded1d633a20c354508536642eb1542baeef59dc6a4655ea755f08701e5ba`.
Its `app.asar` matches the system-installed app exactly:
`58ef5a81c15eedca8fd41cf80caa40789791ebf9655ec62997650f2878606557`.
After its actual isolated installation/startup, pacman upgraded it to the
candidate and that packaged candidate was relaunched. Preferences, real meeting
metadata, source audio/transcript and runtime device record hashes survived.
Post-upgrade Parakeet transcription completed `cuda` / `float32` and retained
its pinned adapter/model/runtime identity. The report digest is
`35c30175c7807d4a7e3f3bf8f6ac4f4147ae38e03223e35f3b1c456d5365d635`.

This demonstrates official prior-package-to-candidate payload/profile survival
in the scoped root. The earlier hook/dependency/system-install limitations still
apply; this scoped experiment alone does not qualify the full system-installed/
platform upgrade. Subsequent manual acceptance is recorded above. The
final rebuild has the same `app.asar`; only archive hashes changed on rebuild.

## Capture and microphone-volume investigation

Real endpoint checks used the default Logitech USB microphone and HDMI output
monitor, with only dedicated local synthetic playback. The candidate-packaged
recorder stopped successfully in Mic Only, Desktop Only and Mic + Desktop;
all three files decoded with packaged FFmpeg. Mic Only captured the endpoint's
ambient signal; there was no controlled physical speech source, so speech
transcription from that microphone alone is unqualified.

At quarter playback-stream volume, Desktop Only transcribed the synthetic
speech but Mic + Desktop produced no speech. Repeating Mic + Desktop with the
same synthetic fixture at unity playback-stream volume produced all six short
speech segments. Only the test playback stream's gain changed; device volumes
and default endpoints were not changed. This demonstrates signal-level
sensitivity, not an app volume-reset defect or broad transcription-quality claim.

Separate disposable Pulse null sinks/remapped source exercised all three modes
with controlled synthetic input. **3/3** capture and Parakeet transcription
checks passed with speech; those are virtual-device checks, not physical
microphone qualification. All temporary modules were unloaded.

Selected physical source volume was **31611/65536 (48%, -19 dB)** before launch,
during each recording, after stop and after packaged restart. Capture-stream
gain was **100%**, not 50%. No reset reproduced. Recorder source and SoundCard
0.4.6's Pulse capture connection contain no source-volume setter. This host's
WirePlumber defaults for source and capture-stream volume are 1.0; its route
restoration machinery alone is not evidence of the reported reset's cause.

**Decision:** retain current app behavior. No app-side or persistent setup-side
gain remedy is supported by this evidence. The original 50% reset attribution
and its capture/transcription impact remain unresolved, so the investigation
scope checkbox was initially left open. The subsequent user manual acceptance
closes it with the retain-current decision; reset attribution is not claimed.
Personal device settings were unchanged.

## Automated-pass UI and cross-platform tooling limits

The available computer-use inventory exposed browser surfaces only, no native
apps. Native control APIs were disabled: `cua.listApps` was not a function.
No alternate desktop input injection was used. This prevents current packaged
Hyprland shortcut conflict checks (start/stop, Record/History/Settings),
click-away rename, UI playback, tray interaction, summary confirmation and
recovery dialogs, and normal UI quit/restart acceptance. The SNI watcher was
present, but presence is not tray interaction acceptance. Process restart/startup
and filesystem checks do not close those UI gates.

Windows September 30 and macOS September 29 Parakeet lifecycle evidence and
October 1 macOS Qwen evidence were reviewed and retained. They did not establish
the four deferred checks or packaged shortcut-conflict matrix. No Windows/macOS
hardware or installer checks ran on this host. Omarchy and experimental desktops
were not newly qualified. The existing cancelled 60-minute soak and open Ubuntu
recording/secret-storage smoke remain unchanged.

## Local evidence fingerprints

Synthetic reports and diagnostic logs remain outside git; no private paths or
meeting content are included in this document.

| Report | SHA-256 |
|---|---|
| Qwen generation | `6698a787b035fc8f13727643b595876c4818cf502241ccccc92a7a3b7b3e7541` |
| Qwen preservation | `5b97c38961ce87eb72c0a368412e82ab3b97c2b1a5ed62091b5f1675ae51661f` |
| Offline Parakeet | `7df832bae47a592f6da10c468107f24848c98fb664bf93432616e42990bc4726` |
| Memory failure preservation | `2007598cf33ab7ee50a3f97c7150c2c7c1e54c885fa28d9e6c00f90729bae091` |
| Live backend recovery | `17f9da0b9248da97ba7897cbd06b679fa1a785f9f02fa3c6910aab986bf96a57` |
| Cached-package upgrade | `35c30175c7807d4a7e3f3bf8f6ac4f4147ae38e03223e35f3b1c456d5365d635` |
| Real endpoint capture/volume | `8925ece99c8185bd4efbda6b67884ce70aa3a208c8cbf68f49796b25bf5489e6` |
| Virtual-device capture | `692d08bad2c8030cde29933d3fd3fd5d908b797818326ef08d30df848d796cd6` |

Initial automated review checks: complete diff inspected; `git diff --check`
passed. That pass did not stage, commit, push, tag, publish or dispatch workflows.
Existing personal data/runtimes and system package were preserved. Subsequent
user manual sign-off closes the scope gates in `todo.md` and the plan and
authorizes committing and pushing these reviewable changes on `master`.
