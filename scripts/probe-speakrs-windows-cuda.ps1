# Native Windows feasibility probe. Run from a Visual Studio developer PowerShell:
# powershell -ExecutionPolicy Bypass -File scripts/probe-speakrs-windows-cuda.ps1 -ScratchDir C:\avanevis-v211-probe
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ScratchDir
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Run this probe natively on Windows x64, not via cross-compilation.'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$parent = (Resolve-Path (Split-Path -Parent ([IO.Path]::GetFullPath($ScratchDir)))).Path
$scratch = Join-Path $parent (Split-Path -Leaf ([IO.Path]::GetFullPath($ScratchDir)))
if (Test-Path -LiteralPath $scratch) { throw 'ScratchDir must be a new, nonexistent directory.' }
foreach ($protected in @($repo, $env:APPDATA, $env:LOCALAPPDATA)) {
    if ($protected -and ($scratch.TrimEnd('\') + '\').StartsWith($protected.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ScratchDir must be outside the repository and app data directories.'
    }
}
New-Item -ItemType Directory -Path $scratch, (Join-Path $scratch 'src'), (Join-Path $scratch 'vendor'), (Join-Path $scratch 'models'), (Join-Path $scratch 'config') | Out-Null
$evidence = Join-Path $scratch 'evidence.txt'
function Record([string]$message) {
    Add-Content -LiteralPath $evidence -Value $message -Encoding UTF8
    Write-Host $message
}
function Hash([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function Run-Logged([string]$label, [string]$exe, [string[]]$arguments) {
    $log = Join-Path $scratch ($label + '.log')
    Write-Host "Running $label (output: $log)"
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @arguments *> $log; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $old }
    Record "$label exit=$code"
    if ($code -ne 0) { throw "$label failed; inspect $log. Windows feasibility remains blocked." }
}
try {
    Record ('UTC=' + [DateTime]::UtcNow.ToString('o'))
    Record ('Windows=' + [Environment]::OSVersion.VersionString + ' architecture=' + $env:PROCESSOR_ARCHITECTURE)
    $revision = (& git -C $repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read repository revision.' }
    Record "git_revision=$revision"
    # Hash the uncommitted tracked patch without including its contents in evidence.
    $patchPath = Join-Path $scratch 'source.patch'
    New-Item -ItemType File -Path $patchPath | Out-Null
    & git -C $repo diff --binary HEAD -- native/speakrs-cli/src/main.rs native/speakrs-cli/vendor/ndarray-npy | Set-Content -LiteralPath $patchPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Cannot capture source patch.' }
    Record ('adapter_patch_sha256=' + (Hash $patchPath))
    $source = Join-Path $repo 'native/speakrs-cli/src/main.rs'
    $vendor = Join-Path $repo 'native/speakrs-cli/vendor/ndarray-npy'
    Copy-Item -LiteralPath $source -Destination (Join-Path $scratch 'src/main.rs')
    Copy-Item -LiteralPath $vendor -Destination (Join-Path $scratch 'vendor/ndarray-npy') -Recurse
    Record ('adapter_sha256=' + (Hash (Join-Path $scratch 'src/main.rs')))
    $vendorManifest = Join-Path $scratch 'vendor-sha256.txt'
    Get-ChildItem -LiteralPath (Join-Path $scratch 'vendor/ndarray-npy') -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring((Join-Path $scratch 'vendor/ndarray-npy').Length).TrimStart('\').Replace('\', '/')
        "$relative $(Hash $_.FullName)"
    } | Set-Content -LiteralPath $vendorManifest -Encoding UTF8
    Record ('vendor_inventory_sha256=' + (Hash $vendorManifest))
    $manifest = @'
[package]
name = "speakrs-v07-probe"
version = "0.1.0"
edition = "2024"
rust-version = "1.89"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
speakrs = { version = "=0.7.0", default-features = false, features = ["cuda"] }
[patch.crates-io]
ndarray-npy = { path = "vendor/ndarray-npy" }
[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(feature, values("ci-cpu-smoke"))'] }
'@
    [IO.File]::WriteAllText((Join-Path $scratch 'Cargo.toml'), $manifest, [Text.UTF8Encoding]::new($false))
    Record ('manifest_sha256=' + (Hash (Join-Path $scratch 'Cargo.toml')))
    $fixture = Join-Path $repo 'tests/fixtures/speakrs-two-speaker-16k.wav'
    $fixtureHash = Hash $fixture
    if ($fixtureHash -ne '1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998') { throw 'Repository fixture SHA-256 mismatch.' }
    Record "fixture_sha256=$fixtureHash"
    Run-Logged 'nvidia-smi' 'nvidia-smi' @()
    Run-Logged 'gpu' 'nvidia-smi' @('--query-gpu=name,driver_version,compute_cap', '--format=csv,noheader')
    Run-Logged 'git-status' 'git' @('-C', $repo, 'status', '--short')
    Run-Logged 'node-version' 'node' @('--version')
    Run-Logged 'npm-version' 'npm.cmd' @('--version')
    Run-Logged 'rustup-show' 'rustup' @('show')
    Run-Logged 'toolchain-install' 'rustup' @('toolchain', 'install', '1.89.0', '--profile', 'minimal')
    Run-Logged 'rustc-version' 'rustup' @('run', '1.89.0', 'rustc', '-Vv')
    Push-Location $scratch
    try {
        Run-Logged 'target-add' 'rustup' @('target', 'add', 'x86_64-pc-windows-msvc', '--toolchain', '1.89.0')
        Run-Logged 'lock' 'cargo' @('+1.89.0', 'generate-lockfile')
        $lock = Get-Content -LiteralPath (Join-Path $scratch 'Cargo.lock') -Raw
        if ($lock -notmatch '(?ms)name = "speakrs"\s+version = "0\.7\.0"\s+source = "registry\+https://github\.com/rust-lang/crates\.io-index"\s+checksum = "61315252c89558117552bcc7eef1d693043fa6fcf72ff46f655b21852f30375e"') { throw 'Speakrs crate source/checksum mismatch in lockfile.' }
        Record ('lock_sha256=' + (Hash (Join-Path $scratch 'Cargo.lock')))
        Run-Logged 'features' 'cargo' @('+1.89.0', 'tree', '--locked', '-e', 'features', '--target', 'x86_64-pc-windows-msvc')
        $tree = Get-Content -LiteralPath (Join-Path $scratch 'features.log') -Raw
        if ($tree -match '(?im)\bhf-hub\b|\bort v\d|feature "online"') { throw 'Online/HF or ORT dependency detected.' }
        foreach ($feature in @('cuda-sm75', 'cuda-sm80', 'cuda-sm90', 'cuda-sm120')) {
            if ($tree -notmatch [regex]::Escape('feature "' + $feature + '"')) { throw "Missing CUDA feature $feature." }
        }
        Record 'feature_graph=CUDA tiers present; no hf-hub, ORT or online detected'
        Run-Logged 'build' 'cargo' @('+1.89.0', 'build', '--release', '--locked', '--target', 'x86_64-pc-windows-msvc')
        $binary = Join-Path $scratch 'target/x86_64-pc-windows-msvc/release/speakrs-v07-probe.exe'
        Record ('binary_sha256=' + (Hash $binary))
        $pins = @(
            @('plda_lda.npy',131200,'e20c9b012bebd1aabda5a38a127e63a43cf35debdc502715fc143e2fb6bc3c4b'),
            @('plda_tr.npy',131200,'e700b68cb319de3fafb5fa093eb9222c23c447084741f8d3a533640d425510ee'),
            @('plda_mu.npy',1152,'d286d48acf99bbc1ed1502fed0a3e361ae5626ce1870c8be9f7397c5e47886c6'),
            @('plda_psi.npy',1152,'d7128c9ed2f28a9781971805131129f077c04f948e2df12e52dcdb99f2b4e5f5'),
            @('plda_mean1.npy',2176,'e424c0c352182aa8e0f555dec1f3b30e29a20b9ed6b25d339f112af92e51e36f'),
            @('plda_mean2.npy',640,'6f6fb708a2037197b5b84ffeaa8f140cb878088fbecd6ab042ad26a7691bd2cf'),
            @('wespeaker-voxceleb-resnet34.min_num_samples.txt',4,'e4df891c484d7abb985dadf539fa1883a646dab6337af5cae4159c587b7050cc'),
            @('segmentation-3.0.safetensors',5897576,'88e7883cf56f679170e162419efddf970f929915281ebce80e351c42b5a7115d'),
            @('wespeaker-multimask-tail.safetensors',26527656,'b97b090ceebcf10924732ad4552a2d867d76d38dcc1409a13687a6ba71ff1ef3')
        )
        foreach ($pin in $pins) {
            $path = Join-Path $scratch ('models/' + $pin[0])
            $uri = 'https://huggingface.co/avencera/speakrs-models/resolve/67f963b6a1d94fcd4678948237b3cc8bd69bf1d8/' + $pin[0]
            Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $path
            if ((Get-Item -LiteralPath $path).Length -ne $pin[1] -or (Hash $path) -ne $pin[2]) { throw "Model verification failed: $($pin[0])" }
            Record "model=$($pin[0]) bytes=$($pin[1]) sha256=$($pin[2])"
        }
        # Isolate upstream tuning state; never pass a token to the native child.
        $names = @('SPEAKRS_MODELS_DIR','SPEAKRS_MODE','SPEAKRS_EXCLUSIVE','SPEAKRS_NUM_SPEAKERS','SPEAKRS_CUDA_TUNE_FILE','SPEAKRS_CUDA_PTX_TIER','SPEAKRS_CUDA_FORCE_PTX_JIT','SPEAKRS_CUDA_FORCE_LIBRARY','XDG_CONFIG_HOME','HF_TOKEN','HUGGING_FACE_HUB_TOKEN','HUGGINGFACE_HUB_TOKEN','HF_TOKEN_PATH')
        $saved = @{}; foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        try {
            $env:SPEAKRS_MODELS_DIR = Join-Path $scratch 'models'; $env:SPEAKRS_MODE = 'cuda'; $env:SPEAKRS_EXCLUSIVE = '1'; $env:XDG_CONFIG_HOME = Join-Path $scratch 'config'; $env:HF_TOKEN_PATH = 'NUL'
            $stdout = Join-Path $scratch 'inference.json'; $stderr = Join-Path $scratch 'inference-stderr.log'
            $process = Start-Process -FilePath $binary -ArgumentList @('"' + $fixture + '"') -WorkingDirectory $scratch -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait -NoNewWindow
            Record "inference_exit=$($process.ExitCode)"
            if ($process.ExitCode -ne 0) { throw 'CUDA inference failed; inspect scratch inference-stderr.log.' }
            $lines = @(Get-Content -LiteralPath $stdout)
            if ($lines.Count -ne 1) { throw 'Expected exactly one stdout JSON document.' }
            $result = $lines[0] | ConvertFrom-Json
            if (-not $result.success -or $result.device -ne 'cuda' -or $result.annotationSource -ne 'exclusive_speaker_diarization') { throw 'Unexpected inference result metadata.' }
            $previous = 0.0
            foreach ($segment in $result.segments) {
                $start = [double]$segment.start; $end = [double]$segment.end
                if ([double]::IsNaN($start) -or [double]::IsInfinity($start) -or [double]::IsNaN($end) -or [double]::IsInfinity($end) -or $start -lt $previous -or $end -le $start -or $end -gt 16) { throw 'Invalid or overlapping exclusive segment boundaries.' }
                $previous = $end
            }
            if (@($result.segments).Count -eq 0) { throw 'Inference returned no segments.' }
            Record "inference_device=cuda segments=$(@($result.segments).Count) speakers=$(@($result.segments.speaker | Sort-Object -Unique).Count)"
        } finally { foreach ($name in $names) { if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } } }
    } finally { Pop-Location }
    Record 'RESULT=source feasibility only; native packaged Windows acceptance remains open.'
    Record 'NEXT: capture dumpbin /DEPENDENTS plus Process Monitor Image Load paths and versions/hashes, including delayed loads. Repeat with developer CUDA directories absent from PATH and harmless DLL decoys in scratch CWD/PATH. Test a consented known multi-speaker recording and packaged inference; do not infer loader safety from this probe.'
    Record 'Also document PTX versions/targets, driver compatibility, forced-PTX and all GPU tiers. Never copy DLLs into System32.'
} catch {
    Record ('RESULT=BLOCKED: ' + $_.Exception.Message)
    throw
}
