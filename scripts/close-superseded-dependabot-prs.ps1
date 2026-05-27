#!/usr/bin/env pwsh
# Close Dependabot PRs superseded by chore/phased-dependency-upgrades (Phase 5).
# Requires: GitHub CLI (`gh auth login`).

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error 'GitHub CLI (gh) is not installed or not on PATH. Install gh, run gh auth login, then re-run this script.'
}

$superseded = @(
  @{ Number = 12; Comment = 'Superseded by chore/phased-dependency-upgrades (Phase 4: ctranslate2==4.7.2).' }
  @{ Number = 20; Comment = 'Superseded by chore/phased-dependency-upgrades (Phase 1 runtime pins).' }
)

$declined = @(
  @{ Number = 19; Comment = 'Declined: lightning-whisper-mlx==0.0.10 requires tiktoken==0.3.3. See docs/development/DEPENDABOT_TRIAGE.md.' }
  @{ Number = 18; Comment = 'Declined: coordinate pyobjc-framework 10→12 in one macOS-tested change. See DEPENDABOT_TRIAGE.md.' }
  @{ Number = 15; Comment = 'Declined: coordinate pyobjc-framework 10→12 in one macOS-tested change. See DEPENDABOT_TRIAGE.md.' }
)

$incorporated = @(
  @{ Number = 17; Comment = 'Incorporated on chore/phased-dependency-upgrades: pyaudiowpatch==0.2.12.8.' }
  @{ Number = 14; Comment = 'Incorporated on chore/phased-dependency-upgrades: protobuf==7.35.0.' }
  @{ Number = 16; Comment = 'Incorporated on chore/phased-dependency-upgrades: setuptools==82.0.1 (macOS build pin).' }
  @{ Number = 21; Comment = 'Incorporated on chore/phased-dependency-upgrades: huggingface-hub==1.16.1.' }
  @{ Number = 13; Comment = 'Incorporated on chore/phased-dependency-upgrades: mpmath==1.4.1.' }
)

function Close-Pr($entry) {
  Write-Host "Closing PR #$($entry.Number)..."
  gh pr close $entry.Number --comment $entry.Comment
}

foreach ($entry in $superseded) { Close-Pr $entry }
foreach ($entry in $declined) { Close-Pr $entry }
foreach ($entry in $incorporated) { Close-Pr $entry }

Write-Host 'Done.'
