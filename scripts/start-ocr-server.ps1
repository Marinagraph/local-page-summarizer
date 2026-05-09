$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-ocr"
$python = Join-Path $venv "Scripts\python.exe"

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

if (Test-Path $python) {
  $version = & $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
  if ($version -eq "3.13") {
    Write-Host "Removing Python 3.13 OCR virtualenv because EasyOCR dependencies are not reliable on it."
    Remove-Item -LiteralPath $venv -Recurse -Force
  }
}

if (-not (Test-Path $python)) {
  $basePython = Get-BasePython
  & $basePython -m venv $venv
}

& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $root "ocr-server\requirements.txt")

$env:PYTHONPATH = Join-Path $root "ocr-server"
& $python -m uvicorn server:app --host 127.0.0.1 --port 2010
