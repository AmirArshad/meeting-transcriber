# Native Windows bootstrap. Symlinks first; junctions when privileges are unavailable.
param([switch]$Check)
$ErrorActionPreference = 'Stop'
if ($args.Count -gt 0) {
    if ($args.Count -eq 1 -and $args[0] -ceq '--check') { $Check = $true }
    else { throw 'Usage: link_skills.ps1 [-Check | --check]' }
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sourceRoot = Join-Path $repo '.agents/skills'
$linkRoot = Join-Path $repo '.claude/skills'
function Is-Link($item) {
    return ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Get-Entry([string]$path) {
    # Enumerate the parent: Test-Path can hide dangling symlinks.
    $parent = Split-Path -Parent $path
    if (-not [IO.Directory]::Exists($parent)) { return $null }
    return Get-ChildItem -LiteralPath $parent -Force | Where-Object { $_.Name -ceq (Split-Path -Leaf $path) } | Select-Object -First 1
}
function Link-Target($item) {
    $raw = @($item.Target)[0]
    if ([string]::IsNullOrEmpty($raw)) { return '' }
    if (-not [IO.Path]::IsPathRooted($raw)) { $raw = Join-Path (Split-Path -Parent $item.FullName) $raw }
    return [IO.Path]::GetFullPath($raw).TrimEnd('\','/')
}
function Remove-Link($item) {
    # Never use recursive deletion on a junction.
    if ($item.PSIsContainer -or $item.LinkType -eq 'Junction') { [IO.Directory]::Delete($item.FullName) }
    else { [IO.File]::Delete($item.FullName) }
}
function Mark-Junction([string]$name, [bool]$checkOnly) {
    $relative = ".claude/skills/$name"
    $record = & git -C $repo ls-files --stage -- $relative
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Git index for $relative" }
    if ($record -match '^120000 ') {
        if ($checkOnly) {
            $flag = & git -C $repo ls-files -v -- $relative
            if ($LASTEXITCODE -ne 0 -or $flag -notmatch '^[Ss] ') { throw "Junction needs skip-worktree: $relative" }
        } else {
            & git -C $repo update-index --skip-worktree -- $relative
            if ($LASTEXITCODE -ne 0) { throw "Cannot mark junction skip-worktree: $relative" }
        }
    } else {
        # No staging here; a future tracked symlink can be marked on the next run.
        Write-Warning "$relative is not a tracked symlink yet; rerun after the migration is committed to mark skip-worktree."
    }
}
if (-not [IO.Directory]::Exists($sourceRoot)) { throw "Missing $sourceRoot" }
foreach ($dir in @((Join-Path $repo '.claude'), $linkRoot)) {
    $item = Get-Entry $dir
    if (Is-Link $item) { throw "Refusing redirected adapter root: $dir" }
    if (-not [IO.Directory]::Exists($dir)) {
        if ($Check) { throw "Missing $dir" }
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}
$skills = @(Get-ChildItem -LiteralPath $sourceRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf })
if ($skills.Count -eq 0) { throw 'No canonical skills found' }
# Case collisions cannot safely map onto native Windows paths.
if (@($skills.Name | Group-Object | Where-Object Count -gt 1).Count) { throw 'Case-colliding skill names' }
foreach ($entry in @(Get-ChildItem -LiteralPath $linkRoot -Force)) {
    if (Is-Link $entry) { continue }
    $expected = "../../.agents/skills/$($entry.Name)"
    $known = @($skills | Where-Object Name -CEQ $entry.Name).Count -eq 1
    if (-not $entry.PSIsContainer -and $known -and [IO.File]::ReadAllText($entry.FullName) -ceq $expected) { continue }
    throw "Refusing real file or directory: $($entry.FullName)"
}
$problems = @()
foreach ($skill in $skills) {
    $path = Join-Path $linkRoot $skill.Name
    $entry = Get-Entry $path
    $expected = "../../.agents/skills/$($skill.Name)"
    $valid = $false
    if (Is-Link $entry) {
        $target = Link-Target $entry
        $valid = $target -eq $skill.FullName.TrimEnd('\','/') -and (Test-Path -LiteralPath (Join-Path $path 'SKILL.md') -PathType Leaf)
        # Symlinks are portable only with the exact relative target. Junctions use absolute targets.
        if ($entry.LinkType -eq 'SymbolicLink') { $valid = $valid -and (@($entry.Target)[0].Replace('\','/') -ceq $expected) }
    }
    if ($valid) {
        if ($entry.LinkType -eq 'Junction') { Mark-Junction $skill.Name $Check.IsPresent }
        continue
    }
    if ($Check) { $problems += "Missing, wrong or dangling link: $path"; continue }
    if ($null -ne $entry) {
        if (Is-Link $entry) { Remove-Link $entry }
        else { [IO.File]::Delete($entry.FullName) }
    }
    try {
        Push-Location -LiteralPath $linkRoot
        try { New-Item -ItemType SymbolicLink -Path $path -Target $expected -ErrorAction Stop | Out-Null }
        finally { Pop-Location }
    }
    catch {
        if ($env:OS -ne 'Windows_NT') { throw }
        # If a failed native link operation left an entry, never clobber it.
        if ($null -ne (Get-Entry $path)) { throw "Failed symlink left an entry at $path" }
        New-Item -ItemType Junction -Path $path -Target $skill.FullName | Out-Null
        Mark-Junction $skill.Name $false
    }
    $created = Get-Entry $path
    if (-not (Is-Link $created) -or (Link-Target $created) -ne $skill.FullName.TrimEnd('\','/') -or -not (Test-Path -LiteralPath (Join-Path $path 'SKILL.md'))) { throw "Link creation failed: $path" }
}
foreach ($entry in @(Get-ChildItem -LiteralPath $linkRoot -Force)) {
    if (-not (Is-Link $entry)) { continue }
    if (@($skills | Where-Object Name -CEQ $entry.Name).Count) { continue }
    if ($Check) { $problems += "Stale or dangling link: $($entry.FullName)" }
    else { Remove-Link $entry }
}
if ($problems.Count) { throw ($problems -join "`n") }
Write-Output "Verified $($skills.Count) Claude skill links."
