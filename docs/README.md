# Documentation Index

This directory separates current guides, maintainer references, completed implementation notes, and future initiatives.

## Current Release

- [AvaNevis v3.1.0 release notes](releases/v3.1.0.md) and [qualification](development/V3_1_QUALIFICATION.md)
- [AvaNevis v3.0.0 release notes](releases/v3.0.0.md) and [qualification](development/V3_0_QUALIFICATION.md)
- [AvaNevis v2.12.0 release notes](releases/v2.12.0.md) and [qualification](development/V2_12_QUALIFICATION.md)
- [AvaNevis v2.11.0 release notes](releases/v2.11.0.md) and [qualification](development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md)
- [Certificate trust maintenance and release gates](development/CERTIFICATE_TRUST_MAINTENANCE_2026-10.md)
- [v2.10 qualification and manual acceptance](development/V2_10_LINUX_RELEASE_QUALIFICATION.md)
- [Release scope/status](../todo.md)

## Current User Guides

- [Troubleshooting](guides/TROUBLESHOOTING.md)
- [Transcription guide](guides/TRANSCRIPTION_GUIDE.md)
- [Recording history and transcript storage](guides/MEETING_TRANSCRIPTION.md)
- [macOS installation](guides/MACOS_INSTALLATION.md)
- [macOS feature compatibility](guides/MACOS_FEATURE_COMPATIBILITY.md)
- [Linux experimental beta](guides/LINUX_EXPERIMENTAL.md)
- [Arch User Repository (AUR) package guide](guides/AUR_PACKAGE_GUIDE.md)

## Canonical Contracts

- [IPC contract](development/contracts/ipc.md)
- [Local AI contract](development/contracts/local-ai.md)
- [Meeting persistence contract](development/contracts/meeting-persistence.md)
- [Recording contract](development/contracts/recording.md)
- [Packaging contract](development/contracts/packaging.md)
- [macOS desktop-audio contract](development/contracts/macos-audio.md)

## Development References

- [Build instructions](development/BUILD_INSTRUCTIONS.md)
- [Testing guide](development/TESTING.md)
- [GPU setup](development/SETUP_GPU.md)
- [Installer implementation](development/INSTALLER_IMPLEMENTATION.md)
- [Backend development notes](development/BACKEND.md)
- [macOS icon notes](development/MACOS_ICONS.md)
- [Local AI model catalog](development/LOCAL_AI_MODEL_CATALOG.md)
- [Speakrs soak / benchmarks](development/SPEAKRS_BENCHMARKS.md)
- [Release compliance](development/RELEASE_COMPLIANCE.md)
- [Adversarial review prompts](development/ADVERSARIAL_REVIEW_PROMPTS.md)
- [Dependabot triage](development/DEPENDABOT_TRIAGE.md) (historical May 2026)

## Validation Checklists

- [Recording smoke checklist](../tests/manual/recording-smoke-checklist.md)
- [Recording/transcription regression checklist](../tests/manual/recording-transcription-regression-checklist.md)
- [Local AI add-ons checklist](../tests/manual/local-ai-addons-checklist.md)

## Legal And Release Notices

- [Third-party notices](../THIRD_PARTY_NOTICES.md)
- [Speakrs model-pack attribution](../legal/speakrs-model-pack/ATTRIBUTION.md)
- [Bundled Python packages](../legal/PYTHON-BUNDLED-PACKAGES.md)

## New Initiatives

- [Roadmap](initiatives/ROADMAP.md)
- [Acoustic echo cancellation](initiatives/FEATURE_ECHO_CANCELLATION.md)
- [Linux support](initiatives/LINUX_SUPPORT.md)
- [Audio setup wizard](initiatives/FEATURE_SETUP_WIZARD.md)
- [macOS audio architecture improvements](initiatives/MACOS_AUDIO_ARCHITECTURE.md)

## Completed Reference (kept under initiatives/)

- [Back-to-back recording & transcription queue](initiatives/FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md) — shipped in v2.6.0 · [before/after SVG](architecture/background-transcription-queue-before-after.svg)

- [AvaNevis codebase refactor](initiatives/AVANEVIS_CODEBASE_REFACTOR.md) — **complete** (2026-07-09); design + phase history for maintainers

## Completed Work And Historical Notes

- [Completed implementation docs](completed/)
- [Completed audits](completed/audits/)
- [Completed TODO archives](completed/todo-archives/)
- [Dependabot triage (May 2026)](development/DEPENDABOT_TRIAGE.md) — historical; see root `todo.md` for current dependency hygiene
