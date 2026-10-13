# Run only on the disposable Windows CI runner: install, verify, then uninstall.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Installer qualification requires a disposable GitHub Actions runner'
}
$version = node -p "require('./package.json').version"
if ($LASTEXITCODE -ne 0) { throw 'Could not read package version' }
$installer = Join-Path (Get-Location) "dist/AvaNevis-Setup-$version.exe"
if (-not (Test-Path $installer)) { throw "Missing NSIS installer: $installer" }
$installDir = Join-Path $env:RUNNER_TEMP ('avanevis-install-' + [guid]::NewGuid().ToString('N'))
$uninstaller = Join-Path $installDir 'Uninstall AvaNevis.exe'
try {
    # NSIS /D must be the final argument and is passed without quotes.
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', '/allusers', "/D=$installDir") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "NSIS install failed: $($process.ExitCode)" }
    $exe = Join-Path $installDir 'AvaNevis.exe'
    if (-not (Test-Path $exe)) { throw 'Installed executable missing' }
    foreach ($relative in @('resources/app.asar', 'resources/python/python.exe', 'resources/ffmpeg/ffmpeg.exe',
                           'resources/bin/speakrs-cli.exe', 'resources/bin/speakrs-two-speaker-16k.wav')) {
        $file = Get-Item (Join-Path $installDir $relative)
        if ($file.Length -le 0) { throw "Installed resource empty: $relative" }
        $builtHash = (Get-FileHash (Join-Path 'dist/win-unpacked' $relative) -Algorithm SHA256).Hash
        if ((Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne $builtHash) {
            throw "Installed resource differs from qualified unpacked build: $relative"
        }
    }
    $env:AVANEVIS_PACKAGED = '1'
    $env:PYTHONNOUSERSITE = '1'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:ORT_DISABLE_TELEMETRY = '1'
    & (Join-Path $installDir 'resources/python/python.exe') -c "import os; os.environ['ORT_RUNNING_UNIT_TESTS']='0'; import transcription; assert os.environ['ORT_RUNNING_UNIT_TESTS']=='1'; import onnxruntime, faster_whisper; assert onnxruntime.__version__=='1.31.0'; print(onnxruntime.__version__)"
    if ($LASTEXITCODE -ne 0) { throw 'Installed Python runtime imports failed' }
    & (Join-Path $installDir 'resources/ffmpeg/ffmpeg.exe') -version
    if ($LASTEXITCODE -ne 0) { throw 'Installed FFmpeg failed' }
    Write-Host 'Windows NSIS installed payload verified'
} finally {
    if (Test-Path $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "NSIS uninstall failed: $($process.ExitCode)" }
        if (Test-Path (Join-Path $installDir 'AvaNevis.exe')) { throw 'Uninstall left the installed executable behind' }
        Write-Host 'Windows NSIS uninstall verified'
    } elseif (Test-Path $installDir) {
        throw 'Install left files without an uninstaller'
    }
}
