$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-ocr"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $python)) {
  python -m venv $venv
}

& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $root "ocr-server\requirements.txt")

$env:PYTHONPATH = Join-Path $root "ocr-server"
& $python -m uvicorn server:app --host 127.0.0.1 --port 2010
