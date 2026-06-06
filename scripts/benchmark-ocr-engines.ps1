param(
  [string]$Image = "",

  [string]$PageUrl = "",

  [ValidateSet("easyocr", "lighton", "both")]
  [string]$Engine = "both",

  [string]$Model = "lightonai/LightOnOCR-2-1B",

  [int]$MaxNewTokens = 1024,

  [switch]$Json,

  [switch]$InstallOnly,

  [switch]$Reinstall
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-ocr-bench"
$python = Join-Path $venv "Scripts\python.exe"
$readyMarker = Join-Path $venv ".ready"
$torchIndexUrl = "https://download.pytorch.org/whl/cu128"
$torchPackages = @("torch==2.11.0+cu128", "torchvision==0.26.0+cu128")

function Get-BasePython {
  $py311 = & py -3.11 -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $py311) {
    return $py311.Trim()
  }

  $pythonExe = & python -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $pythonExe) {
    return $pythonExe.Trim()
  }

  throw "Python 3.11+ is required."
}

if (-not (Test-Path $python)) {
  $basePython = Get-BasePython
  & $basePython -m venv $venv
}

if ($Reinstall -or -not (Test-Path $readyMarker)) {
  & $python -m pip install --upgrade pip
  & $python -m pip install --upgrade --index-url $torchIndexUrl @torchPackages
  & $python -m pip install -r (Join-Path $root "ocr-server\requirements-benchmark.txt")
  New-Item -ItemType File -Force -Path $readyMarker | Out-Null
} else {
  Write-Host "Using existing OCR benchmark environment: $venv"
}

if ($InstallOnly) {
  Write-Host "OCR benchmark environment is ready: $venv"
  exit 0
}

if (-not $Image) {
  throw "Pass -Image with an image file path or URL, or use -InstallOnly to prepare the benchmark environment."
}

$arguments = @(
  (Join-Path $root "ocr-server\benchmark_ocr_engines.py"),
  "--image", $Image,
  "--engine", $Engine,
  "--model", $Model,
  "--max-new-tokens", "$MaxNewTokens"
)

if ($PageUrl) {
  $arguments += @("--page-url", $PageUrl)
}

if ($Json) {
  $arguments += "--json"
}

& $python @arguments
