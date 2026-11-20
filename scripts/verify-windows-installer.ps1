# Verify packaged/installed Windows NSIS artifacts.
# Use -SignaturesOnly to verify Authenticode signatures on dist/ without installing,
# or run without switches on a disposable GitHub Actions runner to test full install/uninstall.
param(
    [switch]$SignaturesOnly
)

$ErrorActionPreference = 'Stop'

function Assert-AuthenticodeSigned {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath
    )
    if (-not (Test-Path $FilePath)) {
        throw "Missing file for Authenticode verification: $FilePath"
    }
    $sig = Get-AuthenticodeSignature -FilePath $FilePath
    if ($sig.Status -ne 'Valid') {
        throw "Invalid Authenticode signature on ${FilePath}: Status=$($sig.Status) Message=$($sig.StatusMessage)"
    }
    if (-not $sig.SignerCertificate) {
        throw "Missing SignerCertificate on $FilePath"
    }
    if (-not $sig.TimeStamperCertificate) {
        throw "Missing RFC 3161 TimeStamperCertificate on $FilePath"
    }
    Write-Host "Authenticode OK: $FilePath (Subject=$($sig.SignerCertificate.Subject))"
}

$version = node -p "require('./package.json').version"
if ($LASTEXITCODE -ne 0) { throw 'Could not read package version' }
$installer = Join-Path (Get-Location) "dist/AvaNevis-Setup-$version.exe"
if (-not (Test-Path $installer)) { throw "Missing NSIS installer: $installer" }
$installerBlockmap = Join-Path (Get-Location) "dist/AvaNevis-Setup-$version.exe.blockmap"
if (-not (Test-Path $installerBlockmap)) { throw "Missing NSIS differential blockmap: $installerBlockmap" }
$latestYml = Join-Path (Get-Location) 'dist/latest.yml'
if (-not (Test-Path $latestYml)) { throw "Missing Windows updater metadata: $latestYml" }

$unpackedExe = Join-Path (Get-Location) 'dist/win-unpacked/AvaNevis.exe'
$unpackedSpeakrs = Join-Path (Get-Location) 'dist/win-unpacked/resources/bin/speakrs-cli.exe'
$appUpdateYml = Join-Path (Get-Location) 'dist/win-unpacked/resources/app-update.yml'
if (-not (Test-Path $appUpdateYml)) { throw "Missing packaged app-update.yml: $appUpdateYml" }
$requireSignedRaw = [string]$env:AVANEVIS_REQUIRE_SIGNED_RELEASE
$requireSigned = $requireSignedRaw -eq '1' -or $requireSignedRaw.ToLowerInvariant() -eq 'true'

if ($SignaturesOnly -or $requireSigned) {
    Assert-AuthenticodeSigned -FilePath $installer
    Assert-AuthenticodeSigned -FilePath $unpackedExe
    Assert-AuthenticodeSigned -FilePath $unpackedSpeakrs
    $appUpdateContent = Get-Content -Path $appUpdateYml -Raw
    if ($appUpdateContent -notmatch '(?m)^publisherName:') {
        throw "Signed Windows build must record publisherName in $appUpdateYml for electron-updater signature verification"
    }
    if ($SignaturesOnly) {
        Write-Host 'Windows Authenticode signature checks passed'
        exit 0
    }
}

if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Installer qualification requires a disposable GitHub Actions runner'
}

$installDir = Join-Path $env:RUNNER_TEMP ('avanevis-install-' + [guid]::NewGuid().ToString('N'))
$uninstaller = Join-Path $installDir 'Uninstall AvaNevis.exe'
try {
    # NSIS /D must be the final argument and is passed without quotes.
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', '/allusers', "/D=$installDir") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "NSIS install failed: $($process.ExitCode)" }
    $exe = Join-Path $installDir 'AvaNevis.exe'
    if (-not (Test-Path $exe)) { throw 'Installed executable missing' }
    if ($requireSigned) {
        Assert-AuthenticodeSigned -FilePath $exe
        Assert-AuthenticodeSigned -FilePath (Join-Path $installDir 'resources/bin/speakrs-cli.exe')
    }
    foreach ($relative in @('resources/app.asar', 'resources/python/python.exe', 'resources/python/python311._pth',
                           'resources/python/DLLs/_ctypes.pyd', 'resources/ffmpeg/ffmpeg.exe',
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
    & (Join-Path $installDir 'resources/python/python.exe') -c "import os, sys; assert sys.version_info[:3] >= (3, 11, 18), sys.version; os.environ['ORT_RUNNING_UNIT_TESTS']='0'; import transcription; assert os.environ['ORT_RUNNING_UNIT_TESTS']=='1'; import onnxruntime, faster_whisper; assert onnxruntime.__version__=='1.31.1'; print(sys.version.split()[0], onnxruntime.__version__)"
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
