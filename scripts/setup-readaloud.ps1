param([string]$Destination = (Join-Path $PSScriptRoot '../.verify/tts'))
$ErrorActionPreference = 'Stop'
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$modelName = 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia'
$modelPath = Join-Path $destinationPath $modelName
$reusePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.verify/tts/zipvoice-native'))
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $modelPath 'encoder.int8.onnx'))) {
    if (Test-Path -LiteralPath (Join-Path $reusePath "$modelName/encoder.int8.onnx")) {
        Copy-Item -LiteralPath (Join-Path $reusePath $modelName) -Destination $modelPath -Recurse
    } else {
        $archivePath = Join-Path $destinationPath "$modelName.tar.bz2"
        if (!(Test-Path -LiteralPath $archivePath)) {
            & curl.exe -L --fail --output $archivePath "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$modelName.tar.bz2"
            if ($LASTEXITCODE -ne 0) { throw 'The official model download failed. No automatic retry was attempted.' }
        }
        & tar -xf $archivePath -C $destinationPath
        if ($LASTEXITCODE -ne 0) { throw 'Model extraction failed.' }
    }
}
$vocoderPath = Join-Path $modelPath 'vocos_24khz.onnx'
if (!(Test-Path -LiteralPath $vocoderPath)) {
    if (Test-Path -LiteralPath (Join-Path $reusePath 'vocos_24khz.onnx')) {
        Copy-Item -LiteralPath (Join-Path $reusePath 'vocos_24khz.onnx') -Destination $vocoderPath
    } else {
        & curl.exe -L --fail --output $vocoderPath 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx'
        if ($LASTEXITCODE -ne 0) { throw 'The official vocoder download failed. No automatic retry was attempted.' }
    }
}
foreach ($file in @('encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt', 'lexicon.txt', 'vocos_24khz.onnx')) {
    $asset = Get-Item -LiteralPath (Join-Path $modelPath $file)
    if ($asset.Length -le 0) { throw "Empty model asset: $file" }
}
if (!(Test-Path -LiteralPath (Join-Path $modelPath 'espeak-ng-data') -PathType Container)) { throw 'Missing espeak-ng-data.' }
foreach ($file in @('conversation-female.wav', 'conversation-female.txt')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../assets/readaloud/$file") -Destination (Join-Path $modelPath $file) -Force
}
Write-Output $modelPath
