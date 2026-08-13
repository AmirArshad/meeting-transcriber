param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'speakrs-two-speaker-16k.wav')
)

$ErrorActionPreference = 'Stop'

$synthesizer = New-Object -ComObject SAPI.SpVoice
$voices = @($synthesizer.GetVoices())
$hazel = $voices | Where-Object { $_.GetDescription() -like 'Microsoft Hazel Desktop*' } | Select-Object -First 1
$zira = $voices | Where-Object { $_.GetDescription() -like 'Microsoft Zira Desktop*' } | Select-Object -First 1
if (-not $hazel -or -not $zira) {
    throw 'This fixture generator requires the built-in Microsoft Hazel and Zira Desktop voices.'
}

$stream = New-Object -ComObject SAPI.SpFileStream
$format = New-Object -ComObject SAPI.SpAudioFormat
$format.Type = 18 # SAFT16kHz16BitMono
$stream.Format = $format
$stream.Open($OutputPath, 3, $false) # SSFMCreateForWrite

try {
    $synthesizer.AudioOutputStream = $stream
    $synthesizer.Rate = 4
    $turns = @(
        @($hazel, 'Morning, Zira. The design review starts at ten, and I prepared the agenda.'),
        @($zira, 'Thanks, Hazel. I will share the schedule and confirm each action owner.'),
        @($hazel, 'Please include testing and accessibility before the final delivery date.'),
        @($zira, 'I will add both checks and send the update after this call.')
    )
    foreach ($turn in $turns) {
        $synthesizer.Voice = $turn[0]
        [void]$synthesizer.Speak($turn[1])
    }
}
finally {
    $stream.Close()
}
