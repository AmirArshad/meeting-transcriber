param(
    [Parameter(Mandatory = $true)][string]$BaselineSitePackages,
    [string]$Python = 'python'
)

# Native ETW qualification on a disposable runner, using only the bundled VAD
# model and public fixture. A positive control prevents an inactive collector
# or automatic CI suppression from producing a false privacy pass.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Run Windows ONNX qualification on a disposable GitHub Actions Windows runner.'
}
$provider = '{3a26b1ff-7484-7484-7484-15261f42614d}'
$root = Join-Path $env:RUNNER_TEMP ('avanevis-onnx-etw-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$helper = Join-Path $PSScriptRoot 'qualify-onnx-vad.py'
$counts = @{}
foreach ($mode in @('control', 'guarded')) {
    $session = 'AvaNevisOnnx-' + [guid]::NewGuid().ToString('N')
    $etl = Join-Path $root "$mode.etl"
    $xmlPath = Join-Path $root "$mode.xml"
    $output = Join-Path $root "$mode.json"
    & logman create trace $session -o $etl -p $provider '0xffffffffffffffff' '0xff' -ets
    if ($LASTEXITCODE -ne 0) { throw "Cannot start ETW collector: $LASTEXITCODE" }
    try {
        $workerArgs = @($helper, '--worker', '--output', $output)
        if ($mode -eq 'guarded') { $workerArgs += '--windows-telemetry-guard' }
        & $Python @workerArgs
        if ($LASTEXITCODE -ne 0) { throw "VAD worker failed: $LASTEXITCODE" }
    } finally {
        & logman stop $session -ets
        if ($LASTEXITCODE -ne 0) { throw "Cannot stop ETW collector: $LASTEXITCODE" }
    }
    & tracerpt $etl -of XML -o $xmlPath -summary (Join-Path $root "$mode-summary.txt") -y
    if ($LASTEXITCODE -ne 0) { throw "Cannot decode ETW trace: $LASTEXITCODE" }
    $result = Get-Content $output -Raw | ConvertFrom-Json
    if ($result.version -ne '1.31.0') { throw "Unexpected candidate: $($result.version)" }
    [xml]$events = Get-Content $xmlPath -Raw
    $count = 0
    foreach ($event in $events.SelectNodes("//*[local-name()='Event']")) {
        $source = $event.SelectSingleNode("*[local-name()='System']/*[local-name()='Provider']")
        $execution = $event.SelectSingleNode("*[local-name()='System']/*[local-name()='Execution']")
        if ($source -and $execution -and $source.GetAttribute('Guid') -ieq $provider -and
            $execution.GetAttribute('ProcessID') -eq [string]$result.pid) {
            $count++
        }
    }
    $counts[$mode] = $count
    Write-Host "ONNX $mode worker PID $($result.pid): $count ETW events"
}
if ($counts.control -lt 1) { throw 'Positive control emitted no ETW events; collector proof failed.' }
if ($counts.guarded -ne 0) { throw 'Guarded ONNX worker emitted telemetry.' }
& $Python $helper --baseline-site-packages $BaselineSitePackages --windows-telemetry-guard
if ($LASTEXITCODE -ne 0) { throw "Baseline/candidate VAD parity failed: $LASTEXITCODE" }
Write-Host 'Windows ONNX qualification passed: positive control detected; guarded ETW events zero; VAD matches.'
